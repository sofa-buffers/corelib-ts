/**
 * `decodeUtf8` — the strict UTF-8 materializer, now part of the public surface.
 *
 * It was internal to the decoder until corelib-ts#147, so the only coverage it had
 * was whatever a decode happened to exercise. As an exported entry point
 * it is also what the *push* path uses — generated code reassembles a payload and
 * decodes it here rather than building a `TextDecoder` of its own — so both of
 * its edges need pinning directly:
 *
 * 1. the **flat ASCII fast path** and its `FLAT_MAX` boundary: one
 *    `String.fromCharCode` per length up to 16, the platform decoder past it, and
 *    the same string out of either;
 * 2. the **`TypeError` → `SofabError` mapping** folded in with the export. A
 *    caller's `catch (e) { if (e instanceof SofabError) … }` is the one clause
 *    the API asks them to write, and a bare platform `TypeError` walks straight
 *    through it.
 *
 * The fast path is where a strictness bug would hide, since it decides validity
 * itself instead of asking the platform: every case below is therefore run at a
 * length inside the flat window *and* past it.
 */

import { describe, expect, it } from "vitest";
import { SofabError, SofabErrorCode, decodeUtf8 } from "../src/index.js";

const UTF8 = new TextEncoder();

/** Longest payload the flat fast path covers (`FLAT_MAX` in src/decode/text.ts). */
const FLAT_MAX = 16;

function bytes(text: string): Uint8Array {
  return UTF8.encode(text);
}

describe("decodeUtf8 decodes what it is given", () => {
  it("returns the empty string for an empty range", () => {
    expect(decodeUtf8(new Uint8Array(0))).toBe("");
    expect(decodeUtf8(bytes("abc"), 1, 1)).toBe("");
  });

  it.each(Array.from({ length: FLAT_MAX + 4 }, (_, n) => n))(
    "round-trips %i ASCII bytes",
    (n) => {
      // "abc…" truncated to n: every length across the flat window's boundary,
      // so each fromCharCode arm and the platform fall-through are both hit.
      const text = "abcdefghijklmnopqrst".slice(0, n);
      expect(decodeUtf8(bytes(text))).toBe(text);
    },
  );

  it.each([
    ["2-byte", "é"],
    ["3-byte", "字"],
    ["astral pair", "🛋"],
    ["mixed", "a🛋é字z"],
    ["embedded NUL", "a\u0000b"],
  ])("round-trips %s payloads inside and past the flat window", (_name, text) => {
    expect(decodeUtf8(bytes(text))).toBe(text);
    const long = text.repeat(12);
    expect(bytes(long).length).toBeGreaterThan(FLAT_MAX);
    expect(decodeUtf8(bytes(long))).toBe(long);
  });

  it("decodes only the requested range", () => {
    const buf = bytes("XXhelloYY");
    expect(decodeUtf8(buf, 2, 7)).toBe("hello");
    // A high-bit byte outside the range must not spoil the ASCII gate inside it.
    const framed = new Uint8Array([0xff, ...bytes("hi"), 0xff]);
    expect(decodeUtf8(framed, 1, 3)).toBe("hi");
  });

  it("defaults the range to the whole array", () => {
    const buf = bytes("hello");
    expect(decodeUtf8(buf)).toBe(decodeUtf8(buf, 0, buf.length));
  });

  it("reads a view at a non-zero byteOffset, not the underlying buffer", () => {
    const backing = new Uint8Array(32).fill(0xff);
    const payload = bytes("hi there");
    backing.set(payload, 8);
    const view = backing.subarray(8, 8 + payload.length);
    expect(view.byteOffset).toBe(8);
    expect(decodeUtf8(view)).toBe("hi there");
  });
});

describe("decodeUtf8 rejects malformed UTF-8 as INVALID_MSG (§8/§6.4)", () => {
  const malformed: [string, number[]][] = [
    ["lone continuation byte", [0x80]],
    ["truncated 2-byte lead", [0xc3]],
    ["truncated 3-byte sequence", [0xe6, 0x96]],
    ["overlong encoding of '/'", [0xc0, 0xaf]],
    ["surrogate half (CESU-8)", [0xed, 0xa0, 0x80]],
    ["above U+10FFFF", [0xf5, 0x80, 0x80, 0x80]],
    ["continuation without lead, mid-payload", [0x61, 0x80, 0x62]],
  ];

  it.each(malformed)("%s throws SofabError(INVALID_MSG)", (_name, raw) => {
    // Twice: short enough for the fast path to have decided, and padded past
    // FLAT_MAX so the platform decoder is the one deciding. Both must reject —
    // the ASCII gate must never let a high-bit byte reach fromCharCode.
    for (const pad of [0, FLAT_MAX]) {
      const buf = new Uint8Array([...raw, ...new Uint8Array(pad).fill(0x61)]);
      try {
        decodeUtf8(buf);
        expect.unreachable(`decodeUtf8 must reject ${_name}`);
      } catch (e) {
        expect(e).toBeInstanceOf(SofabError);
        expect((e as SofabError).code).toBe(SofabErrorCode.InvalidMsg);
      }
    }
  });

  it("never lets the platform TypeError escape", () => {
    // The whole point of folding the mapping in: this is the clause every
    // consumer writes, and a TypeError is not caught by it.
    expect(() => decodeUtf8(Uint8Array.of(0xff, 0xfe))).toThrow(SofabError);
    expect(() => decodeUtf8(Uint8Array.of(0xff, 0xfe))).not.toThrow(TypeError);
  });

  it("judges only the requested range", () => {
    // Invalid bytes on either side of a valid range are none of its business —
    // the mirror of the length-vs-end-index confusion test/utf8-late-offset.ts
    // exists for.
    const buf = new Uint8Array([0xff, ...bytes("ok"), 0xff]);
    expect(decodeUtf8(buf, 1, 3)).toBe("ok");
    expect(() => decodeUtf8(buf, 0, 3)).toThrow(SofabError);
  });
});
