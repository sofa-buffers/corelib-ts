/**
 * A 64-bit integer value carried as two unsigned 32-bit halves.
 *
 * SofaBuffers accepts `bigint` at every 64-bit surface for ergonomics, but a
 * `bigint` in the encode/decode hot path is expensive — especially on
 * JavaScriptCore (Bun), where profiling showed the `bigint` split/materialise
 * and zig-zag operations dominating the 64-bit array codecs. `Long` lets a
 * caller (and the generated code) stay entirely on `number` arithmetic: the
 * codec reads `.low`/`.high` directly, and any `bigint`↔`Long` conversion
 * happens once at the API boundary rather than once per encode.
 *
 * Values are stored as raw two's-complement bits; the same `Long` serves an
 * unsigned or signed field — {@link Long.toBigInt} takes the signedness.
 *
 * The two `bigint` conversions below go through the shared bit-punning scratch
 * ({@link "./varint/bits64"}) that the codec's own hot paths use, rather than
 * through mask-and-shift `bigint` arithmetic: the split allocated four
 * intermediate `bigint`s per call and the join two, on the very boundary this
 * class exists to make cheap.
 */

import { HI, joinI64, joinU64, LO, S_I64, S_U32 } from "./varint/bits64.js";

export class Long {
  /** Low 32 bits (unsigned). */
  readonly low: number;
  /** High 32 bits (unsigned). */
  readonly high: number;

  constructor(low: number, high: number) {
    this.low = low >>> 0;
    this.high = high >>> 0;
  }

  /**
   * The 64-bit zero. `Long` is immutable (readonly halves), so this single shared
   * instance is safe to reuse anywhere a zero default is needed — generated code
   * uses it for fixed-count array defaults and pad-fill instead of
   * `Long.fromValue(0)`, which would run `bigint` arithmetic per call on the hot
   * decode/encode path.
   */
  static readonly ZERO: Long = new Long(0, 0);

  /** Construct from raw 32-bit halves. */
  static fromBits(low: number, high: number): Long {
    return new Long(low, high);
  }

  /**
   * Split a `bigint` into its low/high 32-bit halves (two's complement). The
   * `BigInt64Array` store *is* `ToBigInt64` — reduction modulo 2^64 — so an
   * out-of-range value keeps exactly the halves the masks kept (bits64).
   */
  static fromBigInt(value: bigint): Long {
    S_I64[0] = value;
    return new Long(S_U32[LO]!, S_U32[HI]!);
  }

  /** From an integer `number` (`|n| < 2^53`); sign handled via `bigint` once. */
  static fromNumber(n: number): Long {
    return Long.fromBigInt(BigInt(Math.trunc(n)));
  }

  /** Accept a `Long` as-is, or convert a `bigint` / `number` once. */
  static fromValue(v: Long | bigint | number): Long {
    if (v instanceof Long) return v;
    return typeof v === "bigint" ? Long.fromBigInt(v) : Long.fromNumber(v);
  }

  /** Materialise as a `bigint`. `signed` reads the high bit as two's complement. */
  toBigInt(signed = false): bigint {
    return signed ? joinI64(this.low, this.high) : joinU64(this.low, this.high);
  }

  /** Decimal string (`signed` interprets the high bit as two's complement). */
  toString(signed = false): string {
    return this.toBigInt(signed).toString();
  }
}
