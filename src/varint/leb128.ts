/**
 * LEB128 variable-length integer coding.
 *
 * Each byte carries seven payload bits with the high bit as a continuation
 * flag; bytes are little-endian (least-significant group first). Values are
 * `bigint` so the full 64-bit range works. The streaming decoder in
 * `decode/state.ts` has its own resumable byte-at-a-time reader; the helpers
 * here are for whole-buffer paths (array elements, tests, the JS kernel).
 */

import { VARINT_MAX_BYTES } from "../constants.js";
import { invalidMsgError } from "../errors.js";

/** Number of bytes {@link encodeVarint} will write for `value` (unsigned). */
export function varintSize(value: bigint): number {
  let n = 1;
  let v = value >> 7n;
  while (v > 0n) {
    n++;
    v >>= 7n;
  }
  return n;
}

/**
 * Write `value` (an unsigned `bigint`) as a varint into `out` at `pos`.
 * The caller must guarantee `out` has at least {@link VARINT_MAX_BYTES} bytes
 * of room from `pos`. Returns the position just past the last byte written.
 */
export function encodeVarint(value: bigint, out: Uint8Array, pos: number): number {
  let v = value;
  while (v > 0x7fn) {
    out[pos++] = Number(v & 0x7fn) | 0x80;
    v >>= 7n;
  }
  out[pos++] = Number(v);
  return pos;
}

/** The result of {@link decodeVarint}: the value and the position after it. */
export interface VarintResult {
  value: bigint;
  pos: number;
}

/**
 * Read a varint from `buf` starting at `pos`, with all bytes assumed present.
 * Throws {@link SofabError} (`INVALID_MSG`) on overflow past 64 bits or if the
 * buffer ends mid-varint.
 */
export function decodeVarint(buf: Uint8Array, pos: number): VarintResult {
  let value = 0n;
  let shift = 0n;
  let bytes = 0;
  for (;;) {
    if (pos >= buf.length) throw invalidMsgError("truncated varint");
    if (bytes >= VARINT_MAX_BYTES) throw invalidMsgError("varint overflow");
    const byte = buf[pos++]!;
    value |= BigInt(byte & 0x7f) << shift;
    bytes++;
    if ((byte & 0x80) === 0) return { value, pos };
    shift += 7n;
  }
}
