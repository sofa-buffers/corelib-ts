/**
 * `StringSeq` / `BlobSeq` — the element collectors for a wrapper-sequence array
 * of `string` / `blob` (MESSAGE_SPEC §5.1).
 *
 * Like {@link PayloadAcc}, these decide things the shared vectors cannot see.
 * The vectors fix the *bytes*; what a gap, a repeated index or an over-capacity
 * index turns into is a property of the decoded **value**, and two collectors
 * that disagree about all three still re-encode identically. So §5.1's three
 * placement rules — a gap keeps the indices after it, the length is the highest
 * present id + 1, a repeat replaces — are pinned here field by field.
 *
 * The bound checks get the same treatment from two directions: through real wire
 * bytes, where the point is *when* the verdict lands (an over-long element must
 * be `INVALID` even when the message is cut off inside it — §5.2 gives `INVALID`
 * precedence, and §6.4 forbids a chunk boundary changing the answer), and by
 * calling the collector directly, where the point is *what it costs* — an index
 * near 2^31 must be rejected before a single slot is allocated.
 */

import { describe, expect, it } from "vitest";
import {
  BlobSeq,
  DEFAULT_MAX_DYN_BLOB_LEN,
  DEFAULT_MAX_DYN_STRING_LEN,
  DecodeStatus,
  FixlenSubtype,
  IStream,
  OStream,
  PayloadAcc,
  SofabError,
  SofabErrorCode,
  StringSeq,
  decode,
  type Visitor, growingOStream } from "../src/index.js";

/** The array field's own id in the enclosing scope. */
const ARRAY_ID = 7;

/** Unbounded, the value a schema without `count` / `maxlen` supplies (§7.2). */
const NONE = -1;

/** Wrap `body` — the elements — in the array's wrapper sequence. */
function wrapper(body: (os: OStream) => void): Uint8Array {
  const os = growingOStream();
  os.writeSequenceBeginLazy(ARRAY_ID);
  body(os);
  os.writeSequenceEndKeep();
  return os.bytes().slice();
}

/**
 * The flat-visitor wiring generated code emits around a collector: it knows from
 * the schema which scope is the wrapper array, tracks whether it is inside it, and
 * forwards the two element events (§5.3.1 — one visitor, routed by id and depth).
 */
function router(
  seq: { begin: StringSeq["begin"]; element: StringSeq["element"] },
  kind: FixlenSubtype,
): Visitor {
  let inArray = false;
  const piece = (
    id: number,
    total: number,
    offset: number,
    src: Uint8Array,
    start: number,
    end: number,
  ): void => {
    if (inArray) seq.element(id, total, offset, src, start, end);
  };
  return {
    sequenceBegin: (id) => {
      // A scope *inside* the wrapper is not an element — a string/blob array has
      // no nested scope of its own, so an unknown one is declined whole (§7.3
      // forward compatibility). Declining it means nothing in it is reported, so
      // the router needs no depth counter of its own.
      if (inArray) return false;
      if (id === ARRAY_ID) inArray = true;
      return undefined;
    },
    sequenceEnd: (id) => {
      if (id === ARRAY_ID) inArray = false;
    },
    fixlenBegin: (id, subtype, total) => {
      // `begin` ignores a subtype that is not its own (§7.3), and so does the
      // routing: an element of the wrong kind is a field this array never had.
      if (inArray) seq.begin(id, subtype, total);
    },
    ...(kind === FixlenSubtype.String ? { string: piece } : { blob: piece }),
  };
}

/** Decode `wire` with a {@link StringSeq} bound to the wrapper, returning the elements. */
function strings(wire: Uint8Array, cap = NONE, elemMax = NONE): string[] {
  const out: string[] = [];
  const seq = new StringSeq(out, new PayloadAcc(), cap, elemMax, "tags");
  decode(wire, router(seq, FixlenSubtype.String));
  return out;
}

/** The {@link BlobSeq} twin of {@link strings}. */
function blobs(wire: Uint8Array, cap = NONE, elemMax = NONE): Uint8Array[] {
  const out: Uint8Array[] = [];
  const seq = new BlobSeq(out, new PayloadAcc(), cap, elemMax, "chunks");
  decode(wire, router(seq, FixlenSubtype.Blob));
  return out;
}

