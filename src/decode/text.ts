/**
 * Decode-side text helper — the read-path twin of {@link "../encode/fixlen"}.
 *
 * Two things make a short string expensive to decode, and this avoids both.
 *
 * `TextDecoder.decode` needs a `Uint8Array` covering exactly the payload, so the
 * decoder has to build a `subarray` per string; on Node 24 that view alone costs
 * about a third of the whole read (~500 Ir/op for a 13-byte field). And the
 * decode itself is a WHATWG entry point whose per-call setup dwarfs the payload
 * at these sizes.
 *
 * The obvious fix — walk the bytes in JS and append with `+=`, the way
 * protobufjs does — trades one problem for another: the repeated concatenation
 * builds a **rope**, and the rope is flattened later, by the first consumer that
 * walks it. In a decode-then-encode round trip that consumer is the encoder's own
 * `utf8Length` / `utf8Write` pass, so the cost does not disappear, it moves out
 * of the decode where it is easy to miss. Measured on a 13-byte ASCII field
 * (decode plus one charCodeAt walk): TextDecoder 2006 Ir/op, rope 2095 — the
 * rope form looks 40 percent cheaper if only the decode is measured, and is
 * *worse* once the string is used.
 *
 * So an all-ASCII payload short enough to name its length is built with a
 * SINGLE `String.fromCharCode` call, which returns a flat string with no rope to
 * pay for afterwards: 858 Ir/op on the same measurement, less than half of
 * either alternative. Everything else — non-ASCII, or longer than
 * {@link FLAT_MAX} — goes to the fatal {@link TextDecoder} exactly as before.
 *
 * This stays **strict** (MESSAGE_SPEC section 8): the fast path is gated on every
 * byte being below 0x80, and each such byte is a well-formed single-byte UTF-8
 * sequence, so an all-ASCII run has nothing to reject. Any payload with a high
 * bit set is handed to the platform decoder whole and gets exactly the
 * validation it always got — the fast path can never accept bytes the platform
 * would refuse.
 */

const _utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Longest payload the flat fast path covers. Past this the per-call argument
 * list stops paying for itself against the platform decoder's vectorised scan,
 * and a chunked build would reintroduce the rope the fast path exists to avoid.
 */
const FLAT_MAX = 16;

/**
 * Decode `buf[start..end)` as strict UTF-8. Throws whatever the fatal
 * {@link TextDecoder} throws (a `TypeError`) on malformed input; callers map
 * that to the `INVALID` decode outcome.
 */
export function decodeUtf8(buf: Uint8Array, start: number, end: number): string {
  const n = end - start;
  if (n <= 0) return "";
  if (n <= FLAT_MAX) {
    // ASCII gate: one pass, no allocation, and it settles validity for the whole
    // payload before a single character is built.
    let ascii = true;
    for (let k = start; k < end; k++) {
      if (buf[k]! & 0x80) {
        ascii = false;
        break;
      }
    }
    if (ascii) {
      switch (n) {
      case 1: return String.fromCharCode(buf[start]!);
      case 2: return String.fromCharCode(buf[start]!, buf[start + 1]!);
      case 3: return String.fromCharCode(buf[start]!, buf[start + 1]!, buf[start + 2]!);
      case 4: return String.fromCharCode(buf[start]!, buf[start + 1]!, buf[start + 2]!, buf[start + 3]!);
      case 5: return String.fromCharCode(buf[start]!, buf[start + 1]!, buf[start + 2]!, buf[start + 3]!, buf[start + 4]!);
      case 6: return String.fromCharCode(buf[start]!, buf[start + 1]!, buf[start + 2]!, buf[start + 3]!, buf[start + 4]!, buf[start + 5]!);
      case 7: return String.fromCharCode(buf[start]!, buf[start + 1]!, buf[start + 2]!, buf[start + 3]!, buf[start + 4]!, buf[start + 5]!, buf[start + 6]!);
      case 8: return String.fromCharCode(buf[start]!, buf[start + 1]!, buf[start + 2]!, buf[start + 3]!, buf[start + 4]!, buf[start + 5]!, buf[start + 6]!, buf[start + 7]!);
      case 9: return String.fromCharCode(buf[start]!, buf[start + 1]!, buf[start + 2]!, buf[start + 3]!, buf[start + 4]!, buf[start + 5]!, buf[start + 6]!, buf[start + 7]!, buf[start + 8]!);
      case 10: return String.fromCharCode(buf[start]!, buf[start + 1]!, buf[start + 2]!, buf[start + 3]!, buf[start + 4]!, buf[start + 5]!, buf[start + 6]!, buf[start + 7]!, buf[start + 8]!, buf[start + 9]!);
      case 11: return String.fromCharCode(buf[start]!, buf[start + 1]!, buf[start + 2]!, buf[start + 3]!, buf[start + 4]!, buf[start + 5]!, buf[start + 6]!, buf[start + 7]!, buf[start + 8]!, buf[start + 9]!, buf[start + 10]!);
      case 12: return String.fromCharCode(buf[start]!, buf[start + 1]!, buf[start + 2]!, buf[start + 3]!, buf[start + 4]!, buf[start + 5]!, buf[start + 6]!, buf[start + 7]!, buf[start + 8]!, buf[start + 9]!, buf[start + 10]!, buf[start + 11]!);
      case 13: return String.fromCharCode(buf[start]!, buf[start + 1]!, buf[start + 2]!, buf[start + 3]!, buf[start + 4]!, buf[start + 5]!, buf[start + 6]!, buf[start + 7]!, buf[start + 8]!, buf[start + 9]!, buf[start + 10]!, buf[start + 11]!, buf[start + 12]!);
      case 14: return String.fromCharCode(buf[start]!, buf[start + 1]!, buf[start + 2]!, buf[start + 3]!, buf[start + 4]!, buf[start + 5]!, buf[start + 6]!, buf[start + 7]!, buf[start + 8]!, buf[start + 9]!, buf[start + 10]!, buf[start + 11]!, buf[start + 12]!, buf[start + 13]!);
      case 15: return String.fromCharCode(buf[start]!, buf[start + 1]!, buf[start + 2]!, buf[start + 3]!, buf[start + 4]!, buf[start + 5]!, buf[start + 6]!, buf[start + 7]!, buf[start + 8]!, buf[start + 9]!, buf[start + 10]!, buf[start + 11]!, buf[start + 12]!, buf[start + 13]!, buf[start + 14]!);
      case 16: return String.fromCharCode(buf[start]!, buf[start + 1]!, buf[start + 2]!, buf[start + 3]!, buf[start + 4]!, buf[start + 5]!, buf[start + 6]!, buf[start + 7]!, buf[start + 8]!, buf[start + 9]!, buf[start + 10]!, buf[start + 11]!, buf[start + 12]!, buf[start + 13]!, buf[start + 14]!, buf[start + 15]!);
      }
    }
  }
  return _utf8.decode(buf.subarray(start, end));
}
