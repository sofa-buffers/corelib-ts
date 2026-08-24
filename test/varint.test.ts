/**
 * The varint contract, pinned on the **shipped** entry points.
 *
 * §4.1's rules — the length ladder, the 10-byte / 64-bit bound, truncation
 * versus overflow — used to be exercised against a general `encodeVarint` /
 * `decodeVarint` pair in `src/varint/leb128.ts` that no production path called:
 * a reader whose only job was to be kept in lockstep with the ones that ship
 * (corelib-ts#82, #88, #99/#100, #113, #131 each had to be applied to it as well).
 * The pair is gone; the rules are asserted here through the encoder and the one
 * decoder that actually reads bytes, at both entry points and every chunking —
 * the one place a divergence would matter.
 *
 * The reference LEB128 is written out locally, below: an oracle a test owns is
 * worth more than one that shares an implementation with the code under test.
 */

import { describe, expect, it } from "vitest";
import {
  DecodeStatus,
  IStream,
  OStream,
  SofabError,
  SofabErrorCode,
  U64_MAX,
  decode, growingOStream } from "../src/index.js";

/** Reference LEB128 of a non-negative `bigint` — the test's own oracle. */
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

/** Reference zig-zag `(n << 1) ^ (n >> 63)` over the `int64` domain. */
function zigzag(value: bigint): bigint {
  return ((value << 1n) ^ (value >> 63n)) & U64_MAX;
}

/** Run `fn` and return the SofabError code it throws (or fail loudly). */
function codeOf(fn: () => unknown): SofabErrorCode {
  try {
    fn();
  } catch (e) {
    if (e instanceof SofabError) return e.code;
    throw e;
  }
  throw new Error("expected a SofabError, but nothing was thrown");
}

/** The value bytes of a one-field message: id 0, so the header is one byte. */
function payload(write: (os: OStream) => void): number[] {
  const os = growingOStream();
  write(os);
  return Array.from(os.bytes()).slice(1);
}

/**
 * Feed `buf` to a resumable IStream one byte at a time, reporting the outcome the
 * way the one-shot entry point does: a code for INVALID (thrown) or INCOMPLETE
 * (the status the caller judges), "COMPLETE" otherwise.
 */
const chunked = (buf: Uint8Array): void => {
  const is = new IStream({});
  for (const b of buf) is.feed(Uint8Array.of(b));
  if (is.status() === DecodeStatus.Incomplete) {
    throw new SofabError(SofabErrorCode.Incomplete, "input ends inside a field");
  }
};

/** Decode `buf` in one shot, reading every unsigned scalar it carries. */
const whole = (buf: Uint8Array): (number | bigint)[] => {
  const seen: (number | bigint)[] = [];
  decode(buf, { unsigned: (_id, v) => void seen.push(v) });
  return seen;
};

const BOUNDARIES = [0n, 1n, 127n, 128n, 16383n, 16384n, 2097151n, 2097152n, U64_MAX];

describe("varint round-trip", () => {
  it("encodes every length boundary as the reference LEB128", () => {
    for (const value of BOUNDARIES) {
      expect(payload((os) => os.writeUnsigned(0, value))).toEqual(varint(value));
    }
  });

  it("reads every length boundary back", () => {
    for (const value of BOUNDARIES) {
      const os = growingOStream();
      os.writeUnsigned(0, value);
      const wire = os.bytes().slice();

      expect(BigInt(whole(wire)[0]!)).toBe(value);

      let seen: bigint | undefined;
      decode(wire, { unsigned: (_id, v) => void (seen = BigInt(v)) });
      expect(seen).toBe(value);
    }
  });

  it("reports INCOMPLETE for a truncated varint", () => {
    // A header varint with the continuation bit set and no terminator: more
    // bytes could complete it, so INCOMPLETE, not INVALID.
    const buf = Uint8Array.from([0x80, 0x80]);
    expect(codeOf(() => decode(buf, {}))).toBe(SofabErrorCode.Incomplete);
    expect(codeOf(() => chunked(buf))).toBe(SofabErrorCode.Incomplete);
  });
});

