/**
 * `OStream.writeFixlen` must not emit a `fixlen_word` every conformant decoder
 * has to reject.
 *
 * CORELIB_PLAN §4.6 fixes the domain of the word's low three bits: subtypes
 * `0x4`–`0x7` are **reserved** and a decoder **must** reject a field carrying
 * one as malformed (`INVALID`, §5.2), and an `fp32` / `fp64` payload is
 * **exactly** 4 / 8 bytes — any other declared length for those subtypes is
 * malformed too, rejected the moment the word is read. §6.3 makes the encode
 * side of both an `InvalidArgument`: symmetric with the decoder's verdict, like
 * the strict-UTF-8 pair (`INVALID` on decode, `ARGUMENT` on encode).
 *
 * `writeFixlen` is the byte-level entry point — the one writer that takes the
 * subtype from the caller instead of picking it — and is what the documented
 * bit-exact transcode path uses (`Visitor.fp32`'s `bits` → `writeFp32Bits(id, bits`,
 * Fp32)`). It validated only the length ceiling (corelib-ts#110), so a caller
 * handing over a wrongly sized slice got silently malformed output instead of
 * an error. The typed writers (`writeFp32`, `writeFp64`, `writeString`,
 * `writeBlob`) are correct by construction and are unaffected.
 */

import { describe, expect, it } from "vitest";
import { FixlenSubtype, OStream, SofabError, SofabErrorCode, decode, growingOStream } from "../src/index.js";

/** The reserved subtypes, as the runtime values a cast can smuggle in. */
const RESERVED = [4, 5, 6, 7] as unknown as FixlenSubtype[];

/** Run `fn` and return the SofabError code it throws (or fail). */
function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SofabError) return e.code;
    throw e;
  }
  throw new Error("expected a SofabError, but nothing was thrown");
}

/** Assert `fn` is refused with `ARGUMENT` *before* any byte reaches the buffer. */
function refused(os: OStream, fn: () => void): void {
  expect(codeOf(fn)).toBe(SofabErrorCode.Argument);
  expect(os.bytes().length).toBe(0);
}

describe("writeFixlen rejects a reserved subtype (§4.6, §6.3)", () => {
  for (const sub of RESERVED) {
    it(`subtype 0x${(sub as number).toString(16)}`, () => {
      const os = growingOStream();
      refused(os, () => os.writeFixlen(0, Uint8Array.of(1), sub));
    });

    it(`subtype 0x${(sub as number).toString(16)} with an empty payload`, () => {
      const os = growingOStream();
      refused(os, () => os.writeFixlen(3, new Uint8Array(0), sub));
    });
  }
});

describe("writeFixlen rejects a wrong-width fp32 / fp64 payload (§4.6, §6.3)", () => {
  for (const len of [0, 1, 3, 5, 8]) {
    it(`fp32 of ${len} bytes`, () => {
      const os = growingOStream();
      refused(os, () => os.writeFixlen(0, new Uint8Array(len), FixlenSubtype.Fp32));
    });
  }

  for (const len of [0, 1, 4, 7, 9]) {
    it(`fp64 of ${len} bytes`, () => {
      const os = growingOStream();
      refused(os, () => os.writeFixlen(0, new Uint8Array(len), FixlenSubtype.Fp64));
    });
  }

  it("accepts the exact widths, and they match the typed writers byte for byte", () => {
    const fp32 = growingOStream();
    fp32.writeFixlen(0, Uint8Array.of(0x00, 0x00, 0x80, 0x3f), FixlenSubtype.Fp32);
    const typed32 = growingOStream();
    typed32.writeFp32(0, 1);
    expect(fp32.bytes()).toEqual(typed32.bytes());
    expect(fp32.bytes().subarray(0, 2)).toEqual(Uint8Array.of(0x02, 0x20)); // (4<<3)|0

    const fp64 = growingOStream();
    fp64.writeFixlen(0, Uint8Array.of(0, 0, 0, 0, 0, 0, 0xf0, 0x3f), FixlenSubtype.Fp64);
    const typed64 = growingOStream();
    typed64.writeFp64(0, 1);
    expect(fp64.bytes()).toEqual(typed64.bytes());
    expect(fp64.bytes().subarray(0, 2)).toEqual(Uint8Array.of(0x02, 0x41)); // (8<<3)|1
  });
});

describe("writeFixlen still takes any string / blob length", () => {
  for (const len of [0, 1, 4, 7, 8, 300]) {
    it(`blob of ${len} bytes`, () => {
      const os = growingOStream();
      os.writeBlob(9, new Uint8Array(len));
      expect(os.bytes().length).toBeGreaterThan(0);
    });

    it(`string of ${len} bytes`, () => {
      const os = growingOStream();
      os.writeFixlen(9, new Uint8Array(len).fill(0x61), FixlenSubtype.String);
      expect(os.bytes().length).toBeGreaterThan(0);
    });
  }
});

describe("whatever writeFixlen accepts, a decoder accepts (§4.6)", () => {
  // The property behind the two rules above: the encoder's fixlen domain is
  // exactly the decoder's. Every call the encoder lets through must produce
  // bytes that decode cleanly, and every call it refuses must be one whose
  // bytes the decoder would have rejected.
  const subtypes: FixlenSubtype[] = [
    FixlenSubtype.Fp32,
    FixlenSubtype.Fp64,
    FixlenSubtype.String,
    FixlenSubtype.Blob,
    ...RESERVED,
  ];

  for (const sub of subtypes) {
    for (const len of [0, 3, 4, 7, 8]) {
      it(`subtype 0x${(sub as number).toString(16)}, ${len} bytes`, () => {
        const os = growingOStream();
        let threw = false;
        try {
          os.writeFixlen(11, new Uint8Array(len), sub);
        } catch (e) {
          expect(e).toBeInstanceOf(SofabError);
          expect((e as SofabError).code).toBe(SofabErrorCode.Argument);
          threw = true;
        }
        const legal = (sub as number) <= FixlenSubtype.Blob &&
          (sub !== FixlenSubtype.Fp32 || len === 4) &&
          (sub !== FixlenSubtype.Fp64 || len === 8);
        expect(threw).toBe(!legal);
        if (legal) expect(() => decode(os.bytes(), {})).not.toThrow();
      });
    }
  }
});
