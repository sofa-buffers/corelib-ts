/**
 * §7.2 item 6's named truncation case: a `fixlen_word` **cut after its first
 * byte**, with that byte carrying a **reserved subtype**.
 *
 * > Cover a `fixlen_word` cut after its first byte with that byte carrying a
 * > reserved subtype (`0x4`–`0x7`): the subtype is already settled by the low 3
 * > bits, so an implementation that evaluates it early answers `INVALID` where
 * > §4.1.1 requires `INCOMPLETE`. Nothing else in this list exercises the
 * > no-partial-evaluation rule — the dangling `0x80` carries no settled
 * > sub-field to peek at.
 *
 * The rule under test is §4.1.1: no part of an incomplete varint may influence
 * an outcome. A `fixlen_word` is `(length << 3) | subtype`, so its **subtype is
 * final in the first byte** — the continuation bytes only widen the length. A
 * decoder that reads `byte & 7` before the varint has terminated therefore has a
 * settled, and here illegal, value in hand one byte early, and must not act on
 * it.
 *
 * The truncation tests elsewhere in the suite cannot reach this: the dangling
 * `0x80` of `array-fixlen-word-order.test.ts` and `field-begin.test.ts` carries
 * subtype `0`, and every reserved-subtype case in `istream.malformed.test.ts`,
 * `istream.invalid-latch.test.ts`, `long-scalar.test.ts` and
 * `sequence-skip.test.ts` feeds a **complete** word — which is the INVALID case,
 * not the no-partial-evaluation one.
 *
 * Both lanes are covered, because they are two implementations of the same word:
 * the header fast lane (`varintQuick`/`varintFull`) on the one-shot path, and the
 * resumable ladder (`varintStep`) at one byte per `feed`.
 */

import { describe, expect, it } from "vitest";
import {
  DecodeStatus,
  IStream,
  SofabError,
  SofabErrorCode,
  decode,
  type Visitor,
} from "../src/index.js";

/** The four reserved fixlen subtypes: 0/1/2/3 are fp32/fp64/string/blob. */
const RESERVED = [4, 5, 6, 7] as const;

/** A visitor that would materialize everything, so nothing is skipped away. */
const greedy: Visitor = {
  fixlenBegin: () => undefined,
  string: () => undefined,
  blob: () => undefined,
  fp32: () => undefined,
  fp64: () => undefined,
  arrayBegin: () => true,
  arrayFp32: () => undefined,
  arrayFp64: () => undefined,
};

/** The §6.3 code `decode()` reports for `buf`, or `undefined` when it completes. */
function oneShot(buf: Uint8Array): SofabErrorCode | undefined {
  try {
    decode(buf, greedy);
    return undefined;
  } catch (e) {
    if (e instanceof SofabError) return e.code;
    throw e;
  }
}

/** The same bytes through `IStream`, one byte per `feed`. */
function streamed(buf: Uint8Array): DecodeStatus {
  const is = new IStream(greedy);
  let st: DecodeStatus = DecodeStatus.Complete;
  try {
    for (const b of buf) st = is.feed(Uint8Array.of(b));
  } catch (e) {
    if (e instanceof SofabError) return DecodeStatus.Invalid;
    throw e;
  }
  return st;
}

/** Field header for id 0: `(0 << 3) | wireType`. */
const FIXLEN = 0x02; // scalar fixlen value
const ARRAY_FIXLEN = 0x05; // fixlen array

describe("§7.2 item 6 — a fixlen_word cut after a first byte carrying a reserved subtype", () => {
  describe.each(RESERVED)("subtype %i", (sub) => {
    // `0x80 | sub`: continuation bit set, so the word is unterminated, while the
    // low three bits already hold the reserved subtype.
    const cutLow = Uint8Array.of(FIXLEN, 0x80 | sub);
    // The same, with a length bit set too — a longer word, same settled subtype.
    const cutHigh = Uint8Array.of(FIXLEN, 0x88 | sub);

    it("is INCOMPLETE on the one-shot path, not INVALID", () => {
      expect(oneShot(cutLow)).toBe(SofabErrorCode.Incomplete);
      expect(oneShot(cutHigh)).toBe(SofabErrorCode.Incomplete);
    });

    it("is INCOMPLETE on the resumable path too, at one byte per feed", () => {
      expect(streamed(cutLow)).toBe(DecodeStatus.Incomplete);
      expect(streamed(cutHigh)).toBe(DecodeStatus.Incomplete);
    });

    it("is INVALID once the word terminates — the control", () => {
      // `(0 << 3) | sub`: a complete word, so the reserved subtype is now settled
      // *and* readable, and §5.2.2 makes it INVALID on both lanes.
      const whole = Uint8Array.of(FIXLEN, sub);
      expect(oneShot(whole)).toBe(SofabErrorCode.InvalidMsg);
      expect(streamed(whole)).toBe(DecodeStatus.Invalid);

      // …and with the continuation byte supplied rather than withheld: the same
      // word, spelled non-minimally, is still INVALID and never INCOMPLETE.
      const continued = Uint8Array.of(FIXLEN, 0x80 | sub, 0x00);
      expect(oneShot(continued)).toBe(SofabErrorCode.InvalidMsg);
      expect(streamed(continued)).toBe(DecodeStatus.Invalid);
    });

    it("holds for a fixlen array's shared element word as well", () => {
      // header, element_count = 2, then the element word cut after one byte.
      const cut = Uint8Array.of(ARRAY_FIXLEN, 0x02, 0x80 | sub);
      expect(oneShot(cut)).toBe(SofabErrorCode.Incomplete);
      expect(streamed(cut)).toBe(DecodeStatus.Incomplete);

      // Control: the completed word is INVALID — §5.2.2's reserved-subtype row.
      const whole = Uint8Array.of(ARRAY_FIXLEN, 0x02, sub);
      expect(oneShot(whole)).toBe(SofabErrorCode.InvalidMsg);
      expect(streamed(whole)).toBe(DecodeStatus.Invalid);
    });

    it("completes as an ordinary value once the missing bytes arrive", () => {
      // The other half of §7.2 item 6: feeding what was withheld must resolve the
      // INCOMPLETE rather than leave the decoder latched. Continuing the cut word
      // with `0x00` spells the same reserved subtype, so the resolution is the
      // INVALID verdict — reached only after the word terminated.
      const is = new IStream(greedy);
      expect(is.feed(Uint8Array.of(FIXLEN, 0x80 | sub))).toBe(DecodeStatus.Incomplete);
      let code: SofabErrorCode | undefined;
      try {
        is.feed(Uint8Array.of(0x00));
      } catch (e) {
        if (!(e instanceof SofabError)) throw e;
        code = e.code;
      }
      expect(code).toBe(SofabErrorCode.InvalidMsg);
    });
  });

  it("a legal subtype cut at the same place behaves identically — the discriminator", () => {
    // Without this pairing the tests above would also pass on a decoder that
    // answers INCOMPLETE to everything truncated for the wrong reason. String
    // (2) and blob (3) are the legal counterparts of the reserved rows.
    for (const sub of [0, 1, 2, 3]) {
      expect(oneShot(Uint8Array.of(FIXLEN, 0x80 | sub))).toBe(SofabErrorCode.Incomplete);
      expect(streamed(Uint8Array.of(FIXLEN, 0x80 | sub))).toBe(DecodeStatus.Incomplete);
    }
  });
});
