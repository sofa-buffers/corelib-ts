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
  usageError,
} from "../errors.js";
import {
  getKernel,
  type Kernel,
} from "../backend/kernel.js";
import { encodeVarint, encodeVarintNum, varintSize, varintSizeNum } from "../varint/leb128.js";
import { inI64, inU64, packFp32, packFp64, toBigInt } from "../varint/num64.js";
import { zigzagEncode } from "../varint/zigzag.js";
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
    if (!inU64(v)) throw argumentError(`unsigned value ${v} out of 64-bit range`);
    this.header(id, WireType.Unsigned);
    this.putVarint(v);
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
    if (!inI64(v)) throw argumentError(`signed value ${v} out of 64-bit range`);
    this.header(id, WireType.Signed);
    this.putVarint(zigzagEncode(v));
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
      for (let i = 0; i < values.length; i++) {
        const v = toBigInt(values[i]!);
        if (!inU64(v)) throw argumentError(`unsigned value ${v} out of range`);
        this.ensure(VARINT_MAX_BYTES);
        this.pos = encodeVarint(v, this.buf, this.pos);
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
      for (let i = 0; i < values.length; i++) {
        const v = toBigInt(values[i]!);
        if (!inI64(v)) throw argumentError(`signed value ${v} out of range`);
        this.ensure(VARINT_MAX_BYTES);
        this.pos = encodeVarint(zigzagEncode(v), this.buf, this.pos);
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

  /** Open a nested sequence (a fresh id scope). */
  writeSequenceBegin(id: number): void {
    // §4.9/§6.2: refuse to open more than MAX_DEPTH nested sequences.
    if (this.depth >= MAX_DEPTH) {
      throw usageError(`nesting exceeds MAX_DEPTH (${MAX_DEPTH})`);
    }
    this.header(id, WireType.SequenceStart);
    this.depth++;
  }

  /** Close the current sequence. */
  writeSequenceEnd(): void {
    if (this.depth <= 0) throw usageError("sequence end without matching begin");
    this.ensure(1);
    this.buf[this.pos++] = WireType.SequenceEnd; // id 0, type 7 -> byte 0x07
    this.depth--;
  }

  // --- internals ----------------------------------------------------------

  /** Ensure exactly `value`'s varint size, then write it (bigint path). */
  private putVarint(value: bigint): void {
    this.ensure(varintSize(value));
    this.pos = encodeVarint(value, this.buf, this.pos);
  }

  /** Ensure exactly `value`'s varint size, then write it (number fast path). */
  private putVarintNum(value: number): void {
    this.ensure(varintSizeNum(value));
    this.pos = encodeVarintNum(value, this.buf, this.pos);
  }

  private header(id: number, type: WireType): void {
    if (id < 0 || id > ID_MAX || !Number.isInteger(id)) {
      throw argumentError(`field id ${id} out of range 0..${ID_MAX}`);
    }
    // (id << 3) | type as a number: id ≤ 2^31-1, so the word stays ≤ 2^34.
    this.putVarintNum(id * 8 + type);
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
