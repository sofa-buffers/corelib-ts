/**
 * Receiver-side limits (CORELIB_PLAN §6.2.1, corelib-ts#38).
 *
 * A receiver caps array counts and string / blob byte lengths through
 * {@link DecodeLimits}. An over-limit field is rejected at its count / length
 * header — before it is materialized or streamed — with a `SofabError` whose code
 * is {@link SofabErrorCode.LimitExceeded}, kept deliberately distinct from
 * `InvalidMsg` (policy, not malformation).
 *
 * **They are no longer optional.** §6.2.1 now requires every receiver to carry
 * them — "there is no unset state and no unlimited mode" — so an omitted option
 * takes this port's documented default rather than switching the cap off, and a
 * non-finite one is refused outright. The *values* belong to generated code, which
 * knows the schema and the target; the defaults exist so that a decoder built
 * without any is still bounded.
 *
 * Both entry points are checked: the one-shot {@link decode} and the streaming
 * {@link IStream}. They are the same decoder (§5.3.1), and this is one of the
 * places where "the same decoder" has to be visible rather than asserted.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_DYN_ARRAY_COUNT,
  DEFAULT_MAX_DYN_BLOB_LEN,
  DEFAULT_MAX_DYN_STRING_LEN,
  IStream,
  SofabError,
  SofabErrorCode,
  decode,
  growingOStream,
  type DecodeLimits,
  type Visitor,
} from "../src/index.js";

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

/** Feed a whole buffer to a streaming IStream in one push. */
function drainStream(buf: Uint8Array, limits?: DecodeLimits, visitor: Visitor = {}): void {
  const is = new IStream(visitor, limits);
  is.feed(buf);
}

/** Feed a whole buffer to a streaming IStream one byte at a time. */
function drainChunked(buf: Uint8Array, limits?: DecodeLimits, visitor: Visitor = {}): void {
  const is = new IStream(visitor, limits);
  for (let i = 0; i < buf.length; i++) is.feed(buf.subarray(i, i + 1));
}

describe("decode limits: array count (maxArrayCount)", () => {
  // An otherwise-valid message carrying LIMIT + 1 unsigned elements.
  const LIMIT = 65536;
  const oversize = (() => {
    const os = growingOStream();
    os.writeUnsignedArray(1, new Array(LIMIT + 1).fill(0));
    return os.bytes().slice();
  })();

  it("decodes with no options, because the default cap is above this count", () => {
    expect(LIMIT + 1).toBeLessThan(DEFAULT_MAX_DYN_ARRAY_COUNT);
    expect(() => decode(oversize, {})).not.toThrow();
    expect(() => drainStream(oversize)).not.toThrow();
  });

  it("throws LimitExceeded on both entry points once maxArrayCount is set", () => {
    const limits = { maxArrayCount: LIMIT };
    expect(codeOf(() => decode(oversize, {}, limits))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainStream(oversize, limits))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainChunked(oversize, limits))).toBe(SofabErrorCode.LimitExceeded);
  });

  it("is distinct from InvalidMsg (policy, not malformation)", () => {
    expect(codeOf(() => decode(oversize, {}, { maxArrayCount: LIMIT }))).not.toBe(
      SofabErrorCode.InvalidMsg,
    );
  });

  it("does not latch the stream INVALID — the bytes are well-formed", () => {
    const is = new IStream({}, { maxArrayCount: LIMIT });
    expect(codeOf(() => is.feed(oversize))).toBe(SofabErrorCode.LimitExceeded);
    expect(is.status()).not.toBe("INVALID");
  });

  it("accepts a count exactly at the limit, rejects one past it", () => {
    const at = (() => {
      const os = growingOStream();
      os.writeUnsignedArray(1, new Array(8).fill(1));
      return os.bytes().slice();
    })();
    expect(() => decode(at, {}, { maxArrayCount: 8 })).not.toThrow();
    expect(codeOf(() => decode(at, {}, { maxArrayCount: 7 }))).toBe(
      SofabErrorCode.LimitExceeded,
    );
  });

  it("rejects before the array is announced (no arrayBegin)", () => {
    let began = false;
    const spy: Visitor = { arrayBegin: () => { began = true; } };
    expect(codeOf(() => drainStream(oversize, { maxArrayCount: LIMIT }, spy))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    expect(began).toBe(false);
  });

  it("also caps signed and float arrays", () => {
    const signed = (() => {
      const os = growingOStream();
      os.writeSignedArray(1, new Array(20).fill(-1));
      return os.bytes().slice();
    })();
    const floats = (() => {
      const os = growingOStream();
      os.writeFp32Array(1, new Array(20).fill(1.5));
      return os.bytes().slice();
    })();
    expect(codeOf(() => decode(signed, {}, { maxArrayCount: 10 }))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    expect(codeOf(() => decode(floats, {}, { maxArrayCount: 10 }))).toBe(
      SofabErrorCode.LimitExceeded,
    );
  });
});

