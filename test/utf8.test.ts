/**
 * Strict UTF-8 conformance (MESSAGE_SPEC §8, CORELIB_PLAN §6.4, issue #85).
 *
 * JavaScript strings are a Unicode string type, so corelib-ts is **always
 * strict**: it builds the string in the corelib with a fatal `TextDecoder` and
 * encodes with an unpaired-surrogate-rejecting writer. Lossy `U+FFFD`
 * substitution is forbidden in both directions.
 *
 *  - **Decode:** an invalid-UTF-8 `string` payload that is *materialized* is the
 *    `INVALID` outcome (`SofabError` / `INVALID_MSG`).
 *  - **Encode:** an unpaired surrogate in the input string is refused with the
 *    `InvalidArgument` error (`SofabError` / `ARGUMENT`).
 *
 * The negative vectors are the shared `invalid_utf8` array (superset of the
 * positive suite), tracked by corelib-c-cpp#97.
 */

import { describe, expect, it } from "vitest";
import { Cursor, OStream, SofabError, SofabErrorCode } from "../src/index.js";
import { hexToBytes } from "./helpers/hex.js";
import { loadInvalidUtf8 } from "./helpers/vectors.js";

const invalid = loadInvalidUtf8();

/** Capture the error a thunk throws, or `undefined` if it does not throw. */
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

/**
 * If `hex` is a WTF-8 lone-surrogate encoding (`ED A0..BF xx`), rebuild the JS
 * string that carries that unpaired surrogate, so the encode side can be driven
 * with an input a UTF-16 string can actually hold. Byte payloads that no JS
 * string can produce (overlong forms, out-of-range, stray continuation bytes)
 * return `null` — encode-reject does not apply to a Unicode-string target there.
 */
function surrogateStringOf(hex: string): string | null {
  const b = hexToBytes(hex);
  if (
    b.length === 3 &&
    b[0] === 0xed &&
    b[1]! >= 0xa0 &&
    b[1]! <= 0xbf &&
    b[2]! >= 0x80 &&
    b[2]! <= 0xbf
  ) {
    const cp = ((b[0]! & 0x0f) << 12) | ((b[1]! & 0x3f) << 6) | (b[2]! & 0x3f);
    return String.fromCharCode(cp); // 0xD800..0xDFFF — an unpaired surrogate
  }
  return null;
}

describe("strict UTF-8 (invalid_utf8 vectors)", () => {
  it("loads the shared negative suite", () => {
    expect(invalid.length).toBeGreaterThan(0);
  });

  describe.each(invalid.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    it("decodes the wire message to the INVALID outcome", () => {
      // Drive the pull decoder, which materializes the string in the corelib
      // (fatal TextDecoder). Reading the field must throw INVALID_MSG.
      const c = new Cursor(hexToBytes(v.serialized_hex));
      expect(c.readHeader()).toBe(true);
      expect(c.id).toBe(Number(v.id));
      const err = caught(() => c.readString());
      expect(err).toBeInstanceOf(SofabError);
      expect((err as SofabError).code).toBe(SofabErrorCode.InvalidMsg);
    });

    it("rejects encoding an unpaired-surrogate input (where applicable)", () => {
      const s = surrogateStringOf(v.string_hex);
      if (s === null) return; // not representable as a JS string; encode N/A
      const err = caught(() => new OStream().writeString(v.id, s));
      expect(err).toBeInstanceOf(SofabError);
      expect((err as SofabError).code).toBe(SofabErrorCode.Argument);
    });
  });
});

describe("strict UTF-8 encode: unpaired surrogate → InvalidArgument", () => {
  const bad: [string, string][] = [
    ["lone high surrogate", "\uD800"],
    ["lone low surrogate", "\uDC00"],
    ["high surrogate then ASCII", "a\uD83Dx"],
    ["low surrogate mid-string", "hi\uDFFF!"],
    ["high surrogate at end", "text\uD800"],
    ["reversed surrogate pair", "\uDC00\uD800"],
  ];

  describe.each(bad)("%s", (_name, text) => {
    it("rejects on the in-memory (fast) path", () => {
      const err = caught(() => new OStream().writeString(1, text));
      expect(err).toBeInstanceOf(SofabError);
      expect((err as SofabError).code).toBe(SofabErrorCode.Argument);
    });

    it("rejects on the streaming path", () => {
      // A caller-provided buffer disables the growable fast path and routes
      // through encodeUtf8 (TextEncoder), which must reject just the same.
      const os = new OStream(new Uint8Array(256));
      const err = caught(() => os.writeString(1, text));
      expect(err).toBeInstanceOf(SofabError);
      expect((err as SofabError).code).toBe(SofabErrorCode.Argument);
    });
  });
});

describe("strict UTF-8 encode: valid strings are byte-identical", () => {
  const good: [string, string][] = [
    ["ascii", "hello"],
    ["empty", ""],
    ["two-byte", "café ñ ©"],
    ["three-byte BMP", "日本語 π ∑"],
    ["astral (paired surrogates)", "😀🚀𝄞"],
    ["mixed astral + ascii", "a😀b日c"],
    ["embedded U+0000", "a\u0000b\u0000"],
    ["only NUL", "\u0000"],
  ];

  describe.each(good)("%s", (_name, text) => {
    it("fast path == streaming path (TextEncoder) byte-for-byte", () => {
      // The streaming path encodes valid input via TextEncoder — the pre-change
      // behavior. Equal output proves the fast path is unchanged for valid data.
      const inMemory = new OStream();
      inMemory.writeString(1, text);
      const streaming = new OStream(new Uint8Array(512));
      streaming.writeString(1, text);
      expect(inMemory.bytes()).toStrictEqual(streaming.bytes());
    });

    it("round-trips through the fatal decoder", () => {
      const os = new OStream();
      os.writeString(0, text);
      const c = new Cursor(os.bytes());
      expect(c.readHeader()).toBe(true);
      expect(c.readString()).toBe(text);
    });
  });
});

describe("strict UTF-8 decode: valid payloads accepted", () => {
  it("accepts embedded U+0000 (not the overlong C0 80 form)", () => {
    const os = new OStream();
    os.writeString(0, "a\u0000b");
    const c = new Cursor(os.bytes());
    c.readHeader();
    expect(c.readString()).toBe("a\u0000b");
  });

  it("accepts a correctly paired astral code point", () => {
    const os = new OStream();
    os.writeString(0, "😀");
    const c = new Cursor(os.bytes());
    c.readHeader();
    expect(c.readString()).toBe("😀");
  });
});
