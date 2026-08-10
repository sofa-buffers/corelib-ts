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

    // The shape CORELIB_PLAN §5.1 puts first: one caller buffer sized from the
    // schema's MAX_SIZE, with no owner and no sink. It reaches the wire through
    // different code than the accumulator above — a bulk string / array write is
    // taken only where the payload already fits where the cursor stands and
    // falls back to the element-at-a-time route where it does not — so both
    // routes are pinned against the reference bytes here: `0` slack is an
    // exactly-MAX_SIZE buffer (which cannot take a worst-case array reserve, so
    // the fallback runs), `4096` a roomy one (the bulk route throughout).
    it.each([0, 4096])("encodes to the reference bytes in a caller buffer (+%i)", (slack) => {
      const want = hexToBytes(vector.serialized.hex);
      const os = new OStream(new Uint8Array(want.length + slack));
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
