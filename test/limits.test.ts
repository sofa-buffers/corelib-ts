/**
 * Receiver-side technical limits (CORELIB_PLAN §6.2.1) — **and the fact that this
 * codec holds none.**
 *
 * §6.2.1 fixes the provenance of the numbers and leaves the site of the
 * comparison open: "A corelib **MAY** take a limit as an argument and perform the
 * check itself, and a port that does is conformant", but "a codec **MUST NOT**
 * hold a limit of its own, **MUST NOT** supply a default for one it was not
 * given, **MUST NOT** read an omitted argument as *unlimited*, and **MUST NOT**
 * clamp to one", and "a format ceiling (§6.2) reached because no cap was stated
 * is the **format's** bound, not a receiver cap, and a port **MUST NOT** present
 * it as one".
 *
 * This port used to fail that on both counts: `IStream` / `decode` took a
 * `DecodeLimits`, the decoder held the three caps as fields, and an omitted one
 * fell back to `ARRAY_MAX` / `FIXLEN_MAX` — reporting `LimitExceeded` against a
 * ceiling nobody configured. It is gone. The caps now have **one implementation**
 * (§6.2.1: "A port whose codec offers the check **MUST NOT** also emit it into the
 * generated layer") and it lives in the layer that knows the schema:
 *
 * - a plain `string` / `blob` / array field — generated code compares its cap
 *   inside `fixlenBegin` / `arrayBegin`, which this decoder raises **at the count
 *   or length header**, before a byte of payload or a single element is
 *   delivered;
 * - a wrapper array's `string` / `blob` elements, whose length words reach no
 *   visitor callback — the {@link StringSeq} / {@link BlobSeq} collector compares
 *   the bounds its constructor was handed (`seq-collectors.test.ts` owns those).
 *
 * So what is pinned here is the *contract the codec still owes*: no limit of its
 * own anywhere, and an enforcement point good enough for the layer that has one —
 * at the header, before the allocation, behind the MESSAGE_SPEC §7.3 tag test, and
 * never reached for a field the handler skips.
 */