// Regression for #53: an overlong (>64-bit) varint must be rejected as INVALID,
// not silently truncated/wrapped. The 10th byte carries only bit 63, so its
// payload may not exceed 0x01 and no 11th byte may follow.
describe("overlong (>64-bit) varint is INVALID (#53)", () => {
  /** id 0, wire 0 (unsigned), then the given value bytes. */
  const field = (...value: number[]): Uint8Array => Uint8Array.from([0x00, ...value]);
  /** Nine 0xff groups fill bits 0..62; the 10th byte supplies bit 63 upward. */
  const nine = (): number[] => Array<number>(9).fill(0xff);

  it("accepts the 2^64-1 maximum (10th byte = 0x01) as the control", () => {
    const wire = field(...nine(), 0x01);
    expect(BigInt(whole(wire)[0]!)).toBe(U64_MAX);

    let seen: bigint | undefined;
    decode(wire, { unsigned: (_id, v) => void (seen = BigInt(v)) });
    expect(seen).toBe(U64_MAX);
  });

  it.each([
    ["the 65th bit (10th byte = 0x02)", [...nine(), 0x02]],
    ["high payload bits in the 10th byte (0x7f)", [...nine(), 0x7f]],
    // 10th byte 0x81: the low bit fits bit 63, but the continuation flag demands
    // an 11th byte, which is past the 10-byte maximum.
    ["a continuation into an 11th byte", [...nine(), 0x81, 0x00]],
  ])("rejects %s on both entry points", (_what, value) => {
    const wire = field(...value);
    expect(codeOf(() => decode(wire, {}))).toBe(SofabErrorCode.InvalidMsg);
    expect(codeOf(() => chunked(wire))).toBe(SofabErrorCode.InvalidMsg);
  });
});

// Regression for #113. §4.1 bounds the *encoding*, not the value: ten bytes that
// all carry the continuation flag already demand an 11th, which is past the
// 10-byte / 64-bit maximum — so they are malformed on the bytes already in hand,
// whatever (if anything) follows. §5.2 gives that INVALID precedence over the
// INCOMPLETE of input that merely stops there, and the verdict must not depend on
// where the input happens to end. Both entry points in this repo — the
// one-shot `decode()` and the resumable `IStream` — must therefore return the
// same code for the same bytes.
describe("ten continuation bytes then end of input are INVALID (#113)", () => {
  /** `n` bytes that all set the continuation flag and carry no payload. */
  const cont = (n: number): number[] => Array<number>(n).fill(0x80);

  /** id 0, wire 0 (unsigned): the value varint follows the header immediately. */
  const field = (n: number): Uint8Array => Uint8Array.from([0x00, ...cont(n)]);

  it("both entry points agree on INVALID", () => {
    const ten = field(10);
    expect(codeOf(() => decode(ten, {}))).toBe(SofabErrorCode.InvalidMsg);
    expect(codeOf(() => chunked(ten))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("both entry points agree on INCOMPLETE for nine (control)", () => {
    const nine = field(9);
    expect(codeOf(() => decode(nine, {}))).toBe(SofabErrorCode.Incomplete);
    expect(codeOf(() => chunked(nine))).toBe(SofabErrorCode.Incomplete);
    const is = new IStream({});
    let status: DecodeStatus = DecodeStatus.Complete;
    for (const b of nine) status = is.feed(Uint8Array.of(b));
    expect(status).toBe(DecodeStatus.Incomplete);
  });
});

describe("zig-zag", () => {
  const VALUES = [
    0n,
    -1n,
    1n,
    -2n,
    2n,
    -12345n,
    0x7fff_ffffn,
    -0x8000_0000n,
    -0x8000_0000_0000_0000n,
    0x7fff_ffff_ffff_ffffn,
  ];

  it("writes the zig-zag image of every signed boundary", () => {
    for (const v of VALUES) {
      // The payload of a signed field is the unsigned varint of `zigzag(v)` —
      // asserted against the same field written through the unsigned writer, so
      // the mapping and the encoding are pinned separately.
      expect(payload((os) => os.writeSigned(0, v))).toEqual(varint(zigzag(v)));
      expect(payload((os) => os.writeSigned(0, v))).toEqual(
        payload((os) => os.writeUnsigned(0, zigzag(v))),
      );
    }
  });

  it("reads every signed boundary back through it", () => {
    for (const v of VALUES) {
      const os = growingOStream();
      os.writeSigned(0, v);
      let seen: bigint | undefined;
      decode(os.bytes(), { signed: (_id, x) => void (seen = BigInt(x)) });
      expect(seen).toBe(v);
    }
  });
});
