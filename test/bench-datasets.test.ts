/**
 * The benchmark datasets are cross-language contracts, not bench-local details.
 *
 * BENCH_SPEC fixes the field ids, types and literal values of every workload so
 * that the encoded bytes — and therefore the sizes the numbers are computed
 * from — are identical on every port. Two of those sizes are stated in the spec
 * outright as parity checks (`perf` = 170 bytes, `blob 1MB` = 1,000,005) and one
 * is taken from the reference implementation (`composite` = 956); a port whose
 * bench prints a different one is encoding something else, and its rows are not
 * comparable with anyone's.
 *
 * So the datasets are tested like any other wire-level claim in this repo:
 * sizes, structure, and — for `blob 1MB` — that the streaming rows really do
 * drive the streaming API (a 4096-byte caller buffer with a flush sink, and a
 * decode fed in 4096-byte chunks) and produce the same bytes as the one-shot
 * row.
 */

import { describe, expect, it } from "vitest";

import { DecodeStatus, decode, type Visitor } from "../src/index.js";
import {
  BLOB_CHUNK,
  BLOB_ENCODED_SIZE,
  BLOB_LEN,
  COMPOSITE_ENCODED_SIZE,
  Checksum,
  DiscardSink,
  PERF_ENCODED_SIZE,
  blobOneShotStream,
  blobStreamingStream,
  buildBlob,
  buildU64Array,
  decodeChunked,
  encodeBlobOneShot,
  encodeBlobStreaming,
  encodeComposite,
  encodePerf,
  encodeTypical,
  encodeToBytes,
  skipAll,
} from "../bench/workloads.js";