function expectInvalid(fn: () => unknown): SofabError {
  try {
    fn();
    expect.unreachable("expected an INVALID_MSG rejection");
  } catch (e) {
    expect(e).toBeInstanceOf(SofabError);
    expect((e as SofabError).code).toBe(SofabErrorCode.InvalidMsg);
    return e as SofabError;
  }
  throw new Error("unreachable");
}

describe("StringSeq places elements the way §5.1 requires", () => {
  it("places each element at its own index", () => {
    const wire = wrapper((os) => {
      os.writeString(0, "alpha");
      os.writeString(1, "beta");
      os.writeString(2, "gamma");
    });
    expect(strings(wire)).toStrictEqual(["alpha", "beta", "gamma"]);
  });

  it("fills a gap with the element default instead of shifting", () => {
    // ids 0, 2, 3: the encoder elided an interior element equal to its default.
    // Everything after the gap must keep its index — the failure mode is a
    // collector that appends and silently returns ["a", "c", "d"].
    const wire = wrapper((os) => {
      os.writeString(0, "a");
      os.writeString(2, "c");
      os.writeString(3, "d");
    });
    expect(strings(wire)).toStrictEqual(["a", "", "c", "d"]);
  });

  it("takes its length from the highest present id", () => {
    const wire = wrapper((os) => os.writeString(4, "last"));
    expect(strings(wire)).toStrictEqual(["", "", "", "", "last"]);
  });

  it("lets a repeated index replace rather than append (§7.4)", () => {
    const wire = wrapper((os) => {
      os.writeString(0, "first");
      os.writeString(1, "keep");
      os.writeString(0, "second");
    });
    expect(strings(wire)).toStrictEqual(["second", "keep"]);
  });

  it("decodes an element that arrives in pieces", () => {
    const wire = wrapper((os) => {
      os.writeString(0, "a payload longer than any single fed chunk");
      os.writeString(1, "short");
    });
    const out: string[] = [];
    const seq = new StringSeq(out, new PayloadAcc(), NONE, NONE, "tags");
    const is = new IStream(router(seq, FixlenSubtype.String));
    let st: DecodeStatus = DecodeStatus.Complete;
    for (let i = 0; i < wire.length; i++) st = is.feed(wire.subarray(i, i + 1));
    expect(st).toBe(DecodeStatus.Complete);
    expect(out).toStrictEqual(["a payload longer than any single fed chunk", "short"]);
  });

  it("rejects invalid UTF-8 in an element as INVALID_MSG", () => {
    const wire = wrapper((os) => os.writeFixlen(0, Uint8Array.of(0xff, 0xfe), FixlenSubtype.String));
    expectInvalid(() => strings(wire));
  });
});

describe("BlobSeq places elements the same way, and copies them", () => {
  it("fills a gap with an empty blob", () => {
    const wire = wrapper((os) => {
      os.writeBlob(0, Uint8Array.of(1, 2));
      os.writeBlob(2, Uint8Array.of(3));
    });
    const got = blobs(wire);
    expect(got.map((b) => [...b])).toStrictEqual([[1, 2], [], [3]]);
  });

  it("joins an element that arrives in pieces", () => {
    const big = Uint8Array.from({ length: 40 }, (_, i) => i);
    const wire = wrapper((os) => {
      os.writeBlob(0, big);
      os.writeBlob(1, Uint8Array.of(0xff));
    });
    const out: Uint8Array[] = [];
    const seq = new BlobSeq(out, new PayloadAcc(), NONE, NONE, "chunks");
    const is = new IStream(router(seq, FixlenSubtype.Blob));
    let st: DecodeStatus = DecodeStatus.Complete;
    for (let i = 0; i < wire.length; i++) st = is.feed(wire.subarray(i, i + 1));
    expect(st).toBe(DecodeStatus.Complete);
    expect(out.map((b) => [...b])).toStrictEqual([[...big], [0xff]]);
  });

  it("copies out of the fed chunk, so a reused buffer cannot rot an element", () => {
    // What §6.7 requires of the whole path: the element is storage of its own, so
    // reusing the fed buffer afterwards cannot reach it. (PayloadAcc copies even a
    // payload that arrived whole, which is where that becomes true.)
    const wire = wrapper((os) => os.writeBlob(0, Uint8Array.of(9, 8, 7)));
    const scratch = wire.slice();
    const out: Uint8Array[] = [];
    const seq = new BlobSeq(out, new PayloadAcc(), NONE, NONE, "chunks");
    const is = new IStream(router(seq, FixlenSubtype.Blob));
    is.feed(scratch);
    scratch.fill(0xee);
    expect([...out[0]!]).toStrictEqual([9, 8, 7]);
  });
});

