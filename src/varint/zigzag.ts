/**
 * Zig-zag mapping for signed integers.
 *
 * Signed values are zig-zag encoded before being written as an unsigned varint,
 * so small magnitudes of either sign stay short. The transform is the standard
 * `(n << 1) ^ (n >> 63)` over 64 bits, computed here in `bigint` so the full
 * `int64` range round-trips exactly.
 */

import { U64_MAX } from "../constants.js";

/** Map a signed 64-bit value to its unsigned zig-zag representation. */
export function zigzagEncode(value: bigint): bigint {
  return ((value << 1n) ^ (value >> 63n)) & U64_MAX;
}

/** Recover a signed 64-bit value from its unsigned zig-zag representation. */
export function zigzagDecode(value: bigint): bigint {
  return (value >> 1n) ^ -(value & 1n);
}
