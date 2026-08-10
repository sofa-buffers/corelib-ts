/**
 * 64-bit and IEEE-754 helpers.
 *
 * `bigint` masking utilities plus little-endian float pack/unpack built on a
 * single shared {@link DataView}. The format always stores `fp32` / `fp64`
 * little-endian regardless of host byte order, which a `DataView` gives us for
 * free (the `littleEndian` argument is passed explicitly everywhere).
 */

import { argumentError } from "../errors.js";

// One 8-byte scratch, viewed two ways: the `DataView` performs the IEEE-754
// conversion with an explicit little-endian flag (so the wire stays
// little-endian on any host, §4), and the `Uint8Array` alias moves the bytes.
// Reading through the alias rather than `DataView.getUint8` turns each byte
// into a plain typed-array load instead of a method call.
const SCRATCH_BUF = new ArrayBuffer(8);
const SCRATCH = new DataView(SCRATCH_BUF);
const SCRATCH_BYTES = new Uint8Array(SCRATCH_BUF);

/**
 * Coerce a `number | bigint` to a `bigint`, rejecting non-integers.
 *
 * A fractional, `NaN` or infinite `number` at an integer surface is a caller
 * mistake in exactly the sense of CORELIB_PLAN §6.3's `InvalidArgument`, and so
 * is reported the way every other encoder rejection is: a {@link SofabError}
 * carrying {@link SofabErrorCode.Argument}. It used to escape as a bare
 * `RangeError`, which the documented `catch (e) { if (e instanceof SofabError) }`
 * pattern never sees (corelib-ts#111).
 */
export function toBigInt(value: number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isInteger(value)) {
    throw argumentError(`expected an integer, got ${value}`);
  }
  return BigInt(value);
}

/** Write `value` as a little-endian fp32 into `out` at `pos`; returns `pos + 4`. */
export function packFp32(out: Uint8Array, pos: number, value: number): number {
  SCRATCH.setFloat32(0, value, true);
  out[pos] = SCRATCH_BYTES[0]!;
  out[pos + 1] = SCRATCH_BYTES[1]!;
  out[pos + 2] = SCRATCH_BYTES[2]!;
  out[pos + 3] = SCRATCH_BYTES[3]!;
  return pos + 4;
}

/** Write `value` as a little-endian fp64 into `out` at `pos`; returns `pos + 8`. */
export function packFp64(out: Uint8Array, pos: number, value: number): number {
  SCRATCH.setFloat64(0, value, true);
  out[pos] = SCRATCH_BYTES[0]!;
  out[pos + 1] = SCRATCH_BYTES[1]!;
  out[pos + 2] = SCRATCH_BYTES[2]!;
  out[pos + 3] = SCRATCH_BYTES[3]!;
  out[pos + 4] = SCRATCH_BYTES[4]!;
  out[pos + 5] = SCRATCH_BYTES[5]!;
  out[pos + 6] = SCRATCH_BYTES[6]!;
  out[pos + 7] = SCRATCH_BYTES[7]!;
  return pos + 8;
}

/**
 * The 4 little-endian wire bytes of `value` as one 32-bit word (byte `k` in bits
 * `8*k`) — the inverse of {@link fp32FromBits}, and the companion to an encoder
 * that must emit those bytes one at a time because its output buffer is smaller
 * than the value (CORELIB_PLAN §5.1). Returning a word rather than a byte view
 * keeps the bytes in the caller's registers, so a flush sink that re-enters the
 * encoder mid-value cannot overwrite them the way a shared scratch would.
 */
export function fp32Bits(value: number): number {
  SCRATCH.setFloat32(0, value, true);
  return SCRATCH.getUint32(0, true);
}

/** Bytes 0..3 of `value`'s little-endian fp64 image, as a 32-bit word. */
export function fp64BitsLo(value: number): number {
  SCRATCH.setFloat64(0, value, true);
  return SCRATCH.getUint32(0, true);
}

/** Bytes 4..7 of `value`'s little-endian fp64 image, as a 32-bit word. */
export function fp64BitsHi(value: number): number {
  SCRATCH.setFloat64(0, value, true);
  return SCRATCH.getUint32(4, true);
}

/**
 * Reinterpret the 4 little-endian wire bytes of an fp32, packed into one 32-bit
 * word (byte `k` in bits `8*k`), as a `number`. The companion to a resumable
 * decoder that accumulates float bytes into a machine word instead of a
 * per-instance byte array.
 */
export function fp32FromBits(bits: number): number {
  SCRATCH.setUint32(0, bits, true);
  return SCRATCH.getFloat32(0, true);
}

/** Reinterpret the 8 little-endian wire bytes of an fp64, packed into two words. */
export function fp64FromBits(lo: number, hi: number): number {
  SCRATCH.setUint32(0, lo, true);
  SCRATCH.setUint32(4, hi, true);
  return SCRATCH.getFloat64(0, true);
}

// The raw fp32 channel gets its own 4-byte scratch and its own persistent view,
// deliberately *not* the one pack/unpack use. The whole point of the channel is
// decode-then-re-encode, so the view is live while the consumer calls back into
// the encoder — and sharing a buffer with `packFp32` would let that re-encode
// overwrite the very bytes it is reading. The view is allocated once, so
// handing it out costs no allocation per element.
const RAW_FP32_BUF = new ArrayBuffer(4);
const RAW_FP32_DV = new DataView(RAW_FP32_BUF);
const RAW_FP32_VIEW = new Uint8Array(RAW_FP32_BUF);

/**
 * The 4 wire bytes of an fp32 packed word, as a `Uint8Array` view — the raw
 * channel that lets a bit-exact consumer keep a signaling NaN (§4.6/§6.5).
 *
 * The view aliases a shared scratch and, exactly like the string / blob `chunk`
 * views the decoder hands out, is valid only until the next delivered fp32; a
 * consumer that retains it must copy.
 */
export function rawFp32Bytes(bits: number): Uint8Array {
  RAW_FP32_DV.setUint32(0, bits, true);
  return RAW_FP32_VIEW;
}

