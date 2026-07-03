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
  SofabError,
  SofabErrorCode,
  U64_MAX,
} from "../src/index.js";

// --- helpers for hand-crafting malformed buffers ------------------------------

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

/** Unsigned LEB128 encoding of a bigint, as a plain byte array. */
function uvarint(n: bigint): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
}

/** A field header word `(id << 3) | wire`, LEB128 encoded. */
function header(id: number, wire: number): number[] {
  return uvarint((BigInt(id) << 3n) | BigInt(wire));
}

/** A fixlen sub-header word `(len << 3) | subtype`, LEB128 encoded. */
function fixlenSub(len: number, sub: number): number[] {
  return uvarint((BigInt(len) << 3n) | BigInt(sub));
}

/** Concatenate byte arrays into one Uint8Array. */
function bytes(...parts: number[][]): Uint8Array {
  return Uint8Array.from(parts.flat());
}

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

  it("skips an fp32/fp64 array (ArrayFixlen) unknown field, staying in sync", () => {
    const os = new OStream();
    os.writeFp32Array(1, [1, 2, 3]);
    os.writeFp64Array(2, [1.5, 2.5]);
    os.writeUnsigned(3, 99n); // the one field we keep

    const c = new Cursor(os.bytes());
    let kept = 0 as number | bigint;
    while (c.readHeader()) {
      if (c.id === 3) kept = c.readUnsigned();
      else c.skip(c.wire);
    }
    expect(kept).toBe(99);
  });
});

// --- error / edge paths -------------------------------------------------------
//
// Every branch below throws the same SofabError(INVALID_MSG) as the push
// (fast/istream) decode path. We hand-craft malformed buffers and assert the
// matching Cursor reader rejects them, matching the existing error-code style.

const ID_MAX = 0x7fff_ffff;
const FIXLEN_MAX = 0x7fff_ffff;
const ARRAY_MAX = 0x7fff_ffff;

// FixlenSubtype: Fp32=0, Fp64=1, String=2, Blob=3.
// WireType: Unsigned=0, Signed=1, Fixlen=2, ArrayUnsigned=3, ArraySigned=4,
//           ArrayFixlen=5, SequenceStart=6, SequenceEnd=7.

describe("Cursor header errors", () => {
  it("rejects a field id past ID_MAX", () => {
    const buf = bytes(header(ID_MAX + 1, 0 /* Unsigned */));
    expect(codeOf(() => new Cursor(buf).readHeader())).toBe(
      SofabErrorCode.InvalidMsg,
    );
  });

  it("rejects a field id past ID_MAX inside a skipped nested sequence", () => {
    // SequenceStart, then a bogus inner field header with an out-of-range id.
    const buf = bytes(header(3, 6 /* SequenceStart */), header(ID_MAX + 1, 0));
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.skip(6);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects a nested sequence that never closes (unbalanced)", () => {
    const buf = bytes(header(3, 6 /* SequenceStart */)); // opened, never ended
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.skip(6);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });
});

describe("Cursor fixlen scalar errors", () => {
  it("rejects an fp32 field whose subtype is not fp32", () => {
    const buf = bytes(header(1, 2 /* Fixlen */), fixlenSub(4, 2 /* String */));
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readFp32();
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects an fp32 field whose byte length is not 4", () => {
    const buf = bytes(header(1, 2), fixlenSub(8, 0 /* Fp32, wrong len */));
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readFp32();
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects a truncated fp32 payload", () => {
    const buf = bytes(header(1, 2), fixlenSub(4, 0), [1, 2]); // only 2 of 4 bytes
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readFp32();
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects a truncated fp64 payload", () => {
    const buf = bytes(header(1, 2), fixlenSub(8, 1 /* Fp64 */), [1, 2, 3]);
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readFp64();
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects a string field whose subtype is not string", () => {
    const buf = bytes(header(1, 2), fixlenSub(4, 0 /* Fp32, not String */));
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readString();
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects a string field whose declared length exceeds FIXLEN_MAX", () => {
    const buf = bytes(header(1, 2), fixlenSub(FIXLEN_MAX + 1, 2 /* String */));
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readString();
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects a truncated string/blob payload", () => {
    const buf = bytes(header(1, 2), fixlenSub(10, 2 /* String, len 10 */), [
      1, 2, 3,
    ]);
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readString();
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects a fixlen field with an out-of-range length when skipped", () => {
    const buf = bytes(header(1, 2), fixlenSub(FIXLEN_MAX + 1, 2));
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.skip(2);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects skip() called with an invalid wire type", () => {
    // wire 7 (SequenceEnd) is never a value; skipping it is a malformed input.
    expect(codeOf(() => new Cursor(bytes([])).skip(7))).toBe(
      SofabErrorCode.InvalidMsg,
    );
  });
});

describe("Cursor array errors", () => {
  it("rejects an array count past ARRAY_MAX", () => {
    const buf = bytes(header(1, 3 /* ArrayUnsigned */), uvarint(BigInt(ARRAY_MAX) + 1n));
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readUnsignedArray();
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects an fp32 array whose element type is wrong", () => {
    // count 0, then an fp64 element header where fp32 was expected.
    const buf = bytes(header(1, 5 /* ArrayFixlen */), uvarint(0n), fixlenSub(4, 1 /* Fp64 */));
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readFp32Array();
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });
});

describe("Cursor varint errors", () => {
  // Complete varints of every LEB128 length (1..10 bytes), so the per-byte
  // "final byte" branches in readVarint are all exercised on the happy side.
  const byLength = [
    1n,
    200n,
    20_000n,
    3_000_000n,
    300_000_000n,
    40_000_000_000n,
    5_000_000_000_000n,
    600_000_000_000_000n,
    100_000_000_000_000_000n,
    1n << 63n,
  ];

  it("reads unsigned varints of every encoded byte length", () => {
    const os = new OStream();
    byLength.forEach((v, i) => os.writeUnsigned(i + 1, v));
    const c = new Cursor(os.bytes());
    const got: bigint[] = [];
    while (c.readHeader()) got.push(BigInt(c.readUnsigned()));
    expect(got).toEqual(byLength);
  });

  it("rejects a varint truncated at each byte position", () => {
    // Byte 1: a header but no value bytes at all.
    expect(
      codeOf(() => {
        const c = new Cursor(bytes(header(1, 0)));
        c.readHeader();
        c.readUnsigned();
      }),
    ).toBe(SofabErrorCode.InvalidMsg);

    // Bytes 2..10: a value varint of length k with its final byte chopped off,
    // leaving k-1 continuation bytes that run off the end of the buffer.
    for (const v of byLength.slice(1)) {
      const enc = uvarint(v);
      const buf = bytes(header(1, 0), enc.slice(0, enc.length - 1));
      expect(
        codeOf(() => {
          const c = new Cursor(buf);
          c.readHeader();
          c.readUnsigned();
        }),
      ).toBe(SofabErrorCode.InvalidMsg);
    }
  });

  it("rejects a varint that overflows 64 bits (11th continuation byte)", () => {
    const buf = bytes(header(1, 0), new Array(10).fill(0x80));
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readUnsigned();
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });
});
