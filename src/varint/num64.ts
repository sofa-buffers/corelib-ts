/**
 * 64-bit and IEEE-754 helpers.
 *
 * `bigint` coercion plus the float **bit** helpers: the conversions between an
 * IEEE-754 value and its little-endian wire bits, over one shared
 * {@link DataView}. The format stores `fp32` / `fp64` little-endian regardless of
 * host byte order, which a `DataView` gives us for free (the `littleEndian`
 * argument is passed explicitly everywhere).
 *
 * A single float goes through the shared scratch: one `DataView` construction costs
 * ~129 ns on Node 24, about sixteen `fp64` reads, so a handle over the caller's
 * buffer (CORELIB_PLAN §6.6.2) only pays for a *bulk* run — which is where the
 * kernel and the decoder's array drain take one, and nowhere else.
 */

import { argumentError } from "../errors.js";
import { HI, LO } from "./bits64.js";

// One 8-byte scratch, viewed two ways: the `DataView` performs the IEEE-754
// conversion with an explicit little-endian flag (so the wire stays
// little-endian on any host, §4), and the `Uint8Array` alias moves the bytes.
// Reading through the alias rather than `DataView.getUint8` turns each byte
// into a plain typed-array load instead of a method call.
const SCRATCH_BUF = new ArrayBuffer(8);
const SCRATCH = new DataView(SCRATCH_BUF);
const SCRATCH_BYTES = new Uint8Array(SCRATCH_BUF);
const SCRATCH_U32 = new Uint32Array(SCRATCH_BUF);
const SCRATCH_F32 = new Float32Array(SCRATCH_BUF, 0, 1);
const SCRATCH_F64 = new Float64Array(SCRATCH_BUF);

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
  // Same-width aliases of one word: no byte order is involved, so a plain
  // element store + load replaces two `DataView` method calls (which JSC in
  // particular does not inline as well).
  SCRATCH_U32[0] = bits;
  return SCRATCH_F32[0]!;
}

/**
 * A fresh 4-byte companion holding one fp32 word's wire image: the four
 * little-endian bytes of its 32-bit word, byte `k` in bits `8*k`.
 *
 * Generated-layer support, not a codec path: an `fp32` field whose value is a
 * `NaN` cannot be re-encoded from the `number` a JS host stored it in — the host
 * normalizes the payload bits — so the generated message keeps the four raw wire
 * bytes beside the value and re-emits those (MESSAGE_SPEC §6.5). What the decoder
 * hands over is the 32-bit *word*, because a number costs nothing to pass where
 * the byte view it replaced was an allocation per value and a borrowed slice
 * §6.7 forbids; turning that word back into bytes is this function, and it is the
 * same four shifts for every schema (ARCHITECTURE §8).
 *
 * One function and not two. An `into(out, off, bits)` flavour beside it would be
 * the natural companion — it is what the fp32 *array* path would want — but that
 * path was retired before this one moved here (§6.7 killed the view), so the
 * whole family builds this companion per `NaN` scalar and nothing else calls it.
 * Public API with no consumer drifts, so there is exactly one entry point and it
 * allocates: the allocation is per `NaN`, not per field.
 */
export function fp32RawBytes(bits: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = bits & 0xff;
  out[1] = (bits >>> 8) & 0xff;
  out[2] = (bits >>> 16) & 0xff;
  out[3] = (bits >>> 24) & 0xff;
  return out;
}

/** Reinterpret the 8 little-endian wire bytes of an fp64, packed into two words. */
export function fp64FromBits(lo: number, hi: number): number {
  // The two halves go to the host's own half order (`LO`/`HI`, probed once).
  SCRATCH_U32[LO] = lo;
  SCRATCH_U32[HI] = hi;
  return SCRATCH_F64[0]!;
}
