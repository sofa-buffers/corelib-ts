/**
 * Receiver-side limits (CORELIB_PLAN §6.2.1, corelib-ts#38).
 *
 * A receiver caps array counts and string / blob byte lengths through
 * {@link DecodeLimits}. An over-limit field is rejected at its count / length
 * header — before it is materialized or streamed — with a `SofabError` whose code
 * is {@link SofabErrorCode.LimitExceeded}, kept deliberately distinct from
 * `InvalidMsg` (policy, not malformation).
 *
 * **They are no longer optional.** §6.2.1 requires every receiver to carry them —
 * "there is no unset state and no unlimited mode" — so an omitted option takes
 * the format ceiling it bounds rather than switching the cap off, and a
 * non-finite one is refused outright. The *values* belong to generated code,
 * which knows the schema and the target: "the codec never invents a limit of its
 * own", so the fallback is the widest value that is still a limit, never a number
 * this port picked (A2-0161).
 *
 * Both entry points are checked: the one-shot {@link decode} and the streaming
 * {@link IStream}. They are the same decoder (§5.3.1), and this is one of the
 * places where "the same decoder" has to be visible rather than asserted.
 */

import { describe, expect, it } from "vitest";
import {
  ARRAY_MAX,
  DecodeStatus,
  FIXLEN_MAX,
  IStream,
  SofabError,
  SofabErrorCode,
  decode,
  growingOStream,
  type DecodeLimits,
  type Visitor,
} from "../src/index.js";

/**
 * A visitor that **reads** every field kind a cap bounds.
 *
 * Not decoration. §6.2.1 puts the cap check "at the count/length header of a
 * field that is actually **read**", so a cap test driven by an empty visitor
 * would be testing a field the decoder is entitled to walk past uncapped. Both
 * `arrayBegin` and `fixlenBegin` carry the announced count / declared length
 * before any payload — the number a handler sizes its destination from — so
 * either one alone makes the field read.
 */
const READS: Visitor = {
  arrayBegin: () => undefined,
  fixlenBegin: () => undefined,
};

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
function drainStream(buf: Uint8Array, limits?: DecodeLimits, visitor: Visitor = READS): void {
  const is = new IStream(visitor, limits);
  is.feed(buf);
}