describe("bench datasets (BENCH_SPEC)", () => {
  it("u64 array (1000) is i * 0x9E3779B97F4A7C15, wrapping", () => {
    const src = buildU64Array();
    expect(src.length).toBe(1000);
    expect(src[0]).toBe(0n);
    expect(src[1]).toBe(0x9e37_79b9_7f4a_7c15n);
    // Wrapping: 3 * golden overflows 64 bits.
    expect(src[3]).toBe((3n * 0x9e37_79b9_7f4a_7c15n) & ((1n << 64n) - 1n));
  });

  it("the perf message is 170 bytes on every port", () => {
    expect(encodeToBytes(encodePerf).length).toBe(PERF_ENCODED_SIZE);
    expect(PERF_ENCODED_SIZE).toBe(170);
  });

  it("the typical message round-trips through the standard decode path", () => {
    const wire = encodeToBytes(encodeTypical);
    const seen: number[] = [];
    decode(wire, { fieldBegin: (id) => void seen.push(id) });
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 1, 2]); // 7 opens the sequence
  });

  // A megabyte per assertion, and the coverage run instruments every byte-level
  // loop it passes through: these four sit well inside vitest's 5 s default
  // locally and outside it under `--coverage` on a CI runner. The timeout is
  // generous rather than tuned — the point is that the row is exercised, and a
  // real hang still fails.
  describe("blob 1MB", { timeout: 60_000 }, () => {
    const blob = buildBlob();

    it("is 1,000,000 payload bytes of the same golden-ratio derivation", () => {
      expect(blob.length).toBe(BLOB_LEN);
      expect(BLOB_LEN).toBe(1_000_000);
      expect(blob[1]).toBe(Number(0x9e37_79b9_7f4a_7c15n & 0xffn));
    });

    it("encodes to 1,000,005 bytes: header + 4-byte fixlen word + payload", () => {
      const wire = encodeToBytes((os) => os.writeBlob(1, blob));
      expect(wire.length).toBe(BLOB_ENCODED_SIZE);
      expect(BLOB_ENCODED_SIZE).toBe(1_000_005);
      expect(wire[0]).toBe((1 << 3) | 2); // field header, id 1, fixlen
      // fixlen word (1000000 << 3) | 3, four varint bytes.
      expect(wire.subarray(1, 5)).toEqual(Uint8Array.of(0x83, 0xa4, 0xe8, 0x03));
    });

    it("streams through a 4096-byte caller buffer to the same bytes", () => {
      const oneShot = encodeBlobOneShot(blobOneShotStream(), blob);
      expect(oneShot.length).toBe(BLOB_ENCODED_SIZE);

      // The bench's own sink discards (BENCH_SPEC); this one collects, so the
      // streamed bytes can be compared with the contiguous ones.
      const parts: number[] = [];
      const streamed = new Uint8Array(BLOB_ENCODED_SIZE);
      let at = 0;
      const os = blobStreamingStream((chunk) => {
        parts.push(chunk.length);
        streamed.set(chunk, at);
        at += chunk.length;
      });
      encodeBlobStreaming(os, blob);
      expect(at).toBe(BLOB_ENCODED_SIZE);
      expect(streamed).toEqual(oneShot);
      // ~245 flushes of a 4096-byte buffer, never more than the buffer holds.
      expect(parts.length).toBeGreaterThan(200);
      for (const len of parts) expect(len).toBeLessThanOrEqual(BLOB_CHUNK);
    });

    it("decodes fed in 4096-byte chunks, delivering every payload byte", () => {
      const wire = encodeBlobOneShot(blobOneShotStream(), blob);
      let delivered = 0;
      const v: Visitor = {
        blob: (_id, _total, _off, chunk) => {
          delivered += chunk.length;
        },
      };
      expect(decodeChunked(wire, v, BLOB_CHUNK)).toBe(DecodeStatus.Complete);
      expect(delivered).toBe(BLOB_LEN);
    });
  });

  describe("composite", () => {
    const wire = encodeToBytes(encodeComposite);

    it("encodes to the 956-byte cross-port parity size", () => {
      expect(wire.length).toBe(COMPOSITE_ENCODED_SIZE);
      expect(COMPOSITE_ENCODED_SIZE).toBe(956);
    });

    it("carries the wrapper array, the omitted default and the 2-byte header", () => {
      const top: number[] = [];
      const items: string[] = [];
      const utf8 = new TextDecoder("utf-8", { fatal: true });
      let stringBytes = 0;
      let depth = 0;
      let maxDepth = 0;

      const wrapper: Visitor = {
        string: (id, _t, _o, chunk) => void (items[id] = utf8.decode(chunk)),
        sequenceEnd: () => void depth--,
      };
      const inner: Visitor = {
        sequenceBegin: () => {
          maxDepth = Math.max(maxDepth, ++depth);
          return inner;
        },
        sequenceEnd: () => void depth--,
      };
      const root: Visitor = {
        fieldBegin: (id) => {
          if (depth === 0) top.push(id);
        },
        string: (_id, total) => void (stringBytes = total),
        sequenceBegin: (id) => {
          maxDepth = Math.max(maxDepth, ++depth);
          return id === 1 ? wrapper : inner;
        },
        sequenceEnd: () => void depth--,
      };
      decode(wire, root);

      // Field 4 equals its declared default, so the encoder omits it entirely.
      expect(top).toEqual([1, 2, 3, 130]);
      // 64 wrapper elements at ids 0..63 — ids 16+ take a two-byte header.
      expect(items.length).toBe(64);
      expect(items[0]).toBe("item-0");
      expect(items[63]).toBe("item-63");
      // 32 repetitions of a 1+2+3+4-byte UTF-8 cycle.
      expect(stringBytes).toBe(320);
      // Field 3 nests three levels deep.
      expect(maxDepth).toBe(3);
    });

    it("skip-all walks the whole message without materializing a field", () => {
      // The `decode: composite skip-all` row: every top-level field and every
      // sub-sequence discarded by the pull decoder's skip machinery.
      expect(skipAll(wire)).toBe(4);
    });

    it("decodes every field through the checksum sink the bench uses", () => {
      const c = new Checksum();
      decode(wire, c);
      expect(c.acc).not.toBe(0);
    });
  });

  it("the discard sink folds bytes without accumulating them", () => {
    const s = new DiscardSink();
    s.add(Uint8Array.of(1, 2, 3));
    s.add(Uint8Array.of(4));
    expect(s.flushes).toBe(2);
    expect(s.bytes).toBe(4);
    expect(s.acc).toBe(1 ^ 4);
  });
});
