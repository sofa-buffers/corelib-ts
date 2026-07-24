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
  MAX_DEPTH,
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

// The delivered fixlen subtype, peeked by readHeader onto Cursor.fixSub, is the
// companion to `wire`: it separates the four fixlen kinds (fp32/fp64/string/blob)
// that all share WireType.Fixlen, so a generated guard can skip a fixlen field
// whose subtype contradicts the schema (MESSAGE_SPEC §7.3) instead of throwing
// from the wrong-typed reader (corelib-ts#58).
describe("Cursor fixlen subtype accessor (§7.3; corelib-ts#58)", () => {
  const FIXLEN = 2;
  const ARRAY_FIXLEN = 5;
  // FixlenSubtype: Fp32=0, Fp64=1, String=2, Blob=3.

  it("reports the delivered subtype for each scalar fixlen kind", () => {
    const os = new OStream();
    os.writeFp32(1, 1.5);
    os.writeFp64(2, 2.5);
    os.writeString(3, "hi");
    os.writeBlob(4, Uint8Array.from([0xaa]));

    const c = new Cursor(os.bytes());
    const got: Record<number, number> = {};
    while (c.readHeader()) {
      got[c.id] = c.fixSub;
      c.skip(c.wire);
    }
    // Fp32=0, Fp64=1, String=2, Blob=3 — keyed by field id.
    expect(got).toEqual({ 1: 0, 2: 1, 3: 2, 4: 3 });
  });

  it("reports the element subtype for fixlen arrays", () => {
    const os = new OStream();
    os.writeFp32Array(1, [1, 2]);
    os.writeFp64Array(2, [3.5]);

    const c = new Cursor(os.bytes());
    const got: Record<number, number> = {};
    while (c.readHeader()) {
      got[c.id] = c.fixSub;
      c.skip(c.wire);
    }
    expect(got).toEqual({ 1: 0 /* Fp32 */, 2: 1 /* Fp64 */ });
  });

  it("reports -1 for a non-fixlen field, and does not leak a stale subtype", () => {
    const os = new OStream();
    os.writeString(1, "x"); // sets fixSub = 2 (String)
    os.writeUnsigned(2, 7n); // must reset fixSub to -1, not leak the 2

    const c = new Cursor(os.bytes());
    const got: Record<number, number> = {};
    while (c.readHeader()) {
      got[c.id] = c.fixSub;
      c.skip(c.wire);
    }
    expect(got).toEqual({ 1: 2, 2: -1 });
  });

  it("lets a guard skip a wrong-subtype fixlen field instead of throwing (the issue's case)", () => {
    // id 9, wire Fixlen, but a STRING subtype where the schema wants fp64: the
    // §7.3 guard skips it. Then a real u32 follows and still decodes.
    const os = new OStream();
    os.writeString(9, "x"); // schema expects fp64 at id 9 — subtype contradicts it
    os.writeUnsigned(4, 42n);

    const c = new Cursor(os.bytes());
    let u32 = 0 as number | bigint;
    let skipped = false;
    while (c.readHeader()) {
      // Generated guard shape for an fp64 field at id 9.
      if (c.id === 9) {
        if (c.wire !== FIXLEN || c.fixSub !== 1 /* Fp64 */) {
          c.skip(c.wire);
          skipped = true;
          continue;
        }
        c.readFp64();
      } else if (c.id === 4) {
        u32 = c.readUnsigned();
      } else {
        c.skip(c.wire);
      }
    }
    expect(skipped).toBe(true);
    expect(u32).toBe(42);
  });

  it("peeks without consuming: the matching reader still reads the value", () => {
    const os = new OStream();
    os.writeFp64(9, 3.5);

    const c = new Cursor(os.bytes());
    expect(c.readHeader()).toBe(true);
    expect(c.fixSub).toBe(1); // Fp64, peeked
    expect(c.fixSub).toBe(1); // idempotent — peeking did not advance
    expect(c.readFp64()).toBe(3.5); // reader still consumes the word + payload
    expect(c.readHeader()).toBe(false);
  });

  it("reports a reserved subtype verbatim (guard skips, then skip() rejects it)", () => {
    // subtype 4 is reserved; the guard sees fixSub=4 (≠ any real subtype) and
    // skips, and skip() then rejects the malformed word as INVALID (§5.2).
    const buf = bytes(header(1, FIXLEN), fixlenSub(15, 4 /* reserved */));
    const c = new Cursor(buf);
    expect(c.readHeader()).toBe(true);
    expect(c.fixSub).toBe(4);
    expect(codeOf(() => c.skip(c.wire))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("reports -1 when the subtype word is truncated away", () => {
    // A Fixlen header with no following subtype word at all.
    const c = new Cursor(bytes(header(1, FIXLEN)));
    expect(c.readHeader()).toBe(true);
    expect(c.fixSub).toBe(-1);
    // The reader still surfaces the truncation.
    expect(codeOf(() => c.readFp64())).toBe(SofabErrorCode.Incomplete);
  });

  it("reports -1 for an array-fixlen header truncated before its element word", () => {
    // header + count varint, but the element (subtype) word is missing.
    const c = new Cursor(bytes(header(1, ARRAY_FIXLEN), uvarint(3n)));
    expect(c.readHeader()).toBe(true);
    expect(c.fixSub).toBe(-1);
  });

  it("peeks the element subtype past a multi-byte array count", () => {
    // A count large enough to encode as several LEB128 bytes, so the peek must
    // walk the count varint's continuation bytes to find the element word.
    const buf = bytes(
      header(1, ARRAY_FIXLEN),
      uvarint(300000n), // multi-byte count
      fixlenSub(8, 1 /* Fp64 */),
    );
    const c = new Cursor(buf);
    expect(c.readHeader()).toBe(true);
    expect(c.fixSub).toBe(1);
  });
});

describe("Cursor sequence depth (§7 outcome; corelib-ts#42)", () => {
  const SEQ_START = 6;
  const SEQ_END = 7;

  // Drive the cursor the way generated decode does: loop readHeader and skip each
  // value (skip discards a whole nested sequence). Exercises the skip() depth path.
  function driveSkipping(buf: Uint8Array): void {
    const c = new Cursor(buf);
    while (c.readHeader()) c.skip(c.wire);
  }

  // Drive it by *recursing* on a SequenceStart (like generated decodeFrom), so the
  // nested readHeader loop — and its own depth/EOF handling — is exercised, not skip.
  function driveRecursive(buf: Uint8Array): void {
    const c = new Cursor(buf);
    const loop = (): void => {
      while (c.readHeader()) {
        if (c.wire === SEQ_START) loop();
        else c.skip(c.wire);
      }
    };
    loop();
  }

  it("rejects a top-level stray sequence-end as INVALID", () => {
    // A lone SequenceEnd at the root closes no open sequence — dangling → INVALID.
    expect(codeOf(() => driveSkipping(bytes(header(0, SEQ_END))))).toBe(
      SofabErrorCode.InvalidMsg,
    );
  });

  it("rejects a stray sequence-end after a balanced sequence", () => {
    expect(
      codeOf(() =>
        driveSkipping(
          bytes(header(10, SEQ_START), header(0, SEQ_END), header(0, SEQ_END)),
        ),
      ),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("reports an unclosed sequence at end-of-buffer as INCOMPLETE (recursion path)", () => {
    expect(codeOf(() => driveRecursive(bytes(header(10, SEQ_START))))).toBe(
      SofabErrorCode.Incomplete,
    );
  });

  it("reports an unclosed sequence at end-of-buffer as INCOMPLETE (skip path)", () => {
    expect(codeOf(() => driveSkipping(bytes(header(10, SEQ_START))))).toBe(
      SofabErrorCode.Incomplete,
    );
  });

  it("accepts a balanced empty nested sequence", () => {
    expect(() =>
      driveRecursive(bytes(header(10, SEQ_START), header(0, SEQ_END))),
    ).not.toThrow();
    expect(() =>
      driveSkipping(bytes(header(10, SEQ_START), header(0, SEQ_END))),
    ).not.toThrow();
  });

  // §4.9/§6.2: nesting beyond MAX_DEPTH is INVALID regardless of what follows,
  // so it dominates the unclosed-at-EOF INCOMPLETE (documentation#17). The
  // guard lives in readHeader, so it is the recursion path — not skip() — that
  // exercises the ceiling (corelib-ts#65).
  it("accepts exactly MAX_DEPTH-deep nesting", () => {
    const buf = bytes(
      new Array<number>(MAX_DEPTH).fill(0x06), // MAX_DEPTH SequenceStart markers
      new Array<number>(MAX_DEPTH).fill(0x07), // ...all closed
    );
    expect(() => driveRecursive(buf)).not.toThrow();
  });

  it("rejects nesting one past MAX_DEPTH as INVALID (recursion path)", () => {
    // The 256th open exceeds the ceiling — rejected there, before EOF is reached,
    // so INVALID dominates the INCOMPLETE these unclosed sequences would give.
    const buf = bytes(new Array<number>(MAX_DEPTH + 1).fill(0x06));
    expect(codeOf(() => driveRecursive(buf))).toBe(SofabErrorCode.InvalidMsg);
  });

  // The skip path (skipSequence) must honour the same ceiling as the recursion
  // path: a subtree skipped on a wire-type mismatch is what the Crucible F-0029
  // reproducer exercises (300x 0x06 on a scalar field → c.skip(SequenceStart)),
  // and the readHeader-only guard left it reporting INCOMPLETE (corelib-ts#65).
  it("accepts exactly MAX_DEPTH-deep nesting (skip path)", () => {
    const buf = bytes(
      new Array<number>(MAX_DEPTH).fill(0x06), // MAX_DEPTH SequenceStart markers
      new Array<number>(MAX_DEPTH).fill(0x07), // ...all closed
    );
    expect(() => driveSkipping(buf)).not.toThrow();
  });

  it("rejects nesting one past MAX_DEPTH as INVALID (skip path)", () => {
    // readHeader accepts the first open (depth 0→1), then c.skip descends the
    // rest through skipSequence; the 256th open exceeds the ceiling and is
    // rejected there, before EOF, so INVALID dominates the unbalanced INCOMPLETE.
    const buf = bytes(new Array<number>(MAX_DEPTH + 1).fill(0x06));
    expect(codeOf(() => driveSkipping(buf))).toBe(SofabErrorCode.InvalidMsg);
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
// Each branch below reports the same three-valued outcome as the push
// (fast/istream) decode path (MESSAGE_SPEC §7): a *malformed* buffer throws
// SofabError(INVALID_MSG), while a buffer that ends *inside* a field (a
// truncation) throws SofabError(INCOMPLETE). We hand-craft each and assert the
// matching Cursor reader surfaces the right code.

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

  it("reports INCOMPLETE for a nested sequence that never closes", () => {
    const buf = bytes(header(3, 6 /* SequenceStart */)); // opened, never ended
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.skip(6);
      }),
    ).toBe(SofabErrorCode.Incomplete);
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

  it("reports INCOMPLETE for a truncated fp32 payload", () => {
    const buf = bytes(header(1, 2), fixlenSub(4, 0), [1, 2]); // only 2 of 4 bytes
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readFp32();
      }),
    ).toBe(SofabErrorCode.Incomplete);
  });

  it("reports INCOMPLETE for a truncated fp64 payload", () => {
    const buf = bytes(header(1, 2), fixlenSub(8, 1 /* Fp64 */), [1, 2, 3]);
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readFp64();
      }),
    ).toBe(SofabErrorCode.Incomplete);
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

  it("reports INCOMPLETE for a truncated string/blob payload", () => {
    const buf = bytes(header(1, 2), fixlenSub(10, 2 /* String, len 10 */), [
      1, 2, 3,
    ]);
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readString();
      }),
    ).toBe(SofabErrorCode.Incomplete);
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

// The unknown-field skip path must validate a fixlen word at its header exactly
// like the known-field path, so a *malformed* word (reserved subtype, wrong-width
// float, bad array element type) is INVALID even when the payload is also
// truncated — INVALID takes precedence over INCOMPLETE (MESSAGE_SPEC §5.2/§4.6).
describe("Cursor skip fixlen validation (§5.2 precedence; corelib-ts#49)", () => {
  it("rejects a reserved fixlen subtype (0x4..0x7) in a skipped field, truncated", () => {
    // subtype 4 is reserved; declared length 15, no payload follows.
    const buf = bytes(header(2021, 2 /* Fixlen */), fixlenSub(15, 4 /* reserved */));
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.skip(2);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects a wrong-width fp64 in a skipped field, truncated", () => {
    // subtype 1 (fp64) with declared length 15 (≠ 8), then truncated.
    const buf = bytes(header(2021, 2 /* Fixlen */), fixlenSub(15, 1 /* Fp64 */));
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.skip(2);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects a wrong-width fp32 in a skipped field", () => {
    const buf = bytes(header(2021, 2), fixlenSub(8, 0 /* Fp32, len ≠ 4 */));
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.skip(2);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects a fixlen array (ArrayFixlen) with a bad element word in a skipped field, truncated", () => {
    // count 12019, element word subtype 7 (reserved) — INVALID before the (absent)
    // payload can report INCOMPLETE.
    const buf = bytes(
      header(11, 5 /* ArrayFixlen */),
      uvarint(12019n),
      fixlenSub(0, 7 /* reserved element subtype */),
    );
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.skip(5);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects a fixlen array element with a string subtype in a skipped field", () => {
    // subtype 2 (string) with size 1 is not a valid array element type.
    const buf = bytes(
      header(11, 5 /* ArrayFixlen */),
      uvarint(3n),
      fixlenSub(1, 2 /* String, not fp32/fp64 */),
    );
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.skip(5);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  // Control (issue #49): a *well-formed* skipped field that merely truncates
  // stays INCOMPLETE — the fix must not over-reject.
  it("still reports INCOMPLETE for a well-formed but truncated skipped string", () => {
    // subtype 2 (string) length 2, only 1 payload byte present.
    const buf = bytes(header(2021, 2), fixlenSub(2, 2 /* String */), [0x41]);
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.skip(2);
      }),
    ).toBe(SofabErrorCode.Incomplete);
  });

  it("still reports INCOMPLETE for a well-formed but truncated skipped fp64 array", () => {
    // one fp64 element (size 8) declared, no payload bytes → truncated.
    const buf = bytes(
      header(11, 5 /* ArrayFixlen */),
      uvarint(1n),
      fixlenSub(8, 1 /* Fp64 */),
    );
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.skip(5);
      }),
    ).toBe(SofabErrorCode.Incomplete);
  });
});