import { describe, expect, it } from "vitest";
import {
  ARRAY_MAX,
  DecodeStatus,
  FIXLEN_MAX,
  FixlenSubtype,
  IStream,
  SofabError,
  SofabErrorCode,
  decode,
  growingOStream,
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

/** The rejection generated code raises once its own cap is exceeded (§6.3). */
function overCap(what: string): never {
  throw new SofabError(SofabErrorCode.LimitExceeded, `${what} exceeds the receiver cap`);
}

/**
 * A stand-in for generated code: a visitor holding *its own* numbers and doing
 * its own comparing, at exactly the two callbacks §6.2.1 names as the enforcement
 * point. Nothing below it knows these values exist.
 */
function capping(
  caps: { array?: number; string?: number; blob?: number },
  spy?: Visitor,
): Visitor {
  return {
    ...spy,
    arrayBegin(id, kind, count) {
      if (caps.array !== undefined && count > caps.array) overCap(`array count ${count}`);
      spy?.arrayBegin?.(id, kind, count);
    },
    fixlenBegin(id, sub, total) {
      if (sub === FixlenSubtype.String && caps.string !== undefined && total > caps.string) {
        overCap(`string length ${total}`);
      }
      if (sub === FixlenSubtype.Blob && caps.blob !== undefined && total > caps.blob) {
        overCap(`blob length ${total}`);
      }
      spy?.fixlenBegin?.(id, sub, total);
    },
  };
}

/** Feed a whole buffer to a streaming IStream in one push. */
function drainStream(buf: Uint8Array, visitor: Visitor): DecodeStatus {
  return new IStream(visitor).feed(buf);
}

/** Feed a whole buffer to a streaming IStream one byte at a time. */
function drainChunked(buf: Uint8Array, visitor: Visitor): DecodeStatus {
  const is = new IStream(visitor);
  let last = is.status();
  for (let i = 0; i < buf.length; i++) last = is.feed(buf.subarray(i, i + 1));
  return last;
}

/** A hand-built `ArrayUnsigned` header for `count`, whose payload never arrives. */
function countWord(count: number): Uint8Array {
  // Built by hand: materializing millions of elements to encode them would cost
  // more than the assertion is worth, and only the count word is read.
  const out = [0x0b]; // id 1, wire 3 (ArrayUnsigned)
  for (let v = count; ; v = Math.floor(v / 0x80)) {
    if (v < 0x80) {
      out.push(v);
      break;
    }
    out.push((v % 0x80) | 0x80);
  }
  return Uint8Array.from(out);
}

const arrayOf = (n: number): Uint8Array => {
  const os = growingOStream();
  os.writeUnsignedArray(1, new Array(n).fill(0));
  return os.bytes().slice();
};

const stringOf = (n: number): Uint8Array => {
  const os = growingOStream();
  os.writeString(1, "x".repeat(n));
  return os.bytes().slice();
};

const blobOf = (n: number): Uint8Array => {
  const os = growingOStream();
  os.writeBlob(1, new Uint8Array(n));
  return os.bytes().slice();
};

describe("the codec holds no receiver limit (§6.2.1)", () => {
  it("neither decode surface takes one", () => {
    // The audit in one assertion: `decode(bytes, visitor)` and
    // `new IStream(visitor)`. A third / second parameter is where the held
    // limit used to arrive.
    expect(decode.length).toBe(2);
    expect(IStream.length).toBe(1);
  });

  it("decodes a count far above any plausible default, because it defaults nothing", () => {
    // The defect this removed: an omitted cap used to become the format ceiling,
    // and before that a 2^20 default, so a caller who configured nothing still
    // got rejections — reported as `LimitExceeded`, a limit they never set and
    // could not raise. Unconfigured now means unconfigured: every count the
    // *format* permits reaches the visitor.
    for (const count of [1_048_577, 2_000_000, ARRAY_MAX]) {
      const bytes = countWord(count);
      const seen: number[] = [];
      const watch: Visitor = { arrayBegin: (_id, _k, c) => void seen.push(c) };
      // Accepted at the header: the decoder is waiting for elements, not
      // rejecting the count.
      expect(new IStream(watch).feed(bytes)).toBe(DecodeStatus.Incomplete);
      expect(codeOf(() => decode(bytes, watch))).toBe(SofabErrorCode.Incomplete);
      expect(seen).toStrictEqual([count, count]);
    }
  });

  it("decodes an unbounded string and blob length the same way", () => {
    for (const bytes of [stringOf(100_000), blobOf(100_000)]) {
      expect(() => decode(bytes, {})).not.toThrow();
      expect(drainStream(bytes, {})).toBe(DecodeStatus.Complete);
    }
  });

  it("never reports a format ceiling as a receiver cap", () => {
    // §6.2: `ARRAY_MAX` / `FIXLEN_MAX` bound what the WIRE may express, so one
    // past them is malformed input for every receiver however configured —
    // `InvalidMsg`, never `LimitExceeded`. That distinction is the whole reason
    // the old fallback was wrong: it answered a *policy* code for a bound no
    // policy had chosen.
    expect(codeOf(() => decode(countWord(ARRAY_MAX + 1), {}))).toBe(SofabErrorCode.InvalidMsg);
    expect(codeOf(() => drainStream(countWord(ARRAY_MAX + 1), {}))).toBe(
      SofabErrorCode.InvalidMsg,
    );
    expect(ARRAY_MAX).toBe(0x7fff_ffff);
    expect(FIXLEN_MAX).toBe(0x7fff_ffff);
  });
});

describe("the enforcement point the codec owes generated code (§6.2.1)", () => {
  it("hands over the element count before a single element is delivered", () => {
    const events: string[] = [];
    decode(arrayOf(5), {
      arrayBegin: (_id, _kind, count) => void events.push(`begin ${count}`),
      arrayUnsigned: (_id, i) => void events.push(`elem ${i}`),
    });
    expect(events[0]).toBe("begin 5");
    expect(events).toHaveLength(6);
  });

  it("hands over the declared length before any payload piece", () => {
    const events: string[] = [];
    decode(stringOf(10), {
      fixlenBegin: (_id, _sub, total) => void events.push(`begin ${total}`),
      string: () => void events.push("piece"),
    });
    expect(events).toStrictEqual(["begin 10", "piece"]);
  });

  it("a rejection at that point stops the decode with nothing materialized", () => {
    const seen: string[] = [];
    const v = capping({ array: 4 }, { arrayUnsigned: () => void seen.push("elem") });
    expect(codeOf(() => decode(arrayOf(8), v))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainStream(arrayOf(8), v))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainChunked(arrayOf(8), v))).toBe(SofabErrorCode.LimitExceeded);
    expect(seen).toStrictEqual([]);
  });

  it("the same for a string and a blob, before any piece arrives", () => {
    const pieces: string[] = [];
    const s = capping({ string: 8 }, { string: () => void pieces.push("s") });
    const b = capping({ blob: 8 }, { blob: () => void pieces.push("b") });
    expect(codeOf(() => decode(stringOf(100), s))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainChunked(stringOf(100), s))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => decode(blobOf(100), b))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainChunked(blobOf(100), b))).toBe(SofabErrorCode.LimitExceeded);
    expect(pieces).toStrictEqual([]);
  });

  it("accepts a count exactly at the cap and rejects one past it", () => {
    expect(() => decode(arrayOf(8), capping({ array: 8 }))).not.toThrow();
    expect(codeOf(() => decode(arrayOf(8), capping({ array: 7 })))).toBe(
      SofabErrorCode.LimitExceeded,
    );
  });

  it("keeps LimitExceeded distinct from InvalidMsg, and out of the INVALID latch", () => {
    // §6.3: a cap rejection is a policy rejection of WELL-FORMED bytes and "MUST
    // NOT be reported as `InvalidMessage`". The stream must not latch INVALID
    // over it either — the same bytes decode under a looser cap.
    const is = new IStream(capping({ array: 4 }));
    expect(codeOf(() => is.feed(arrayOf(8)))).toBe(SofabErrorCode.LimitExceeded);
    expect(is.status()).not.toBe(DecodeStatus.Invalid);
    // The contrast that makes it a distinction rather than an accident.
    const bad = new IStream({});
    expect(codeOf(() => bad.feed(Uint8Array.of(0x02, 0x04)))).toBe(SofabErrorCode.InvalidMsg);
    expect(bad.status()).toBe(DecodeStatus.Invalid);
  });

  it("a schema bound rejects as INVALID from the very same callback", () => {
    // §6.3's three ways a value can be refused: the schema bound is a statement
    // about validity, the cap one about capacity, and generated code raises both
    // here — which is exactly why they must not be raised twice, once here and
    // once inside the codec.
    const bounded: Visitor = {
      fixlenBegin(_id, _sub, total) {
        if (total > 8) throw new SofabError(SofabErrorCode.InvalidMsg, "over schema maxlen");
      },
    };
    expect(codeOf(() => decode(stringOf(10), bounded))).toBe(SofabErrorCode.InvalidMsg);
  });
});

