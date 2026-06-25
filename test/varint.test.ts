/**
 * Unit coverage for the low-level varint helpers used by the whole-buffer paths
 * (the streaming decoder has its own resumable reader, tested via the vectors).
 */

import { describe, expect, it } from "vitest";
import { decodeVarint, encodeVarint, varintSize } from "../src/varint/leb128.js";
import { zigzagDecode, zigzagEncode } from "../src/varint/zigzag.js";
import { SofabError, SofabErrorCode, U64_MAX } from "../src/index.js";

const BOUNDARIES = [0n, 1n, 127n, 128n, 16383n, 16384n, 2097151n, 2097152n, U64_MAX];

describe("varint round-trip", () => {
  it("encodes and decodes every length boundary", () => {
    for (const value of BOUNDARIES) {
      const buf = new Uint8Array(10);
      const end = encodeVarint(value, buf, 0);
      expect(end).toBe(varintSize(value));
      const { value: decoded, pos } = decodeVarint(buf, 0);
      expect(decoded).toBe(value);
      expect(pos).toBe(end);
    }
  });

  it("rejects a truncated varint", () => {
    const buf = Uint8Array.from([0x80, 0x80]); // continuation with no terminator
    try {
      decodeVarint(buf, 0);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SofabError);
      expect((e as SofabError).code).toBe(SofabErrorCode.InvalidMsg);
    }
  });

  it("rejects an overlong varint", () => {
    const buf = new Uint8Array(11).fill(0x80);
    expect(() => decodeVarint(buf, 0)).toThrow(SofabError);
  });
});

describe("zig-zag round-trip", () => {
  it("maps signed boundaries through the unsigned domain", () => {
    const values = [0n, -1n, 1n, -2n, 2n, -0x8000_0000_0000_0000n, 0x7fff_ffff_ffff_ffffn];
    for (const v of values) {
      expect(zigzagDecode(zigzagEncode(v))).toBe(v);
    }
    expect(zigzagEncode(0n)).toBe(0n);
    expect(zigzagEncode(-1n)).toBe(1n);
    expect(zigzagEncode(1n)).toBe(2n);
    expect(zigzagEncode(-0x8000_0000_0000_0000n)).toBe(U64_MAX);
  });
});