// The known-field array read path must validate the fixlen element word at its
// header exactly like the skip path (#49), so a *malformed* element word is
// INVALID even when the payload is also truncated — INVALID takes precedence
// over INCOMPLETE (§5.2). arrayFixlenHeader used to call arrayCount() first,
// whose `count > remaining` guard fired INCOMPLETE before the element word was
// ever read (corelib-ts#51, follow-up to #49).
describe("Cursor read fixlen-array validation (§5.2 precedence; corelib-ts#51)", () => {
  it("rejects a reserved element subtype in a truncated fp64 array read", () => {
    // count 12019 (> the remaining byte, so the old count>remaining guard would
    // have fired INCOMPLETE), element word subtype 7 (reserved) → INVALID.
    const buf = bytes(
      header(11, 5 /* ArrayFixlen */),
      uvarint(12019n),
      fixlenSub(0, 7 /* reserved element subtype */),
    );
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readFp64Array();
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects a string element subtype in a truncated fp32 array read", () => {
    // subtype 2 (string) is not a valid array element type; large count so the
    // old guard would have masked it as INCOMPLETE.
    const buf = bytes(
      header(11, 5 /* ArrayFixlen */),
      uvarint(12019n),
      fixlenSub(1, 2 /* String, not fp32/fp64 */),
    );
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readFp32Array();
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  // Control: a *well-formed* element word that merely truncates the payload
  // stays INCOMPLETE — the fix must not over-reject.
  it("still reports INCOMPLETE for a well-formed but truncated fp64 array read", () => {
    // one fp64 element (size 8) declared, no payload bytes → truncated.
    const buf = bytes(
      header(11, 5 /* ArrayFixlen */),
      uvarint(1n),
      fixlenSub(8, 1 /* Fp64 */),
    );
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readFp64Array();
      }),
    ).toBe(SofabErrorCode.Incomplete);
  });
});

