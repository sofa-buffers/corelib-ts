/**
 * The encode-side UTF-8 writer itself (`src/encode/fixlen.ts`), driven directly
 * rather than through `OStream.writeString`.
 *
 * §6.4 / MESSAGE_SPEC §8 forbid silent `U+FFFD` substitution in either
 * direction, and this module has **three** paths that could commit it: the sizing
 * pass (`utf8Length`), the contiguous writing pass (`utf8Write`) and the
 * byte-at-a-time one (`utf8WriteSink`, the narrow-buffer path). `writeString` runs the
 * sizing pass first — it needs the byte length for the fixlen word — so through
 * the public API the writer only ever sees strings the sizer already accepted,
 * and its own surrogate rejections are never taken. That is precisely why they
 * are worth a test: they are the second half of a two-pass invariant, and a
 * refactor that drops the pre-pass (or reorders it behind a `reserveBulk` fast
 * path) would silently start emitting `U+FFFD` bytes with the whole public suite
 * still green. The unit under test is the internal module, deliberately.
 */

import { describe, expect, it } from "vitest";
import { utf8Length, utf8Write, utf8WriteSink } from "../src/encode/fixlen.js";

/** Collect what {@link utf8WriteSink} emits, byte by byte. */
function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  utf8WriteSink(text, { putByte: (b) => void out.push(b) });
  return Uint8Array.from(out);
}
import { SofabError, SofabErrorCode } from "../src/index.js";

const REPLACEMENT = [0xef, 0xbf, 0xbd]; // U+FFFD, the byte triple §8 forbids

/** Write `text` into a scratch buffer at `pos` and return the bytes written. */
function written(text: string, pos = 0): number[] {
  const out = new Uint8Array(pos + 4 * text.length + 8).fill(0xaa);
  const end = utf8Write(text, out, pos);
  return [...out.subarray(pos, end)];
}

/** Run `fn` and return the `SofabError` code it throws (or fail). */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SofabError) return e.code;
    throw e;
  }
  throw new Error("expected a SofabError, but nothing was thrown");
}

describe("utf8Write matches TextEncoder for well-formed input", () => {
  const good = [
    "",
    "hello",
    "pure ascii, the whole string", // exercises the ASCII-only early return
    "café ñ ©",
    "日本語 π",
    "a\u0000b", // embedded NUL is one byte, never the Modified-UTF-8 pair
    "\u{1f600}\u{1d11e}", // paired surrogates -> 4-byte sequences
    "mixed a\u{1f600}b日c",
  ];

  it.each(good)("%j", (text) => {
    const expected = [...new TextEncoder().encode(text)];
    expect(written(text)).toStrictEqual(expected);
    expect(utf8Length(text)).toBe(expected.length);
    expect([...encodeUtf8(text)]).toStrictEqual(expected);
  });

  it("writes at the caller's offset and reports the position past the last byte", () => {
    const out = new Uint8Array(16).fill(0xaa);
    const end = utf8Write("hé", out, 5);
    expect(end).toBe(8);
    expect([...out.subarray(0, 5)]).toStrictEqual([0xaa, 0xaa, 0xaa, 0xaa, 0xaa]);
    expect([...out.subarray(5, 8)]).toStrictEqual([0x68, 0xc3, 0xa9]);
    expect(out[8]).toBe(0xaa); // nothing written past the reported end
  });
});

describe("utf8Write rejects an unpaired surrogate rather than substituting U+FFFD", () => {
  const bad: [string, string][] = [
    ["lone high surrogate", "\ud800"],
    ["lone low surrogate", "\udc00"],
    ["high surrogate then ASCII", "a\ud83dx"],
    ["high surrogate at the very end", "text\ud800"],
    ["low surrogate after multibyte", "é\udfff"],
    ["reversed pair", "\udc00\ud800"],
  ];

  it.each(bad)("%s", (_name, text) => {
    expect(codeOf(() => written(text))).toBe(SofabErrorCode.Argument);
    expect(codeOf(() => utf8Length(text))).toBe(SofabErrorCode.Argument);
    expect(codeOf(() => encodeUtf8(text))).toBe(SofabErrorCode.Argument);
  });

  it("emits no replacement bytes before it gives up", () => {
    // The bytes already written when the writer hits the bad unit stay whatever
    // the valid prefix produced — no U+FFFD is ever appended for the bad one.
    const out = new Uint8Array(32).fill(0xaa);
    expect(codeOf(() => utf8Write("ok\ud800", out, 0))).toBe(SofabErrorCode.Argument);
    const hay = [...out].join(",");
    expect(hay.includes(REPLACEMENT.join(","))).toBe(false);
  });

  it("names the index of the offending code unit", () => {
    try {
      utf8Write("aé\ud800b", new Uint8Array(32), 0);
      expect.unreachable("an unpaired surrogate must be rejected");
    } catch (e) {
      expect((e as SofabError).message).toContain("index 2");
    }
  });
});