describe("the schema bounds bind, and bind early (§7.1, §5.2)", () => {
  it("accepts the last index the capacity allows and rejects the next", () => {
    const ok = wrapper((os) => os.writeString(3, "in"));
    expect(strings(ok, 4)).toHaveLength(4);
    const over = wrapper((os) => os.writeString(4, "out"));
    const err = expectInvalid(() => strings(over, 4));
    expect(err.message).toContain("tags");
    expect(err.message).toContain("4");
  });

  it("accepts an element of exactly maxlen and rejects one byte more", () => {
    const ok = wrapper((os) => os.writeString(0, "12345"));
    expect(strings(ok, NONE, 5)).toStrictEqual(["12345"]);
    const over = wrapper((os) => os.writeString(0, "123456"));
    expectInvalid(() => strings(over, NONE, 5));
  });

  it("bounds a blob element by its schema maxlen the same way", () => {
    const ok = wrapper((os) => os.writeBlob(0, Uint8Array.of(1, 2, 3, 4, 5)));
    expect(blobs(ok, NONE, 5)).toStrictEqual([Uint8Array.of(1, 2, 3, 4, 5)]);
    const over = wrapper((os) => os.writeBlob(0, Uint8Array.of(1, 2, 3, 4, 5, 6)));
    expectInvalid(() => blobs(over, NONE, 5));
  });

  it("rejects an over-long element whose payload never arrives", () => {
    // The anti-folding case. Cut the message right after the element's fixlen
    // word: the bound is already decided, so the verdict must be INVALID and not
    // the INCOMPLETE a payload-only check would produce.
    const wire = wrapper((os) => os.writeString(0, "far too long"));
    const truncated = wire.subarray(0, wire.length - 12);
    const out: string[] = [];
    const seq = new StringSeq(out, new PayloadAcc(), NONE, 4, "tags");
    const is = new IStream(router(seq, FixlenSubtype.String));
    expectInvalid(() => is.feed(truncated));
    expect(out).toStrictEqual([]);
  });

  it("leaves both bounds off when they are -1 (§7.2)", () => {
    const wire = wrapper((os) => os.writeString(9, "a string no maxlen bounds"));
    expect(strings(wire)).toHaveLength(10);
  });

  it("rejects an index near 2^31 before allocating a single slot", () => {
    // The adversarial shape: `while (out.length <= id) push(default)` is O(id),
    // so the capacity check has to come first. Called directly — no encoder will
    // produce this, and the point is exactly that the guard runs before the work.
    const out: string[] = [];
    const seq = new StringSeq(out, new PayloadAcc(), 4, NONE, "tags");
    expectInvalid(() => seq.element(2 ** 31 - 1, 1, 0, Uint8Array.of(0x41), 0, 1));
    expectInvalid(() => seq.begin(2 ** 31 - 1, FixlenSubtype.String, 1));
    expect(out).toStrictEqual([]);
  });

  it("applies the same two bounds in BlobSeq", () => {
    const over = wrapper((os) => os.writeBlob(2, Uint8Array.of(1)));
    const err = expectInvalid(() => blobs(over, 2));
    expect(err.message).toContain("chunks");
    const long = wrapper((os) => os.writeBlob(0, Uint8Array.of(1, 2, 3)));
    expectInvalid(() => blobs(long, NONE, 2));
  });
});