// A field that is BOTH a schema-bound violation (over-count / over-maxlen) AND
// truncated must be INVALID, never INCOMPLETE — INVALID dominates INCOMPLETE
// (MESSAGE_SPEC §5.2 anti-folding; §6.2/§7 over-count, §7.1 over-maxlen). The
// whole-unit readers now take the per-field schema bound and reject at the
// deciding count/length word, before their own truncation guard fires
// (corelib-ts#69; generator side sofa-buffers/generator#216). The reproduction
// vectors are the wire-level table from the issue: field id 15, count bound 4.
describe("Cursor schema-bound reject at header (§5.2 precedence; corelib-ts#69)", () => {
  // 0x7b = header(15, ArrayUnsigned): (15 << 3) | 3.
  it("rejects a truncated over-count unsigned array as INVALID, not INCOMPLETE", () => {
    // count 6 (> bound 4) then EOF after two element bytes: complete-message
    // over-count is already INVALID; this asserts the truncated twin is too.
    const buf = bytes(header(15, 3 /* ArrayUnsigned */), uvarint(6n), [0x01, 0x02]);
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readUnsignedArray(4);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  // Control: count == bound, then a truncated payload, stays INCOMPLETE — the
  // bound check must not over-reject a well-formed-but-short array.
  it("still reports INCOMPLETE for a count == bound array that truncates", () => {
    const buf = bytes(header(15, 3 /* ArrayUnsigned */), uvarint(4n), [0x01, 0x02]);
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readUnsignedArray(4);
      }),
    ).toBe(SofabErrorCode.Incomplete);
  });

  it("rejects a truncated over-count signed array as INVALID", () => {
    const buf = bytes(header(15, 4 /* ArraySigned */), uvarint(6n), [0x02]);
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readSignedArray(4);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects a truncated over-count array on the Long paths as INVALID", () => {
    const un = bytes(header(15, 3 /* ArrayUnsigned */), uvarint(6n), [0x01]);
    expect(
      codeOf(() => {
        const c = new Cursor(un);
        c.readHeader();
        c.readUnsignedArrayLong(4);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
    const si = bytes(header(15, 4 /* ArraySigned */), uvarint(6n), [0x01]);
    expect(
      codeOf(() => {
        const c = new Cursor(si);
        c.readHeader();
        c.readSignedArrayLong(4);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("rejects a truncated over-count fp64 array as INVALID", () => {
    // count 6 (> bound 4), valid fp64 element word, no payload → truncated.
    const buf = bytes(
      header(15, 5 /* ArrayFixlen */),
      uvarint(6n),
      fixlenSub(8, 1 /* Fp64 */),
    );
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readFp64Array(4);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("still reports INCOMPLETE for a count == bound fp64 array that truncates", () => {
    const buf = bytes(
      header(15, 5 /* ArrayFixlen */),
      uvarint(4n),
      fixlenSub(8, 1 /* Fp64 */),
    );
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readFp64Array(4);
      }),
    ).toBe(SofabErrorCode.Incomplete);
  });

  it("rejects a truncated over-maxlen string as INVALID, not INCOMPLETE", () => {
    // declared length 6 (> maxlen 4), only two payload bytes → truncated.
    const buf = bytes(
      header(15, 2 /* Fixlen */),
      fixlenSub(6, 2 /* String */),
      [0x61, 0x62],
    );
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readString(4);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  it("still reports INCOMPLETE for a length == maxlen string that truncates", () => {
    const buf = bytes(
      header(15, 2 /* Fixlen */),
      fixlenSub(4, 2 /* String */),
      [0x61, 0x62],
    );
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readString(4);
      }),
    ).toBe(SofabErrorCode.Incomplete);
  });

  it("rejects a truncated over-maxlen blob as INVALID", () => {
    const buf = bytes(
      header(15, 2 /* Fixlen */),
      fixlenSub(6, 3 /* Blob */),
      [0x61, 0x62],
    );
    expect(
      codeOf(() => {
        const c = new Cursor(buf);
        c.readHeader();
        c.readBlob(4);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });

  // Reading exactly at the bound with a complete payload still yields the value:
  // the bound is a ceiling (count/len may equal it), not a strict cap.
  it("reads a bound-sized array and string unchanged when complete", () => {
    const arr = bytes(header(15, 3 /* ArrayUnsigned */), uvarint(4n), [1, 2, 3, 4]);
    const ca = new Cursor(arr);
    ca.readHeader();
    expect(ca.readUnsignedArray(4)).toEqual([1, 2, 3, 4]);

    const str = bytes(header(15, 2 /* Fixlen */), fixlenSub(4, 2 /* String */), [
      0x61, 0x62, 0x63, 0x64,
    ]);
    const cs = new Cursor(str);
    cs.readHeader();
    expect(cs.readString(4)).toBe("abcd");
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

  it("reports INCOMPLETE for a varint truncated at each byte position", () => {
    // Byte 1: a header but no value bytes at all.
    expect(
      codeOf(() => {
        const c = new Cursor(bytes(header(1, 0)));
        c.readHeader();
        c.readUnsigned();
      }),
    ).toBe(SofabErrorCode.Incomplete);

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
      ).toBe(SofabErrorCode.Incomplete);
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

  // Regression for #53: an overlong (>64-bit) varint whose 10th byte carries
  // more than bit 63 was silently truncated/wrapped instead of rejected. Only
  // the low bit of the 10th byte is valid (it supplies bit 63); any higher
  // payload bit is a >64-bit overflow → INVALID.
  describe("overlong 10th byte is INVALID, not truncated (#53)", () => {
    const nineFF = () => new Array(9).fill(0xff); // fills bits 0..62

    const readValue = (tail: number[]) => {
      const c = new Cursor(bytes(header(1, 0), nineFF(), tail));
      c.readHeader();
      return c.readUnsigned();
    };

    it("accepts the 2^64-1 maximum (10th byte 0x01) as the control", () => {
      expect(BigInt(readValue([0x01]))).toBe(U64_MAX);
    });

    it("rejects the 65th bit (10th byte 0x02)", () => {
      expect(codeOf(() => readValue([0x02]))).toBe(SofabErrorCode.InvalidMsg);
    });

    it("rejects high payload bits in the 10th byte (0x7f)", () => {
      expect(codeOf(() => readValue([0x7f]))).toBe(SofabErrorCode.InvalidMsg);
    });
  });
});
