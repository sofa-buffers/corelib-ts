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
  let lo = Number(value & 0xffff_ffffn) >>> 0;
  let hi = Number((value >> 32n) & 0xffff_ffffn) >>> 0;
  let n = 0;
  while (hi !== 0) {
    n++;
    const next = ((lo >>> 7) | (hi << 25)) >>> 0;
    hi >>>= 7;
    lo = next;
  }
  while (lo > 0x7f) {
    n++;
    lo >>>= 7;
  }
  return n + 1;
}

/**
 * Write `value` (an unsigned `bigint`) as a varint into `out` at `pos`.
 * The caller must guarantee `out` has at least {@link VARINT_MAX_BYTES} bytes
 * of room from `pos`. Returns the position just past the last byte written.
 *
 * The 64-bit value is split into two 32-bit *number* halves once (the only two
 * `bigint` operations), then the LEB128 groups are produced with number-only
 * arithmetic — `lo`'s top bits are fed from `hi` as it drains. This avoids the
 * ~20 short-lived `bigint` allocations a per-byte `v & 0x7fn; v >>= 7n` loop
 * would make, which V8 profiling showed to be the encoder's dominant cost.
 */
export function encodeVarint(value: bigint, out: Uint8Array, pos: number): number {
  let lo = Number(value & 0xffff_ffffn) >>> 0;
  let hi = Number((value >> 32n) & 0xffff_ffffn) >>> 0;
  // While high bits remain, every emitted byte is a full 7-bit group + continuation.
  while (hi !== 0) {
    out[pos++] = (lo & 0x7f) | 0x80;
    lo = ((lo >>> 7) | (hi << 25)) >>> 0; // shift the 64-bit value right by 7
    hi >>>= 7;
  }
  while (lo > 0x7f) {
    out[pos++] = (lo & 0x7f) | 0x80;
    lo >>>= 7;
  }
  out[pos++] = lo;
  return pos;
}

/**
 * Write a 64-bit value already split into two unsigned 32-bit halves as a
 * varint — the `bigint`-free sibling of {@link encodeVarint}. Callers holding a
 * `bigint` split it once (or hold a {@link Long}) and then stay on the number
 * path here, avoiding the per-value `bigint` churn that dominates the 64-bit
 * array encoders (and which JavaScriptCore optimizes far worse than V8).
 * `lo`/`hi` are coerced to uint32.
 */
export function encodeVarintLoHi(lo: number, hi: number, out: Uint8Array, pos: number): number {
  lo >>>= 0;
  hi >>>= 0;
  while (hi !== 0) {
    out[pos++] = (lo & 0x7f) | 0x80;
    lo = ((lo >>> 7) | (hi << 25)) >>> 0;
    hi >>>= 7;
  }
  while (lo > 0x7f) {
    out[pos++] = (lo & 0x7f) | 0x80;
    lo >>>= 7;
  }
  out[pos++] = lo;
  return pos;
}

/** Number of bytes {@link encodeVarintNum} will write for `value`. */
export function varintSizeNum(value: number): number {
  let n = 1;
  while (value > 0x7f) {
    n++;
    value = Math.floor(value / 128);
  }
  return n;
}

/**
 * Write `value` (a non-negative integer `number`, `≤ 2^53`) as a varint into
 * `out` at `pos`. The number-only sibling of {@link encodeVarint}: it avoids
 * `bigint` entirely, which is the encoder's hot path for ids, lengths, counts
 * and the very common small scalar. The caller guarantees {@link VARINT_MAX_BYTES}
 * bytes of room. Returns the position past the last byte written.
 */
export function encodeVarintNum(value: number, out: Uint8Array, pos: number): number {
  // Fast path: below 2^32 every 7-bit group survives bitwise extraction (ToUint32
  // is exact there, and `>>>` keeps it unsigned), so we stay on cheap integer ops.
  // This covers ids, lengths, counts, u8..u32 and their zig-zags — the vast
  // majority of calls. It matters because JavaScriptCore does not inline this
  // helper and its `% 128` / `Math.floor(/128)` float path is a top-3 hotspot
  // there; V8 optimizes both away, so the change is JSC-facing but harmless on V8.
  if (value < 0x1_0000_0000) {
    let v = value;
    while (v > 0x7f) {
      out[pos++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    out[pos++] = v;
    return pos;
  }
  // Slow path: 2^32 .. 2^53, where bitwise ops would truncate to 32 bits.
  while (value > 0x7f) {
    out[pos++] = (value % 128) | 0x80;
    value = Math.floor(value / 128);
  }
  out[pos++] = value;
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
