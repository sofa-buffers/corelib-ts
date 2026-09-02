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
  decode, growingOStream } from "../src/index.js";
import { ID_MAX } from "../src/constants.js";

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

/**
 * LEB128 bytes of a non-negative `bigint`, written here rather than taken from
 * the library: these tests build headers the encoder *refuses* to write, so the
 * bytes have to come from somewhere it does not gate.
 */
function varint(value: bigint): number[] {
  const out: number[] = [];
  for (let v = value; ; v >>= 7n) {
    if (v < 0x80n) {
      out.push(Number(v));
      return out;
    }
    out.push(Number(v & 0x7fn) | 0x80);
  }
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
    // (id << 3) | wire 0, one past the id ceiling.
    const buf = bytes(...varint(BigInt(ID_MAX + 1) << 3n));
    expect(codeOf(() => decode(buf, {}))).toBe(SofabErrorCode.InvalidMsg);
  });

});

// The finish-less three-valued outcome (MESSAGE_SPEC §7): input that ends inside
// a field is INCOMPLETE (more bytes could complete it), NOT the malformed
// INVALID. `feed()` never promotes an incomplete decode to an error.
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

  it("streaming feed() returns INCOMPLETE for a lone dangling 0x80 (no throw)", () => {
    const is = new IStream({});
    // continuation bit set, no terminator
    expect(is.feed(bytes(0x80))).toBe(DecodeStatus.Incomplete);
  });

  it("streaming feed() returns INCOMPLETE for an unbalanced open sequence", () => {
    const is = new IStream({});
    // id 1 sequence start, never closed
    expect(is.feed(bytes(0x0e))).toBe(DecodeStatus.Incomplete);
  });

  it("streaming feed() returns COMPLETE for a message that ends on a boundary", () => {
    const os = growingOStream();
    os.writeUnsigned(1, 7);
    const is = new IStream({});
    expect(is.feed(os.bytes())).toBe(DecodeStatus.Complete);
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
    expect(codeOf(() => growingOStream().writeUnsigned(-1, 0))).toBe(SofabErrorCode.Argument);
  });

  it("field id above ID_MAX", () => {
    expect(codeOf(() => growingOStream().writeUnsigned(ID_MAX + 1, 0))).toBe(SofabErrorCode.Argument);
  });

  it("sequence-begin field id out of range", () => {
    // A lazily-opened sequence may never write its header, so the id is checked
    // at the call that supplied it rather than at commit time.
    expect(codeOf(() => growingOStream().writeSequenceBeginLazy(-1))).toBe(SofabErrorCode.Argument);
    expect(codeOf(() => growingOStream().writeSequenceBeginLazy(ID_MAX + 1))).toBe(SofabErrorCode.Argument);
  });

  it("unsigned value out of 64-bit range", () => {
    expect(codeOf(() => growingOStream().writeUnsigned(1, -1n))).toBe(SofabErrorCode.Argument);
    expect(codeOf(() => growingOStream().writeUnsigned(1, 1n << 64n))).toBe(SofabErrorCode.Argument);
  });

  it("signed value out of 64-bit range", () => {
    expect(codeOf(() => growingOStream().writeSigned(1, 1n << 63n))).toBe(SofabErrorCode.Argument);
  });

  it("sequence end without a matching begin is written, not rejected", () => {
    // The encoder writes what it is told; an end with no matching begin makes
    // the *bytes* malformed, which is the decoder's verdict, not the encoder's.
    // No other port refuses it.
    const os = growingOStream();
    os.writeSequenceEnd();
    expect(os.bytes()).toEqual(Uint8Array.from([0x07]));
  });

  it("buffer full with no flush sink", () => {
    const os = new OStream(new Uint8Array(4)); // fixed, tiny, no sink
    expect(codeOf(() => os.writeString(1, "this will not fit"))).toBe(SofabErrorCode.BufferFull);
  });

});

/**
 * A `number` that is not an integer is a caller mistake in exactly the sense
 * CORELIB_PLAN §6.3 gives `InvalidArgument`, so it must arrive as a
 * {@link SofabError} carrying `ARGUMENT` like every other encoder rejection —
 * not as a bare `RangeError` that the documented
 * `catch (e) { if (e instanceof SofabError) … }` pattern never sees
 * (corelib-ts#111).
 *
 * Every integer surface is covered on **both** constructions, because the two
 * take different code paths: a growable stream reserves the whole array and runs
 * the bulk {@link Kernel}, while a fixed caller buffer with a sink converts one
 * element at a time inside `OStream`.
 */
describe("a non-integer number is an ARGUMENT error, not a bare RangeError", () => {
  /** A growable encoder (bulk kernel path for arrays). */
  const grown = (): OStream => growingOStream();
  /** A fixed 1-byte caller buffer with a sink (element-at-a-time array path). */
  const streamed = (): OStream => new OStream(new Uint8Array(1), 0, () => {});

  const CASES: Array<[string, (os: OStream) => void]> = [
    ["writeUnsigned", (os) => os.writeUnsigned(1, 1.5)],
    ["writeSigned", (os) => os.writeSigned(1, -1.5)],
    ["writeUnsignedArray", (os) => os.writeUnsignedArray(1, [1.5])],
    ["writeSignedArray", (os) => os.writeSignedArray(1, [-1.5])],
    // The largest magnitudes a fractional double can still carry (spacing is
    // 0.5 just under 2^52), so the check cannot be a small-value-only guard.
    ["writeUnsignedArray (large fractional)", (os) => os.writeUnsignedArray(1, [2 ** 51 + 0.5])],
    ["writeSignedArray (large fractional)", (os) => os.writeSignedArray(1, [-(2 ** 51) - 0.5])],
    ["writeUnsigned (NaN)", (os) => os.writeUnsigned(1, Number.NaN)],
    ["writeSigned (Infinity)", (os) => os.writeSigned(1, Number.POSITIVE_INFINITY)],
    ["writeUnsignedArray (NaN)", (os) => os.writeUnsignedArray(1, [Number.NaN])],
    ["writeSignedArray (-Infinity)", (os) => os.writeSignedArray(1, [Number.NEGATIVE_INFINITY])],
  ];

  for (const [name, write] of CASES) {
    it(`${name} rejects with ARGUMENT (growable)`, () => {
      expect(codeOf(() => write(grown()))).toBe(SofabErrorCode.Argument);
    });

    it(`${name} rejects with ARGUMENT (fixed streaming buffer)`, () => {
      expect(codeOf(() => write(streamed()))).toBe(SofabErrorCode.Argument);
    });
  }

  it("the thrown error is a SofabError, so `instanceof SofabError` catches it", () => {
    try {
      growingOStream().writeUnsigned(1, 1.5);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SofabError);
      expect((e as SofabError).code).toBe(SofabErrorCode.Argument);
      expect((e as SofabError).message).toContain("1.5");
    }
  });
});
