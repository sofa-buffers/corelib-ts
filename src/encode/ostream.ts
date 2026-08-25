/**
 * The SofaBuffers encoder.
 *
 * `OStream` writes fields into a **caller-supplied** byte buffer — the corelib
 * allocates no output buffer and never grows or reallocates one it was handed
 * (CORELIB_PLAN §5.1). Two ways to drive it:
 *
 * - **One-shot** (`new OStream(buffer, offset?)`): the buffer must hold the
 *   whole message — the size a caller derives from the generated `MAX_SIZE` —
 *   and a buffer that fills reports `BUFFER_FULL` rather than growing.
 * - **Streaming** (`new OStream(buffer, offset?, flush?)`): when the buffer
 *   fills, the produced bytes go to the `flush` sink and encoding continues —
 *   so the buffer can be arbitrarily smaller than the message, **down to a
 *   single byte** (§5.1): no single write requires contiguous room, a value
 *   larger than the buffer is split across flushes, and the bytes produced are
 *   identical either way — which is why this port declares
 *   {@link MIN_OUTPUT_BUFFER} = 1, the floor a buffer installed *with* a sink
 *   must clear. `offset` reserves room at the front for a lower-layer header,
 *   and it is `length - offset` that must clear the floor. Without a `flush`
 *   sink there is nowhere to drain to, so no minimum applies.
 *
 * Where the message has no schema-derived bound, the allocating half is the
 * caller's, and CORELIB_PLAN §5.1.2 names the shape it takes: "install a scratch
 * buffer **with a sink** that appends into the growing result". `growingOStream`
 * (`./accumulate.ts`) is that caller ready-made — a **helper** (§6.6.1) built out
 * of the streaming mode below, owning storage the encoder never sees the whole
 * of. `OStream` itself has no growth mechanism at all.
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
  MIN_OUTPUT_BUFFER,
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
import {
  fp32Bits,
  fp64BitsHi,
  fp64BitsLo,
  packFp32,
  packFp64,
  toBigInt,
} from "../varint/num64.js";
import { encodeZigzagVarintLoHi } from "../varint/zigzag.js";
import { type ByteSink, utf8Length, utf8Write, utf8WriteSink } from "./fixlen.js";
import type { FlushSink } from "./sink.js";

/**
 * Largest magnitude a signed scalar takes on the number fast path: its zig-zag
 * image (`|v| * 2`) must stay an exact integer, i.e. `≤ 2^53`.
 */
const SIGNED_FAST_MAX = 0x10_0000_0000_0000; // 2^52

/**
 * Validate a caller-supplied output buffer *where it is handed over* — at
 * construction and at every mid-stream {@link OStream.setBuffer} (CORELIB_PLAN
 * §5.1). The offset must land inside the buffer, and, **only** when a flush sink
 * is installed, the usable window must be at least {@link MIN_OUTPUT_BUFFER}
 * bytes: a streaming buffer that cannot take a single byte would otherwise fail
 * partway through a message via the buffer-full path instead of here. Without a
 * sink there is no minimum — no flush can occur, so nothing can be split, and
 * the exact-`MAX_SIZE` case must stay exact.
 */
function checkHandover(
  buffer: Uint8Array,
  offset: number,
  streaming: boolean,
  carried: number,
): void {
  if (offset < 0 || offset > buffer.length) {
    throw argumentError(`offset ${offset} out of range`);
  }
  if (!Number.isInteger(carried) || carried < 0 || carried > offset) {
    throw argumentError(`carried ${carried} out of range 0..${offset}`);
  }
  if (streaming && buffer.length - offset < MIN_OUTPUT_BUFFER) {
    throw argumentError(
      `output buffer with a flush sink has ${buffer.length - offset} usable ` +
        `byte(s), below MIN_OUTPUT_BUFFER (${MIN_OUTPUT_BUFFER})`,
    );
  }
}

/**
 * Encoder for the SofaBuffers wire format. Each `write*` method appends one
 * field and maps one-to-one onto a wire type. It writes into the buffer the
 * caller supplies and into no other: it allocates none of its own, grows
 * none it was given, and has no hook through which anything else could grow one
 * for it (CORELIB_PLAN §5.1.2, §6.6). Hand it a buffer that holds the whole
 * message, or one that drains to a {@link FlushSink} as it fills so the message
 * can outgrow it. Invalid arguments and a full buffer with no sink throw
 * {@link SofabError}. To let the buffer follow the message instead, encode into
 * the accumulator `growingOStream` builds — a helper over the streaming mode,
 * not a mode of this class.
 */
