/**
 * `writeString(id, text, maxlen)` — the caller's bound on a string field, in
 * UTF-8 bytes.
 *
 * A generated encoder knows its schema's `maxlen`; this codec does not, and is
 * only handed it. What only the codec knows is the UTF-8 length of a JS string
 * (which carries UTF-16 units), because the writer computes it anyway to size
 * the fixlen header. So the bound is checked there, in the same pass, and a
 * string over it is refused with `ARGUMENT` (CORELIB_PLAN §6.3) before a byte
 * of the field is written — on the ASCII fast path and the general UTF-8 path,
 * into a fixed buffer and through a flush sink alike.
 */

import { describe, expect, it } from "vitest";
import { OStream, SofabError, SofabErrorCode, decode, type Visitor } from "../src/index.js";

function caught(fn: () => void): SofabError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SofabError) return e;
    throw e;
  }
  throw new Error("expected a SofabError, nothing was thrown");
}

/** The string field of `bytes`, decoded through the visitor. */
function readString(bytes: Uint8Array): string {
  const parts: number[] = [];
  const v: Visitor = {
    string(_id, _total, _offset, src, start, end) {
      for (let i = start; i < end; i++) parts.push(src[i]!);
    },
  };
  decode(bytes, v);
  return new TextDecoder().decode(new Uint8Array(parts));
}

describe("writeString with a maxlen", () => {
  const cases: Array<[string, string, number]> = [
    ["ASCII exactly at the bound", "xxxx", 4],
    ["2-byte characters exactly at the bound", "éé", 4],
    ["a 4-byte character exactly at the bound", "😀", 4],
    ["the empty string at bound 0", "", 0],
    ["a short string well under the bound", "ab", 60],
  ];
  for (const [what, text, maxlen] of cases) {
    it(`accepts ${what}`, () => {
      const buf = new Uint8Array(32);
      const os = new OStream(buf);
      os.writeString(1, text, maxlen);
      expect(readString(os.bytes())).toBe(text);
    });
  }

  const over: Array<[string, string, number, number]> = [
    ["ASCII one byte over", "xxxxx", 4, 5],
    ["ASCII far over", "x".repeat(60), 4, 60],
    ["2-byte characters over (80 bytes, 40 UTF-16 units)", "é".repeat(40), 4, 80],
    ["a string whose cut at the bound would split a character", "xxxé", 4, 5],
    ["a 4-byte character over a bound of 3", "😀", 3, 4],
    ["any byte at bound 0", "a", 0, 1],
    ["two UTF-16 units that are 6 UTF-8 bytes, bound 5", "€€", 5, 6],
  ];
  for (const [what, text, maxlen, len] of over) {
    it(`refuses ${what}, with ARGUMENT and nothing written`, () => {
      const buf = new Uint8Array(128);
      const os = new OStream(buf);
      os.writeUnsigned(0, 7);
      const before = os.bytesUsed;
      const err = caught(() => os.writeString(1, text, maxlen));
      expect(err.code).toBe(SofabErrorCode.Argument);
      expect(err.message).toBe(`string length ${len} bytes exceeds maxlen ${maxlen}`);
      expect(os.bytesUsed).toBe(before);
      expect(buf.subarray(before).every((b) => b === 0)).toBe(true);
      // The encoder is still usable: the refusal changed nothing.
      os.writeString(1, "ok", maxlen < 2 ? 2 : maxlen);
      expect(readString(os.bytes())).toBe("ok");
    });
  }

  it("refuses through a flush sink before anything reaches the sink", () => {
    const chunks: number[] = [];
    const os = new OStream(new Uint8Array(16), 0, (_b, s, e) => {
      chunks.push(e - s);
    });
    const err = caught(() => os.writeString(1, "é".repeat(40), 79));
    expect(err.code).toBe(SofabErrorCode.Argument);
    expect(chunks).toEqual([]);
    expect(os.bytesUsed).toBe(0);
  });

  it("streams a string at its bound through a narrow flush buffer", () => {
    const parts: Uint8Array[] = [];
    const os = new OStream(new Uint8Array(16), 0, (b, s, e) => {
      parts.push(b.slice(s, e));
    });
    const text = "é".repeat(40);
    os.writeString(1, text, 80);
    os.flush();
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    expect(readString(all)).toBe(text);
  });

  it("without a maxlen behaves as before: only FIXLEN_MAX bounds it", () => {
    const text = "x".repeat(600);
    const a = new OStream(new Uint8Array(700));
    a.writeString(1, text);
    expect(readString(a.bytes())).toBe(text);
  });

  it("writes the same bytes with and without a satisfied maxlen", () => {
    for (const text of ["", "abcd", "äöü€", "😀x"]) {
      const a = new OStream(new Uint8Array(32));
      const b = new OStream(new Uint8Array(32));
      a.writeString(3, text);
      b.writeString(3, text, 16);
      expect(Array.from(b.bytes())).toEqual(Array.from(a.bytes()));
    }
  });

  it("still refuses a lone surrogate under the bound, as without one", () => {
    const os = new OStream(new Uint8Array(32));
    const err = caught(() => os.writeString(1, "a\ud800", 16));
    expect(err.code).toBe(SofabErrorCode.Argument);
    expect(os.bytesUsed).toBe(0);
  });
});
