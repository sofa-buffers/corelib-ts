/**
 * The SofaBuffers encoder.
 *
 * `OStream` writes fields into a byte buffer. Two modes:
 *
 * - **In-memory** (`new OStream()`): an auto-growing buffer; call
 *   {@link OStream.bytes} for the finished message.
 * - **Streaming** (`new OStream(buffer, offset?, flush?)`): writes into a
 *   caller-provided buffer and, when it fills, hands the produced bytes to the
 *   `flush` sink and continues — so the buffer can be much smaller than the
 *   message. `offset` reserves room at the front for a lower-layer header.
 *
 * Generated code typically writes one field per message field; the methods map
 * one-to-one onto the wire types. Problems throw {@link SofabError}.
 *
 * Nested sequences are opened with {@link OStream.writeSequenceBeginLazy}, which
 * holds the header back until the sequence proves it has content, so an
 * all-default one is omitted rather than framed empty (MESSAGE_SPEC §2). Close a
 * `struct`/`union` field or an array wrapper with {@link OStream.writeSequenceEnd}
 * and a wrapper-array *element* with {@link OStream.writeSequenceEndKeep}.
 */

import {
  ARRAY_MAX,
  FIXLEN_MAX,
  FixlenSubtype,
  ID_MAX,
  MAX_DEPTH,
  VARINT_MAX_BYTES,
  WireType,
} from "../constants.js";
import {
  argumentError,
  bufferFullError,
} from "../errors.js";
import {
  getKernel,
  type Kernel,
} from "../backend/kernel.js";
import { Long } from "../long.js";
import { HI, LO, S_U32, splitI64, splitU64 } from "../varint/bits64.js";
import {
  encodeVarintLoHi,
  encodeVarintNum,
  varintSizeLoHi,
  varintSizeNum,
} from "../varint/leb128.js";
import { packFp32, packFp64, toBigInt } from "../varint/num64.js";
import { encodeZigzagVarintLoHi } from "../varint/zigzag.js";
import { encodeUtf8, utf8Length, utf8Write } from "./fixlen.js";
import type { FlushSink } from "./sink.js";

const DEFAULT_CAPACITY = 256;

/**
 * Largest magnitude a signed scalar takes on the number fast path: its zig-zag
 * image (`|v| * 2`) must stay an exact integer, i.e. `≤ 2^53`.
 */
const SIGNED_FAST_MAX = 0x10_0000_0000_0000; // 2^52

/**
 * Encoder for the SofaBuffers wire format. Each `write*` method appends one
 * field and maps one-to-one onto a wire type. Construct it in-memory (an
 * auto-growing buffer, read back with {@link OStream.bytes}) or in streaming
 * mode over a caller-provided buffer that drains to a {@link FlushSink} as it
 * fills, so the message can outgrow the buffer. Invalid arguments and a full
 * buffer with no sink throw {@link SofabError}.
 */
export class OStream {
  private buf: Uint8Array;
  private pos: number;
  private start: number;
  private readonly flushSink: FlushSink | undefined;
  private readonly canGrow: boolean;
  private depth = 0;
  /**
   * Ids of the innermost open sequences whose header has not been written yet
   * (MESSAGE_SPEC §2 lazy framing, {@link OStream.writeSequenceBeginLazy}).
   * Always a contiguous suffix of the open sequences: writing any field commits
   * the whole run at once, so {@link OStream.writeSequenceEnd} can drop the
   * innermost one by dropping the last entry. Held-back ids are encoder state,
   * never buffer content, so a flush can never split a run.
   *
   * Storage plus an explicit count rather than `push`/`pop`, so the slots are
   * reused across messages (no allocation on a pooled encoder) and so
   * {@link OStream.commitPending} can zero the count *before* it writes.
   *
   * The array grows on demand and is bounded only by `MAX_DEPTH` — there is no
   * fixed hold-back window and hence no eager-framing fallback, which is what
   * CORELIB_PLAN §6 ("How deep the hold-back reaches") demands of an
   * implementation that can allocate: canonical output at *every* depth.
   *
   * Created on the first {@link OStream.writeSequenceBeginLazy}, so a message
   * with no sequence field never allocates it.
   */
  private pending: number[] | null = null;
  /** Valid entries in {@link OStream.pending}. */
  private nPending = 0;
  private kernel: Kernel;

