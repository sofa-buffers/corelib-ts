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
 * zero-copy `subarray` view. It reports the same three-valued outcome as the
 * push path (MESSAGE_SPEC §7): malformed input throws a {@link SofabError} with
 * code `INVALID_MSG`, and a read that runs off the end of the buffer mid-field
 * throws `INCOMPLETE`.
 */

import {
  ARRAY_MAX,
  FIXLEN_MAX,
  FixlenSubtype,
  ID_MAX,
  WireType,
} from "../constants.js";
import {
  incompleteError,
  invalidMsgError,
  limitExceededError,
} from "../errors.js";
import { Long } from "../long.js";
import { zigzagDecode } from "../varint/zigzag.js";
import type { DecodeLimits } from "./limits.js";

const TWO32 = 0x1_0000_0000; // 2^32, for combining the 32-bit halves
// Strict UTF-8 (MESSAGE_SPEC §8, CORELIB_PLAN §6.4): JavaScript strings are a
// Unicode string type, so this target is always strict — the decoder builds the
// string with the fatal TextDecoder, which throws on any invalid-UTF-8 payload
// (overlong forms, surrogate code points, out-of-range, truncated or stray
// bytes) rather than silently substituting U+FFFD. readString maps that throw to
// the INVALID decode outcome. A lossy decoder is never used.
const _utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A pull decoder over a complete message held in one contiguous buffer.
 *
 * Usage from generated code: loop on {@link readHeader}; for each field switch on
 * {@link id} and call the matching `read*` (which consumes that field's value and
 * advances the cursor); recurse into a child type's decoder on a nested sequence;
 * fall through to {@link skip} for an unknown id. See {@link readHeader}.
 *
 * Pass {@link DecodeLimits} to cap array counts and string / blob lengths; an
 * over-limit field throws {@link SofabError} (`LIMIT_EXCEEDED`) at its header,
 * before it is materialized. Omit for no caps (the default).
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

  // Opt-in decode limits (corelib-ts#38). An unset limit is Infinity — no cap,
  // today's behavior. Enforced at the count / length header, before allocation.
  private readonly maxArrayCount: number;
  private readonly maxStringLen: number;
  private readonly maxBlobLen: number;

  // Last varint, as two unsigned 32-bit halves (see readVarint).
  private lo = 0;
  private hi = 0;

  // Number of nested sequences currently open (0 = root). Incremented when
  // readHeader accepts a SequenceStart, decremented when it consumes the matching
  // SequenceEnd (or when skip() discards a whole nested sequence). Lets the pull
  // parser tell a root-level dangling sequence-end (INVALID) and an unclosed
  // sequence at end-of-buffer (INCOMPLETE) apart from a clean boundary.
  private depth = 0;

  constructor(buf: Uint8Array, limits?: DecodeLimits) {
    this.buf = buf;
    this.n = buf.length;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.length);
    this.maxArrayCount = limits?.maxArrayCount ?? Infinity;
    this.maxStringLen = limits?.maxStringLen ?? Infinity;
    this.maxBlobLen = limits?.maxBlobLen ?? Infinity;
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
    if (this.p >= this.n) {
      // End of buffer. At the root (depth 0) this is a clean, complete boundary;
      // inside an open sequence it is a truncated, unclosed sequence → INCOMPLETE
      // (§7), matching the fast path (fast.ts) which throws on `stack.length > 1`.
      if (this.depth > 0) {
        throw incompleteError("truncated message: unbalanced sequence");
      }
      return false;
    }
    this.readVarint();
    const wire = this.lo & 7;
    if (wire === WireType.SequenceEnd) {
      // A sequence-end closes the current nested scope. At the root (depth 0)
      // there is no open sequence to close, so it is a dangling marker → INVALID
      // (mirrors fast.ts `stack.length <= 1` → "unbalanced sequence end").
      if (this.depth === 0) {
        throw invalidMsgError("unbalanced sequence end");
      }
      this.depth--;
      return false;
    }
    const id = this.upper();
    if (id > ID_MAX) throw invalidMsgError(`field id ${id} out of range`);
    if (wire === WireType.SequenceStart) this.depth++;
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
    // take() (truncation → INCOMPLETE) runs before the decode, so a short
    // payload stays INCOMPLETE; only genuinely malformed UTF-8 bytes reach the
    // fatal decoder. Its TypeError becomes the INVALID outcome (§8/§6.4/§5.2).
    const bytes = this.take(len);
    try {
      return _utf8.decode(bytes);
    } catch {
      throw invalidMsgError("invalid UTF-8 in string");
    }
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

  /**
   * Read an unsigned 64-bit array into {@link Long}[] — the `bigint`-free path.
   * Each element keeps the raw lo/hi halves; call {@link Long.toBigInt} to
   * materialise only the values the caller actually needs.
   */
  readUnsignedArrayLong(): Long[] {
    const count = this.arrayCount();
    const out = new Array<Long>(count);
    for (let i = 0; i < count; i++) {
      this.readVarint();
      out[i] = new Long(this.lo, this.hi);
    }
    return out;
  }

  /** Read a signed 64-bit array (zig-zag) into {@link Long}[] — the `bigint`-free path. */
  readSignedArrayLong(): Long[] {
    const count = this.arrayCount();
    const out = new Array<Long>(count);
    for (let i = 0; i < count; i++) {
      this.readVarint();
      const lo = this.lo >>> 0;
      const hi = this.hi >>> 0;
      const mask = (-(lo & 1)) >>> 0; // all ones when the zig-zag lsb is set
      out[i] = new Long((((lo >>> 1) | (hi << 31)) >>> 0) ^ mask, ((hi >>> 1) >>> 0) ^ mask);
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
      // readHeader already counted this SequenceStart (depth++); skipSequence
      // consumes its whole balanced body incl. the matching end without going
      // through readHeader, so balance the count here.
      this.skipSequence();
      this.depth--;
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
        const sub = this.lo & 7;
        const len = this.upper();
        // §4.6/§5.2: validate the fixlen word at the header, before the payload,
        // so a malformed word — a reserved subtype (0x4..0x7), or an fp32/fp64
        // whose declared length ≠ 4/8 — is INVALID even when the payload is also
        // truncated (INVALID takes precedence over INCOMPLETE). Mirrors the
        // known-field path ({@link fixlenHeader}) and fast.ts. A skip never
        // materializes the value, so string/blob keep only the len ≤ FIXLEN_MAX
        // bound — no opt-in length limit is enforced here (corelib-ts#49).
        if (sub > FixlenSubtype.Blob) throw invalidMsgError(`invalid fixlen subtype ${sub}`);
        if (sub === FixlenSubtype.Fp32 || sub === FixlenSubtype.Fp64) {
          if (len !== (sub === FixlenSubtype.Fp32 ? 4 : 8)) {
            throw invalidMsgError("fixlen float length mismatch");
          }
        } else if (len > FIXLEN_MAX) {
          throw invalidMsgError("fixlen length out of range");
        }
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
        // Read count and the element word, then validate the element type at the
        // header before taking the payload — a fixlen array carries only fp32
        // (size 4) or fp64 (size 8) elements (§4.8), so any other element word is
        // INVALID even when the payload is truncated (§5.2 precedence). This
        // deliberately does NOT use {@link arrayCount}'s count ≤ remaining-bytes
        // guard: that guard exists to bound allocation on the read paths, but the
        // skip path allocates nothing, and applying it here would report a
        // malformed-element array as INCOMPLETE instead of INVALID (corelib-ts#49).
        this.readVarint();
        const count = this.num();
        if (count > ARRAY_MAX) throw invalidMsgError("array count out of range");
        if (count > this.maxArrayCount) {
          throw limitExceededError(
            `array count ${count} exceeds maxArrayCount ${this.maxArrayCount}`,
          );
        }
        this.readVarint();
        const sub = this.lo & 7;
        const size = this.upper();
        const ok =
          (sub === FixlenSubtype.Fp32 && size === 4) ||
          (sub === FixlenSubtype.Fp64 && size === 8);
        if (!ok) throw invalidMsgError("invalid fixlen array element type");
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
      if (this.p >= this.n) throw incompleteError("truncated message: unbalanced sequence");
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
    if (count > this.maxArrayCount) {
      throw limitExceededError(
        `array count ${count} exceeds maxArrayCount ${this.maxArrayCount}`,
      );
    }
    // Part A hardening (corelib-ts#38): a dynamic array needs at least one wire
    // byte per element (a varint element, or an fp element ≥ its size), so a
    // count larger than the bytes left in the buffer cannot be real — reject it
    // as truncation *before* sizing `new Array(count)`, so a hostile count can
    // never drive an allocation larger than the input. A tighter fixlen bound
    // (count * elemSize) is applied once the element word is read, in
    // {@link arrayFixlenHeader}.
    if (count > this.n - this.p) throw incompleteError("truncated array");
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
    // Opt-in length cap (corelib-ts#38), enforced at the header before the
    // payload is taken. wantSub tells string from blob, so the right limit
    // applies to each.
    const limit =
      wantSub === FixlenSubtype.String ? this.maxStringLen : this.maxBlobLen;
    if (len > limit) {
      const what = wantSub === FixlenSubtype.String ? "string" : "blob";
      const name =
        wantSub === FixlenSubtype.String ? "maxStringLen" : "maxBlobLen";
      throw limitExceededError(
        `${what} length ${len} exceeds ${name} ${limit}`,
      );
    }
    return len;
  }

  /** Read an array fixlen element header (count + element type); returns the count. */
  private arrayFixlenHeader(wantSub: number, wantSize: number): number {
    // §4.8: a fixlen array always carries its element-length word — even when
    // empty — so the element kind stays known. count may then be 0.
    //
    // Read the count and validate the element word *before* the count ≤
    // remaining-bytes truncation guard, so a malformed element word on a
    // truncated array is INVALID, not INCOMPLETE (§5.2 precedence). This
    // deliberately inlines the count parse rather than calling {@link
    // arrayCount}, whose own `count > remaining` guard would otherwise fire
    // first — the same trap #49 sidestepped in skipValue's ArrayFixlen case
    // (corelib-ts#51, follow-up to #49).
    this.readVarint();
    const count = this.num();
    if (count > ARRAY_MAX) throw invalidMsgError("array count out of range");
    if (count > this.maxArrayCount) {
      throw limitExceededError(
        `array count ${count} exceeds maxArrayCount ${this.maxArrayCount}`,
      );
    }
    this.readVarint();
    const sub = this.lo & 7;
    const size = this.upper();
    if (sub !== wantSub || size !== wantSize) {
      throw invalidMsgError("invalid fixlen array element type");
    }
    // Part A hardening (corelib-ts#38): now the element size is known, a fixlen
    // array needs count * size payload bytes; a count claiming more than the
    // buffer holds is truncation — reject before sizing `new Array(count)`.
    // This tighter bound subsumes arrayCount's `count > remaining` guard.
    if (count > (this.n - this.p) / wantSize) {
      throw incompleteError("truncated fixlen array");
    }
    return count;
  }

  /** Hand back a zero-copy view of the next `len` bytes, advancing the cursor. */
  private take(len: number): Uint8Array {
    const start = this.p;
    const end = start + len;
    if (end > this.n) throw incompleteError("truncated fixlen payload");
    this.p = end;
    return this.buf.subarray(start, end);
  }

  private rawFp32(): number {
    const p = this.p;
    if (p + 4 > this.n) throw incompleteError("truncated fp32");
    this.p = p + 4;
    return this.view.getFloat32(p, true);
  }

  private rawFp64(): number {
    const p = this.p;
    if (p + 8 > this.n) throw incompleteError("truncated fp64");
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

    if (p >= n) throw incompleteError("truncated varint");
    b = buf[p++]!;
    lo = b & 0x7f;
    if (b < 0x80) return this.set(lo, 0, p);

    if (p >= n) throw incompleteError("truncated varint");
    b = buf[p++]!;
    lo |= (b & 0x7f) << 7;
    if (b < 0x80) return this.set(lo, 0, p);

    if (p >= n) throw incompleteError("truncated varint");
    b = buf[p++]!;
    lo |= (b & 0x7f) << 14;
    if (b < 0x80) return this.set(lo, 0, p);

    if (p >= n) throw incompleteError("truncated varint");
    b = buf[p++]!;
    lo |= (b & 0x7f) << 21;
    if (b < 0x80) return this.set(lo, 0, p);

    // 5th byte straddles the 32-bit boundary: 4 bits to lo, 3 bits to hi.
    if (p >= n) throw incompleteError("truncated varint");
    b = buf[p++]!;
    lo |= (b & 0x0f) << 28;
    hi = (b >> 4) & 0x07;
    if (b < 0x80) return this.set(lo, hi, p);

    if (p >= n) throw incompleteError("truncated varint");
    b = buf[p++]!;
    hi |= (b & 0x7f) << 3;
    if (b < 0x80) return this.set(lo, hi, p);

    if (p >= n) throw incompleteError("truncated varint");
    b = buf[p++]!;
    hi |= (b & 0x7f) << 10;
    if (b < 0x80) return this.set(lo, hi, p);

    if (p >= n) throw incompleteError("truncated varint");
    b = buf[p++]!;
    hi |= (b & 0x7f) << 17;
    if (b < 0x80) return this.set(lo, hi, p);

    if (p >= n) throw incompleteError("truncated varint");
    b = buf[p++]!;
    hi |= (b & 0x7f) << 24;
    if (b < 0x80) return this.set(lo, hi, p);

    // 10th byte: only bit 63 (1 payload bit) remains below 64; any higher
    // payload bit, or a continuation into an 11th byte, is a >64-bit overflow.
    if (p >= n) throw incompleteError("truncated varint");
    b = buf[p++]!;
    if (((b & 0x7f) >> 1) !== 0) throw invalidMsgError("varint overflow");
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