export class OStream implements ByteSink {
  private buf: Uint8Array;
  private pos: number;
  /**
   * Where the **current flush unit** begins in {@link buf}: the first byte the
   * next {@link flush} hands to the sink.
   */
  private start: number;
  /**
   * Where the **message so far** begins in {@link buf} — what {@link bytes} and
   * {@link bytesUsed} report from.
   *
   * Equal to {@link start} for every ordinary stream, and the two move together:
   * what has not been flushed is the whole of what is still in the buffer. They
   * part only when a caller installs a replacement that **already holds** the
   * earlier bytes of this message (`setBuffer`'s `carried` argument) — the shape
   * an accumulating caller uses, where each new window opens after the bytes the
   * previous one left behind in the same storage. Keeping the two apart is what
   * lets that caller be an ordinary sink (§5.1.5) instead of a growth hook
   * inside the encoder (§6.6).
   */
  private origin: number;
  private readonly flushSink: FlushSink | undefined;
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
   * reused across messages and so {@link OStream.commitPending} can zero the
   * count *before* it writes.
   *
   * **Fixed size, sized at construction** from `MAX_DEPTH` — the "fixed-size
   * state whose size this document fixes" of CORELIB_PLAN §6.6.2, and the shape
   * §6.0.1 asks for: the run covers the full depth, so it is always a contiguous
   * suffix of the open sequences, every sequence stays canonical however deep it
   * nests, and there is no eager-framing fallback. Nothing is allocated per
   * message, per field or per sequence.
   *
   * A plain array rather than an `Int32Array`: a 255-slot typed array is an
   * external backing store on V8 (~3.1 µs to allocate on Node 24, against ~5 ns
   * for this), and an encoder is constructed per message on the accumulator path.
   * Slots are written before they are read, so it is never read holey.
   */
  private readonly pending: number[];
  /** Valid entries in {@link OStream.pending}. */
  private nPending = 0;
  /**
   * How many buffer installations {@link OStream.setBuffer} has made. Only ever
   * compared for equality across the flush callback, which is how
   * {@link OStream.flush} tells "the sink copied and returned" from "the sink
   * took the buffer and installed a replacement" — the one distinction §5.1
   * rests the handover contract on, and the one that decides whether the start
   * offset was consumed or re-armed.
   */
  private installs = 0;
  private readonly kernel: Kernel;

  /**
   * Encoder over a caller buffer, optionally draining to `flush` as it fills.
   *
   * Those are the only two buffer models there are (CORELIB_PLAN §5.1.1): the
   * buffer the caller hands over, and whatever a sink installs in its place
   * (§5.1.5). There is no third parameter through which the encoder could be
   * given something to enlarge — growing a destination from a write path is what
   * §6.6's second violation row names, whoever owns the allocator.
   *
   * Constructing one is the only allocating step (§6.6): it sizes the hold-back
   * run from `MAX_DEPTH` and reads the active kernel once. No `write*` call after
   * that allocates anything.
   */
  constructor(buffer: Uint8Array, offset = 0, flush?: FlushSink) {
    this.kernel = getKernel();
    this.pending = new Array<number>(MAX_DEPTH);
    checkHandover(buffer, offset, flush !== undefined, 0);
    this.buf = buffer;
    this.start = offset;
    this.origin = offset;
    this.pos = offset;
    this.flushSink = flush;
  }

  /** Bytes of the message currently held in the buffer (see {@link bytes}). */
  get bytesUsed(): number {
    return this.pos - this.origin;
  }

  /**
   * The encoded message so far, as a view into the working buffer: everything
   * written since construction, the last {@link reset}, or the last flush the
   * sink returned from without installing a buffer. With a flush sink that is
   * normally only the not-yet-flushed tail; on a stream whose sink hands back a
   * replacement carrying the earlier bytes — the accumulator `growingOStream`
   * builds — it is the whole message. The view is valid until the next write.
   */
  bytes(): Uint8Array {
    return this.buf.subarray(this.origin, this.pos);
  }

  /**
   * Drain buffered bytes to the flush sink (no-op without one).
   *
   * A sink that returns **without** installing a buffer has copied what it was
   * handed, so the encoder keeps writing into the same buffer — resuming at
   * offset **0**. The start offset belongs to the *installation*, not to the
   * buffer (CORELIB_PLAN §5.1): the buffer-set that armed it — the constructor
   * or {@link OStream.setBuffer} — reserved room in the unit it began, and
   * handing that unit over consumes the reservation. A sink that wants header
   * room in *every* unit re-arms it by calling `setBuffer(buf, offset)` from
   * inside the callback, a new installation like any other; a bare return must
   * not do it implicitly, or the leading bytes would be capacity the rest of the
   * stream could never use and the two shapes would be indistinguishable.
   */
  flush(): void {
    this.drain(0);
  }

