/**
 * The pull / cursor decoder ({@link Cursor}).
 *
 * These exercise the monomorphic decode path generated code uses: loop on
 * {@link Cursor.readHeader}, switch on {@link Cursor.id}, and pull each value
 * with the matching typed reader. We assert it reads exactly the same values as
 * the push ({@link decode}) path for scalars, floats, strings/blobs, arrays at
 * the 64-bit boundaries, nested sequences (recursion), and unknown-field skip.
 */

import { describe, expect, it } from "vitest";
import {
  Cursor,
  I64_MAX,
  I64_MIN,
  OStream,
  U64_MAX,
} from "../src/index.js";

describe("Cursor scalars", () => {
  it("reads unsigned/signed number-first at the 64-bit boundaries", () => {
    const os = new OStream();
    os.writeUnsigned(1, 0n);
    os.writeUnsigned(2, U64_MAX);
    os.writeSigned(3, I64_MIN);
    os.writeSigned(4, I64_MAX);
    os.writeSigned(5, -1n);

    const c = new Cursor(os.bytes());
    const got: Record<number, number | bigint> = {};
    while (c.readHeader()) {
      if (c.wire === 0) got[c.id] = c.readUnsigned();
      else got[c.id] = c.readSigned();
    }
    expect(got).toEqual({ 1: 0, 2: U64_MAX, 3: I64_MIN, 4: I64_MAX, 5: -1 });
  });

  it("reads fp32 (with rounding) and fp64", () => {
    const os = new OStream();
    os.writeFp32(1, 3.14159);
    os.writeFp64(2, Math.PI);
    os.writeFp32(3, Infinity);

    const c = new Cursor(os.bytes());
    const got: Record<number, number> = {};
    while (c.readHeader()) got[c.id] = c.id === 2 ? c.readFp64() : c.readFp32();
    expect(got[1]).toBe(Math.fround(3.14159));
    expect(got[2]).toBe(Math.PI);
    expect(got[3]).toBe(Infinity);
  });

  it("reads strings, unicode, empties and blobs (zero-copy view)", () => {
    const os = new OStream();
    os.writeString(1, "Hello, Sofab!");
    os.writeString(2, "äöü€");
    os.writeString(3, "");
    os.writeBlob(4, Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));

    const c = new Cursor(os.bytes());
    expect(c.readHeader()).toBe(true);
    expect(c.readString()).toBe("Hello, Sofab!");
    expect(c.readHeader()).toBe(true);
    expect(c.readString()).toBe("äöü€");
    expect(c.readHeader()).toBe(true);
    expect(c.readString()).toBe("");
    expect(c.readHeader()).toBe(true);
    expect(Array.from(c.readBlob())).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(c.readHeader()).toBe(false);
  });
});

describe("Cursor arrays", () => {
  it("reads unsigned/signed arrays at the boundaries, number-first", () => {
    const os = new OStream();
    os.writeUnsignedArray(1, [0n, U64_MAX]);
    os.writeSignedArray(2, [I64_MIN, 0n, I64_MAX]);

    const c = new Cursor(os.bytes());
    expect(c.readHeader()).toBe(true);
    expect(c.readUnsignedArray()).toEqual([0, U64_MAX]);
    expect(c.readHeader()).toBe(true);
    expect(c.readSignedArray()).toEqual([I64_MIN, 0, I64_MAX]);
  });

  it("reads float arrays", () => {
    const os = new OStream();
    os.writeFp32Array(1, [1, 2, 3]);
    os.writeFp64Array(2, [1.5, -2.5, 1e308]);

    const c = new Cursor(os.bytes());
    expect(c.readHeader()).toBe(true);
    expect(c.readFp32Array()).toEqual([1, 2, 3]);
    expect(c.readHeader()).toBe(true);
    expect(c.readFp64Array()).toEqual([1.5, -2.5, 1e308]);
  });
});

describe("Cursor nested sequences", () => {
  it("recurses: readHeader ends (consuming the close) at the sequence end", () => {
    // { u1=11, seq(2){ u1=99 } }
    const os = new OStream();
    os.writeUnsigned(1, 11n);
    os.writeSequenceBegin(2);
    os.writeUnsigned(1, 99n);
    os.writeSequenceEnd();

    const c = new Cursor(os.bytes());
    let outer = 0 as number | bigint;
    let inner = 0 as number | bigint;
    while (c.readHeader()) {
      if (c.id === 1) outer = c.readUnsigned();
      else if (c.id === 2 && c.wire === 6) {
        // child decode: read until the nested close
        while (c.readHeader()) inner = c.readUnsigned();
      }
    }
    expect(outer).toBe(11);
    expect(inner).toBe(99);
  });
});

describe("Cursor skip", () => {
  it("skips unknown scalar, array and whole nested-sequence fields, staying in sync", () => {
    const os = new OStream();
    os.writeUnsigned(1, 7n);
    os.writeUnsignedArray(2, [1n, 2n, 3n]);
    os.writeSequenceBegin(3);
    os.writeString(1, "ignored");
    os.writeSequenceBegin(9);
    os.writeUnsigned(1, 5n);
    os.writeSequenceEnd();
    os.writeSequenceEnd();
    os.writeUnsigned(4, 42n); // the one field we keep

    const c = new Cursor(os.bytes());
    let kept = 0 as number | bigint;
    while (c.readHeader()) {
      if (c.id === 4) kept = c.readUnsigned();
      else c.skip(c.wire);
    }
    expect(kept).toBe(42);
  });
});
