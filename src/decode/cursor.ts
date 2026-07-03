/**
 * The pull / cursor decoder: a monomorphic companion to {@link "./fast"}.
 *
 * {@link "./fast"}'s {@link decodeContiguous} is a *push* decoder — it drives the
 * buffer and calls a {@link Visitor} method per field. That is the right shape
 * for streaming and skip-subtree callers, but the visitor call sites go
 * megamorphic once a single decode routes through several differently-shaped
 * visitor objects (one per nested message type), which a JIT cannot inline.
 *
 * {@link Cursor} inverts control: it keeps one read cursor over the contiguous
 * {@link Uint8Array} and exposes *pull* primitives — {@link Cursor.readHeader}
 * plus a typed `read*` per wire type — so **generated code drives the loop** with
 * a single `switch (cursor.id)` that reads straight into its own fields. Every
 * call site is then monomorphic (the generated per-type decoder is the only
 * caller), which is what lets V8 inline the whole decode into a flat loop — the
 * same technique protobuf's generated `decode(reader)` uses.
 *
 * It shares {@link "./fast"}'s number-first varint core verbatim: each varint is
 * accumulated into two 32-bit JS *numbers* (`lo`/`hi`) and a `bigint` is
 * materialised only for a 64-bit *value* that does not fit in `2^53-1` (never for
 * ids, lengths or counts). String / blob payloads are returned as a single
 * zero-copy `subarray` view. Malformed input throws the same
 * {@link SofabError} (`INVALID_MSG`) as the push path.
 */

import {
  ARRAY_MAX,
  FIXLEN_MAX,
  FixlenSubtype,
  ID_MAX,
  WireType,
} from "../constants.js";
import { invalidMsgError } from "../errors.js";
import { zigzagDecode } from "../varint/zigzag.js";

const TWO32 = 0x1_0000_0000; // 2^32, for combining the 32-bit halves
const _utf8 = new TextDecoder();

/**
 * A pull decoder over a complete message held in one contiguous buffer.
 *
 * Usage from generated code: loop on {@link readHeader}; for each field switch on
 * {@link id} and call the matching `read*` (which consumes that field's value and
 * advances the cursor); recurse into a child type's decoder on a nested sequence;
 * fall through to {@link skip} for an unknown id. See {@link readHeader}.
 */
export class Cursor {
  /** Field id of the header last accepted by {@link readHeader}. */
  id = 0;
  /** Wire type of the header last accepted by {@link readHeader}. */
  wire = 0;

  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private readonly n: number;
  private p = 0;

