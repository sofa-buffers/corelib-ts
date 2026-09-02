/**
 * An array count with bit 63 set is INVALID — it must never read back negative.
 *
 * The count word is accumulated into two 32-bit halves with bitwise ops, so bit
 * 63 lands on the high half's sign bit. Read without a `>>> 0` it comes back as
 * a large *negative* number, which is not `> ARRAY_MAX` and not
 * `> maxArrayCount`: both guards pass, the element loop (`i < count`) runs zero
 * times, and the array is treated as empty. A message truncated inside that
 * array is then reported COMPLETE — an *accept* of input every other
 * implementation rejects, on one fully attacker-controlled bit (corelib-ts#88).
 *
 * The 2^62 vector is the control: one bit lower, nine bytes instead of ten. It
 * was always rejected, which pins the defect on the sign bit rather than on
 * varint length — and keeps this test honest about *why* the fix works.
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

// `0x3b` is an unsigned-array header at id 7: wire type 3 (ArrayUnsigned), id 7.
// Its value is skipped, which is all the decoder has to do to trip the bug.
const HEADER = 0x3b;

const BIT63 = new Uint8Array([HEADER, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
const BIT63_ALT = new Uint8Array([HEADER, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe5, 0x01]);
const BIT62 = new Uint8Array([HEADER, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x40]);

/** One-shot path — the whole message in one buffer. */
function viaFast(bytes: Uint8Array): string {
  try {
    decode(bytes, {} as Visitor);
    return DecodeStatus.Complete;
  } catch (e) {
    return (e as { code: string }).code === SofabErrorCode.InvalidMsg
      ? DecodeStatus.Invalid
      : DecodeStatus.Incomplete;
  }
}

/** Chunked push path, one byte per feed — the worst case for a resumable varint. */
function viaIStream(bytes: Uint8Array): string {
  try {
    const is = new IStream({} as Visitor);
    // The verdict is what the last `feed` returned — there is no accessor to ask
    // afterwards, and a stream that got no bytes at all sits on a boundary.
    let st: string = DecodeStatus.Complete;
    for (let i = 0; i < bytes.length; i++) st = is.feed(bytes.subarray(i, i + 1));
    return st;
  } catch (e) {
    return (e as { code: string }).code === SofabErrorCode.InvalidMsg
      ? DecodeStatus.Invalid
      : DecodeStatus.Incomplete;
  }
}

const paths: Array<[string, (b: Uint8Array) => string]> = [
  ["decode", viaFast],
  ["IStream", viaIStream],
];

describe("array count with bit 63 set", () => {
  for (const [name, run] of paths) {
    it(`${name} rejects a 2^63 count instead of accepting a truncated array`, () => {
      expect(run(BIT63)).toBe(DecodeStatus.Invalid);
    });

    it(`${name} rejects a count whose high word is all ones`, () => {
      expect(run(BIT63_ALT)).toBe(DecodeStatus.Invalid);
    });

    it(`${name} still rejects the 2^62 control, one bit below the sign bit`, () => {
      expect(run(BIT62)).toBe(DecodeStatus.Invalid);
    });
  }

  it("both entry points agree on every vector", () => {
    for (const bytes of [BIT63, BIT63_ALT, BIT62]) {
      const verdicts = paths.map(([, run]) => run(bytes));
      expect(new Set(verdicts).size).toBe(1);
    }
  });

  it("a receiver cap cannot be slipped either", () => {
    // A receiver cap is compared with the same `>` (§6.2.1, in the layer that
    // holds the number) — a negative count would pass that guard just as it
    // passed the ARRAY_MAX one. It never gets the chance: the format ceiling is
    // decided first, in the codec, and rejects the header outright.
    const capped: Visitor = {
      arrayBegin(_id, _kind, count) {
        if (count > 4) throw new SofabError(SofabErrorCode.LimitExceeded, "over cap");
      },
    };
    expect(() => decode(BIT63, capped)).toThrow();
  });
});
