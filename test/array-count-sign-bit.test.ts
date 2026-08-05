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
import { Cursor, DecodeStatus, IStream, SofabErrorCode, decode, type Visitor } from "../src/index.js";

// `0x3b` is an unsigned-array header at id 7: wire type 3 (ArrayUnsigned), id 7.
// Its value is skipped, which is all the decoder has to do to trip the bug.
const HEADER = 0x3b;

const BIT63 = new Uint8Array([HEADER, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
const BIT63_ALT = new Uint8Array([HEADER, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe5, 0x01]);
const BIT62 = new Uint8Array([HEADER, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x40]);

/** Pull path — a generated decoder skipping a field its schema declares scalar. */
function viaCursor(bytes: Uint8Array): string {
  try {
    const c = new Cursor(bytes);
    while (c.readHeader()) c.skip(c.wire);
    return DecodeStatus.Complete;
  } catch (e) {
    return (e as { code: string }).code === SofabErrorCode.InvalidMsg
      ? DecodeStatus.Invalid
      : DecodeStatus.Incomplete;
  }
}

/** Contiguous push path. */
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
    const is = new IStream();
    for (let i = 0; i < bytes.length; i++) is.feed(bytes.subarray(i, i + 1), {} as Visitor);
    return is.end();
  } catch (e) {
    return (e as { code: string }).code === SofabErrorCode.InvalidMsg
      ? DecodeStatus.Invalid
      : DecodeStatus.Incomplete;
  }
}

const paths: Array<[string, (b: Uint8Array) => string]> = [
  ["Cursor", viaCursor],
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

  it("all three decode paths agree on every vector", () => {
    for (const bytes of [BIT63, BIT63_ALT, BIT62]) {
      const verdicts = paths.map(([, run]) => run(bytes));
      expect(new Set(verdicts).size).toBe(1);
    }
  });

  it("a limit cap cannot be slipped either", () => {
    // maxArrayCount is compared with the same `>` — a negative count would pass
    // this guard just as it passed the ARRAY_MAX one.
    const c = new Cursor(BIT63, { maxArrayCount: 4 });
    expect(() => {
      while (c.readHeader()) c.skip(c.wire);
    }).toThrow();
  });
});
