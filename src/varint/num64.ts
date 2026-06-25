/**
 * 64-bit and IEEE-754 helpers.
 *
 * `bigint` masking utilities plus little-endian float pack/unpack built on a
 * single shared {@link DataView}. The format always stores `fp32` / `fp64`
 * little-endian regardless of host byte order, which a `DataView` gives us for
 * free (the `littleEndian` argument is passed explicitly everywhere).
 */

import { I64_MAX, I64_MIN, U64_MAX } from "../constants.js";

const SCRATCH = new DataView(new ArrayBuffer(8));

/** Coerce a `number | bigint` to a `bigint`, rejecting non-integers. */
export function toBigInt(value: number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isInteger(value)) {
    throw new RangeError(`expected an integer, got ${value}`);
  }
  return BigInt(value);
}

/** True when `value` fits in an unsigned 64-bit integer. */
export function inU64(value: bigint): boolean {
  return value >= 0n && value <= U64_MAX;
}

/** True when `value` fits in a signed 64-bit integer. */
export function inI64(value: bigint): boolean {
  return value >= I64_MIN && value <= I64_MAX;
}

/** Write `value` as a little-endian fp32 into `out` at `pos`; returns `pos + 4`. */
export function packFp32(out: Uint8Array, pos: number, value: number): number {
  SCRATCH.setFloat32(0, value, true);
  out[pos] = SCRATCH.getUint8(0);
  out[pos + 1] = SCRATCH.getUint8(1);
  out[pos + 2] = SCRATCH.getUint8(2);
  out[pos + 3] = SCRATCH.getUint8(3);
  return pos + 4;
}

/** Write `value` as a little-endian fp64 into `out` at `pos`; returns `pos + 8`. */
export function packFp64(out: Uint8Array, pos: number, value: number): number {
  SCRATCH.setFloat64(0, value, true);
  for (let i = 0; i < 8; i++) out[pos + i] = SCRATCH.getUint8(i);
  return pos + 8;
}

/** Read a little-endian fp32 from `buf` at `pos`. */
export function unpackFp32(buf: Uint8Array, pos: number): number {
  SCRATCH.setUint8(0, buf[pos]!);
  SCRATCH.setUint8(1, buf[pos + 1]!);
  SCRATCH.setUint8(2, buf[pos + 2]!);
  SCRATCH.setUint8(3, buf[pos + 3]!);
  return SCRATCH.getFloat32(0, true);
}

/** Read a little-endian fp64 from `buf` at `pos`. */
export function unpackFp64(buf: Uint8Array, pos: number): number {
  for (let i = 0; i < 8; i++) SCRATCH.setUint8(i, buf[pos + i]!);
  return SCRATCH.getFloat64(0, true);
}