  /** In-memory encoder backed by an auto-growing buffer. */
  constructor();
  /** Streaming encoder over a caller buffer, optionally draining to `flush`. */
  constructor(buffer: Uint8Array, offset?: number, flush?: FlushSink);
  constructor(buffer?: Uint8Array, offset = 0, flush?: FlushSink) {
    this.kernel = getKernel();
    if (buffer === undefined) {
      this.buf = new Uint8Array(DEFAULT_CAPACITY);
      this.start = 0;
      this.pos = 0;
      this.flushSink = undefined;
      this.canGrow = true;
    } else {
      if (offset < 0 || offset > buffer.length) {
        throw argumentError(`offset ${offset} out of range`);
      }
      this.buf = buffer;
      this.start = offset;
      this.pos = offset;
      this.flushSink = flush;
      this.canGrow = false;
    }
  }

  /** Bytes currently held in the buffer (since construction or the last flush). */
  get bytesUsed(): number {
    return this.pos - this.start;
  }

  /**
   * The encoded message so far, as a view into the working buffer.
   * Meaningful for the in-memory mode; in streaming mode it is only the
   * not-yet-flushed tail. The view is valid until the next write.
   */
  bytes(): Uint8Array {
    return this.buf.subarray(this.start, this.pos);
  }

  /** Drain buffered bytes to the flush sink (no-op without one). */
  flush(): void {
    if (this.flushSink && this.pos > this.start) {
      this.flushSink(this.buf.subarray(this.start, this.pos));
      this.pos = this.start;
    }
  }

  /**
   * Install a fresh output buffer to write into, mid-stream. Intended for the
   * streaming (flush-sink) mode: call it from inside your flush callback to hand
   * the encoder a new buffer for the next batch of bytes, so encoding continues
   * without interruption. `offset` reserves space at the front of the new
   * buffer. Any not-yet-flushed bytes in the old buffer are dropped, so
   * {@link flush} first (the flush callback fires before you swap).
   */
  setBuffer(buffer: Uint8Array, offset = 0): void {
    if (offset < 0 || offset > buffer.length) {
      throw argumentError(`offset ${offset} out of range`);
    }
    this.buf = buffer;
    this.start = offset;
    this.pos = offset;
  }

  /**
   * Rewind the encoder to empty, reusing the existing buffer. Lets a caller pool
   * one OStream across many messages instead of allocating a fresh buffer per
   * encode. Any view previously returned by {@link bytes} is invalidated.
   */
  reset(): void {
    this.pos = this.start;
    this.depth = 0;
    this.nPending = 0;
  }

  // --- scalars ------------------------------------------------------------

  /** Write an unsigned integer field. */
  writeUnsigned(id: number, value: number | bigint): void {
    // Fast path: a small non-negative integer never touches bigint.
    if (typeof value === "number" && value >= 0 && value <= Number.MAX_SAFE_INTEGER && Number.isInteger(value)) {
      this.header(id, WireType.Unsigned);
      this.putVarintNum(value);
      return;
    }
    const v = toBigInt(value);
    // splitU64 range-checks *and* splits in one store/load pair: the round-trip
    // through the unsigned 64-bit scratch differs from the input exactly when
    // the input was negative or ≥ 2^64 (bits64). The halves must be copied out
    // before `header` runs, because a flush sink it may reach is caller code
    // that can re-enter this encoder and overwrite the shared scratch.
    if (!splitU64(v)) throw argumentError(`unsigned value ${v} out of 64-bit range`);
    const lo = S_U32[LO]!;
    const hi = S_U32[HI]!;
    this.header(id, WireType.Unsigned);
    this.ensure(varintSizeLoHi(lo, hi));
    this.pos = encodeVarintLoHi(lo, hi, this.buf, this.pos);
  }

