/**
 * The decoder must accept input split at *any* byte boundary. For every vector
 * we feed the bytes one at a time, and in 7-byte groups, and assert the decoded
 * round-trip still reproduces the reference hex — proving the state machine
 * resumes correctly across varints, fixlen payloads, array elements and nesting.
 */

import { describe, expect, it } from "vitest";
import { IStream, OStream } from "../src/index.js";
import { bytesToHex, hexToBytes } from "./helpers/hex.js";
import { TranscodeVisitor } from "./helpers/recording-visitor.js";
import { loadVectors } from "./helpers/vectors.js";

const vectors = loadVectors();

function feedInChunks(bytes: Uint8Array, chunkSize: number): string {
  const out = new OStream();
  const visitor = new TranscodeVisitor(out);
  const is = new IStream();
  for (let i = 0; i < bytes.length; i += chunkSize) {
    is.feed(bytes.subarray(i, i + chunkSize), visitor);
  }
  is.end();
  return bytesToHex(out.bytes());
}

describe("chunked feeding", () => {
  describe.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    const bytes = hexToBytes(vector.serialized.hex);

    it("decodes one byte at a time", () => {
      expect(feedInChunks(bytes, 1)).toBe(vector.serialized.hex);
    });

    it("decodes in 7-byte chunks", () => {
      expect(feedInChunks(bytes, 7)).toBe(vector.serialized.hex);
    });
  });

  it("handles an empty chunk without advancing", () => {
    const os = new OStream();
    os.writeUnsigned(1, 42n);
    const out = new OStream();
    const is = new IStream();
    is.feed(new Uint8Array(0), new TranscodeVisitor(out));
    is.feed(os.bytes(), new TranscodeVisitor(out));
    is.end();
    expect(bytesToHex(out.bytes())).toBe(bytesToHex(os.bytes()));
  });
});