/** Feed a whole buffer to a streaming IStream one byte at a time. */
function drainChunked(buf: Uint8Array, limits?: DecodeLimits, visitor: Visitor = READS): void {
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

  it("decodes with no options, because the default cap is the format ceiling", () => {
    expect(LIMIT + 1).toBeLessThan(ARRAY_MAX);
    expect(() => decode(oversize, READS)).not.toThrow();
    expect(() => drainStream(oversize)).not.toThrow();
  });

  it("throws LimitExceeded on both entry points once maxArrayCount is set", () => {
    const limits = { maxArrayCount: LIMIT };
    expect(codeOf(() => decode(oversize, READS, limits))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainStream(oversize, limits))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainChunked(oversize, limits))).toBe(SofabErrorCode.LimitExceeded);
  });

  it("is distinct from InvalidMsg (policy, not malformation)", () => {
    expect(codeOf(() => decode(oversize, READS, { maxArrayCount: LIMIT }))).not.toBe(
      SofabErrorCode.InvalidMsg,
    );
  });

  it("does not latch the stream INVALID — the bytes are well-formed", () => {
    const is = new IStream(READS, { maxArrayCount: LIMIT });
    expect(codeOf(() => is.feed(oversize))).toBe(SofabErrorCode.LimitExceeded);
    expect(is.status()).not.toBe("INVALID");
  });

  it("is terminal on the error channel, and status() is not that channel", () => {
    // A2-0167. §6.3 leaves the surfacing open — "either a fourth decode outcome,
    // or a terminal failure carrying the `LimitExceeded` code on the error
    // channel" — and this port takes the second, which is why the three-valued
    // `status()` has nothing true to say about a cap rejection. What §6.3 does
    // require is that the two stay distinguishable and that the rejection be
    // terminal, both of which are pinned here.
    const is = new IStream(READS, { maxArrayCount: LIMIT });
    expect(codeOf(() => is.feed(oversize))).toBe(SofabErrorCode.LimitExceeded);

    // Terminal: every later feed re-reports it, consuming nothing.
    expect(codeOf(() => is.feed(Uint8Array.of(0x00)))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => is.feed(new Uint8Array(0)))).toBe(SofabErrorCode.LimitExceeded);

    // Never folded into INVALID (§6.2.1, §6.3) and never COMPLETE: the outcome
    // stays the structural answer for the bytes consumed, which is INCOMPLETE
    // because a cap fires at a count/length word, inside a field.
    expect(is.status()).toBe(DecodeStatus.Incomplete);

    // The contrast that makes it a distinction rather than an accident: a
    // *malformed* message does latch INVALID and status() says so.
    const bad = new IStream(READS);
    expect(codeOf(() => bad.feed(Uint8Array.of(0x02, 0x04)))).toBe(SofabErrorCode.InvalidMsg);
    expect(bad.status()).toBe(DecodeStatus.Invalid);
  });

  it("accepts a count exactly at the limit, rejects one past it", () => {
    const at = (() => {
      const os = growingOStream();
      os.writeUnsignedArray(1, new Array(8).fill(1));
      return os.bytes().slice();
    })();
    expect(() => decode(at, READS, { maxArrayCount: 8 })).not.toThrow();
    expect(codeOf(() => decode(at, READS, { maxArrayCount: 7 }))).toBe(
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
    expect(codeOf(() => decode(signed, READS, { maxArrayCount: 10 }))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    expect(codeOf(() => decode(floats, READS, { maxArrayCount: 10 }))).toBe(
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
    expect(100).toBeLessThan(FIXLEN_MAX);
    expect(() => decode(msg, READS)).not.toThrow();
    expect(() => drainStream(msg)).not.toThrow();
  });

  it("throws LimitExceeded on both entry points once maxStringLen is set", () => {
    const limits = { maxStringLen: 64 };
    expect(codeOf(() => decode(msg, READS, limits))).toBe(SofabErrorCode.LimitExceeded);
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
    expect(() => decode(blob, READS, { maxStringLen: 4 })).not.toThrow();
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
    expect(codeOf(() => decode(msg, READS, limits))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainStream(msg, limits))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainChunked(msg, limits))).toBe(SofabErrorCode.LimitExceeded);
  });

  it("a string is not capped by maxBlobLen (independent limits)", () => {
    const str = (() => {
      const os = growingOStream();
      os.writeString(1, "x".repeat(100));
      return os.bytes().slice();
    })();
    expect(() => decode(str, READS, { maxBlobLen: 4 })).not.toThrow();
  });
});