  /** Write a signed integer field (zig-zag encoded). */
  writeSigned(id: number, value: number | bigint): void {
    // Fast path: a small-magnitude integer zig-zags within number precision.
    if (typeof value === "number" && value >= -SIGNED_FAST_MAX && value <= SIGNED_FAST_MAX && Number.isInteger(value)) {
      this.header(id, WireType.Signed);
      this.putVarintNum(value >= 0 ? value * 2 : -value * 2 - 1);
      return;
    }
    const v = toBigInt(value);
    // As in writeUnsigned, the signed scratch round-trip is both the `inI64`
    // range check and the split; the halves are read out before `header`.
    if (!splitI64(v)) throw argumentError(`signed value ${v} out of 64-bit range`);
    const lo = S_U32[LO]!;
    const hi = S_U32[HI]!;
    // Zig-zag on the halves — `(n << 1) ^ (n >> 63)` widened across both — so
    // the exact varint size is known and only that many bytes are ensured, as
    // before (a fixed caller buffer must not see a 10-byte demand for a 2-byte
    // field).
    const sgn = -(hi >>> 31) >>> 0;
    const zLo = (((lo << 1) >>> 0) ^ sgn) >>> 0;
    const zHi = ((((hi << 1) | (lo >>> 31)) >>> 0) ^ sgn) >>> 0;
    this.header(id, WireType.Signed);
    this.ensure(varintSizeLoHi(zLo, zHi));
    this.pos = encodeVarintLoHi(zLo, zHi, this.buf, this.pos);
  }

  /** Write a boolean field (encoded as the unsigned value 0 or 1). */
  writeBoolean(id: number, value: boolean): void {
    this.header(id, WireType.Unsigned);
    this.putVarintNum(value ? 1 : 0);
  }

  /** Write an IEEE-754 32-bit float field. */
  writeFp32(id: number, value: number): void {
    this.fixlenHead(id, 4, FixlenSubtype.Fp32);
    this.ensure(4);
    this.pos = packFp32(this.buf, this.pos, value);
  }

  /** Write an IEEE-754 64-bit double field. */
  writeFp64(id: number, value: number): void {
    this.fixlenHead(id, 8, FixlenSubtype.Fp64);
    this.ensure(8);
    this.pos = packFp64(this.buf, this.pos, value);
  }

  /** Write a UTF-8 string field. */
  writeString(id: number, text: string): void {
    // Fast path (in-memory, growable buffer): scan the UTF-8 byte length, write
    // the fixlen header, then encode the characters straight into the output
    // buffer. This skips `TextEncoder.encode`'s per-call setup + throwaway array
    // + second copy — the encoder's dominant cost on string-heavy messages.
    if (this.canGrow) {
      // Pure ASCII — the overwhelmingly common case for keys, identifiers and
      // short text — needs neither of the general helpers: the UTF-8 byte length
      // is the character count, so the header can go out after one scan and the
      // payload is a straight character-to-byte copy. `utf8Length` /
      // `utf8Write` below remain the single implementation of everything else,
      // including all surrogate handling; this only short-circuits the case
      // where both of them would reduce to exactly this loop.
      const n = text.length;
      let a = 0;
      while (a < n && text.charCodeAt(a) < 0x80) a++;
      if (a === n) {
        if (n > FIXLEN_MAX) {
          throw argumentError(`fixlen length ${n} exceeds ${FIXLEN_MAX}`);
        }
        this.fixlenHead(id, n, FixlenSubtype.String);
        this.ensure(n);
        const buf = this.buf;
        const p = this.pos;
        for (let k = 0; k < n; k++) buf[p + k] = text.charCodeAt(k);
        this.pos = p + n;
        return;
      }

      const byteLen = utf8Length(text);
      if (byteLen > FIXLEN_MAX) {
        throw argumentError(`fixlen length ${byteLen} exceeds ${FIXLEN_MAX}`);
      }
      this.fixlenHead(id, byteLen, FixlenSubtype.String);
      this.ensure(byteLen);
      this.pos = utf8Write(text, this.buf, this.pos);
      return;
    }
    // Streaming path: the payload may outgrow a fixed caller buffer, so keep the
    // chunk-draining `writeRaw` route (needs the bytes materialised up front).
    this.writeFixlen(id, encodeUtf8(text), FixlenSubtype.String);
  }

  /** Write a blob (arbitrary bytes) field. */
  writeBlob(id: number, data: Uint8Array): void {
    this.writeFixlen(id, data, FixlenSubtype.Blob);
  }

