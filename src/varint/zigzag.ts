/**
 * Zig-zag mapping for signed integers.
 *
 * Signed values are zig-zag encoded before being written as an unsigned varint,
 * so small magnitudes of either sign stay short. The transform is the standard
 * `(n << 1) ^ (n >> 63)` over 64 bits, computed here on a value already held as
 * two 32-bit *number* halves — the only shape the codec's hot paths ever have
 * it in. Combined with the bit punning in {@link "./bits64"}, a signed 64-bit
 * value round-trips with a single `bigint` materialisation, against the four the
 * `bigint` form (`(v << 1n) ^ (v >> 63n)`) allocates per value; that `bigint`
 * form had no production caller left and is gone with it.
 */

import { Long } from "../long.js";
import { joinI64 } from "./bits64.js";
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

/**
 * Zig-zag *decode* an unsigned 64-bit value held as two 32-bit halves, returning
 * the signed `bigint`. Materialises exactly one `bigint` — the result — where
 * the `bigint` form allocated four.
 */
export function zigzagDecodeLoHi(lo: number, hi: number): bigint {
  // `mask` is all-ones exactly when the zig-zag low bit is set (a negative
  // result) — the `-(value & 1n)` of the `bigint` form.
  const mask = -(lo & 1) >>> 0;
  return joinI64(
    (((lo >>> 1) | (hi << 31)) >>> 0) ^ mask,
    ((hi >>> 1) ^ mask) >>> 0,
  );
}

/**
 * Zig-zag *decode* an unsigned 64-bit value held as two 32-bit halves into a
 * {@link Long} — the `bigint`-free twin of {@link zigzagDecodeLoHi}, and the one
 * implementation every `Long`-returning signed reader shares: the scalar
 * {@link Cursor.readSignedLong}, the array {@link Cursor.readSignedArrayLong},
 * and the opt-in `Long` channel on both push decoders. It allocates the single
 * `Long` it returns and nothing else.
 *
 * The shifts are the ones {@link zigzagDecodeLoHi} performs, and they are
 * bit-exact on a half whose bit 31 is set: `>>>` reads its operand as unsigned
 * and `<<` works on the raw 32 bits, so neither half needs coercing first.
 */
export function zigzagDecodeLong(lo: number, hi: number): Long {
  const mask = -(lo & 1) >>> 0;
  return new Long(
    (((lo >>> 1) | (hi << 31)) >>> 0) ^ mask,
    ((hi >>> 1) >>> 0) ^ mask,
  );
}