  /**
   * {@link flush}, plus the number of contiguous bytes the caller wants at the
   * cursor afterwards — `0` when it wants none in particular.
   *
   * Split out from the public `flush` so the figure cannot be invented by a
   * caller: it is the encoder's own reserve request, and a sink that sizes a
   * replacement from it (`growingOStream`) has to be able to trust it. Everything
   * else is identical, including that a sink which returns without installing has
   * *copied* and the cursor resumes at `0`.
   */
  private drain(needed: number): void {
    if (this.flushSink && this.pos > this.start) {
      const installed = this.installs;
      // The installed buffer itself, with the region's coordinates — never a view
      // this encoder built (§6.6: no allocation after construction) and never
      // memory from anywhere else (§5.1.6: pass-through is forbidden).
      //
      // Called as a **method of this stream**, deliberately: a sink written as a
      // plain function then receives the encoder as `this`, which is how
      // `growingOStream` (`./accumulate.ts`) ships a stateless module-level sink
      // and allocates nothing per stream. Hoisting `this.flushSink` into a local
      // here would silently take that away — `test/buffer-ownership.test.ts`
      // pins the receiver.
      this.flushSink(this.buf, this.start, this.pos, needed);
      // A `setBuffer` from inside the callback *is* the new installation and has
      // already placed the cursor at its own offset; only a bare return leaves
      // the old installation in place, and that one is the consumed case.
      if (this.installs === installed) {
        this.start = 0;
        this.origin = 0;
        this.pos = 0;
      }
    }
  }

  /**
   * Install a fresh output buffer to write into, mid-stream. Intended for the
   * streaming (flush-sink) mode: call it from inside your flush callback to hand
   * the encoder a new buffer for the next batch of bytes, so encoding continues
   * without interruption. `offset` reserves space at the front of the new
   * buffer. Any not-yet-flushed bytes in the old buffer are dropped, so
   * {@link flush} first (the flush callback fires before you swap).
   *
   * Every call is a **new installation**, and its `offset` applies to the unit
   * it begins and is consumed when that unit is flushed (CORELIB_PLAN §5.1).
   * Passing the buffer the encoder already has is an installation like any
   * other: that is how a sink gets header room in *every* flushed unit — one
   * framing header per packet — where returning bare would resume at `0`.
   *
   * On a stream that has a flush sink the new buffer must leave at least
   * {@link MIN_OUTPUT_BUFFER} usable bytes (`buffer.length - offset`); a smaller
   * one is rejected here, with {@link SofabErrorCode.Argument}, leaving the
   * encoder on the buffer it already had. A sink-less stream has no minimum.
   *
   * `carried` says how many bytes **immediately before `offset`** the
   * replacement already holds of *this* message — normally `0`, because a fresh
   * buffer holds none. A caller that keeps the whole message in one growing
   * store passes the length it copied across, so {@link bytes} keeps reporting
   * the message rather than only the piece written after the swap. It changes
   * nothing on the wire and nothing about flushing: the next flush still begins
   * at `offset`. `growingOStream` is the caller this exists for; it is the
   * §5.1.5 handover, not a growth hook inside the encoder (§6.6).
   *
   * The accumulating stream `growingOStream` builds is an ordinary streaming
   * stream, so this works on it too, and means exactly what it means anywhere
   * else: the not-yet-flushed bytes in the old buffer are dropped, encoding
   * continues into yours, and its sink takes over growing *that* one from the
   * next flush — reserve offset included, since what it copies out is the
   * message rather than the buffer. Encode into a plain
   * `new OStream(buffer, offset, flush?)` to keep the buffer yours instead.
   */
  setBuffer(buffer: Uint8Array, offset = 0, carried = 0): void {
    checkHandover(buffer, offset, this.flushSink !== undefined, carried);
    this.buf = buffer;
    this.start = offset;
    this.origin = offset - carried;
    this.pos = offset;
    // Counted *after* the checks: a rejected buffer is not an installation, and
    // a flush in progress must still see the one it handed over (§5.1).
    this.installs++;
  }

  /**
   * Rewind the encoder to empty, reusing the existing buffer. Lets a caller pool
   * one OStream across many messages instead of allocating a fresh buffer per
   * encode. Any view previously returned by {@link bytes} is invalidated.
   */
  reset(): void {
    this.pos = this.origin;
    this.start = this.origin;
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
    this.putVarintLoHi(lo, hi);
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
    // the varint goes out at its exact size (a fixed caller buffer must not see
    // a 10-byte demand for a 2-byte field).
    const sgn = -(hi >>> 31) >>> 0;
    const zLo = (((lo << 1) >>> 0) ^ sgn) >>> 0;
    const zHi = ((((hi << 1) | (lo >>> 31)) >>> 0) ^ sgn) >>> 0;
    this.header(id, WireType.Signed);
    this.putVarintLoHi(zLo, zHi);
  }

  /**
   * Write an unsigned 64-bit scalar from a {@link Long} — the `bigint`-free twin
   * of {@link writeUnsigned}, and the scalar counterpart of
   * {@link writeUnsignedArrayLong}. Produces the identical wire.
   *
   * There is no range check and no scratch round-trip: a `Long` *is* two 32-bit
   * halves, so it is in the `uint64` domain by construction — which is the whole
   * of what `splitU64` decides for a `number | bigint`. The halves go straight
   * into the varint writer, so nothing is allocated per value. Nothing needs
   * copying out ahead of `header` either, for the same reason the array writers
   * do not: the halves come off a caller-owned immutable `Long`, not the shared
   * scratch a re-entrant flush sink could overwrite.
   */
  writeUnsignedLong(id: number, value: Long): void {
    this.header(id, WireType.Unsigned);
    this.putVarintLoHi(value.low, value.high);
  }

