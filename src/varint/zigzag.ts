/**
 * Zig-zag mapping for signed integers.
 *
 * Signed values are zig-zag encoded before being written as an unsigned varint,
 * so small magnitudes of either sign stay short. The transform is the standard
 * `(n << 1) ^ (n >> 63)` over 64 bits.
 *
 * Two shapes are offered. {@link zigzagEncode} / {@link zigzagDecode} work in
 * `bigint` and are the general form. The `LoHi` pair below computes the very
 * same mapping on a value already held as two 32-bit *number* halves, which is
 * how the hot paths use it: combined with the bit punning in
 * {@link "./bits64"}, a signed 64-bit value round-trips with a single `bigint`
 * materialisation instead of the four the `bigint` form allocates (shift, mask,
 * negate, xor).
 */

import { U64_MAX } from "../constants.js";
import { joinI64 } from "./bits64.js";
import { encodeVarintLoHi } from "./leb128.js";

/** Map a signed 64-bit value to its unsigned zig-zag representation. */
export function zigzagEncode(value: bigint): bigint {
  return ((value << 1n) ^ (value >> 63n)) & U64_MAX;
}

/** Recover a signed 64-bit value from its unsigned zig-zag representation. */
export function zigzagDecode(value: bigint): bigint {
  return (value >> 1n) ^ -(value & 1n);
}

/**
 * Zig-zag *encode* a two's-complement 64-bit value held as two 32-bit halves and
 * write the result as a varint into `out` at `pos`; returns the position past
 * the last byte. Equivalent to `encodeVarint(zigzagEncode(v))` for every value
 * in the `int64` domain, with no `bigint` allocated at all. The caller
 * guarantees `VARINT_MAX_BYTES` bytes of room, as for {@link encodeVarintLoHi}.
 */
export function encodeZigzagVarintLoHi(
  lo: number,
  hi: number,
  out: Uint8Array,
  pos: number,
): number {
  // `sgn` is all-ones exactly when the value is negative — the arithmetic
  // `value >> 63` of the scalar form, widened across both halves.
  const sgn = -(hi >>> 31) >>> 0;
  return encodeVarintLoHi(
    (((lo << 1) >>> 0) ^ sgn) >>> 0,
    ((((hi << 1) | (lo >>> 31)) >>> 0) ^ sgn) >>> 0,
    out,
    pos,
  );
}

/**
 * Zig-zag *decode* an unsigned 64-bit value held as two 32-bit halves, returning
 * the signed `bigint`. Equivalent to {@link zigzagDecode}, materialising exactly
 * one `bigint` (the result) instead of four.
 */
export function zigzagDecodeLoHi(lo: number, hi: number): bigint {
  // `mask` is all-ones exactly when the zig-zag low bit is set (a negative
  // result) — the `-(value & 1n)` of the scalar form.
  const mask = -(lo & 1) >>> 0;
  return joinI64(
    (((lo >>> 1) | (hi << 31)) >>> 0) ^ mask,
    ((hi >>> 1) ^ mask) >>> 0,
  );
}