describe("decode limits: string length (maxStringLen)", () => {
  const msg = (() => {
    const os = growingOStream();
    os.writeString(1, "x".repeat(100));
    return os.bytes().slice();
  })();

  it("decodes under the default cap", () => {
    expect(100).toBeLessThan(DEFAULT_MAX_DYN_STRING_LEN);
    expect(() => decode(msg, {})).not.toThrow();
    expect(() => drainStream(msg)).not.toThrow();
  });

  it("throws LimitExceeded on both entry points once maxStringLen is set", () => {
    const limits = { maxStringLen: 64 };
    expect(codeOf(() => decode(msg, {}, limits))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainStream(msg, limits))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainChunked(msg, limits))).toBe(SofabErrorCode.LimitExceeded);
  });

  it("rejects before any payload piece reaches the visitor", () => {
    let gotPiece = false;
    const spy: Visitor = { string: () => { gotPiece = true; } };
    expect(codeOf(() => drainStream(msg, { maxStringLen: 64 }, spy))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    expect(gotPiece).toBe(false);
  });

  it("a blob is not capped by maxStringLen (independent limits)", () => {
    const blob = (() => {
      const os = growingOStream();
      os.writeBlob(1, new Uint8Array(100));
      return os.bytes().slice();
    })();
    expect(() => decode(blob, {}, { maxStringLen: 4 })).not.toThrow();
  });
});

describe("decode limits: blob length (maxBlobLen)", () => {
  const msg = (() => {
    const os = growingOStream();
    os.writeBlob(1, new Uint8Array(100));
    return os.bytes().slice();
  })();

  it("throws LimitExceeded on both entry points once maxBlobLen is set", () => {
    const limits = { maxBlobLen: 64 };
    expect(codeOf(() => decode(msg, {}, limits))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainStream(msg, limits))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainChunked(msg, limits))).toBe(SofabErrorCode.LimitExceeded);
  });

  it("a string is not capped by maxBlobLen (independent limits)", () => {
    const str = (() => {
      const os = growingOStream();
      os.writeString(1, "x".repeat(100));
      return os.bytes().slice();
    })();
    expect(() => decode(str, {}, { maxBlobLen: 4 })).not.toThrow();
  });
});

