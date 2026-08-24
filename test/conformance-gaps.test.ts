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
  type Visitor, growingOStream } from "../src/index.js";
import { bytesToHex } from "./helpers/hex.js";
import { RecordingVisitor, TranscodeVisitor } from "./helpers/recording-visitor.js";

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
  const is = new IStream(visitor);
  for (let i = 0; i < bytes.length; i++) is.feed(bytes.subarray(i, i + 1));
  is.status();
}

describe("zero-count arrays encode to the canonical empty form", () => {
  it("unsigned array (id 0) -> 03 00", () => {
    const os = growingOStream();
    os.writeUnsignedArray(0, []);
    expect(bytesToHex(os.bytes())).toBe("0300");
  });

  it("signed array (id 0) -> 04 00", () => {
    const os = growingOStream();
    os.writeSignedArray(0, []);
    expect(bytesToHex(os.bytes())).toBe("0400");
  });

  it("fp32 array (id 0) -> 05 00 20 (fixlen_word, no payload)", () => {
    const os = growingOStream();
    os.writeFp32Array(0, []);
    expect(bytesToHex(os.bytes())).toBe("050020");
  });

  it("fp64 array (id 0) -> 05 00 41 (fixlen_word, no payload)", () => {
    const os = growingOStream();
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
      const os = growingOStream();
      write(os);
      const seen = new RecordingVisitor();
      decode(os.bytes(), seen);
      expect(seen.events).toEqual([{ kind: "array", id: 7, arrayKind: kind, values: [] }]);
    });

    it(`${name}: streaming decode (one byte at a time) matches`, () => {
      const os = growingOStream();
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
    const os = growingOStream();
    for (let i = 0; i < MAX_DEPTH; i++) os.writeSequenceBeginLazy(0);
    expect(codeOf(() => os.writeSequenceBeginLazy(0))).toBe(SofabErrorCode.Argument);
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

// --- §4.9/§6.2: ID_MAX binds a sequence-end header too (F-0054) ---------------
//
// A sequence end's id is *discarded*, but discarded is not unvalidated: the
// header is an ordinary field header, so its id is bounded by ID_MAX exactly as
// every other header's is. The bound is on the id's **value**, not its
// spelling — §4.1's accept-and-normalize rule is untouched, so a non-minimal
// encoding of an in-range id stays valid. Only ID_MAX + 1 is INVALID.

/** Unsigned LEB128 encoding of a bigint, as a plain byte array. */
function uvarint(n: bigint): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
}

/** A field header word `(id << 3) | wire`, LEB128 encoded. */
function header(id: bigint, wire: number): number[] {
  return uvarint((id << 3n) | BigInt(wire));
}

const ID_MAX = 0x7fff_ffffn;
const SEQ_START = 6;
const SEQ_END = 7;

/** An undeclared sequence field (id 14) closed by an end marker carrying `id`. */
function seqWithEndId(end: number[]): Uint8Array {
  return Uint8Array.from([...header(14n, SEQ_START), ...end]);
}

/**
 * Decode `buf` through both entry points — one-shot and chunked — and, for each,
 * both with a visitor that declines the sequence (so it is consumed by the
 * decoder's own skip path) and with one that descends into it. There is one decode
 * *surface* (§5.3.1), but a declined subtree and a read one are still two paths
 * through it, and the guard under test has to hold on both.
 */
function codesOnEverySurface(buf: Uint8Array): Record<string, string> {
  const declines: Visitor = { sequenceBegin: () => false };
  return {
    oneShot: codeOf(() => decode(buf, {})),
    streaming: codeOf(() => decodeChunked(buf, {})),
    oneShotDeclined: codeOf(() => decode(buf, declines)),
    streamingDeclined: codeOf(() => decodeChunked(buf, declines)),
  };
}

/** The same four paths, asserting none of them throws. */
function acceptedOnEverySurface(buf: Uint8Array): void {
  const declines: Visitor = { sequenceBegin: () => false };
  expect(() => decode(buf, {})).not.toThrow();
  expect(() => decodeChunked(buf, {})).not.toThrow();
  expect(() => decode(buf, declines)).not.toThrow();
  expect(() => decodeChunked(buf, declines)).not.toThrow();
}

describe("a sequence-end header's id is bounded by ID_MAX (§4.9/§6.2)", () => {
  it("rejects the F-0054 isolate `76 87 80 80 80 40` on every decode surface", () => {
    // 76        -> id 14, wire 6 (SequenceStart), undeclared -> skipped (§5.2)
    // 87 80 80 80 40 -> wire 7 (SequenceEnd), id 2^31 = ID_MAX + 1 -> INVALID
    const buf = Uint8Array.from([0x76, 0x87, 0x80, 0x80, 0x80, 0x40]);
    expect(bytesToHex(buf)).toBe("768780808040");
    expect(buf).toEqual(seqWithEndId(header(ID_MAX + 1n, SEQ_END)));

    const codes = codesOnEverySurface(buf);
    expect(codes).toEqual({
      oneShot: SofabErrorCode.InvalidMsg,
      streaming: SofabErrorCode.InvalidMsg,
      oneShotDeclined: SofabErrorCode.InvalidMsg,
      streamingDeclined: SofabErrorCode.InvalidMsg,
    });
  });

  it("rejects an over-ceiling end-marker id at the root, with no open sequence", () => {
    // INVALID on the id alone — it must not depend on the unbalanced-end check.
    const buf = Uint8Array.from(header(ID_MAX + 1n, SEQ_END));
    const codes = codesOnEverySurface(buf);
    expect(codes.oneShot).toBe(SofabErrorCode.InvalidMsg);
    expect(codes.streaming).toBe(SofabErrorCode.InvalidMsg);
    expect(codes.oneShotDeclined).toBe(SofabErrorCode.InvalidMsg);
  });

  it("accepts the three controls: end-marker ids 0, 3 and ID_MAX", () => {
    // ctl_seqend_canonical / ctl_seqend_id_small / ctl_seqend_id_at_IDMAX.
    for (const id of [0n, 3n, ID_MAX]) {
      acceptedOnEverySurface(seqWithEndId(header(id, SEQ_END)));
    }
    // The canonical spelling really is the bare 0x07 the encoder must write.
    expect(header(0n, SEQ_END)).toEqual([0x07]);
  });

  it("bounds the id's value, not its spelling: `87 00` for id 0 stays valid (§4.1)", () => {
    const nonMinimal = seqWithEndId([0x87, 0x00]);
    acceptedOnEverySurface(nonMinimal);

    // It decodes as an ordinary sequence end and re-encodes to the canonical
    // `0x07` — accept-and-normalize, not accept-and-preserve.
    const out = growingOStream();
    decode(nonMinimal, new TranscodeVisitor(out));
    expect(bytesToHex(out.bytes())).toBe("7607");
  });
});