  /**
   * Write a signed 64-bit scalar (zig-zag) from a {@link Long} — the
   * `bigint`-free twin of {@link writeSigned}, and the scalar counterpart of
   * {@link writeSignedArrayLong}. Zig-zag `(n << 1) ^ (n >> 63)` is computed on
   * the lo/hi pair, so the varint goes out at its exact size (a fixed caller
   * buffer must not see a 10-byte demand for a 2-byte field) and no `bigint` is
   * created. A `Long` carries exactly 64 bits, so as in {@link writeUnsignedLong}
   * there is nothing left to range-check.
   */
  writeSignedLong(id: number, value: Long): void {
    this.header(id, WireType.Signed);
    this.putZigzagVarintLoHi(value.low, value.high);
  }

  /** Write a boolean field (encoded as the unsigned value 0 or 1). */
  writeBoolean(id: number, value: boolean): void {
    this.header(id, WireType.Unsigned);
    this.putVarintNum(value ? 1 : 0);
  }

  /** Write an IEEE-754 32-bit float field. */
  writeFp32(id: number, value: number): void {
    this.fixlenHead(id, 4, FixlenSubtype.Fp32);
    this.putFp32(value);
  }

  /**
   * Write an fp32 field from its raw wire bits — the 4 little-endian payload
   * bytes as one 32-bit word, which is exactly what {@link Visitor.fp32} delivers
   * as `bits`.
   *
   * This is the re-encode half of the bit-exactness rule (CORELIB_PLAN §6.5). A JS
   * `number` is a 64-bit double, and widening an fp32 **signaling** NaN into one
   * quiets it, so re-encoding through {@link writeFp32} cannot reproduce such a
   * payload; the bits go out verbatim here, so decode → re-encode is byte-for-byte
   * for every fp32 value, sNaN included. §6.5 requires this path of every
   * double-only target, and names it: "a 32-bit bits accessor".
   */
  writeFp32Bits(id: number, bits: number): void {
    this.fixlenHead(id, 4, FixlenSubtype.Fp32);
    this.putFp32Bits(bits >>> 0);
  }

  /** Write an IEEE-754 64-bit double field. */
  writeFp64(id: number, value: number): void {
    this.fixlenHead(id, 8, FixlenSubtype.Fp64);
    this.putFp64(value);
  }

  /** Write a UTF-8 string field. */
  writeString(id: number, text: string): void {
    // Fast path: scan the UTF-8 byte length, write the fixlen header, then encode
    // the characters straight into the output buffer. This skips
    // `TextEncoder.encode`'s per-call setup + throwaway array + second copy — the
    // encoder's dominant cost on string-heavy messages. It needs the payload to
    // fit contiguously where the cursor stands, which {@link reserveBulk}
    // answers for *any* buffer; where it does not, the chunk-draining `writeRaw`
    // route below takes over, needing no contiguous room at all.
    //
    // Pure ASCII — the overwhelmingly common case for keys, identifiers and
    // short text — needs neither of the general helpers: the UTF-8 byte length
    // is the character count, so the header can go out after one scan and the
    // payload is a straight character-to-byte copy. `utf8Length` / `utf8Write`
    // below remain the single implementation of everything else, including all
    // surrogate handling; this only short-circuits the case where both of them
    // would reduce to exactly this loop.
    const n = text.length;
    let a = 0;
    while (a < n && text.charCodeAt(a) < 0x80) a++;
    if (a === n) {
      if (n > FIXLEN_MAX) {
        throw argumentError(`fixlen length ${n} exceeds ${FIXLEN_MAX}`);
      }
      this.fixlenHead(id, n, FixlenSubtype.String);
      if (this.reserveBulk(n)) {
        const buf = this.buf;
        const p = this.pos;
        for (let k = 0; k < n; k++) buf[p + k] = text.charCodeAt(k);
        this.pos = p + n;
        return;
      }
      utf8WriteSink(text, this);
      return;
    }

    // Sized (and surrogate-validated) before the header goes out, so an
    // unencodable string still throws with nothing written.
    const byteLen = utf8Length(text);
    if (byteLen > FIXLEN_MAX) {
      throw argumentError(`fixlen length ${byteLen} exceeds ${FIXLEN_MAX}`);
    }
    this.fixlenHead(id, byteLen, FixlenSubtype.String);
    if (this.reserveBulk(byteLen)) {
      this.pos = utf8Write(text, this.buf, this.pos);
      return;
    }
    // Buffer too narrow to take the payload in one piece: emit it byte by byte,
    // draining the sink in between (§5.1.3 — a payload run is divisible at any
    // byte). Encoding *through* the byte writer rather than into a throwaway
    // array is what keeps this path allocation-free (§6.6).
    utf8WriteSink(text, this);
  }

  /** Write a blob (arbitrary bytes) field. */
  writeBlob(id: number, data: Uint8Array): void {
    this.writeFixlen(id, data, FixlenSubtype.Blob);
  }

