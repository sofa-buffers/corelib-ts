/**
 * The byte-level reading core shared by the two whole-buffer decoders.
 *
 * The push decoder ({@link "./fast"}) and the pull decoder ({@link "./cursor"})
 * differ in who drives the loop, not in how bytes come off the wire: both hold
 * one contiguous {@link Uint8Array} and a cursor into it, read varints with the
 * same unrolled `bigint`-free ladder, and hand out payloads as zero-copy
 * subarrays. That machinery used to live as a verbatim copy in each file — the
 * 55-line unrolled reader plus the half-combining helpers, ~65 identical lines
 * apiece. Every varint-level fix (corelib-ts#82, #88, #99/#100, #131) then had
 * to be applied twice by hand, and a fix landing in one copy only is invisible
 * to review: the shared vectors feed both surfaces the same well-formed bytes,
 * so only a hostile varint tells them apart (corelib-ts#114). This base class is
 * the single definition; the two decoders extend it and add their own field
 * logic and limit policy.
 *
 * Kept as a base class rather than free functions over module-scope registers on
 * purpose: the varint reader is the innermost loop of every decode, its callers
 * consume {@link lo} / {@link hi} in the same breath, and the measured cost of
 * routing that through a shared free function (three arguments in, a position
 * out, the halves published module-side) was +8% Ir/op on `decode: u64 array
 * (1000)` and +15% on `decode: typical message` under Callgrind. Inheritance
 * keeps every access a plain field access on `this`, so the numbers are
 * unchanged — this repo's profile is maxspeed, and that is measured, not
 * asserted.
 *
 * The resumable streaming decoder ({@link "./state"}) does **not** extend this:
 * it must suspend mid-varint at a chunk boundary, so it carries a byte-at-a-time
 * accumulator, and its whole-varint fast path is entered only once the caller
 * has proved all ten bytes are present — it therefore has no per-byte bounds
 * check at all. Different contract, different code, not a copy of this one.
 */

import { incompleteError, invalidMsgError } from "../errors.js";
import { joinU64 } from "../varint/bits64.js";
import { zigzagDecodeLoHi } from "../varint/zigzag.js";

const TWO32 = 0x1_0000_0000; // 2^32, for combining the 32-bit halves

/**
 * One cursor over a contiguous message buffer: varints, floats, payload views.
 *
 * Not part of the public API (CORELIB_PLAN §6.1's name set is closed): it is an
 * implementation detail of the two decoders and is not exported from the package
 * entry point. Its members are `protected` only because subclasses need them.
 *
 * @internal
 */
export abstract class BufferReader {
  protected readonly buf: Uint8Array;
  protected readonly n: number;
  protected p = 0;

  // Last varint, as two unsigned 32-bit halves (see readVarint).
  protected lo = 0;
  protected hi = 0;

  /**
   * The `DataView` the float readers convert through — built on **first use**,
   * not in the constructor.
   *
   * `new DataView(buffer, offset, length)` measures ~115 ns on Node 24, which is
   * a tenth of a small message's whole decode, and a message with no `fp32` /
   * `fp64` field never touches it: every other wire type is read straight off
   * the `Uint8Array`. One decoder is constructed per message on both whole-buffer
   * surfaces (`decode()` and `Cursor`), so that was a fixed per-message toll for
   * a member most messages do not use. The `??=` below is one already-loaded
   * field test per float read, paid only by the messages that have floats.
   */
  private fpView: DataView | null = null;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.n = buf.length;
  }

  /** The float-conversion view over the source buffer (see {@link fpView}). */
  private floats(): DataView {
    return (this.fpView ??= new DataView(
      this.buf.buffer,
      this.buf.byteOffset,
      this.buf.length,
    ));
  }

  /** Hand back a zero-copy view of the next `len` bytes, advancing the cursor. */
  protected take(len: number): Uint8Array {
    const start = this.p;
    const end = start + len;
    if (end > this.n) throw incompleteError("truncated fixlen payload");
    this.p = end;
    return this.buf.subarray(start, end);
  }

  /** Read the next 4 bytes as a little-endian fp32, advancing the cursor. */
  protected rawFp32(): number {
    const p = this.p;
    if (p + 4 > this.n) throw incompleteError("truncated fp32");
    this.p = p + 4;
    return this.floats().getFloat32(p, true);
  }

  /** Read the next 8 bytes as a little-endian fp64, advancing the cursor. */
  protected rawFp64(): number {
    const p = this.p;
    if (p + 8 > this.n) throw incompleteError("truncated fp64");
    this.p = p + 8;
    return this.floats().getFloat64(p, true);
  }

  // --- varint reading -----------------------------------------------------

  /**
   * The last varint as an unsigned value, number-first: a `number` when it fits
   * exactly (`≤ 2^53-1` — all ids, u8..u32 and small u64s), a `bigint` only
   * beyond that — built by punning the two halves through the shared scratch, so
   * one `bigint` is allocated where the shift-and-or form allocated four
   * ({@link "../varint/bits64"}), and none at all on the common path.
   */
  protected unsignedValue(): number | bigint {
    const hi = this.hi >>> 0; // unsigned: hi's bit 31 must not read as negative
    return hi <= 0x1fffff ? hi * TWO32 + (this.lo >>> 0) : joinU64(this.lo >>> 0, hi);
  }

  /** The last zig-zag varint as a signed value, number-first (see {@link unsignedValue}). */
  protected signedValue(): number | bigint {
    const hi = this.hi >>> 0;
    if (hi <= 0x1fffff) {
      const r = hi * TWO32 + (this.lo >>> 0); // raw zig-zag, ≤ 2^53-1
      return r % 2 === 0 ? r / 2 : -(r + 1) / 2;
    }
    return zigzagDecodeLoHi(this.lo >>> 0, hi);
  }

  /**
   * The last varint's value as a JS number — exact for ids/lengths/counts.
   *
   * `hi` is accumulated with 32-bit bitwise ops, so a varint with **bit 63** set
   * lands on its sign bit and reads back negative. Coerce it unsigned, exactly
   * as {@link upper} already does: without the `>>> 0` the result is a large
   * negative number, which is not `> ARRAY_MAX` and not `> maxArrayCount`, so a
   * hostile count slips past every guard and its element loop runs zero times —
   * a message truncated inside that array is then reported COMPLETE
   * (corelib-ts#88). One bit, fully attacker-controlled, and an *accept*.
   *
   * Past 2^53 the sum is no longer exact, but every value up there is far beyond
   * the ARRAY_MAX ceiling this feeds and is only ever compared against it.
   */
  protected num(): number {
    return (this.hi >>> 0) * TWO32 + (this.lo >>> 0);
  }

  /** The last varint with its low 3 tag bits stripped (`value >> 3`). */
  protected upper(): number {
    // value >> 3 without losing the high bits: drop 3 bits, carry hi's low 3.
    return (this.hi >>> 0) * (TWO32 / 8) + (this.lo >>> 3);
  }

  /**
   * Decode one LEB128 varint at the cursor into {@link lo} / {@link hi} (each an
   * unsigned 32-bit half), advancing {@link p}. Throws on truncation
   * (`INCOMPLETE`) or a value spilling past 64 bits (`INVALID_MSG`, >10 bytes).
   * Unrolled, number-only — no `bigint`.
   */
  protected readVarint(): void {
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

  /** Publish a fully-decoded varint and the cursor past it (see {@link readVarint}). */
  private set(lo: number, hi: number, p: number): void {
    this.lo = lo;
    this.hi = hi;
    this.p = p;
  }
}