describe("a wrapper array the schema left unbounded is bounded by the receiver (§6.2.1)", () => {
  // §7.2 item 8: a sequence array announces no count, so the element **index** is
  // the only place a receiver can bound it — and "unbounded by the schema is still
  // bounded by the receiver" has no exception for the one array shape that carries
  // no count word. Exceeding it is LIMIT_EXCEEDED (capacity), not INVALID (validity).
  const cap = 4;

  /** `strings` / `blobs`, with the schema bound left off and a receiver cap set. */
  function underCap(wire: Uint8Array): string[] {
    const out: string[] = [];
    const seq = new StringSeq(out, new PayloadAcc(), NONE, NONE, "tags", cap);
    decode(wire, router(seq, FixlenSubtype.String));
    return out;
  }

  it("accepts the last index the cap allows", () => {
    expect(underCap(wrapper((os) => os.writeString(cap - 1, "in")))).toHaveLength(cap);
  });

  it("rejects the next one as LIMIT_EXCEEDED, not INVALID_MSG", () => {
    const over = wrapper((os) => os.writeString(cap, "out"));
    try {
      underCap(over);
      expect.unreachable("the receiver cap should have fired");
    } catch (e) {
      expect(e).toBeInstanceOf(SofabError);
      expect((e as SofabError).code).toBe(SofabErrorCode.LimitExceeded);
    }
  });

  it("extends nothing when it rejects, so a later lower index still lands", () => {
    const out: string[] = [];
    const seq = new StringSeq(out, new PayloadAcc(), NONE, NONE, "tags", cap);
    expect(() => seq.element(cap, 1, 0, Uint8Array.of(0x41), 0, 1)).toThrow(SofabError);
    expect(out).toStrictEqual([]);
    seq.element(1, 1, 0, Uint8Array.of(0x42), 0, 1);
    expect(out).toStrictEqual(["", "B"]);
  });

  it("bounds a blob array the same way", () => {
    const out: Uint8Array[] = [];
    const seq = new BlobSeq(out, new PayloadAcc(), NONE, NONE, "chunks", cap);
    const over = wrapper((os) => os.writeBlob(cap, Uint8Array.of(1)));
    try {
      decode(over, router(seq, FixlenSubtype.Blob));
      expect.unreachable("the receiver cap should have fired");
    } catch (e) {
      expect((e as SofabError).code).toBe(SofabErrorCode.LimitExceeded);
    }
    expect(out).toStrictEqual([]);
  });

  it("defers to the schema bound where there is one — INVALID, not the cap", () => {
    // A schema `count` is a statement about validity and outranks capacity: with
    // one present the receiver cap is out of the picture for this field entirely.
    const out: string[] = [];
    const seq = new StringSeq(out, new PayloadAcc(), 2, NONE, "tags", cap);
    const over = wrapper((os) => os.writeString(2, "out"));
    try {
      decode(over, router(seq, FixlenSubtype.String));
      expect.unreachable("the schema bound should have fired");
    } catch (e) {
      expect((e as SofabError).code).toBe(SofabErrorCode.InvalidMsg);
    }
  });
});