  /**
   * Write a fixed-length field of the given subtype from raw bytes.
   *
   * This is the byte-level entry point — the one writer that takes the subtype
   * from the caller rather than picking it — so the payload is checked
   * **against that subtype** before a byte is written, and it cannot emit a
   * `fixlen_word` a conformant decoder must reject (`ARGUMENT`, §6.3):
   *
   * * subtypes `0x4`–`0x7` are **reserved** — a decoder must treat a field
   *   carrying one as malformed (`INVALID`, §4.6/§5.2);
   * * `Fp32` / `Fp64` payloads are **exactly** 4 / 8 bytes — any other declared
   *   length for those subtypes is malformed, rejected the moment the word is
   *   read (§4.6);
   * * `String` / `Blob` take any length up to `FIXLEN_MAX`.
   *
   * The typed writers ({@link writeFp32}, {@link writeFp64},
   * {@link writeString}) are correct by construction and go straight to the
   * header; only {@link writeBlob}, whose subtype is unconstrained anyway,
   * shares this path.
   */
  writeFixlen(id: number, data: Uint8Array, subtype: FixlenSubtype): void {
    // One predicted-false unsigned compare folds "reserved" and "negative" into
    // a single test; the integer check (also what rules out `NaN`, which
    // `>>> 0` turns into 0) rides on its short-circuit.
    if ((subtype as number) >>> 0 > FixlenSubtype.Blob || !Number.isInteger(subtype)) {
      throw argumentError(`fixlen subtype ${subtype} is reserved (§4.6: 0x0..0x3)`);
    }
    if (subtype === FixlenSubtype.Fp32 || subtype === FixlenSubtype.Fp64) {
      const want = subtype === FixlenSubtype.Fp32 ? 4 : 8;
      if (data.length !== want) {
        throw argumentError(
          `fixlen ${subtype === FixlenSubtype.Fp32 ? "fp32" : "fp64"} payload must be ` +
            `exactly ${want} bytes, got ${data.length}`,
        );
      }
    } else if (data.length > FIXLEN_MAX) {
      throw argumentError(`fixlen length ${data.length} exceeds ${FIXLEN_MAX}`);
    }
    this.fixlenHead(id, data.length, subtype);
    this.writeRaw(data);
  }

  // --- arrays -------------------------------------------------------------

  /** Write an array of unsigned integers (each a varint). */
  writeUnsignedArray(id: number, values: ArrayLike<number | bigint>): void {
    this.arrayHead(id, WireType.ArrayUnsigned, values.length);
    if (this.reserveBulk(values.length * VARINT_MAX_BYTES)) {
      this.pos = this.kernel.encodeUnsignedVarints(values, this.buf, this.pos);
    } else {
      // Streaming (fixed caller buffer): each element is range-checked and
      // split by the same single scratch round-trip the scalar writers use, and
      // the halves are read out before `putVarintLoHi` — which may reach a flush
      // sink, i.e. caller code that can re-enter and overwrite the scratch
      // (bits64).
      for (let i = 0; i < values.length; i++) {
        const v = toBigInt(values[i]!);
        if (!splitU64(v)) throw argumentError(`unsigned value ${v} out of range`);
        const lo = S_U32[LO]!;
        const hi = S_U32[HI]!;
        this.putVarintLoHi(lo, hi);
      }
    }
  }