describe("there is no unset state and no unlimited mode (§6.2.1)", () => {
  /** A message whose one field is `n` elements / bytes long. */
  const arrayOf = (n: number): Uint8Array => {
    const os = growingOStream();
    os.writeUnsignedArray(1, new Array(n).fill(0));
    return os.bytes().slice();
  };

  it("an omitted cap takes the port's default rather than switching off", () => {
    // A count one past the default must be rejected by a decoder that was given
    // no options at all — the property "unbounded by the schema is still bounded
    // by the receiver" rests on.
    const overDefault = (() => {
      // Built by hand: materializing 2^20 + 1 elements to encode them would cost
      // more than the assertion is worth, and only the count word is read.
      const count = DEFAULT_MAX_DYN_ARRAY_COUNT + 1;
      const out = [0x0b]; // id 1, wire 3 (ArrayUnsigned)
      for (let v = count; ; v >>>= 7) {
        if (v < 0x80) { out.push(v); break; }
        out.push((v & 0x7f) | 0x80);
      }
      return Uint8Array.from(out);
    })();
    expect(codeOf(() => decode(overDefault, {}))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainStream(overDefault))).toBe(SofabErrorCode.LimitExceeded);
    // One below it is merely truncated — so the rejection above really is the cap.
    expect(() => decode(arrayOf(3), {})).not.toThrow();
  });

  it("the defaults are finite and within the format ceilings", () => {
    for (const v of [
      DEFAULT_MAX_DYN_ARRAY_COUNT,
      DEFAULT_MAX_DYN_STRING_LEN,
      DEFAULT_MAX_DYN_BLOB_LEN,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(0x7fff_ffff);
    }
  });

  it("refuses Infinity, a negative cap and a fractional one", () => {
    for (const bad of [Infinity, -1, 1.5, NaN]) {
      expect(codeOf(() => new IStream({}, { maxArrayCount: bad }))).toBe(
        SofabErrorCode.Argument,
      );
      expect(codeOf(() => new IStream({}, { maxStringLen: bad }))).toBe(
        SofabErrorCode.Argument,
      );
      expect(codeOf(() => new IStream({}, { maxBlobLen: bad }))).toBe(
        SofabErrorCode.Argument,
      );
    }
  });

  it("refuses a cap above the format ceiling it bounds", () => {
    expect(codeOf(() => new IStream({}, { maxArrayCount: 0x8000_0000 }))).toBe(
      SofabErrorCode.Argument,
    );
  });

  it("accepts 0 as a real cap — it is a bound, not 'absent'", () => {
    const empty = (() => {
      const os = growingOStream();
      os.writeUnsignedArray(1, []);
      return os.bytes().slice();
    })();
    expect(() => decode(empty, {}, { maxArrayCount: 0 })).not.toThrow();
    expect(codeOf(() => decode(arrayOf(1), {}, { maxArrayCount: 0 }))).toBe(
      SofabErrorCode.LimitExceeded,
    );
  });
});

describe("a schema-bounded field is the generated layer's to bound (§6.2.1)", () => {
  // §6.2.1 keeps the two bounds apart: a *schema* bound is a statement about
  // validity (violation → INVALID) and a *receiver* cap one about capacity
  // (violation → LIMIT_EXCEEDED), and a cap "MUST NOT be applied to a field the
  // schema already bounds".
  //
  // The corelib is driven by wire type and never learns a schema (§5.3.1 leaves it
  // one surface, and that surface carries no declarations), so the split is made
  // where the schema is known: generated code takes the declared bound from
  // `fixlenBegin` / `arrayBegin`, and configures caps that do not cut across its
  // own declarations. corelib-ts#105.

  const string10 = (() => {
    const os = growingOStream();
    os.writeString(1, "0123456789");
    return os.bytes().slice();
  })();

  it("hands generated code the declared length before any payload", () => {
    const seen: number[] = [];
    decode(string10, { fixlenBegin: (_id, _sub, total) => void seen.push(total) });
    expect(seen).toEqual([10]);
  });

  it("hands generated code the element count before any element", () => {
    const uarr5 = (() => {
      const os = growingOStream();
      os.writeUnsignedArray(1, [1, 2, 3, 4, 5]);
      return os.bytes().slice();
    })();
    const events: string[] = [];
    decode(uarr5, {
      arrayBegin: (_id, _kind, count) => void events.push(`begin ${count}`),
      arrayUnsigned: (_id, i) => void events.push(`elem ${i}`),
    });
    expect(events[0]).toBe("begin 5");
    expect(events).toHaveLength(6);
  });

  it("lets a schema bound reject as INVALID, distinct from the cap", () => {
    // What generated code does with the declared size: over its own bound is
    // INVALID, which must not be reported as, or masked by, a capacity rejection.
    const bounded: Visitor = {
      fixlenBegin(_id, _sub, total) {
        if (total > 8) throw new SofabError(SofabErrorCode.InvalidMsg, "over schema maxlen");
      },
    };
    expect(codeOf(() => decode(string10, bounded, { maxStringLen: 64 }))).toBe(
      SofabErrorCode.InvalidMsg,
    );
  });
});
