/**
 * Cross-language conformance: encode and decode every shared test vector.
 *
 * For each vector we (1) replay its field list and assert the bytes equal the
 * reference hex, and (2) decode the reference hex, re-encode what we read, and
 * assert it reproduces the same hex — proving the decoder read every field,
 * value and length correctly.
 */

import { describe, expect, it } from "vitest";
import { OStream, decode } from "../src/index.js";
import { bytesToHex, hexToBytes } from "./helpers/hex.js";
import { TranscodeVisitor } from "./helpers/recording-visitor.js";
import { encodeFields, loadVectors } from "./helpers/vectors.js";

const vectors = loadVectors();

describe("conformance vectors", () => {
  it("loads the shared suite", () => {
    expect(vectors.length).toBeGreaterThan(40);
  });

  describe.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    it("encodes to the reference bytes", () => {
      const os = new OStream();
      encodeFields(os, vector.fields);
      expect(bytesToHex(os.bytes())).toBe(vector.serialized.hex);
    });

    it("decodes and round-trips back to the reference bytes", () => {
      const out = new OStream();
      decode(hexToBytes(vector.serialized.hex), new TranscodeVisitor(out));
      expect(bytesToHex(out.bytes())).toBe(vector.serialized.hex);
    });
  });
});
