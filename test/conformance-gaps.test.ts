/**
 * Conformance fixes for the updated wire spec:
 *
 * - §4.7/§4.8: zero-count arrays are valid, fully-specified empty arrays. A
 *   zero-count unsigned/signed array is exactly `[ header ][ count = 0 ]`; a
 *   zero-count fixlen array is `[ header ][ count = 0 ][ fixlen_word ]` (no
 *   payload) — the `fixlen_word` is always present so an empty fp32 array stays
 *   distinct from an empty fp64 one.
 * - §4.9/§6.2: nesting deeper than `MAX_DEPTH` (255) is rejected on both encode
 *   and decode, rather than risking unbounded recursion.
 */

import { describe, expect, it } from "vitest";
import {
  ArrayKind,
  IStream,
  MAX_DEPTH,
  OStream,
  SofabError,
  SofabErrorCode,
  decode,
  type Visitor,
} from "../src/index.js";
import { bytesToHex } from "./helpers/hex.js";
import { RecordingVisitor } from "./helpers/recording-visitor.js";

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

/** Decode `bytes` one byte at a time through the resumable state machine. */
function decodeChunked(bytes: Uint8Array, visitor: Visitor): void {
  const is = new IStream();
  for (let i = 0; i < bytes.length; i++) is.feed(bytes.subarray(i, i + 1), visitor);
  is.end();
}

describe("zero-count arrays encode to the canonical empty form", () => {
  it("unsigned array (id 0) -> 03 00", () => {
    const os = new OStream();
    os.writeUnsignedArray(0, []);
    expect(bytesToHex(os.bytes())).toBe("0300");
  });

  it("signed array (id 0) -> 04 00", () => {
    const os = new OStream();
    os.writeSignedArray(0, []);
    expect(bytesToHex(os.bytes())).toBe("0400");
  });

  it("fp32 array (id 0) -> 05 00 20 (fixlen_word, no payload)", () => {
    const os = new OStream();
    os.writeFp32Array(0, []);
    expect(bytesToHex(os.bytes())).toBe("050020");
  });

  it("fp64 array (id 0) -> 05 00 41 (fixlen_word, no payload)", () => {
    const os = new OStream();
    os.writeFp64Array(0, []);
    expect(bytesToHex(os.bytes())).toBe("050041");
  });
});

describe("zero-count arrays round-trip to an empty array", () => {
  const cases: Array<[string, (os: OStream) => void, ArrayKind]> = [
    ["unsigned", (os) => os.writeUnsignedArray(7, []), ArrayKind.Unsigned],
    ["signed", (os) => os.writeSignedArray(7, []), ArrayKind.Signed],
    // An empty fixlen array always carries its element-length word, so the
    // decoder still tells fp32 from fp64 even with zero elements.
    ["fp32", (os) => os.writeFp32Array(7, []), ArrayKind.Fp32],
    ["fp64", (os) => os.writeFp64Array(7, []), ArrayKind.Fp64],
  ];

  for (const [name, write, kind] of cases) {
    it(`${name}: fast decode delivers begin(count 0)+end with no elements`, () => {
      const os = new OStream();
      write(os);
      const seen = new RecordingVisitor();
      decode(os.bytes(), seen);
      expect(seen.events).toEqual([{ kind: "array", id: 7, arrayKind: kind, values: [] }]);
    });

    it(`${name}: streaming decode (one byte at a time) matches`, () => {
      const os = new OStream();
      write(os);
      const bytes = os.bytes().slice();
      const seen = new RecordingVisitor();
      decodeChunked(bytes, seen);
      expect(seen.events).toEqual([{ kind: "array", id: 7, arrayKind: kind, values: [] }]);
    });
  }

  it("accepts the canonical empty wire forms directly", () => {
    // Integer arrays: [ header ][ count = 0 ]. Fixlen arrays additionally carry
    // the always-present fixlen_word (0x20 = fp32, 0x41 = fp64).
    const cases: Array<[number[], ArrayKind]> = [
      [[0x03, 0x00], ArrayKind.Unsigned],
      [[0x04, 0x00], ArrayKind.Signed],
      [[0x05, 0x00, 0x20], ArrayKind.Fp32],
      [[0x05, 0x00, 0x41], ArrayKind.Fp64],
    ];
    for (const [bytes, kind] of cases) {
      const seen = new RecordingVisitor();
      decode(Uint8Array.from(bytes), seen);
      expect(seen.events).toEqual([{ kind: "array", id: 0, arrayKind: kind, values: [] }]);
    }
  });
});

describe("MAX_DEPTH (255) is enforced", () => {
  it("is exported and equals 255", () => {
    expect(MAX_DEPTH).toBe(255);
  });

  it("encoder allows exactly 255 nested sequences but refuses a 256th", () => {
    const os = new OStream();
    for (let i = 0; i < MAX_DEPTH; i++) os.writeSequenceBegin(0);
    expect(codeOf(() => os.writeSequenceBegin(0))).toBe(SofabErrorCode.Usage);
  });

  it("fast decoder accepts 255-deep nesting", () => {
    // 255 sequence-start bytes (0x06) followed by 255 sequence-end bytes (0x07).
    const bytes = Uint8Array.from([
      ...new Array(MAX_DEPTH).fill(0x06),
      ...new Array(MAX_DEPTH).fill(0x07),
    ]);
    expect(() => decode(bytes, {})).not.toThrow();
  });

  it("fast decoder rejects 256-deep nesting with InvalidMsg", () => {
    const bytes = Uint8Array.from(new Array(MAX_DEPTH + 1).fill(0x06));
    expect(codeOf(() => decode(bytes, {}))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("streaming decoder rejects 256-deep nesting with InvalidMsg", () => {
    const bytes = Uint8Array.from(new Array(MAX_DEPTH + 1).fill(0x06));
    expect(codeOf(() => decodeChunked(bytes, {}))).toBe(SofabErrorCode.InvalidMsg);
  });
});