  // Last varint, as two unsigned 32-bit halves (see readVarint).
  private lo = 0;
  private hi = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.n = buf.length;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.length);
  }

  /**
   * Advance to the next field header. Returns `true` and sets {@link id} /
   * {@link wire} when a field follows; returns `false` — consuming the marker —
   * at the end of the buffer *or* at the sequence-end that closes the sequence
   * this decoder is reading. So a generated per-type decoder loops uniformly:
   *
   * ```ts
   * while (c.readHeader()) {
   *   switch (c.id) {
   *     case 4: this.u32 = Number(c.readUnsigned()); break;
   *     case 10: this.child = Child.decodeFrom(c); break; // nested sequence
   *     default: c.skip(c.wire); break;                   // unknown field
   *   }
   * }
   * ```
   *
   * At the root the loop ends at end-of-buffer; inside a nested sequence it ends
   * at the matching {@link WireType.SequenceEnd} (which is consumed). A field
   * whose id is out of range throws {@link SofabError} (`INVALID_MSG`).
   */
  readHeader(): boolean {
    if (this.p >= this.n) return false;
    this.readVarint();
    const wire = this.lo & 7;
    if (wire === WireType.SequenceEnd) return false;
    const id = this.upper();
    if (id > ID_MAX) throw invalidMsgError(`field id ${id} out of range`);
    this.id = id;
    this.wire = wire;
    return true;
  }

  /** Read an unsigned scalar (wire {@link WireType.Unsigned}), number-first. */
  readUnsigned(): number | bigint {
    this.readVarint();
    return this.unsignedValue();
  }

  /** Read a signed scalar (wire {@link WireType.Signed}), zig-zag, number-first. */
  readSigned(): number | bigint {
    this.readVarint();
    return this.signedValue();
  }

  /** Read a 32-bit float scalar (wire {@link WireType.Fixlen}, subtype fp32). */
  readFp32(): number {
    this.fixlenHeader(FixlenSubtype.Fp32, 4);
    return this.rawFp32();
  }

  /** Read a 64-bit float scalar (wire {@link WireType.Fixlen}, subtype fp64). */
  readFp64(): number {
    this.fixlenHeader(FixlenSubtype.Fp64, 8);
    return this.rawFp64();
  }

  /** Read a UTF-8 string scalar (wire {@link WireType.Fixlen}, subtype string). */
  readString(): string {
    const len = this.fixlenLen(FixlenSubtype.String);
    return _utf8.decode(this.take(len));
  }

  /**
   * Read a blob scalar (wire {@link WireType.Fixlen}, subtype blob) as a
   * zero-copy {@link Uint8Array} view into the source buffer.
   */
  readBlob(): Uint8Array {
    const len = this.fixlenLen(FixlenSubtype.Blob);
    return this.take(len);
  }

  /** Read an unsigned array (wire {@link WireType.ArrayUnsigned}), number-first per element. */
  readUnsignedArray(): (number | bigint)[] {
    const count = this.arrayCount();
    const out: (number | bigint)[] = new Array(count);
    for (let i = 0; i < count; i++) {
      this.readVarint();
      out[i] = this.unsignedValue();
    }
    return out;
  }

  /** Read a signed array (wire {@link WireType.ArraySigned}), zig-zag, number-first per element. */
  readSignedArray(): (number | bigint)[] {
    const count = this.arrayCount();
    const out: (number | bigint)[] = new Array(count);
    for (let i = 0; i < count; i++) {
      this.readVarint();
      out[i] = this.signedValue();
    }
    return out;
  }

  /** Read an fp32 array (wire {@link WireType.ArrayFixlen}, element subtype fp32). */
  readFp32Array(): number[] {
    const count = this.arrayFixlenHeader(FixlenSubtype.Fp32, 4);
    const out: number[] = new Array(count);
    for (let i = 0; i < count; i++) out[i] = this.rawFp32();
    return out;
  }

  /** Read an fp64 array (wire {@link WireType.ArrayFixlen}, element subtype fp64). */
  readFp64Array(): number[] {
    const count = this.arrayFixlenHeader(FixlenSubtype.Fp64, 8);
    const out: number[] = new Array(count);
    for (let i = 0; i < count; i++) out[i] = this.rawFp64();
    return out;
  }

  /**
   * Consume the value of the field whose header {@link readHeader} just accepted,
   * discarding it — for a `default:` branch that keeps the cursor in sync on an
   * unknown id. Pass {@link wire}. A {@link WireType.SequenceStart} skips the
   * whole nested sequence.
   */
  skip(wire: number): void {
    if (wire === WireType.SequenceStart) {
      this.skipSequence();
      return;
    }
    this.skipValue(wire);
  }

  // --- value skipping -----------------------------------------------------

  private skipValue(wire: number): void {
    switch (wire) {
      case WireType.Unsigned:
      case WireType.Signed:
        this.readVarint();
        return;
      case WireType.Fixlen: {
        this.readVarint();
        const len = this.upper();
        if (len > FIXLEN_MAX) throw invalidMsgError("fixlen length out of range");
        this.take(len);
        return;
      }
      case WireType.ArrayUnsigned:
      case WireType.ArraySigned: {
        const count = this.arrayCount();
        for (let i = 0; i < count; i++) this.readVarint();
        return;
      }
      case WireType.ArrayFixlen: {
        const count = this.arrayCount();
        this.readVarint();
        const size = this.upper();
        this.take(count * size);
        return;
      }
      default:
        throw invalidMsgError(`invalid wire type ${wire}`);
    }
  }

  private skipSequence(): void {
    let depth = 1;
    while (depth > 0) {
      if (this.p >= this.n) throw invalidMsgError("truncated message: unbalanced sequence");
      this.readVarint();
      const wire = this.lo & 7;
      if (wire === WireType.SequenceEnd) {
        depth--;
        continue;
      }
      const id = this.upper();
      if (id > ID_MAX) throw invalidMsgError(`field id ${id} out of range`);
      if (wire === WireType.SequenceStart) depth++;
      else this.skipValue(wire);
    }
  }

  // --- field helpers ------------------------------------------------------

  /** Read and validate an array count word (0..ARRAY_MAX; §4.7/§4.8). */
  private arrayCount(): number {
    this.readVarint();
    const count = this.num();
    if (count > ARRAY_MAX) throw invalidMsgError("array count out of range");
    return count;
  }

  /** Read a scalar fixlen sub-header, asserting subtype and exact byte length (floats). */
  private fixlenHeader(wantSub: number, wantLen: number): void {
    this.readVarint();
    const sub = this.lo & 7;
    const len = this.upper();
    if (sub !== wantSub) throw invalidMsgError(`invalid fixlen subtype ${sub}`);
    if (len !== wantLen) throw invalidMsgError("fixlen float length mismatch");
  }

  /** Read a scalar fixlen sub-header for a string/blob, asserting subtype; returns byte length. */
  private fixlenLen(wantSub: number): number {
    this.readVarint();
    const sub = this.lo & 7;
    const len = this.upper();
    if (sub !== wantSub) throw invalidMsgError(`invalid fixlen subtype ${sub}`);
    if (len > FIXLEN_MAX) throw invalidMsgError("fixlen length out of range");
    return len;
  }

  /** Read an array fixlen element header (count + element type); returns the count. */
  private arrayFixlenHeader(wantSub: number, wantSize: number): number {
    // §4.8: a fixlen array always carries its element-length word — even when
    // empty — so the element kind stays known. count may then be 0.
    const count = this.arrayCount();
    this.readVarint();
    const sub = this.lo & 7;
    const size = this.upper();
    if (sub !== wantSub || size !== wantSize) {
      throw invalidMsgError("invalid fixlen array element type");
    }
    return count;
  }

  /** Hand back a zero-copy view of the next `len` bytes, advancing the cursor. */
  private take(len: number): Uint8Array {
    const start = this.p;
    const end = start + len;
    if (end > this.n) throw invalidMsgError("truncated fixlen payload");
    this.p = end;
    return this.buf.subarray(start, end);
  }

  private rawFp32(): number {
    const p = this.p;
    if (p + 4 > this.n) throw invalidMsgError("truncated fp32");
    this.p = p + 4;
    return this.view.getFloat32(p, true);
  }

  private rawFp64(): number {
    const p = this.p;
    if (p + 8 > this.n) throw invalidMsgError("truncated fp64");
    this.p = p + 8;
    return this.view.getFloat64(p, true);
  }

  // --- varint reading (shared verbatim with ./fast) -----------------------

  /**
   * The last varint's full value as a `bigint` (64-bit fidelity). Only ever
   * called from {@link unsignedValue} / {@link signedValue} on the `hi` overflow
   * path (`this.hi >>> 0 > 0x1fffff`), so `hi` is always non-zero here.
   */
  private big(): bigint {
    return (BigInt(this.hi >>> 0) << 32n) | BigInt(this.lo >>> 0);
  }

  /**
   * The last varint as an unsigned value, number-first: a `number` when it fits
   * exactly (`≤ 2^53-1`), a `bigint` only beyond that.
   */
  private unsignedValue(): number | bigint {
    const hi = this.hi >>> 0;
    return hi <= 0x1fffff ? hi * TWO32 + (this.lo >>> 0) : this.big();
  }

  /** The last zig-zag varint as a signed value, number-first. */
  private signedValue(): number | bigint {
    const hi = this.hi >>> 0;
    if (hi <= 0x1fffff) {
      const r = hi * TWO32 + (this.lo >>> 0); // raw zig-zag, ≤ 2^53-1
      return r % 2 === 0 ? r / 2 : -(r + 1) / 2;
    }
    return zigzagDecode(this.big());
  }

  /** The last varint's value as a JS number — exact for ids/lengths/counts. */
  private num(): number {
    return this.hi * TWO32 + (this.lo >>> 0);
  }

  /** The last varint with its low 3 tag bits stripped (`value >> 3`). */
  private upper(): number {
    return (this.hi >>> 0) * (TWO32 / 8) + (this.lo >>> 3);
  }

  /**
   * Decode one LEB128 varint at the cursor into {@link lo} / {@link hi} (each an
   * unsigned 32-bit half), advancing {@link p}. Throws on truncation or a value
   * spilling past 64 bits (>10 bytes). Unrolled, number-only — no `bigint`.
   */
  private readVarint(): void {
    const buf = this.buf;
    const n = this.n;
    let p = this.p;
    let b: number;
    let lo: number;
    let hi = 0;

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    lo = b & 0x7f;
    if (b < 0x80) return this.set(lo, 0, p);

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    lo |= (b & 0x7f) << 7;
    if (b < 0x80) return this.set(lo, 0, p);

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    lo |= (b & 0x7f) << 14;
    if (b < 0x80) return this.set(lo, 0, p);

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    lo |= (b & 0x7f) << 21;
    if (b < 0x80) return this.set(lo, 0, p);

    // 5th byte straddles the 32-bit boundary: 4 bits to lo, 3 bits to hi.
    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    lo |= (b & 0x0f) << 28;
    hi = (b >> 4) & 0x07;
    if (b < 0x80) return this.set(lo, hi, p);

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    hi |= (b & 0x7f) << 3;
    if (b < 0x80) return this.set(lo, hi, p);

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    hi |= (b & 0x7f) << 10;
    if (b < 0x80) return this.set(lo, hi, p);

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    hi |= (b & 0x7f) << 17;
    if (b < 0x80) return this.set(lo, hi, p);

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    hi |= (b & 0x7f) << 24;
    if (b < 0x80) return this.set(lo, hi, p);

    // 10th byte: only bit 63 remains; any continuation here is a >64-bit overflow.
    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    hi |= (b & 0x7f) << 31;
    if (b < 0x80) return this.set(lo, hi, p);

    throw invalidMsgError("varint overflow");
  }

  private set(lo: number, hi: number, p: number): void {
    this.lo = lo;
    this.hi = hi;
    this.p = p;
  }
}
