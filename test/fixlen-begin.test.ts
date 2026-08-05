/**
 * `Visitor.fixlenBegin` — the string/blob counterpart of `arrayBegin`.
 *
 * A receiver-side bound on a *declared* length is decided by the length word,
 * not by the payload. Without this hook a visitor first learns `total` when
 * payload bytes arrive, so a message that ends right after an over-bound length
 * word escapes the check and degrades to INCOMPLETE — while the same bytes
 * through `Cursor.readString` are INVALID. §5.2 gives INVALID precedence over
 * INCOMPLETE for input already known to be malformed, so the two paths have to
 * agree.
 *
 * The guarantee tested here: `fixlenBegin` fires exactly once per string/blob
 * field, before any payload call, with the declared `total` — on the contiguous
 * path and the chunked one alike, and for a zero-length payload too.
 */

import { describe, expect, it } from "vitest";
import { FixlenSubtype, IStream, OStream, type Visitor } from "../src/index.js";

type Ev =
  | { k: "begin"; id: number; sub: FixlenSubtype; total: number }
  | { k: "bytes"; id: number; total: number; offset: number; len: number };

class Rec implements Visitor {
  readonly ev: Ev[] = [];
  fixlenBegin(id: number, subtype: FixlenSubtype, total: number): void {
    this.ev.push({ k: "begin", id, sub: subtype, total });
  }
  string(id: number, total: number, offset: number, chunk: Uint8Array): void {
    this.ev.push({ k: "bytes", id, total, offset, len: chunk.length });
  }
  blob(id: number, total: number, offset: number, chunk: Uint8Array): void {
    this.ev.push({ k: "bytes", id, total, offset, len: chunk.length });
  }
}

function encode(build: (os: OStream) => void): Uint8Array {
  const os = new OStream();
  build(os);
  return os.bytes().slice();
}

function feed(bytes: Uint8Array, chunkSize: number): Ev[] {
  const rec = new Rec();
  const is = new IStream();
  if (chunkSize <= 0) is.feed(bytes, rec);
  else for (let i = 0; i < bytes.length; i += chunkSize) {
    is.feed(bytes.subarray(i, i + chunkSize), rec);
  }
  return rec.ev;
}

describe("Visitor.fixlenBegin", () => {
  const cases: Array<[string, (os: OStream) => void, number, FixlenSubtype]> = [
    ["a string", (os) => os.writeString(2, "hello"), 5, FixlenSubtype.String],
    ["an empty string", (os) => os.writeString(2, ""), 0, FixlenSubtype.String],
    ["a blob", (os) => os.writeBlob(3, new Uint8Array([1, 2, 3, 4])), 4, FixlenSubtype.Blob],
    ["an empty blob", (os) => os.writeBlob(3, new Uint8Array()), 0, FixlenSubtype.Blob],
  ];

  for (const [what, build, total, sub] of cases) {
    for (const chunkSize of [0, 1, 2, 3]) {
      const how = chunkSize === 0 ? "one feed" : `${chunkSize} byte(s) per feed`;
      it(`announces ${what} at the length word — ${how}`, () => {
        const ev = feed(encode(build), chunkSize);
        const begins = ev.filter((e) => e.k === "begin");
        expect(begins).toHaveLength(1);
        expect(begins[0]).toEqual({ k: "begin", id: sub === FixlenSubtype.String ? 2 : 3, sub, total });
        // Before any payload: the announce must be the first event for the field.
        expect(ev[0]!.k).toBe("begin");
      });
    }
  }

  it("announces the declared total even when the payload never arrives", () => {
    // The case the hook exists for: an over-bound length word with nothing after
    // it. A payload-only visitor never learns `total` here.
    const whole = encode((os) => os.writeBlob(3, new Uint8Array(14)));
    const headerOnly = whole.subarray(0, 2); // field header + length word
    const ev = feed(headerOnly, 1);
    expect(ev).toEqual([{ k: "begin", id: 3, sub: FixlenSubtype.Blob, total: 14 }]);
  });
});