  /** Write an array of signed integers (each zig-zag + varint). */
  writeSignedArray(id: number, values: ArrayLike<number | bigint>): void {
    this.arrayHead(id, WireType.ArraySigned, values.length);
    if (this.reserveBulk(values.length * VARINT_MAX_BYTES)) {
      this.pos = this.kernel.encodeSignedVarints(values, this.buf, this.pos);
    } else {
      // See writeUnsignedArray: range-check and split in one round-trip, halves
      // out before the write, then zig-zag on the halves rather than in
      // `bigint`.
      for (let i = 0; i < values.length; i++) {
        const v = toBigInt(values[i]!);
        if (!splitI64(v)) throw argumentError(`signed value ${v} out of range`);
        this.putZigzagVarintLoHi(S_U32[LO]!, S_U32[HI]!);
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
    if (this.reserveBulk(values.length * VARINT_MAX_BYTES)) {
      // One contiguous reserve, then a flat loop over a buffer that cannot move.
      let pos = this.pos;
      const buf = this.buf;
      for (let i = 0; i < values.length; i++) {
        const v = values[i]!;
        pos = encodeVarintLoHi(v.low, v.high, buf, pos);
      }
      this.pos = pos;
    } else {
      // Streaming (fixed caller buffer): reserve one element at a time so the
      // sink drains between elements — the whole point of a fixed buffer is that
      // the array may be far larger than it. Reserving the array's worst case
      // (10 bytes × length) as one contiguous run instead made a 64-bit array
      // unstreamable, and threw *after* arrayHead, leaving a header with no
      // payload (corelib-ts#91). The halves come off the caller's Long before
      // the write, since a flush reaches sink code that could re-enter.
      for (let i = 0; i < values.length; i++) {
        const v = values[i]!;
        this.putVarintLoHi(v.low, v.high);
      }
    }
  }

  /**
   * Write a signed 64-bit array (zig-zag) from {@link Long}[] — the `bigint`-free
   * path. Zig-zag `(n << 1) ^ (n >> 63)` is computed on the lo/hi pair.
   */
  writeSignedArrayLong(id: number, values: readonly Long[]): void {
    this.arrayHead(id, WireType.ArraySigned, values.length);
    if (this.reserveBulk(values.length * VARINT_MAX_BYTES)) {
      let pos = this.pos;
      const buf = this.buf;
      for (let i = 0; i < values.length; i++) {
        const v = values[i]!;
        pos = encodeZigzagVarintLoHi(v.low, v.high, buf, pos);
      }
      this.pos = pos;
    } else {
      // See writeUnsignedArrayLong: one element at a time so the sink drains
      // between them, halves read out before a flush can re-enter.
      for (let i = 0; i < values.length; i++) {
        const v = values[i]!;
        this.putZigzagVarintLoHi(v.low, v.high);
      }
    }
  }

  /** Write an array of IEEE-754 32-bit floats. */
  writeFp32Array(id: number, values: ArrayLike<number>): void {
    this.arrayHead(id, WireType.ArrayFixlen, values.length);
    // A fixlen array always carries its fixlen_word — even when empty (§4.8) —
    // so an empty fp32 array stays distinct from an empty fp64 one. The payload
    // loop below simply runs zero times: the field is [ header ][ count = 0 ]
    // [ fixlen_word ] with no elements.
    this.putVarintNum(4 * 8 + FixlenSubtype.Fp32);
    if (this.reserveBulk(values.length * 4)) {
      this.pos = this.kernel.packFp32Array(values, this.buf, this.pos);
    } else {
      for (let i = 0; i < values.length; i++) this.putFp32(values[i]!);
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
    if (this.reserveBulk(values.length * 8)) {
      this.pos = this.kernel.packFp64Array(values, this.buf, this.pos);
    } else {
      for (let i = 0; i < values.length; i++) this.putFp64(values[i]!);
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
    // The run covers the full MAX_DEPTH (see `pending`), so it is *always* a
    // contiguous suffix of the open sequences and every sequence stays canonical
    // however deep it nests — what CORELIB_PLAN §6.0.1 ("How deep the hold-back
    // reaches") requires. No eager-framing fallback, and no allocation.
    this.pending[this.nPending++] = id;
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
    if (this.tryEnsure(varintSizeNum(value))) {
      this.pos = encodeVarintNum(value, this.buf, this.pos);
      return;
    }
    // Buffer too small for the whole varint: emit it a byte at a time, draining
    // the sink in between (§5.1). The `% 128` form covers the full 0 .. 2^53
    // domain, unlike the bitwise loop `encodeVarintNum` uses below 2^32.
    while (value > 0x7f) {
      this.putByte((value % 128) | 0x80);
      value = Math.floor(value / 128);
    }
    this.putByte(value);
  }

  /**
   * Write a 64-bit value, held as two 32-bit halves, as a varint.
   *
   * Deliberately just a bounds check and two calls: this is what the array
   * loops call per element, and it only pays its way while it is small enough
   * for the JIT to inline. Spelling the drain case out here instead — three
   * more lines — cost 16-19% on an array streamed through a 32/64-byte buffer,
   * where most elements take the fast path and want it inlined.
   */
  private putVarintLoHi(lo: number, hi: number): void {
    if (this.buf.length - this.pos >= VARINT_MAX_BYTES) {
      this.pos = encodeVarintLoHi(lo, hi, this.buf, this.pos);
      return;
    }
    this.putVarintLoHiSlow(lo, hi);
  }

  /**
   * A full buffer that is nonetheless wide enough to hold any varint: drain it
   * and retry the worst case, which is exactly what `ensure(VARINT_MAX_BYTES)`
   * did before §5.1 and is still the common streaming case. Sizing the value
   * first instead — the narrow-buffer path in {@link putVarintLoHiTight} — cost
   * +125 instructions on every element of an array streamed through a
   * one-element-wide buffer.
   */
  private putVarintLoHiSlow(lo: number, hi: number): void {
    if (this.buf.length - this.start >= VARINT_MAX_BYTES) {
      this.flush();
      if (this.buf.length - this.pos >= VARINT_MAX_BYTES) {
        this.pos = encodeVarintLoHi(lo, hi, this.buf, this.pos);
        return;
      }
    }
    this.putVarintLoHiTight(lo, hi);
  }

  /**
   * Zig-zag {@link putVarintLoHi}: `(n << 1) ^ (n >> 63)` on the halves. Keeps
   * its own worst-case fast path so the signed array loop reaches the combined
   * zig-zag-and-encode writer directly, exactly as it did before; the drain and
   * narrow-buffer cases are the same for both signs, so they are shared.
   */
  private putZigzagVarintLoHi(lo: number, hi: number): void {
    if (this.buf.length - this.pos >= VARINT_MAX_BYTES) {
      this.pos = encodeZigzagVarintLoHi(lo, hi, this.buf, this.pos);
      return;
    }
    const sgn = -(hi >>> 31) >>> 0;
    this.putVarintLoHi(
      (((lo << 1) >>> 0) ^ sgn) >>> 0,
      ((((hi << 1) | (lo >>> 31)) >>> 0) ^ sgn) >>> 0,
    );
  }

  /**
   * The narrow-buffer tail of {@link putVarintLoHi}: the buffer could not hold a
   * worst-case varint even empty. Sizing the value exactly keeps such a buffer
   * from flushing for room it does not need; only when it cannot hold the varint
   * *at all* does the value get split across flushes, seven bits at a time.
   */
  private putVarintLoHiTight(lo: number, hi: number): void {
    lo >>>= 0;
    hi >>>= 0;
    if (this.tryEnsure(varintSizeLoHi(lo, hi))) {
      this.pos = encodeVarintLoHi(lo, hi, this.buf, this.pos);
      return;
    }
    for (;;) {
      const more = hi !== 0 || lo > 0x7f;
      this.putByte(more ? (lo & 0x7f) | 0x80 : lo);
      if (!more) return;
      lo = ((lo >>> 7) | (hi << 25)) >>> 0;
      hi >>>= 7;
    }
  }

  /**
   * Write the 4 little-endian bytes of an fp32 (§4.6).
   *
   * Through the shared scratch, not a `DataView` over the buffer: building that
   * handle costs ~129 ns against the ~2 ns it saves on one value (§6.6.2 allows the
   * handle, arithmetic forbids it here). The bulk array path amortizes one over the
   * whole run instead — see the kernel.
   */
  private putFp32(value: number): void {
    if (this.buf.length - this.pos >= 4) {
      this.pos = packFp32(this.buf, this.pos, value);
      return;
    }
    this.putFp32Slow(value);
  }

  private putFp32Slow(value: number): void {
    if (this.tryEnsure(4)) {
      this.pos = packFp32(this.buf, this.pos, value);
      return;
    }
    // The bytes live in a local word rather than a scratch array, so a flush
    // sink that re-enters the encoder between them cannot overwrite the tail.
    this.putFp32Bits(fp32Bits(value));
  }

  /**
   * Write the 4 little-endian bytes of an fp32 held as a 32-bit word (§4.6) — the
   * path {@link OStream.writeFp32Bits} takes, and the tail of
   * {@link OStream.putFp32Slow}.
   */
  private putFp32Bits(bits: number): void {
    if (this.buf.length - this.pos >= 4) {
      const buf = this.buf;
      let p = this.pos;
      buf[p++] = bits & 0xff;
      buf[p++] = (bits >>> 8) & 0xff;
      buf[p++] = (bits >>> 16) & 0xff;
      buf[p++] = bits >>> 24;
      this.pos = p;
      return;
    }
    // Too narrow for four contiguous bytes: split across flushes, byte by byte
    // (this port declares MIN_OUTPUT_BUFFER = 1, so it splits atomic units too).
    this.putByte(bits & 0xff);
    this.putByte((bits >>> 8) & 0xff);
    this.putByte((bits >>> 16) & 0xff);
    this.putByte(bits >>> 24);
  }

  /** Write the 8 little-endian bytes of an fp64 (§4.6) — see {@link putFp32}. */
  private putFp64(value: number): void {
    if (this.buf.length - this.pos >= 8) {
      this.pos = packFp64(this.buf, this.pos, value);
      return;
    }
    this.putFp64Slow(value);
  }

  private putFp64Slow(value: number): void {
    if (this.tryEnsure(8)) {
      this.pos = packFp64(this.buf, this.pos, value);
      return;
    }
    // Both halves are read out *before* the first byte goes out, for the reason
    // in putFp32Slow: a flush between them reaches re-entrant caller code.
    const lo = fp64BitsLo(value);
    const hi = fp64BitsHi(value);
    this.putByte(lo & 0xff);
    this.putByte((lo >>> 8) & 0xff);
    this.putByte((lo >>> 16) & 0xff);
    this.putByte(lo >>> 24);
    this.putByte(hi & 0xff);
    this.putByte((hi >>> 8) & 0xff);
    this.putByte((hi >>> 16) & 0xff);
    this.putByte(hi >>> 24);
  }

  /**
   * Append one byte, draining to the sink first when the buffer is full.
   *
   * @internal Public only because {@link utf8WriteSink} writes through it — the
   * narrow-buffer string path (§5.1.3). Not part of the field-writing API.
   */
  putByte(b: number): void {
    if (this.pos === this.buf.length) this.ensureSome(1);
    this.buf[this.pos++] = b;
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
    const pending = this.pending;
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

  /**
   * Copy `data` out, flushing/growing as needed (large payloads stay chunked).
   *
   * The whole-payload case — the common one, and the only one on a buffer sized
   * from `MAX_SIZE` or on the accumulator — is a single `set` of the caller's
   * array: a `memcpy`, and no view at all.
   *
   * **A payload split across flushes takes a per-piece view: a language-forced
   * handle under CORELIB_PLAN §6.6.2.** `TypedArray.set` is the only `memcpy`
   * this language exposes and it takes a *typed array* as its source, so copying a
   * *range* of one needs a `subarray` — §6.6.2's "the only way to name a region of
   * the caller's buffer is a wrapper over it". It has the two properties that
   * clause requires: it carries no message bytes (the storage is the caller's, on
   * both ends) and no wire number sizes it (a handle over a thousand bytes costs
   * what a handle over ten costs). The allocation-free alternative is a byte loop,
   * measured at 358 MB/s against 10,963 MB/s for `set`.
   *
   * It never leaves this method: `set` consumes it and no caller can reach it, so
   * §6.7's ban on exposing a value that outlives its callback is untouched — and so
   * is §5.1.6, which is why the copy happens at all rather than the payload being
   * handed to the sink. §6.6.2 asks the port to make such handles visible rather
   * than invisible: the README itemises it (§9.6) and `heap-free-codec.test.ts`
   * pins its count and kind.
   */
  private writeRaw(data: Uint8Array): void {
    const total = data.length;
    let off = 0;
    while (off < total) {
      const room = this.ensureSome(total - off);
      if (off === 0 && room === total) {
        this.buf.set(data, this.pos);
      } else {
        this.buf.set(data.subarray(off, off + room), this.pos);
      }
      this.pos += room;
      off += room;
    }
  }

  /**
   * Make room for `n` contiguous bytes at `pos` if the buffer can hold them at
   * all: `true` when it can (flushing or growing as needed), `false` when a
   * fixed caller buffer is simply smaller than `n` and the value must be split
   * across flushes instead — CORELIB_PLAN §5.1 puts the floor on the output
   * buffer at a single byte, so no write may demand a contiguous run.
   *
   * The one case that still fails is a buffer with no sink to drain to: there is
   * nowhere for a split to put the earlier bytes, so it reports BufferFull here,
   * before anything is written, exactly as {@link ensure} did.
   */
  private tryEnsure(n: number): boolean {
    if (this.buf.length - this.pos >= n) return true;
    this.drain(n);
    if (this.buf.length - this.pos >= n) return true;
    if (this.flushSink === undefined) {
      throw bufferFullError(
        `output buffer full: need ${n} more bytes, have ${this.buf.length - this.pos}`,
      );
    }
    return false;
  }

  /**
   * Reserve `n` contiguous bytes for a bulk write — the whole payload of an
   * array or a string, written in one pass into a buffer that cannot move under
   * it. Every caller has an element-at-a-time route to fall back on when this
   * says no, producing the identical bytes, so a `false` here is never an error.
   *
   * The room already at the cursor counts on **any** buffer, which is what makes
   * the one-shot `new OStream(buf)` case — a caller buffer sized from the
   * schema's `MAX_SIZE`, the shape CORELIB_PLAN §5.1 puts first — the fast one:
   * without it a message encoded into a caller's own buffer took `TextEncoder`
   * for every string and the element loop for every array, measured at 1.9 µs
   * against 0.16 µs for the same five-field message.
   *
   * Beyond that room only a **sink** may be asked, and only by draining. Emptying
   * the buffer is the one thing that can produce room without an allocation
   * anywhere (§6.6), and it is legal wherever this is called — every caller has
   * just written a complete header, so the cursor is on a boundary between atomic
   * units (§5.1.3). A sink that installs a larger replacement (§5.1.5) therefore
   * re-opens the bulk route by itself, which is how the accumulating helper keeps
   * it. Nothing is *demanded*: a `false` sends the caller down its
   * element-at-a-time route, which produces the identical bytes, so a fixed
   * buffer too narrow for the worst case never turns into a spurious
   * `BUFFER_FULL`.
   */
  private reserveBulk(n: number): boolean {
    if (this.buf.length - this.pos >= n) return true;
    if (this.flushSink === undefined) return false;
    this.drain(n);
    return this.buf.length - this.pos >= n;
  }

  /**
   * Ensure `n` contiguous bytes are free at `pos`; returns `pos` for chaining.
   *
   * The only remaining caller is the one-byte sequence-end marker, which is
   * indivisible: there is no smaller piece to split it into, so a buffer that
   * cannot take it has nothing left to report but `BUFFER_FULL`.
   */
  private ensure(n: number): number {
    if (!this.tryEnsure(n)) {
      throw bufferFullError(
        `output buffer full: need ${n} more bytes, have ${this.buf.length - this.pos}`,
      );
    }
    return this.pos;
  }

  /** Ensure *some* room (up to `want`); returns how many bytes are available. */
  private ensureSome(want: number): number {
    let room = this.buf.length - this.pos;
    if (room === 0) {
      this.flush();
      room = this.buf.length - this.pos;
      if (room === 0) throw bufferFullError("output buffer full");
    }
    return Math.min(room, want);
  }
}