  /** Write a fixed-length field of the given subtype from raw bytes. */
  writeFixlen(id: number, data: Uint8Array, subtype: FixlenSubtype): void {
    if (data.length > FIXLEN_MAX) {
      throw argumentError(`fixlen length ${data.length} exceeds ${FIXLEN_MAX}`);
    }
    this.fixlenHead(id, data.length, subtype);
    this.writeRaw(data);
  }

  // --- arrays -------------------------------------------------------------

  /** Write an array of unsigned integers (each a varint). */
  writeUnsignedArray(id: number, values: ArrayLike<number | bigint>): void {
    this.arrayHead(id, WireType.ArrayUnsigned, values.length);
    if (this.canGrow) {
      this.ensure(values.length * VARINT_MAX_BYTES);
      this.pos = this.kernel.encodeUnsignedVarints(values, this.buf, this.pos);
    } else {
      // Streaming (fixed caller buffer): each element is range-checked and
      // split by the same single scratch round-trip the scalar writers use, and
      // the halves are read out before `ensure` — which may reach a flush sink,
      // i.e. caller code that can re-enter and overwrite the scratch (bits64).
      for (let i = 0; i < values.length; i++) {
        const v = toBigInt(values[i]!);
        if (!splitU64(v)) throw argumentError(`unsigned value ${v} out of range`);
        const lo = S_U32[LO]!;
        const hi = S_U32[HI]!;
        this.ensure(VARINT_MAX_BYTES);
        this.pos = encodeVarintLoHi(lo, hi, this.buf, this.pos);
      }
    }
  }

  /** Write an array of signed integers (each zig-zag + varint). */
  writeSignedArray(id: number, values: ArrayLike<number | bigint>): void {
    this.arrayHead(id, WireType.ArraySigned, values.length);
    if (this.canGrow) {
      this.ensure(values.length * VARINT_MAX_BYTES);
      this.pos = this.kernel.encodeSignedVarints(values, this.buf, this.pos);
    } else {
      // See writeUnsignedArray: range-check and split in one round-trip, halves
      // out before `ensure`, then zig-zag on the halves rather than in `bigint`.
      for (let i = 0; i < values.length; i++) {
        const v = toBigInt(values[i]!);
        if (!splitI64(v)) throw argumentError(`signed value ${v} out of range`);
        const lo = S_U32[LO]!;
        const hi = S_U32[HI]!;
        this.ensure(VARINT_MAX_BYTES);
        this.pos = encodeZigzagVarintLoHi(lo, hi, this.buf, this.pos);
      }
    }
  }

