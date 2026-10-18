/**
 * The elements of an array **nobody asked for** (`arrayBulk` absent or declining):
 * they are walked over, not decoded into existence — §6.7.2's `skip` intent — and
 * walking is now a scan for the byte that clears the continuation bit rather than
 * a full varint read, because the value it would build is discarded.
 *
 * What must NOT change with it is the verdict. §4.1.3 bounds the *bytes*: a varint
 * past ten bytes is malformed, and so is a tenth byte carrying more than bit 63.
 * Those are facts about the message, not about who wanted the field, so a skipped
 * element has to be refused exactly where a delivered one is — otherwise the same
 * bytes would be `INVALID` for one visitor and `COMPLETE` for another, which is the
 * one thing §5.2.3 does not allow.
 *
 * Each case below is therefore decoded **twice**: once by a visitor that takes the
 * elements and once by one that does not declare `arrayBulk` at all. The two
 * verdicts are compared, not just asserted.
 */

import { describe, expect, it } from "vitest";
import { SofabErrorCode, WireType, decode, type ArrayTarget, type Visitor } from "../src/index.js";

const U64 = { minLo: 0, minHi: 0, maxLo: 0xffffffff, maxHi: 0xffffffff };

/** `[ header: id 1, array of unsigned ][ count = 1 ][ element ]`. */
function oneElementArray(element: number[]): Uint8Array {
  return Uint8Array.from([(1 << 3) | WireType.ArrayUnsigned, 1, ...element]);
}

/** The verdict `bytes` gets, as a code or `"COMPLETE"`. */
function verdict(bytes: Uint8Array, visitor: Visitor): string {
  try {
    decode(bytes, visitor);
    return "COMPLETE";
  } catch (e) {
    return (e as { code?: string }).code ?? "OTHER";
  }
}

const taking: Visitor = {
  arrayBulk: (_id, _kind, count): ArrayTarget => ({
    lo: new Uint32Array(count),
    hi: new Uint32Array(count),
    ...U64,
  }),
};
/** Declares no `arrayBulk`, so every array is walked rather than delivered. */
const skipping: Visitor = {};

describe("an element of a skipped array (§6.7.2, §4.1.3)", () => {
  it("is walked, and a well-formed one is COMPLETE either way", () => {
    // Ten bytes, bit 63 only: the longest legal varint there is.
    const bytes = oneElementArray([...Array(9).fill(0x80), 0x01]);
    expect(verdict(bytes, skipping)).toBe("COMPLETE");
    expect(verdict(bytes, taking)).toBe("COMPLETE");
  });

  it("is INVALID past ten bytes, whether or not anyone wanted it", () => {
    const bytes = oneElementArray([...Array(10).fill(0x80), 0x00]);
    expect(verdict(bytes, skipping)).toBe(SofabErrorCode.InvalidMsg);
    expect(verdict(bytes, taking)).toBe(SofabErrorCode.InvalidMsg);
  });

  it("is INVALID when its tenth byte carries more than bit 63", () => {
    // 0x02 in the tenth byte is payload bit 64 — past the 64-bit value domain,
    // and the refusal a byte-counting scan would miss.
    const bytes = oneElementArray([...Array(9).fill(0x80), 0x02]);
    expect(verdict(bytes, skipping)).toBe(SofabErrorCode.InvalidMsg);
    expect(verdict(bytes, taking)).toBe(SofabErrorCode.InvalidMsg);
  });

  it("is INCOMPLETE when the walk runs out of bytes mid-element", () => {
    const bytes = oneElementArray([0x80, 0x80]);
    expect(verdict(bytes, skipping)).toBe(SofabErrorCode.Incomplete);
    expect(verdict(bytes, taking)).toBe(SofabErrorCode.Incomplete);
  });

  it("walks a whole run of elements, long and short mixed", () => {
    const bytes = Uint8Array.from([
      (1 << 3) | WireType.ArrayUnsigned,
      4,
      0x01, // one byte
      0xff,
      0x01, // two
      ...Array(9).fill(0x80),
      0x01, // ten
      0x7f, // one
    ]);
    expect(verdict(bytes, skipping)).toBe("COMPLETE");
    expect(verdict(bytes, taking)).toBe("COMPLETE");
  });
});
