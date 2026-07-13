/**
 * Error handling: every *malformed*-input branch of the decoder rejects with
 * `INVALID_MSG`, input that ends *inside* a field is reported as `INCOMPLETE`
 * (MESSAGE_SPEC §7, never promoted to an error by a finish step), and the
 * encoder rejects bad arguments / overflow with the matching
 * {@link SofabErrorCode}.
 */

import { describe, expect, it } from "vitest";
import {
  DecodeStatus,
  IStream,
  OStream,
  SofabError,
  SofabErrorCode,
  decode,
} from "../src/index.js";
import { ID_MAX } from "../src/constants.js";
import { encodeVarint } from "../src/varint/leb128.js";

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

function bytes(...n: number[]): Uint8Array {
  return Uint8Array.from(n);
}

describe("decoder rejects malformed input", () => {
  it("varint overflow (>10 bytes)", () => {
    const overlong = new Uint8Array(11).fill(0x80);
    expect(codeOf(() => decode(overlong, {}))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("invalid fixlen subtype", () => {
    // id 0 fixlen, length-word (1<<3)|4 -> subtype 4 is out of range
    expect(codeOf(() => decode(bytes(0x02, 0x0c, 0x00), {}))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("fixlen float length mismatch", () => {
    // id 0 fixlen, length-word (5<<3)|0 -> fp32 must be exactly 4 bytes
    expect(codeOf(() => decode(bytes(0x02, 0x28, 0, 0, 0, 0, 0), {}))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("invalid fixlen-array element type", () => {
    // id 0 fixlen-array, count 1, element-word (4<<3)|2 -> string elements not allowed
    expect(codeOf(() => decode(bytes(0x05, 0x01, 0x22), {}))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("unbalanced sequence end", () => {
    expect(codeOf(() => decode(bytes(0x07), {}))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("field id out of range", () => {
    const buf = new Uint8Array(8);
    const n = encodeVarint((BigInt(ID_MAX + 1) << 3n) | 0n, buf, 0);
    expect(codeOf(() => decode(buf.subarray(0, n), {}))).toBe(SofabErrorCode.InvalidMsg);
  });

});

// The finish-less three-valued outcome (MESSAGE_SPEC §7): input that ends inside
// a field is INCOMPLETE (more bytes could complete it), NOT the malformed
// INVALID. end()/feed() never promote an incomplete decode to an error.
describe("decoder distinguishes INCOMPLETE from INVALID", () => {
  it("one-shot decode of a lone dangling 0x80 is INCOMPLETE, not malformed", () => {
    // 0x80: a header varint with the continuation bit set and no terminator.
    expect(codeOf(() => decode(bytes(0x80), {}))).toBe(SofabErrorCode.Incomplete);
  });

  it("one-shot decode of a truncated payload is INCOMPLETE", () => {
    // id 0 fixlen string, declared length 4, only 2 payload bytes present.
    expect(codeOf(() => decode(bytes(0x02, 0x22, 0x41, 0x42), {}))).toBe(
      SofabErrorCode.Incomplete,
    );
  });

  it("streaming end() reports INCOMPLETE for a lone dangling 0x80 (no throw)", () => {
    const is = new IStream();
    is.feed(bytes(0x80), {}); // continuation bit set, no terminator
    expect(is.end()).toBe(DecodeStatus.Incomplete);
  });

  it("streaming end() reports INCOMPLETE for an unbalanced open sequence", () => {
    const is = new IStream();
    is.feed(bytes(0x0e), {}); // id 1 sequence start, never closed
    expect(is.end()).toBe(DecodeStatus.Incomplete);
  });

  it("streaming end() reports COMPLETE for a message that ends on a boundary", () => {
    const os = new OStream();
    os.writeUnsigned(1, 7);
    const is = new IStream();
    is.feed(os.bytes(), {});
    expect(is.end()).toBe(DecodeStatus.Complete);
  });

  it("a >64-bit varint is INVALID even though it too runs off the end", () => {
    // header id 0 unsigned, then 10 continuation bytes with no terminator: this
    // overflows 64 bits before it is ever truncated, so it is malformed.
    const buf = Uint8Array.from([0x00, ...new Array(10).fill(0x80)]);
    expect(codeOf(() => decode(buf, {}))).toBe(SofabErrorCode.InvalidMsg);
  });
});

describe("encoder rejects bad arguments", () => {
  it("field id below zero", () => {
    expect(codeOf(() => new OStream().writeUnsigned(-1, 0))).toBe(SofabErrorCode.Argument);
  });

  it("field id above ID_MAX", () => {
    expect(codeOf(() => new OStream().writeUnsigned(ID_MAX + 1, 0))).toBe(SofabErrorCode.Argument);
  });

  it("unsigned value out of 64-bit range", () => {
    expect(codeOf(() => new OStream().writeUnsigned(1, -1n))).toBe(SofabErrorCode.Argument);
    expect(codeOf(() => new OStream().writeUnsigned(1, 1n << 64n))).toBe(SofabErrorCode.Argument);
  });

  it("signed value out of 64-bit range", () => {
    expect(codeOf(() => new OStream().writeSigned(1, 1n << 63n))).toBe(SofabErrorCode.Argument);
  });

  it("sequence end without a matching begin", () => {
    expect(codeOf(() => new OStream().writeSequenceEnd())).toBe(SofabErrorCode.Usage);
  });

  it("buffer full with no flush sink", () => {
    const os = new OStream(new Uint8Array(4)); // fixed, tiny, no sink
    expect(codeOf(() => os.writeString(1, "this will not fit"))).toBe(SofabErrorCode.BufferFull);
  });

  it("non-integer scalar throws RangeError", () => {
    expect(() => new OStream().writeUnsigned(1, 1.5)).toThrow(RangeError);
  });
});