describe("an element the schema left unbounded is bounded by the receiver too (§6.2.1)", () => {
  // corelib-ts#164. The index already had both bounds; the element **byte length**
  // had only the schema half, so an element of an array declared without `maxlen`
  // was bounded by nothing in the collector — and a wrapper array's `string` /
  // `blob` length words never reach the generated visitor, they come here.
  const elemCap = 8;

  /** A `StringSeq` with no schema `maxlen` and a receiver element cap. */
  function seq(out: string[]): StringSeq {
    return new StringSeq(out, new PayloadAcc(), NONE, NONE, "tags", 1024, elemCap);
  }

  function codeOf(fn: () => unknown): SofabErrorCode | undefined {
    try {
      fn();
      return undefined;
    } catch (e) {
      expect(e).toBeInstanceOf(SofabError);
      return (e as SofabError).code;
    }
  }

  it("accepts an element of exactly the cap", () => {
    const out: string[] = [];
    decode(wrapper((os) => os.writeString(0, "x".repeat(elemCap))), router(seq(out), FixlenSubtype.String));
    expect(out).toStrictEqual(["x".repeat(elemCap)]);
  });

  it("rejects one byte more as LIMIT_EXCEEDED, not INVALID_MSG", () => {
    const out: string[] = [];
    const over = wrapper((os) => os.writeString(0, "x".repeat(elemCap + 1)));
    expect(codeOf(() => decode(over, router(seq(out), FixlenSubtype.String)))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    // Nothing was placed: the length word is checked before any payload byte.
    expect(out).toStrictEqual([]);
  });

  it("fires at the length word, so a message cut inside the element still rejects", () => {
    // §5.2.3's ordering, for the receiver cap: the verdict may not depend on where
    // the chunk boundary fell.
    const whole = wrapper((os) => os.writeString(0, "x".repeat(elemCap + 1)));
    const cut = whole.subarray(0, whole.length - 4);
    const out: string[] = [];
    const is = new IStream(router(seq(out), FixlenSubtype.String));
    expect(codeOf(() => {
      for (const b of cut) is.feed(Uint8Array.of(b));
      return is.status();
    })).toBe(SofabErrorCode.LimitExceeded);
  });

  it("defers to the schema maxlen where there is one — INVALID, not the cap", () => {
    // §6.2.1: a cap "MUST NOT be applied to a field the schema already bounds".
    // The schema bound is looser than the receiver cap here, so an additive
    // reading would reject and the exclusive one must not.
    const out: string[] = [];
    const seqBounded = new StringSeq(out, new PayloadAcc(), NONE, 32, "tags", 1024, elemCap);
    const wire = wrapper((os) => os.writeString(0, "x".repeat(elemCap + 4)));
    decode(wire, router(seqBounded, FixlenSubtype.String));
    expect(out).toStrictEqual(["x".repeat(elemCap + 4)]);

    // …and past the schema bound it is INVALID, the validity answer.
    const out2: string[] = [];
    const seq2 = new StringSeq(out2, new PayloadAcc(), NONE, 32, "tags", 1024, elemCap);
    const over = wrapper((os) => os.writeString(0, "x".repeat(33)));
    expect(codeOf(() => decode(over, router(seq2, FixlenSubtype.String)))).toBe(
      SofabErrorCode.InvalidMsg,
    );
  });

  it("bounds a blob element the same way", () => {
    const out: Uint8Array[] = [];
    const bs = new BlobSeq(out, new PayloadAcc(), NONE, NONE, "chunks", 1024, elemCap);
    const over = wrapper((os) => os.writeBlob(0, new Uint8Array(elemCap + 1)));
    expect(codeOf(() => decode(over, router(bs, FixlenSubtype.Blob)))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    expect(out).toStrictEqual([]);
  });

  it("is finite by default: there is no unset state (§6.2.1)", () => {
    const s = new StringSeq([], new PayloadAcc());
    const b = new BlobSeq([], new PayloadAcc());
    expect(Number.isFinite(s.receiverElemMax)).toBe(true);
    expect(Number.isFinite(b.receiverElemMax)).toBe(true);
    expect(s.receiverElemMax).toBe(DEFAULT_MAX_DYN_STRING_LEN);
    expect(b.receiverElemMax).toBe(DEFAULT_MAX_DYN_BLOB_LEN);
  });
});

describe("what a collector must not treat as an element", () => {
  it("skips an element of the wrong fixlen subtype instead of rejecting it (§7.3)", () => {
    // A blob among strings is a schema mismatch, and §7.3 makes that a skip —
    // including when its index is past the capacity, which is not the string
    // array's business at all.
    const wire = wrapper((os) => {
      os.writeString(0, "a");
      os.writeBlob(9, Uint8Array.of(1, 2, 3));
      os.writeString(1, "b");
    });
    expect(strings(wire, 2)).toStrictEqual(["a", "b"]);
  });

  it("skips a string element among blobs, and swallows a nested sequence (BlobSeq)", () => {
    const wire = wrapper((os) => {
      os.writeBlob(0, Uint8Array.of(1));
      os.writeString(9, "not a blob");
      os.writeSequenceBeginLazy(1);
      os.writeBlob(0, Uint8Array.of(0xaa));
      os.writeSequenceEndKeep();
      os.writeBlob(2, Uint8Array.of(2));
    });
    expect(blobs(wire, 3).map((b) => [...b])).toStrictEqual([[1], [], [2]]);
  });

  it("swallows a nested sequence whole rather than binding it into the array", () => {
    // Returning nothing from sequenceBegin would keep *this* visitor, so the
    // unknown subtree's own `string(0, …)` would land at index 0 of the array.
    const wire = wrapper((os) => {
      os.writeString(0, "a");
      os.writeSequenceBeginLazy(1);
      os.writeString(0, "POISON");
      os.writeSequenceBeginLazy(0);
      os.writeString(0, "DEEPER POISON");
      os.writeSequenceEndKeep();
      os.writeSequenceEndKeep();
      os.writeString(2, "c");
    });
    expect(strings(wire)).toStrictEqual(["a", "", "c"]);
  });
});
