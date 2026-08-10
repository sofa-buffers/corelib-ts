/**
 * LEB128 variable-length integer coding — the **encode** half.
 *
 * Each byte carries seven payload bits with the high bit as a continuation flag;
 * bytes are little-endian (least-significant group first). Everything here is
 * `bigint`-free: a 64-bit value arrives already split into two 32-bit halves
 * (`…LoHi`, the shape {@link "./bits64"} produces), or as a `number` below 2^53
 * (`…Num`, the shape ids, lengths, counts and small scalars have).
 *
 * There is no varint *reader* in this module. Each decode surface reads varints
 * in the shape its own control flow needs — the resumable byte-at-a-time
 * accumulator in `decode/state.ts`, the unrolled whole-buffer ladder shared by
 * `Cursor` and `decode()` in `decode/reader.ts` — and a third, general reader
 * with no production caller was only ever a fourth copy of the same overflow and
 * truncation rules to keep in lockstep (it had to be fixed alongside them in
 * corelib-ts#82, #88, #99/#100, #113, #131). The rules are pinned on the shipped
 * surfaces instead, in `test/varint.test.ts` and `test/varint-reader-shared.test.ts`.
 */

/**
 * Number of bytes {@link encodeVarintLoHi} will write for the 64-bit value held
 * as two unsigned 32-bit halves, so a caller that has already split a value
 * sizes it without splitting again.
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
 * Write a 64-bit value already split into two unsigned 32-bit halves as a
 * varint. Callers holding a `bigint` split it once through the shared
 * bit-punning scratch ({@link "./bits64"}, which allocates no `bigint` at all)
 * or hold a {@link Long}, and then stay on the number path here — avoiding both
 * the per-value `bigint` churn that dominates the 64-bit array encoders (which
 * JavaScriptCore optimizes far worse than V8) and the ~20 short-lived `bigint`s
 * a per-byte `v & 0x7fn; v >>= 7n` loop would make. The caller guarantees
 * `VARINT_MAX_BYTES` bytes of room from `pos`; `lo`/`hi` are coerced to uint32.
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
 * `out` at `pos`. The number-only sibling of {@link encodeVarintLoHi}: it avoids
 * `bigint` entirely, which is the encoder's hot path for ids, lengths, counts
 * and the very common small scalar. The caller guarantees `VARINT_MAX_BYTES`
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
