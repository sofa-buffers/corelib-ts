/**
 * The decoder must accept input split at *any* byte boundary. For every vector
 * we feed the bytes one at a time, and in 7-byte groups, and assert the decoded
 * round-trip still reproduces the reference hex — proving the state machine
 * resumes correctly across varints, fixlen payloads, array elements and nesting.
 */

import { describe, expect, it } from "vitest";
import {
  DecodeStatus,
  IStream,
  OStream,
  SofabError,
  SofabErrorCode, growingOStream } from "../src/index.js";
import { bytesToHex, hexToBytes } from "./helpers/hex.js";
import { TranscodeVisitor } from "./helpers/recording-visitor.js";
import { loadVectors } from "./helpers/vectors.js";

const vectors = loadVectors();

function feedInChunks(bytes: Uint8Array, chunkSize: number): string {
  const out = growingOStream();
  const is = new IStream(new TranscodeVisitor(out));
  // Every `feed` returns the outcome for the bytes consumed so far and needs no
  // end step (CORELIB_PLAN §6): on a whole vector the last one must say
  // COMPLETE, at every chunk size, and the accessor must agree with it.
  let status: DecodeStatus = DecodeStatus.Complete;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    status = is.feed(bytes.subarray(i, i + chunkSize));
    expect(status).toBe(is.status());
  }
  expect(status).toBe(DecodeStatus.Complete);
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

    // A chunk wider than the longest varint lets the decoder take its bulk
    // path — whole varints read straight out of the chunk with no resume
    // bookkeeping, and array elements drained without re-entering the state
    // switch. The 1- and 7-byte sizes above can never reach it (both are
    // narrower than VARINT_MAX_BYTES), so without this the fast route through
    // the state machine would go unexercised while the slow one is covered
    // twice.
    it("decodes as a single whole-buffer chunk", () => {
      expect(feedInChunks(bytes, Math.max(bytes.length, 1))).toBe(vector.serialized.hex);
    });

    it("decodes in 16-byte chunks", () => {
      expect(feedInChunks(bytes, 16)).toBe(vector.serialized.hex);
    });
  });

  // The decoder has two routes through every construct: a bulk one that reads
  // whole varints straight out of the chunk, and a resumable one that carries a
  // half-read varint across the boundary. Which route runs depends on where the
  // splits fall, so fixed chunk sizes only ever probe a few alignments. This
  // walks every vector with a deterministic pseudo-random split pattern, which
  // is what catches a boundary that hands the bulk route a pending accumulator.
  describe("arbitrary split points", () => {
    it.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
      const bytes = hexToBytes(vector.serialized.hex);
      // xorshift32, seeded per vector so a failure reproduces exactly.
      let seed = 0x9e37_79b9;
      const next = (): number => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return (seed >>> 0) % 13; // 0..12, straddling VARINT_MAX_BYTES
      };
      for (let trial = 0; trial < 8; trial++) {
        const out = growingOStream();
        const is = new IStream(new TranscodeVisitor(out));
        for (let i = 0; i < bytes.length; ) {
          const take = next() + 1;
          is.feed(bytes.subarray(i, i + take));
          i += take;
        }
        is.status();
        expect(bytesToHex(out.bytes())).toBe(vector.serialized.hex);
      }
    });
  });

  // A verdict must not depend on where the chunk boundaries fell. Ten varint
  // bytes that all carry the continuation flag require an 11th, which is past the
  // 10-byte / 64-bit maximum (§4.1) — decidable from the bytes in hand, so
  // INVALID (§5.2 precedence), not the suspend-then-INCOMPLETE the resumable
  // reader used to fall into when the chunk ended exactly on the tenth byte
  // (corelib-ts#82).
  describe("an overlong varint is INVALID at every chunk size (corelib-ts#82)", () => {
    const malformed: Record<string, Uint8Array> = {
      "a bare scalar varint": Uint8Array.from([0x01, ...Array(10).fill(0x80)]),
      // id 8 / ArrayUnsigned, count 11, then the same ten continuation bytes.
      "an array element varint": Uint8Array.from([0x43, 0x0b, ...Array(10).fill(0x80)]),
    };

    for (const [what, bytes] of Object.entries(malformed)) {
      it(`rejects ${what}`, () => {
        for (let chunkSize = 1; chunkSize <= bytes.length; chunkSize++) {
          let code: SofabErrorCode | "none" = "none";
          try {
            const is = new IStream({});
            for (let i = 0; i < bytes.length; i += chunkSize) {
              is.feed(bytes.subarray(i, i + chunkSize));
            }
            is.status();
          } catch (e) {
            if (!(e instanceof SofabError)) throw e;
            code = e.code;
          }
          expect(code, `chunk size ${chunkSize}`).toBe(SofabErrorCode.InvalidMsg);
        }
      });
    }

    // Control: nine continuation bytes still *could* terminate legally, so the
    // fix must leave ordinary mid-varint suspension alone.
    it("still suspends on nine continuation bytes", () => {
      const bytes = Uint8Array.from([0x01, ...Array(9).fill(0x80)]);
      for (let chunkSize = 1; chunkSize <= bytes.length; chunkSize++) {
        const is = new IStream({});
        for (let i = 0; i < bytes.length; i += chunkSize) {
          is.feed(bytes.subarray(i, i + chunkSize));
        }
        expect(is.status(), `chunk size ${chunkSize}`).toBe(DecodeStatus.Incomplete);
      }
    });
  });

  it("handles an empty chunk without advancing", () => {
    const os = growingOStream();
    os.writeUnsigned(1, 42n);
    const out = growingOStream();
    const is = new IStream(new TranscodeVisitor(out));
    is.feed(new Uint8Array(0));
    is.feed(os.bytes());
    is.status();
    expect(bytesToHex(out.bytes())).toBe(bytesToHex(os.bytes()));
  });
});