  /**
   * Write an unsigned 64-bit array from {@link Long}[] — the `bigint`-free path.
   * Produces the identical wire to {@link writeUnsignedArray}; reads each Long's
   * 32-bit halves directly, so no `bigint` is created per element.
   */
  writeUnsignedArrayLong(id: number, values: readonly Long[]): void {
    this.arrayHead(id, WireType.ArrayUnsigned, values.length);
    this.ensure(values.length * VARINT_MAX_BYTES);
    let pos = this.pos;
    const buf = this.buf;
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      pos = encodeVarintLoHi(v.low, v.high, buf, pos);
    }
    this.pos = pos;
  }

  /**
   * Write a signed 64-bit array (zig-zag) from {@link Long}[] — the `bigint`-free
   * path. Zig-zag `(n << 1) ^ (n >> 63)` is computed on the lo/hi pair.
   */
  writeSignedArrayLong(id: number, values: readonly Long[]): void {
    this.arrayHead(id, WireType.ArraySigned, values.length);
    this.ensure(values.length * VARINT_MAX_BYTES);
    let pos = this.pos;
    const buf = this.buf;
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      pos = encodeZigzagVarintLoHi(v.low, v.high, buf, pos);
    }
    this.pos = pos;
  }

  /** Write an array of IEEE-754 32-bit floats. */
  writeFp32Array(id: number, values: ArrayLike<number>): void {
    this.arrayHead(id, WireType.ArrayFixlen, values.length);
    // A fixlen array always carries its fixlen_word — even when empty (§4.8) —
    // so an empty fp32 array stays distinct from an empty fp64 one. The payload
    // loop below simply runs zero times: the field is [ header ][ count = 0 ]
    // [ fixlen_word ] with no elements.
    this.putVarintNum(4 * 8 + FixlenSubtype.Fp32);
    if (this.canGrow) {
      this.ensure(values.length * 4);
      this.pos = this.kernel.packFp32Array(values, this.buf, this.pos);
    } else {
      for (let i = 0; i < values.length; i++) {
        this.ensure(4);
        this.pos = packFp32(this.buf, this.pos, values[i]!);
      }
    }
  }

  /**
   * Write an fp32 array from its raw little-endian element payload. The bytes
   * are emitted verbatim — no per-element `setFloat32` — so a signaling NaN
   * survives bit-for-bit (§4.6), which {@link writeFp32Array} cannot guarantee
   * because it re-quantizes each JS `number`. `payload.length` must be a
   * multiple of 4; the element count is `payload.length / 4`.
   */
  writeFp32ArrayRaw(id: number, payload: Uint8Array): void {
    if ((payload.length & 3) !== 0) {
      throw argumentError(
        `fp32 array payload length ${payload.length} is not a multiple of 4`,
      );
    }
    this.arrayHead(id, WireType.ArrayFixlen, payload.length >> 2);
    this.putVarintNum(4 * 8 + FixlenSubtype.Fp32);
    this.writeRaw(payload);
  }

  /** Write an array of IEEE-754 64-bit doubles. */
  writeFp64Array(id: number, values: ArrayLike<number>): void {
    this.arrayHead(id, WireType.ArrayFixlen, values.length);
    // A fixlen array always carries its fixlen_word — even when empty (§4.8) —
    // so an empty fp64 array stays distinct from an empty fp32 one. The payload
    // loop below simply runs zero times: the field is [ header ][ count = 0 ]
    // [ fixlen_word ] with no elements.
    this.putVarintNum(8 * 8 + FixlenSubtype.Fp64);
    if (this.canGrow) {
      this.ensure(values.length * 8);
      this.pos = this.kernel.packFp64Array(values, this.buf, this.pos);
    } else {
      for (let i = 0; i < values.length; i++) {
        this.ensure(8);
        this.pos = packFp64(this.buf, this.pos, values[i]!);
      }
    }
  }

  // --- sequences ----------------------------------------------------------

  /**
   * Open a nested sequence (a fresh id scope) whose header is **held back**
   * until the sequence turns out to have content.
   *
   * MESSAGE_SPEC §2 omits a sequence-typed field whose value equals its declared
   * default, and "not one child was written" is exactly that condition —
   * evaluated per child field, recursively, for free, because the message layer
   * already omits every child equal to its default. A sequence closed with
   * nothing in it therefore emits **nothing** instead of a two-byte empty frame,
   * and an all-default message becomes the empty byte string. No byte image is
   * ever compared, so in-memory layout never enters the decision.
   *
   * This is the only way to open a sequence. How it closes decides whether a
   * contentless one survives: {@link OStream.writeSequenceEnd} drops it,
   * {@link OStream.writeSequenceEndKeep} forces the frame out.
   */
  writeSequenceBeginLazy(id: number): void {
    // §4.9/§6.2: refuse to open more than MAX_DEPTH nested sequences. This is a
    // bound on a caller-supplied value, so it reports Argument — the category
    // the C and Java ports use for the same check.
    if (this.depth >= MAX_DEPTH) {
      throw argumentError(`nesting exceeds MAX_DEPTH (${MAX_DEPTH})`);
    }
    // Validate here, not at commit time: the header may never be written, and a
    // bad id must still be rejected at the call that supplied it. (Same cheap
    // integer/range test as `header`.)
    if (id >>> 0 !== id || id > ID_MAX) {
      throw argumentError(`field id ${id} out of range 0..${ID_MAX}`);
    }
    // No hold-back window and so no eager fallback: the run is an ordinary
    // growable array already bounded by MAX_DEPTH, so it is *always* a
    // contiguous suffix of the open sequences and every sequence stays
    // canonical however deep it nests. That is what CORELIB_PLAN §6 ("How deep
    // the hold-back reaches") requires of an implementation that can allocate;
    // only a heap-free profile may bound the run and frame eagerly past it.
    (this.pending ??= [])[this.nPending++] = id;
    this.depth++;
  }

  /**
   * Close the current sequence, letting it **vanish** if it received no content.
   *
   * Use it wherever absence encodes the same value as an empty frame: a
   * `struct`/`union` field, and an array field whose declared `default` is the
   * empty collection (MESSAGE_SPEC §2). Where the frame must be visible, close
   * with {@link OStream.writeSequenceEndKeep} instead.
   *
   * An end with no matching begin is not rejected: the encoder writes what it is
   * told, and the resulting bytes are then malformed, which is the decoder's
   * verdict to make. No other port refuses it. The depth counter stops at zero
   * so the MAX_DEPTH check on begin cannot be fooled by an underflow.
   */
  writeSequenceEnd(): void {
    if (this.nPending !== 0) {
      // The innermost open sequence is the last held-back one (the run is a
      // suffix of the open sequences), and it never got content: drop it —
      // header and end marker both.
      this.nPending--;
      if (this.depth > 0) this.depth--;
      return;
    }
    this.ensure(1);
    this.buf[this.pos++] = WireType.SequenceEnd; // id 0, type 7 -> byte 0x07
    if (this.depth > 0) this.depth--;
  }

  /**
   * Close the current sequence, **keeping** its frame even when it received no
   * content.
   *
   * Behaves like a write: it first emits any held-back headers — this frame's
   * and every enclosing one's — and then the end marker, so an empty sequence
   * reaches the wire as `begin` + `end`.
   *
   * Required wherever the frame carries information beyond its contents:
   * - a **wrapper-array element** (`struct`/`union`/nested row): element
   *   presence is what carries a dynamic array's length — *highest present id +
   *   1* (MESSAGE_SPEC §5.1) — so dropping an all-default element would change
   *   the decoded length, not just the bytes;
   * - an array field already known to **differ from a non-empty declared
   *   `default`**: absence would reconstruct that default, so the empty frame is
   *   the only encoding of "explicitly empty" (§2, §3).
   *
   * The two failure directions are not symmetric, which is why this is the safe
   * choice when in doubt: using it where {@link OStream.writeSequenceEnd} would
   * do costs one non-canonical empty frame that a decoder normalizes away, while
   * the reverse silently changes an array's length.
   */
  writeSequenceEndKeep(): void {
    if (this.nPending !== 0) this.commitPending();
    this.ensure(1);
    this.buf[this.pos++] = WireType.SequenceEnd; // id 0, type 7 -> byte 0x07
    if (this.depth > 0) this.depth--;
  }

  // --- internals ----------------------------------------------------------

  /** Ensure exactly `value`'s varint size, then write it (number fast path). */
  private putVarintNum(value: number): void {
    // Single-byte fast path. Every value reaching here is non-negative (ids,
    // lengths, counts, zig-zagged scalars, booleans), so `< 0x80` is exactly
    // "one byte", and `pos < buf.length` is exactly "there is room for it".
    // This is the most-executed line in the encoder — every field header, every
    // fixlen word and every array count goes through it — and it skips the
    // sizing pass, the `ensure` call and the encode call in one test.
    const pos = this.pos;
    if (value < 0x80 && pos < this.buf.length) {
      this.buf[pos] = value;
      this.pos = pos + 1;
      return;
    }
    this.putVarintNumSlow(value);
  }

  /**
   * The multi-byte / needs-room tail of {@link putVarintNum}, kept in its own
   * method so the single-byte test above stays small enough for the JIT to
   * inline into every `header` / `fixlenHead` / `arrayHead` call site.
   */
  private putVarintNumSlow(value: number): void {
    this.ensure(varintSizeNum(value));
    this.pos = encodeVarintNum(value, this.buf, this.pos);
  }

  /**
   * Write a field header, the `(id << 3) | wireType` tag, as a varint.
   *
   * This is the single choke point every field write passes through — the
   * scalar, fixlen, float, string, blob and both array writers all reach the
   * wire through `header` / `fixlenHead` / `arrayHead`, and `fixlenHead` and
   * `arrayHead` are themselves nothing but `header` plus a follow-up varint. So
   * this is also where a held-back sequence run is committed: the field about to
   * be written is content, which means every enclosing sequence is non-default
   * and must be framed after all (MESSAGE_SPEC §2).
   *
   * The only writers that do *not* pass through here are the two sequence
   * closers, which must not commit ({@link OStream.writeSequenceEnd}) or commit
   * explicitly ({@link OStream.writeSequenceEndKeep}), and
   * {@link OStream.writeSequenceBeginLazy}, which writes no byte at all.
   */
  private header(id: number, type: WireType): void {
    // `id >>> 0 !== id` rejects every non-integer, negative and ≥ 2^32 value in
    // one cheap coercion (ToUint32 is exact only on 0 .. 2^32-1 integers), so
    // the remaining bound is the ID_MAX ceiling. Equivalent to the
    // `id < 0 || id > ID_MAX || !Number.isInteger(id)` triple it replaces, minus
    // the `Number.isInteger` call on every field write.
    if (id >>> 0 !== id || id > ID_MAX) {
      throw argumentError(`field id ${id} out of range 0..${ID_MAX}`);
    }
    if (this.nPending !== 0) this.commitPending();
    // (id << 3) | type as a number: id ≤ 2^31-1, so the word stays ≤ 2^34.
    this.putVarintNum(id * 8 + type);
  }

  /**
   * Write out the held-back sequence headers, **outermost first**, and clear the
   * run. Runs at most once per non-default sequence, never per field — the cost
   * on the hot path is the single `nPending` test in {@link header}.
   *
   * The count is zeroed before the first byte goes out, so a write re-entered
   * from a flush sink cannot emit the same run twice.
   */
  private commitPending(): void {
    const n = this.nPending;
    // Zero the count *first*, before a single byte is written. Deliberate, and
    // the ordering matters: the writes below can fill the buffer and call the
    // flush sink, which is caller code and may re-enter this encoder (that is
    // what `setBuffer` is for, and a sink is free to write a framing field of
    // its own). A re-entrant `header()` must find an empty run, or it would
    // emit these same ids a second time. The loop counts with the local `n`, so
    // clearing the field does not cut short the run it is already emitting.
    this.nPending = 0;
    const pending = this.pending!;
    for (let i = 0; i < n; i++) {
      this.putVarintNum(pending[i]! * 8 + WireType.SequenceStart);
    }
  }

  private fixlenHead(id: number, length: number, subtype: FixlenSubtype): void {
    this.header(id, WireType.Fixlen);
    this.putVarintNum(length * 8 + subtype);
  }

  private arrayHead(id: number, type: WireType, count: number): void {
    // §4.7/§4.8: element_count range is 0..ARRAY_MAX; a zero-count array is a
    // valid, fully-specified empty array on the wire.
    if (count < 0 || count > ARRAY_MAX) {
      throw argumentError(`array count ${count} out of range 0..${ARRAY_MAX}`);
    }
    this.header(id, type);
    this.putVarintNum(count);
  }

  /** Copy `data` out, flushing/growing as needed (large payloads stay chunked). */
  private writeRaw(data: Uint8Array): void {
    let off = 0;
    while (off < data.length) {
      const room = this.ensureSome(data.length - off);
      this.buf.set(data.subarray(off, off + room), this.pos);
      this.pos += room;
      off += room;
    }
  }

  /** Ensure `n` contiguous bytes are free at `pos`; returns `pos` for chaining. */
  private ensure(n: number): number {
    if (this.buf.length - this.pos >= n) return this.pos;
    this.flush();
    if (this.buf.length - this.pos >= n) return this.pos;
    if (this.canGrow) {
      this.growTo(this.pos + n);
      return this.pos;
    }
    throw bufferFullError(
      `output buffer full: need ${n} more bytes, have ${this.buf.length - this.pos}`,
    );
  }

  /** Ensure *some* room (up to `want`); returns how many bytes are available. */
  private ensureSome(want: number): number {
    let room = this.buf.length - this.pos;
    if (room === 0) {
      this.flush();
      room = this.buf.length - this.pos;
      if (room === 0) {
        if (this.canGrow) {
          this.growTo(this.pos + want);
          room = this.buf.length - this.pos;
        } else {
          throw bufferFullError("output buffer full");
        }
      }
    }
    return Math.min(room, want);
  }

  private growTo(needed: number): void {
    let cap = this.buf.length * 2;
    if (cap < needed) cap = needed;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }
}
