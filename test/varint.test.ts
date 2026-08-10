/**
 * Unit coverage for the low-level varint helpers used by the whole-buffer paths
 * (the streaming decoder has its own resumable reader, tested via the vectors).
 */

import { describe, expect, it } from "vitest";
import { decodeVarint, encodeVarint, varintSize } from "../src/varint/leb128.js";
import { zigzagDecode, zigzagEncode } from "../src/varint/zigzag.js";
import {
  Cursor,
  DecodeStatus,
  IStream,
  SofabError,
  SofabErrorCode,
  U64_MAX,
  decode,
} from "../src/index.js";

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

  it("reports INCOMPLETE for a truncated varint", () => {
    const buf = Uint8Array.from([0x80, 0x80]); // continuation with no terminator
    try {
      decodeVarint(buf, 0);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SofabError);
      // Ends mid-varint: more bytes could complete it, so INCOMPLETE not INVALID.
      expect((e as SofabError).code).toBe(SofabErrorCode.Incomplete);
    }
  });

  it("rejects an overlong varint", () => {
    const buf = new Uint8Array(11).fill(0x80);
    expect(() => decodeVarint(buf, 0)).toThrow(SofabError);
  });

  // Regression for #53: an overlong (>64-bit) varint must be rejected as
  // INVALID, not silently truncated/wrapped. The 10th byte carries only bit 63,
  // so its payload may not exceed 0x01 and no 11th byte may follow.
  describe("overlong (>64-bit) varint is INVALID (#53)", () => {
    // Nine 0xff groups fill bits 0..62; the 10th byte supplies bit 63 upward.
    const nine = () => Array(9).fill(0xff);

    it("accepts the 2^64-1 maximum (10th byte = 0x01) as the control", () => {
      const buf = Uint8Array.from([...nine(), 0x01]);
      const { value, pos } = decodeVarint(buf, 0);
      expect(value).toBe(U64_MAX);
      expect(pos).toBe(10);
    });

    it("rejects the 65th bit (10th byte = 0x02)", () => {
      const buf = Uint8Array.from([...nine(), 0x02]);
      try {
        decodeVarint(buf, 0);
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(SofabError);
        expect((e as SofabError).code).toBe(SofabErrorCode.InvalidMsg);
      }
    });

    it("rejects high payload bits in the 10th byte (0x7f)", () => {
      const buf = Uint8Array.from([...nine(), 0x7f]);
      try {
        decodeVarint(buf, 0);
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(SofabError);
        expect((e as SofabError).code).toBe(SofabErrorCode.InvalidMsg);
      }
    });

    it("rejects a continuation into an 11th byte", () => {
      // 10th byte 0x81: low bit fits bit 63 but the continuation bit demands an
      // 11th byte, which is a >64-bit overflow.
      const buf = Uint8Array.from([...nine(), 0x81, 0x00]);
      try {
        decodeVarint(buf, 0);
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(SofabError);
        expect((e as SofabError).code).toBe(SofabErrorCode.InvalidMsg);
      }
    });
  });
});

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

// Regression for #113. §4.1 bounds the *encoding*, not the value: ten bytes that
// all carry the continuation flag already demand an 11th, which is past the
// 10-byte / 64-bit maximum — so they are malformed on the bytes already in hand,
// whatever (if anything) follows. §5.2 gives that INVALID precedence over the
// INCOMPLETE of input that merely stops there, and the verdict must not depend on
// where the input happens to end. All four varint readers in this repo — the
// helper here, the contiguous `decode()`, the pull `Cursor` and the resumable
// `IStream` — must therefore return the same code for the same bytes.
describe("ten continuation bytes then end of input are INVALID (#113)", () => {
  /** `n` bytes that all set the continuation flag and carry no payload. */
  const cont = (n: number): number[] => Array<number>(n).fill(0x80);

  /** id 0, wire 0 (unsigned): the value varint follows the header immediately. */
  const field = (n: number): Uint8Array => Uint8Array.from([0x00, ...cont(n)]);

  /** Feed `buf` to a resumable IStream one byte at a time. */
  const chunked = (buf: Uint8Array): void => {
    const is = new IStream();
    for (const b of buf) is.feed(Uint8Array.of(b), {});
  };

  const pull = (buf: Uint8Array): void => {
    const c = new Cursor(buf);
    while (c.readHeader()) c.readUnsigned();
  };

  it("decodeVarint reports INVALID, not INCOMPLETE", () => {
    expect(codeOf(() => decodeVarint(Uint8Array.from(cont(10)), 0))).toBe(
      SofabErrorCode.InvalidMsg,
    );
  });

  it("decodeVarint still reports nine-then-EOF as INCOMPLETE (control)", () => {
    expect(codeOf(() => decodeVarint(Uint8Array.from(cont(9)), 0))).toBe(
      SofabErrorCode.Incomplete,
    );
  });

  it("the three decode surfaces agree on INVALID", () => {
    const ten = field(10);
    expect(codeOf(() => decode(ten, {}))).toBe(SofabErrorCode.InvalidMsg);
    expect(codeOf(() => pull(ten))).toBe(SofabErrorCode.InvalidMsg);
    expect(codeOf(() => chunked(ten))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("the three decode surfaces agree on INCOMPLETE for nine (control)", () => {
    const nine = field(9);
    expect(codeOf(() => decode(nine, {}))).toBe(SofabErrorCode.Incomplete);
    expect(codeOf(() => pull(nine))).toBe(SofabErrorCode.Incomplete);
    const is = new IStream();
    let status: DecodeStatus = DecodeStatus.Complete;
    for (const b of nine) status = is.feed(Uint8Array.of(b), {});
    expect(status).toBe(DecodeStatus.Incomplete);
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
