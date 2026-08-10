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
import { incompleteError, invalidMsgError } from "../errors.js";
import { HI, joinU64, LO, S_U32, S_U64 } from "./bits64.js";

/** Number of bytes {@link encodeVarint} will write for `value` (unsigned). */
export function varintSize(value: bigint): number {
  // Split through the shared scratch (see bits64): the two `bigint` masks and
  // shift this replaces cost ~900 instructions, the store/load pair ~32.
  S_U64[0] = value;
  return varintSizeLoHi(S_U32[LO]!, S_U32[HI]!);
}

/**
 * Number of bytes {@link encodeVarintLoHi} will write for the 64-bit value held
 * as two unsigned 32-bit halves — the `bigint`-free sibling of
 * {@link varintSize}, so a caller that has already split a value sizes it
 * without splitting again.
 */
export function varintSizeLoHi(lo: number, hi: number): number {
  // Below 2^32 the answer is a plain range ladder — no loop, no 64-bit shifting.
  if (hi === 0) {
    return lo < 0x80 ? 1 : lo < 0x4000 ? 2 : lo < 0x20_0000 ? 3 : lo < 0x1000_0000 ? 4 : 5;
  }
  // Above it, the first five bytes are always full: four 7-bit groups out of
  // `lo` plus a fifth straddling byte carrying lo's top 4 bits and hi's low 3.
  // What remains is `hi >>> 3`, a 29-bit quantity, sized by the same ladder.
  const h = hi >>> 3;
  return h === 0
    ? 5
    : 5 + (h < 0x80 ? 1 : h < 0x4000 ? 2 : h < 0x20_0000 ? 3 : h < 0x1000_0000 ? 4 : 5);
}

/**
 * Write `value` (an unsigned `bigint`) as a varint into `out` at `pos`.
 * The caller must guarantee `out` has at least {@link VARINT_MAX_BYTES} bytes
 * of room from `pos`. Returns the position just past the last byte written.
 *
 * The 64-bit value is split into two 32-bit *number* halves once — through the
 * shared bit-punning scratch, so **no** `bigint` is allocated at all (see
 * {@link "./bits64"}) — and the LEB128 groups are then produced with number-only
 * arithmetic, `lo`'s top bits fed from `hi` as it drains. This avoids both the
 * ~20 short-lived `bigint` allocations a per-byte `v & 0x7fn; v >>= 7n` loop
 * would make and the three the mask-and-shift split used to.
 */
export function encodeVarint(value: bigint, out: Uint8Array, pos: number): number {
  // One typed-array store replaces the three `bigint` allocations the mask and
  // shift used to make; the halves are read back as plain numbers (see bits64).
  S_U64[0] = value;
  return encodeVarintLoHi(S_U32[LO]!, S_U32[HI]!, out, pos);
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
  if (hi === 0) {
    // Wholly within 32 bits: a plain varint loop over `lo`, at most 5 bytes.
    while (lo > 0x7f) {
      out[pos++] = (lo & 0x7f) | 0x80;
      lo >>>= 7;
    }
    out[pos++] = lo;
    return pos;
  }
  // A real 64-bit value. The first four bytes are the four full 7-bit groups of
  // `lo`, taken straight off it — the loop this replaces re-derived a shifted
  // 64-bit value (`(lo >>> 7) | (hi << 25)`) for *every* byte, which is the
  // dominant per-byte cost when every element is a full-width u64.
  out[pos++] = (lo & 0x7f) | 0x80;
  out[pos++] = ((lo >>> 7) & 0x7f) | 0x80;
  out[pos++] = ((lo >>> 14) & 0x7f) | 0x80;
  out[pos++] = ((lo >>> 21) & 0x7f) | 0x80;
  // Fifth byte straddles the halves: lo's top 4 bits, then hi's low 3.
  const b4 = (lo >>> 28) | ((hi & 0x07) << 4);
  let h = hi >>> 3;
  if (h === 0) {
    out[pos++] = b4;
    return pos;
  }
  out[pos++] = b4 | 0x80;
  // What is left is a 29-bit quantity — an ordinary 32-bit varint tail.
  while (h > 0x7f) {
    out[pos++] = (h & 0x7f) | 0x80;
    h >>>= 7;
  }
  out[pos++] = h;
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
 * Read a varint from `buf` starting at `pos`. Reports the same two decode
 * failures the streaming path does (MESSAGE_SPEC §7): throws a
 * {@link SofabError} with code `INVALID_MSG` on overflow past 64 bits (malformed
 * regardless of what follows — including nothing at all: ten continuation bytes
 * then end of input are INVALID, not INCOMPLETE), and `INCOMPLETE` if the buffer
 * ends mid-varint short of that bound (an unterminated varint that more bytes
 * could still complete).
 */
export function decodeVarint(buf: Uint8Array, pos: number): VarintResult {
  // Accumulate into two 32-bit *number* halves and materialise the `bigint`
  // once, at the end — the per-byte `BigInt(b) << shift` this replaces
  // allocated two `bigint`s for every byte consumed (see {@link "./bits64"}).
  let lo = 0;
  let hi = 0;
  let bytes = 0;
  for (;;) {
    // Overflow is decided before truncation, and deliberately so: reaching here
    // with a full accumulator means the byte that filled it had its continuation
    // flag set (a terminator returns below), so an 11th byte is *required* — past
    // the 10-byte / 64-bit maximum §4.1 puts on the *encoding*, not on the value.
    // That is settled by bytes already in hand, so §5.2 makes it INVALID even
    // when the input stops right there; the verdict must not depend on how much
    // of it has arrived. Same precedence as the resumable reader in
    // `decode/state.ts` and the unrolled ones in `decode/fast.ts` and
    // `decode/cursor.ts` (corelib-ts#113).
    if (bytes >= VARINT_MAX_BYTES) throw invalidMsgError("varint overflow");
    if (pos >= buf.length) throw incompleteError("truncated varint");
    const byte = buf[pos++]!;
    // 10th byte carries only bit 63 below 64; any higher payload bit would
    // spill past bit 63 and is a >64-bit overflow (silently accepted before).
    if (bytes === VARINT_MAX_BYTES - 1 && (byte & 0x7f) > 1) {
      throw invalidMsgError("varint overflow");
    }
    if (bytes < 4) lo |= (byte & 0x7f) << (7 * bytes);
    else if (bytes === 4) {
      lo |= (byte & 0x0f) << 28;
      hi |= (byte >> 4) & 0x07;
    } else hi |= (byte & 0x7f) << (7 * bytes - 32);
    bytes++;
    if ((byte & 0x80) === 0) return { value: joinU64(lo >>> 0, hi >>> 0), pos };
  }
}