describe("a field the handler skips is never capped (§6.2.1)", () => {
  // > A limit bounds an allocation, and a field the handler skips allocates
  // > nothing — it is walked, not materialized (§6.7.2). A `max_dyn_*` limit
  // > **MUST NOT** be applied to it, so a decode that steps over an over-cap
  // > field it was never going to read stays `COMPLETE`.
  //
  // With the comparison in the handler this is structural rather than a rule the
  // codec has to remember: the callback that holds the number is the callback a
  // skipped field never reaches. That is §6.2.1's own argument for handing the
  // number in — "makes them a property of the structure rather than of every
  // caller's discipline" — and it is what the removed decoder-side check needed
  // two private `*IsRead()` probes to approximate.

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
    const seen: number[] = [];
    const reader: Visitor = { unsigned: (id, v) => void seen.push(id, Number(v)) };
    expect(() => decode(bytes, reader)).not.toThrow();
    expect(seen).toStrictEqual([2, 7]);
    expect(drainStream(bytes, reader)).toBe(DecodeStatus.Complete);
    expect(drainChunked(bytes, reader)).toBe(DecodeStatus.Complete);
  });

  it.each([
    ["string", withString, capping({ string: 4 })],
    ["blob", withBlob, capping({ blob: 4 })],
    ["array", withArray, capping({ array: 2 })],
  ])("still caps the same %s once a handler for it exists", (_name, bytes, reader) => {
    // The discriminator: the bytes are identical, only the handler's shape
    // changed.
    expect(codeOf(() => decode(bytes, reader))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainStream(bytes, reader))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainChunked(bytes, reader))).toBe(SofabErrorCode.LimitExceeded);
  });

  it("does not reach the handler inside a declined scope either", () => {
    const os = growingOStream();
    os.writeSequenceBeginLazy(1);
    os.writeString(2, "x".repeat(100));
    os.writeSequenceEnd();
    os.writeUnsigned(3, 7);
    const bytes = os.bytes().slice();

    const seen: number[] = [];
    const decline: Visitor = {
      ...capping({ string: 4 }),
      sequenceBegin: () => false,
      unsigned: (id, v) => void seen.push(id, Number(v)),
    };
    expect(() => decode(bytes, decline)).not.toThrow();
    expect(seen).toStrictEqual([3, 7]);
  });

  it("leaves the format ceiling alone: it binds a skipped field too", () => {
    // A cap is policy and answers to the handler; `ARRAY_MAX` is the format and
    // does not. One past it stays INVALID whether or not anyone reads the field.
    expect(codeOf(() => decode(countWord(ARRAY_MAX + 1), {}))).toBe(SofabErrorCode.InvalidMsg);
    expect(codeOf(() => decode(countWord(ARRAY_MAX + 1), capping({ array: 2 })))).toBe(
      SofabErrorCode.InvalidMsg,
    );
  });
});
