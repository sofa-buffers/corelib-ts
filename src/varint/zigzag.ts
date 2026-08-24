/**
 * Zig-zag mapping for signed integers.
 *
 * Signed values are zig-zag encoded before being written as an unsigned varint, so
 * small magnitudes of either sign stay short. The transform is the standard
 * `(n << 1) ^ (n >> 63)` over 64 bits, computed here on a value already held as two
 * 32-bit *number* halves — the only shape the codec's hot paths ever have it in, and
 * one that allocates nothing (§6.6) where the `bigint` form
 * (`(v << 1n) ^ (v >> 63n)`) allocates four per value.
 *
 * Only the encode direction lives here. The decoder undoes zig-zag inline, where it
 * already holds the halves, and hands them to the visitor beside the value — so a
 * `Long`-returning decode helper would be an object per value the codec may not
 * allocate.
 */

import { encodeVarintLoHi } from "./leb128.js";

/**
 * Zig-zag *encode* a two's-complement 64-bit value held as two 32-bit halves and
 * write the result as a varint into `out` at `pos`; returns the position past
 * the last byte. Equivalent to zig-zagging the value and then writing the varint
 * of the result, for every value in the `int64` domain, with no `bigint`
 * allocated at all. The caller guarantees `VARINT_MAX_BYTES` bytes of room, as
 * for {@link encodeVarintLoHi}.
 */
export function encodeZigzagVarintLoHi(
  lo: number,
  hi: number,
  out: Uint8Array,
  pos: number,
): number {
  // `sgn` is all-ones exactly when the value is negative — the arithmetic
  // `value >> 63` of the 64-bit form, widened across both halves.
  const sgn = -(hi >>> 31) >>> 0;
  return encodeVarintLoHi(
    (((lo << 1) >>> 0) ^ sgn) >>> 0,
    ((((hi << 1) | (lo >>> 31)) >>> 0) ^ sgn) >>> 0,
    out,
    pos,
  );
}