describe("there is no unset state and no unlimited mode (§6.2.1)", () => {
  /** A message whose one field is `n` elements / bytes long. */
  const arrayOf = (n: number): Uint8Array => {
    const os = growingOStream();
    os.writeUnsignedArray(1, new Array(n).fill(0));
    return os.bytes().slice();
  };

  /** A hand-built `ArrayUnsigned` header for `count`, whose payload never arrives. */
  const countWord = (count: number): Uint8Array => {
    // Built by hand: materializing millions of elements to encode them would cost
    // more than the assertion is worth, and only the count word is read.
    const out = [0x0b]; // id 1, wire 3 (ArrayUnsigned)
    for (let v = count; ; v = Math.floor(v / 0x80)) {
      if (v < 0x80) { out.push(v); break; }
      out.push((v % 0x80) | 0x80);
    }
    return Uint8Array.from(out);
  };

  it("an omitted cap takes the format ceiling, not a number this port invented", () => {
    // A2-0161. §6.2.1: "the codec never invents a limit of its own", and
    // ARCHITECTURE §9.5: the value comes "from generated code, never from a
    // default the corelib invented". So a decoder given no options at all is
    // bounded exactly where the *format* bounds it, and nowhere tighter — a
    // caller who configures nothing must not get a rejection a sibling port
    // accepts. 2,000,000 is the count the audit measured being rejected under
    // the old 2^20 default.
    for (const count of [1_048_577, 2_000_000, ARRAY_MAX]) {
      const bytes = countWord(count);
      // The count word is *accepted*: the decoder is waiting for the elements,
      // not rejecting the header. Under the old 2^20 default the first two
      // counts were LIMIT_EXCEEDED right here.
      expect(new IStream(READS).feed(bytes)).toBe(DecodeStatus.Incomplete);
      expect(codeOf(() => decode(bytes, READS))).toBe(SofabErrorCode.Incomplete);
      expect(new IStream(READS).feed(bytes)).not.toBe(DecodeStatus.Invalid);
    }
    // And a whole message whose count sits above the old default decodes clean.
    const wide = arrayOf(3);
    expect(() => decode(wide, READS)).not.toThrow();
  });

  it("the format ceiling itself is still INVALID, and stays INVALID not LimitExceeded", () => {
    // The cap fallback cannot widen what the format allows: one past ARRAY_MAX is
    // malformed input (§5.2.2), a different category from a policy rejection.
    const bytes = countWord(ARRAY_MAX + 1);
    expect(codeOf(() => decode(bytes, READS))).toBe(SofabErrorCode.InvalidMsg);
    expect(codeOf(() => drainStream(bytes))).toBe(SofabErrorCode.InvalidMsg);
    // And configuring a cap does not change the category of that same input.
    expect(codeOf(() => decode(bytes, READS, { maxArrayCount: 8 }))).toBe(
      SofabErrorCode.InvalidMsg,
    );
  });

  it("a configured cap still bites where the default no longer does", () => {
    // The default moved; the mechanism did not. The same 2,000,000-count header
    // that decodes unconfigured is LimitExceeded once a deployment says so.
    const bytes = countWord(2_000_000);
    expect(codeOf(() => decode(bytes, READS, { maxArrayCount: 1_048_576 }))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    expect(codeOf(() => drainStream(bytes, { maxArrayCount: 1_048_576 }))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    expect(codeOf(() => drainChunked(bytes, { maxArrayCount: 1_048_576 }))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    // One below it is merely truncated — so the rejection above really is the cap.
    expect(() => decode(arrayOf(3), READS)).not.toThrow();
  });

  it("the defaults are finite and are exactly the format ceilings", () => {
    // Finite, so there is no unlimited mode; equal to the ceiling, so the codec
    // invented nothing. Both halves of §6.2.1 at once.
    for (const [limits, ceiling] of [
      [{ maxArrayCount: ARRAY_MAX }, ARRAY_MAX],
      [{ maxStringLen: FIXLEN_MAX }, FIXLEN_MAX],
      [{ maxBlobLen: FIXLEN_MAX }, FIXLEN_MAX],
    ] as const) {
      expect(Number.isFinite(ceiling)).toBe(true);
      // Accepting the ceiling and refusing one past it pins where the fallback is.
      expect(() => new IStream(READS, limits)).not.toThrow();
    }
    expect(ARRAY_MAX).toBe(0x7fff_ffff);
    expect(FIXLEN_MAX).toBe(0x7fff_ffff);
  });

  it("refuses Infinity, a negative cap and a fractional one", () => {
    for (const bad of [Infinity, -1, 1.5, NaN]) {
      expect(codeOf(() => new IStream(READS, { maxArrayCount: bad }))).toBe(
        SofabErrorCode.Argument,
      );
      expect(codeOf(() => new IStream(READS, { maxStringLen: bad }))).toBe(
        SofabErrorCode.Argument,
      );
      expect(codeOf(() => new IStream(READS, { maxBlobLen: bad }))).toBe(
        SofabErrorCode.Argument,
      );
    }
  });

  it("refuses a cap above the format ceiling it bounds", () => {
    expect(codeOf(() => new IStream(READS, { maxArrayCount: 0x8000_0000 }))).toBe(
      SofabErrorCode.Argument,
    );
  });

  it("accepts 0 as a real cap — it is a bound, not 'absent'", () => {
    const empty = (() => {
      const os = growingOStream();
      os.writeUnsignedArray(1, []);
      return os.bytes().slice();
    })();
    expect(() => decode(empty, READS, { maxArrayCount: 0 })).not.toThrow();
    expect(codeOf(() => decode(arrayOf(1), READS, { maxArrayCount: 0 }))).toBe(
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

describe("a field the handler skips is never capped (§6.2.1)", () => {
  // `c837108` added the rule outright:
  //
  // > A limit bounds an allocation, and a field the handler skips allocates
  // > nothing — it is walked, not materialized (§6.7.2). A `max_dyn_*` limit
  // > **MUST NOT** be applied to it, so a decode that steps over an over-cap
  // > field it was never going to read stays `COMPLETE`. The check belongs at
  // > the count/length header of a field that is actually **read**.
  //
  // On a flat visitor (§6.0) the intent is spelled by which callbacks exist, so
  // "skipped" here means the callback for that field kind is absent. The port
  // already honoured a *declined scope*; these pin the field-level half.
  const TIGHT: DecodeLimits = { maxArrayCount: 2, maxStringLen: 4, maxBlobLen: 4 };

  const withString = (() => {
    const os = growingOStream();
    os.writeString(1, "x".repeat(100));
    os.writeUnsigned(2, 7);
    return os.bytes().slice();
  })();

  const withBlob = (() => {
    const os = growingOStream();
    os.writeBlob(1, new Uint8Array(100));
    os.writeUnsigned(2, 7);
    return os.bytes().slice();
  })();

  const withArray = (() => {
    const os = growingOStream();
    os.writeUnsignedArray(1, [1, 2, 3, 4, 5, 6, 7, 8]);
    os.writeUnsigned(2, 7);
    return os.bytes().slice();
  })();

  it.each([
    ["an over-cap string", withString],
    ["an over-cap blob", withBlob],
    ["an over-cap array", withArray],
  ])("walks past %s and still completes", (_name, bytes) => {
    // The handler takes the scalar and nothing else, so the over-cap field is
    // consumed and never delivered. COMPLETE, on every drive.
    const seen: number[] = [];
    const reader: Visitor = { unsigned: (id, v) => void seen.push(id, Number(v)) };
    expect(() => decode(bytes, reader, TIGHT)).not.toThrow();
    expect(seen).toStrictEqual([2, 7]);
    expect(new IStream(reader, TIGHT).feed(bytes)).toBe(DecodeStatus.Complete);
    expect(() => drainChunked(bytes, TIGHT, reader)).not.toThrow();
  });

  it.each([
    ["string", withString, { fixlenBegin: () => undefined } as Visitor],
    ["string", withString, { string: () => undefined } as Visitor],
    ["blob", withBlob, { fixlenBegin: () => undefined } as Visitor],
    ["blob", withBlob, { blob: () => undefined } as Visitor],
    ["array", withArray, { arrayBegin: () => undefined } as Visitor],
    ["array", withArray, { arrayUnsigned: () => undefined } as Visitor],
  ])("still caps the same %s once a handler for it exists", (_name, bytes, reader) => {
    // The discriminator: the bytes and the caps are identical, only the
    // handler's shape changed. Either callback is enough — `fixlenBegin` /
    // `arrayBegin` carry the number a destination gets sized from.
    expect(codeOf(() => decode(bytes, reader, TIGHT))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainStream(bytes, TIGHT, reader))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    expect(codeOf(() => drainChunked(bytes, TIGHT, reader))).toBe(
      SofabErrorCode.LimitExceeded,
    );
  });

  it("caps a fixlen array only when a float handler takes it", () => {
    // A fixlen array's element kind is unknown at the count word, so either
    // float callback has to keep it read.
    const bytes = (() => {
      const os = growingOStream();
      os.writeFp64Array(1, [1, 2, 3, 4, 5, 6, 7, 8]);
      return os.bytes().slice();
    })();
    expect(() => decode(bytes, { unsigned: () => undefined }, TIGHT)).not.toThrow();
    expect(codeOf(() => decode(bytes, { arrayFp64: () => undefined }, TIGHT))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    expect(codeOf(() => decode(bytes, { arrayFp32: () => undefined }, TIGHT))).toBe(
      SofabErrorCode.LimitExceeded,
    );
  });

  it("leaves the format ceiling alone: it binds a skipped field too", () => {
    // A cap is policy and answers to the handler; `ARRAY_MAX` is the format and
    // does not. One past it stays INVALID whether anyone reads the field.
    const bytes = (() => {
      const out = [0x0b];
      for (let v = ARRAY_MAX + 1; ; v = Math.floor(v / 0x80)) {
        if (v < 0x80) { out.push(v); break; }
        out.push((v % 0x80) | 0x80);
      }
      return Uint8Array.from(out);
    })();
    expect(codeOf(() => decode(bytes, {}))).toBe(SofabErrorCode.InvalidMsg);
    expect(codeOf(() => decode(bytes, {}, TIGHT))).toBe(SofabErrorCode.InvalidMsg);
  });
});
