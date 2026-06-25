/**
 * Skip behavior (ARCHITECTURE.md §7.2.6): a decoder that ignores some fields —
 * including an entire nested sub-sequence — must consume their bytes and resync
 * cleanly on the following field. In the visitor model "skip" is simply not
 * handling a field; the decoder walks the bytes regardless.
 */

import { describe, expect, it } from "vitest";
import { IStream, OStream, decode, type Visitor } from "../src/index.js";

/** A message with fields surrounding a nested sub-sequence (itself nested). */
function build(os: OStream): void {
  os.writeUnsigned(1, 100);
  os.writeString(2, "skip-me");
  os.writeSequenceBegin(3); // <- whole sub-sequence to be skipped
  os.writeUnsigned(1, 1);
  os.writeSignedArray(2, [-1, -2, -3]);
  os.writeSequenceBegin(4); // nested deeper
  os.writeFp64(1, 2.5);
  os.writeSequenceEnd();
  os.writeSequenceEnd();
  os.writeUnsigned(9, 999); // <- must still decode after the skipped sub-sequence
}

describe("skipping", () => {
  it("resyncs on the field after a fully skipped sub-sequence", () => {
    const os = new OStream();
    build(os);

    // Visitor handles only the trailing field; everything else is skipped.
    let tail: bigint | undefined;
    const seen: number[] = [];
    const visitor: Visitor = {
      unsigned(id, v) {
        seen.push(id);
        if (id === 9) tail = v;
      },
    };

    expect(() => decode(os.bytes(), visitor)).not.toThrow();
    expect(tail).toBe(999n); // resynced correctly after the skipped sequence
    // id 1 appears top-level and inside the skipped sequence; id 9 is the tail.
    expect(seen).toEqual([1, 1, 9]);
  });

  it("skips correctly even when fed one byte at a time", () => {
    const os = new OStream();
    build(os);
    const bytes = os.bytes();

    let tail: bigint | undefined;
    const visitor: Visitor = {
      unsigned(id, v) {
        if (id === 9) tail = v;
      },
    };

    const is = new IStream();
    for (let i = 0; i < bytes.length; i++) is.feed(bytes.subarray(i, i + 1), visitor);
    is.end();

    expect(tail).toBe(999n);
  });

  it("a fully empty visitor consumes the whole message and ends cleanly", () => {
    const os = new OStream();
    build(os);
    const is = new IStream();
    is.feed(os.bytes(), {});
    expect(() => is.end()).not.toThrow();
  });
});
