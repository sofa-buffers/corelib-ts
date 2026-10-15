/**
 * **Reuse mode** on the four element collectors (`ElementSeq`, `FramedSeq`,
 * `StringSeq`, `BlobSeq`) — decoding a wrapper-sequence array into a destination
 * that already holds an earlier message (ARCHITECTURE §8, generator#760).
 *
 * Everything tested here is invisible to the shared vectors twice over: it is a
 * property of the decoded *value* rather than of the bytes, like the rest of
 * `seq.ts`, and it is a property of the **second** decode into the same
 * destination, which no single vector describes. Two collectors that disagree
 * about all of it re-encode identically.
 *
 * Three questions, and the file is organized around them:
 *
 * 1. **Is the result the same as a fresh decode's?** That is the one property the
 *    mode must not trade away, so it is checked as a property rather than
 *    case-by-case: every pair out of a set of message shapes, decoded one after
 *    the other into one destination, against a fresh decode of the second.
 *    Truncation is where this bites — the array carries no length, so a shorter
 *    message would otherwise read with the previous one's tail still attached.
 * 2. **Is the storage actually reused?** Identity, not equality: `toBe` on the
 *    element object, the row array and the blob buffer, plus factory call counts.
 *    Structural assertions cannot tell this mode from the fresh path, which is
 *    the whole point of it.
 * 3. **Do the rules of §5.1 and §6.2.1 still hold?** A gap is still the element
 *    default and never what the slot happened to hold; a repeat still replaces
 *    without re-defaulting; a re-opened framed element still merges into what it
 *    built (§7.4); and both bounds still reject before the destination moves —
 *    including the receiver-cap path, which the POC behind generator#760 left
 *    uncovered.
 */

import { describe, expect, it } from "vitest";
import {
  ARRAY_MAX,
  BlobSeq,
  DecodeStatus,
  ElementSeq,
  FIXLEN_MAX,
  FixlenSubtype,
  FramedSeq,
  IStream,
  type OStream,
  PayloadAcc,
  SofabError,
  SofabErrorCode,
  StringSeq,
  UNBOUNDED,
  type Visitor,
  decode,
  growingOStream,
} from "../src/index.js";

/** The array field's own id in the enclosing scope. */
const ARRAY_ID = 7;

/** The receiver caps a test that is not about caps states anyway (§6.2.1). */
const WIDE_INDEX = ARRAY_MAX;
const WIDE_LEN = FIXLEN_MAX;

/** The code thrown by `fn`, or `undefined` if it returned. */
function codeOf(fn: () => unknown): SofabErrorCode | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(SofabError);
    return (e as SofabError).code;
  }
}

describe("ElementSeq in reuse mode claims the slots that are already there", () => {
  /** A collector armed over `out`, with the schema `count` as its only bound. */
  function armed(out: string[], cap = 8, receiverCap = WIDE_INDEX): ElementSeq<string> {
    return new ElementSeq(out, "", cap, "tags", receiverCap).reuse();
  }

  it("writes this decode's elements into the slots the last one left", () => {
    const out = ["a", "b", "c"];
    const slots = armed(out);
    slots.place(0, "x");
    slots.place(1, "y");
    slots.place(2, "z");
    slots.end();
    expect(out).toStrictEqual(["x", "y", "z"]);
  });

  it("cuts the array to this decode's length, so a shorter message leaves no tail", () => {
    const out = ["a", "b", "c", "d"];
    const slots = armed(out);
    slots.place(0, "x");
    slots.place(1, "y");
    // The cut happens at `end()`, not per element: the length of a wrapper array
    // is only known once the elements stop arriving (§5.1).
    expect(out).toHaveLength(4);
    slots.end();
    expect(out).toStrictEqual(["x", "y"]);
  });

  it("fills a gap with the element default, never with what the slot held", () => {
    const out = ["a", "b", "c"];
    const slots = armed(out);
    slots.place(2, "z");
    slots.end();
    expect(out).toStrictEqual(["", "", "z"]);
  });

  it("lets a repeat replace without re-defaulting what this decode placed (§7.4)", () => {
    const out = ["a", "b"];
    const slots = armed(out);
    slots.place(0, "x");
    slots.place(0, "y");
    slots.place(1, "w");
    slots.end();
    expect(out).toStrictEqual(["y", "w"]);
  });

  it("keeps a lower id delivered after a higher one", () => {
    const out = ["a", "b", "c"];
    const slots = armed(out);
    slots.place(2, "z");
    slots.place(0, "x");
    slots.end();
    expect(out).toStrictEqual(["x", "", "z"]);
  });

  it("grows past what was there, pushing only the slots that are new", () => {
    const out = ["a"];
    const slots = armed(out);
    slots.place(2, "z");
    slots.end();
    expect(out).toStrictEqual(["", "", "z"]);
  });

  it("reserves a slot the same way place does", () => {
    const out = ["a", "b", "c"];
    const slots = armed(out);
    slots.reserve(1);
    slots.end();
    expect(out).toStrictEqual(["", ""]);
  });

  it("is the fresh path when the destination is empty", () => {
    const out: string[] = [];
    const slots = armed(out);
    slots.place(1, "b");
    slots.end();
    expect(out).toStrictEqual(["", "b"]);
  });

  it("leaves a destination it was never armed over alone", () => {
    // The unarmed collector over a non-empty array: its slots are *its* own, which
    // is what a re-opened wrapper sequence needs (§7.4) and what this class did
    // before reuse mode existed. `end()` is a no-op there, twice over.
    const out = ["a"];
    const slots = new ElementSeq(out, "", 8, "tags", WIDE_INDEX);
    slots.place(0, "x");
    slots.end();
    slots.end();
    expect(out).toStrictEqual(["x"]);
  });

  it("appends after end(), and a second end() changes nothing", () => {
    const out = ["a", "b", "c"];
    const slots = armed(out);
    slots.place(1, "y");
    slots.end();
    expect(out).toStrictEqual(["", "y"]);
    slots.place(2, "z");
    slots.end();
    slots.end();
    expect(out).toStrictEqual(["", "y", "z"]);
  });

  it("rejects an id above the schema count without touching the destination", () => {
    const out = ["a", "b", "c", "d", "e"];
    const slots = armed(out, 3);
    expect(codeOf(() => slots.place(3, "x"))).toBe(SofabErrorCode.InvalidMsg);
    expect(codeOf(() => slots.reserve(3))).toBe(SofabErrorCode.InvalidMsg);
    // §7.2 item 8: nothing moved — not the slots, not the stale tail, not the
    // length — so a lower id delivered afterwards still lands at its own index.
    expect(out).toStrictEqual(["a", "b", "c", "d", "e"]);
    slots.place(1, "y");
    slots.end();
    expect(out).toStrictEqual(["", "y"]);
  });

  it("rejects an id above the receiver cap as LIMIT_EXCEEDED, destination untouched", () => {
    // The §6.2.1 half the POC behind generator#760 never exercised: a
    // schema-unbounded array, where the receiver cap governs and its breach is a
    // policy rejection of well-formed bytes.
    const out = ["a", "b", "c"];
    const slots = armed(out, UNBOUNDED, 2);
    expect(codeOf(() => slots.place(2, "x"))).toBe(SofabErrorCode.LimitExceeded);
    expect(out).toStrictEqual(["a", "b", "c"]);
  });

  it("leaves the elements it decoded, and the older tail it had not reached, on a refusal", () => {
    // The state after a mid-array rejection, pinned deliberately rather than
    // discovered: `end()` is never reached, so the destination holds this decode's
    // slots and, past them, the previous message's. That is the same mixed state
    // every other field of a reused destination is in after a refusal — the
    // generated contract promises the fields decoded before the error, no more.
    const out = ["a", "b", "c", "d"];
    const slots = armed(out, UNBOUNDED, 3);
    slots.place(0, "x");
    expect(codeOf(() => slots.place(3, "w"))).toBe(SofabErrorCode.LimitExceeded);
    expect(out).toStrictEqual(["x", "b", "c", "d"]);
  });
});

describe("ElementSeq.staleAt hands over the previous decode's value, once", () => {
  it("offers an unclaimed slot and withdraws it once this decode has claimed it", () => {
    const out = ["a", "b", "c"];
    const slots = new ElementSeq(out, "", 8, "tags", WIDE_INDEX).reuse();
    expect(slots.staleAt(0)).toBe("a");
    expect(slots.staleAt(2)).toBe("c");
    expect(slots.staleAt(3)).toBeNull(); // past the end of the array
    slots.place(0, "x");
    expect(slots.staleAt(0)).toBeNull(); // this decode's own now
    expect(slots.staleAt(1)).toBe("b");
  });

  it("offers nothing at all on a collector that was not armed", () => {
    const slots = new ElementSeq(["a"], "", 8, "tags", WIDE_INDEX);
    expect(slots.staleAt(0)).toBeNull();
  });

  it("offers nothing after end(), which is where the stale slots stop existing", () => {
    const out = ["a", "b"];
    const slots = new ElementSeq(out, "", 8, "tags", WIDE_INDEX).reuse();
    slots.place(0, "x");
    slots.end();
    expect(slots.staleAt(1)).toBeNull();
  });
});

describe("FramedSeq in reuse mode resets the object it already built", () => {
  class Elem {
    n = 0;
    tag = "";
  }

  /** A collector armed over `out`, counting both halves of the gap-value choice. */
  function armed(
    out: Elem[],
    cap = 8,
    receiverCap = WIDE_INDEX,
  ): { slots: FramedSeq<Elem>; built: () => number; reset: () => number } {
    let built = 0;
    let reset = 0;
    const slots = new FramedSeq<Elem>(
      out,
      () => {
        built++;
        return new Elem();
      },
      cap,
      "rows",
      receiverCap,
    ).reuse((e) => {
      reset++;
      e.n = 0;
      e.tag = "";
    });
    return { slots, built: () => built, reset: () => reset };
  }

  it("keeps the object identity and never calls the factory", () => {
    // The allocation this mode exists to avoid, and the assertion has to be
    // identity: a fresh `new Elem()` per slot is structurally identical.
    const first = new Elem();
    first.n = 1;
    first.tag = "a";
    const second = new Elem();
    second.n = 2;
    second.tag = "b";
    const out = [first, second];
    const { slots, built, reset } = armed(out);

    slots.reserve(0);
    slots.reserve(1);
    slots.end();

    expect(built()).toBe(0);
    expect(reset()).toBe(2);
    expect(out[0]).toBe(first);
    expect(out[1]).toBe(second);
    expect([out[0]!.n, out[0]!.tag]).toStrictEqual([0, ""]);
  });

  it("resets a slot once, so a re-opened element merges into what it built (§7.4)", () => {
    const out = [new Elem()];
    const { slots, reset } = armed(out);
    slots.reserve(0);
    out[0]!.n = 5;
    slots.reserve(0);
    expect(out[0]!.n).toBe(5);
    expect(reset()).toBe(1);
  });

  it("builds only the slots that are new", () => {
    const kept = new Elem();
    kept.n = 1;
    const out = [kept];
    const { slots, built, reset } = armed(out);
    slots.reserve(2);
    slots.end();
    expect(reset()).toBe(1);
    expect(built()).toBe(2);
    expect(out[0]).toBe(kept);
    expect(out[0]!.n).toBe(0);
    expect(out[1]).not.toBe(out[2]);
    expect(out).toHaveLength(3);
  });

  it("resets a gap below a placed row, and not the slot it replaces", () => {
    const rowA = [1, 2];
    const rowB = [3];
    const out = [rowA, rowB];
    let reset = 0;
    const rows = new FramedSeq<number[]>(out, () => [], 8, "matrix", WIDE_INDEX).reuse((r) => {
      reset++;
      r.length = 0;
    });
    const fresh = [9];
    rows.place(1, fresh);
    rows.end();
    expect(reset).toBe(1); // the gap at 0, never the slot that is overwritten
    expect(out[0]).toBe(rowA);
    expect(rowA).toStrictEqual([]);
    expect(out[1]).toBe(fresh);
    expect(out).toHaveLength(2);
  });

  it("cuts the rows this decode did not reach", () => {
    const out = [new Elem(), new Elem(), new Elem(), new Elem()];
    const { slots } = armed(out);
    slots.reserve(0);
    slots.end();
    expect(out).toHaveLength(1);
  });

  it("resets nothing and builds nothing for a rejected id", () => {
    const first = new Elem();
    first.n = 1;
    const out = [first, new Elem(), new Elem()];
    const { slots, built, reset } = armed(out, 2);
    expect(codeOf(() => slots.reserve(2))).toBe(SofabErrorCode.InvalidMsg);
    expect(codeOf(() => slots.place(2, new Elem()))).toBe(SofabErrorCode.InvalidMsg);
    expect(built()).toBe(0);
    expect(reset()).toBe(0);
    expect(out[0]).toBe(first);
    expect(out[0]!.n).toBe(1);
    expect(out).toHaveLength(3);
  });

  it("offers a typed row through staleAt, for a destination the caller sizes itself", () => {
    // The row shape `reset` cannot serve: a `Float32Array` matrix row is
    // *replaced*, not decoded in place, so the generated code asks for the array
    // the last decode left and keeps it when the element count still matches.
    const row = Float32Array.of(1, 2, 3);
    const out = [row];
    const rows = new FramedSeq<Float32Array>(
      out,
      () => new Float32Array(0),
      UNBOUNDED,
      "matrix",
      16,
    ).reuse(() => expect.unreachable("a replaced row is never reset"));

    const old = rows.staleAt(0);
    expect(old).toBe(row);
    expect(rows.staleAt(1)).toBeNull(); // past the end of the array
    rows.place(0, old !== null && old.length === 3 ? old : new Float32Array(3));
    expect(rows.staleAt(0)).toBeNull(); // this decode owns the slot now
    rows.end();
    expect(out[0]).toBe(row);
    expect(out).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The two leaf collectors, driven by the real decoder.                        */
/* -------------------------------------------------------------------------- */

/** Wrap `body` — the elements — in the array's wrapper sequence. */
function wrapper(body: (os: OStream) => void): Uint8Array {
  const os = growingOStream();
  os.writeSequenceBeginLazy(ARRAY_ID);
  body(os);
  os.writeSequenceEndKeep();
  return os.bytes().slice();
}

/**
 * The flat-visitor wiring generated code emits around a collector, with the one
 * line reuse mode adds: `end()` at the wrapper's `sequenceEnd`, which is where
 * the array's length is finally known.
 */
function router(
  seq: { begin: StringSeq["begin"]; element: StringSeq["element"]; end: () => void },
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
      if (inArray) return false;
      if (id === ARRAY_ID) inArray = true;
      return undefined;
    },
    sequenceEnd: (id) => {
      if (id === ARRAY_ID) {
        inArray = false;
        seq.end();
      }
    },
    fixlenBegin: (id, subtype, total) => {
      if (inArray) seq.begin(id, subtype, total);
    },
    ...(kind === FixlenSubtype.String ? { string: piece } : { blob: piece }),
  };
}

/** Decode `wire` into `out`, armed for reuse — the receive loop's second decode. */
function reuseStrings(wire: Uint8Array, out: string[], cap = UNBOUNDED, elemMax = UNBOUNDED): void {
  const seq = new StringSeq(
    out,
    new PayloadAcc(),
    cap,
    elemMax,
    "tags",
    WIDE_INDEX,
    WIDE_LEN,
  ).reuse();
  decode(wire, router(seq, FixlenSubtype.String));
}

/** The {@link BlobSeq} twin of {@link reuseStrings}. */
function reuseBlobs(wire: Uint8Array, out: Uint8Array[]): void {
  const seq = new BlobSeq(
    out,
    new PayloadAcc(),
    UNBOUNDED,
    UNBOUNDED,
    "chunks",
    WIDE_INDEX,
    WIDE_LEN,
  ).reuse();
  decode(wire, router(seq, FixlenSubtype.Blob));
}

/** The message shapes a receive loop has to survive in any order. */
const SHAPES: { what: string; wire: Uint8Array; strings: string[] }[] = [
  {
    what: "dense, three elements",
    wire: wrapper((os) => {
      os.writeString(0, "alpha");
      os.writeString(1, "beta");
      os.writeString(2, "gamma");
    }),
    strings: ["alpha", "beta", "gamma"],
  },
  {
    what: "one element",
    wire: wrapper((os) => os.writeString(0, "solo")),
    strings: ["solo"],
  },
  {
    what: "an interior gap",
    wire: wrapper((os) => {
      os.writeString(0, "a");
      os.writeString(2, "c");
      os.writeString(3, "d");
    }),
    strings: ["a", "", "c", "d"],
  },
  {
    what: "a leading gap, five long",
    wire: wrapper((os) => os.writeString(4, "last")),
    strings: ["", "", "", "", "last"],
  },
  { what: "no elements at all", wire: wrapper(() => {}), strings: [] },
];

describe("StringSeq decodes message after message into one destination", () => {
  it.each(SHAPES)("reads $what the same as a fresh decode", ({ wire, strings }) => {
    const out: string[] = [];
    reuseStrings(wire, out);
    expect(out).toStrictEqual(strings);
  });

  it("gives the same answer for every pair of messages as a fresh decode of the second", () => {
    // The property the mode must not trade away, across the transitions that
    // actually break it: full → shorter, full → empty, short → full, gaps either
    // way. A collector that forgot to cut would carry the first message's tail.
    for (const first of SHAPES) {
      for (const second of SHAPES) {
        const out: string[] = [];
        reuseStrings(first.wire, out);
        reuseStrings(second.wire, out);
        expect(out, `${first.what} → ${second.what}`).toStrictEqual(second.strings);
      }
    }
  });

  it("keeps enforcing both element-length bounds (§6.2.1)", () => {
    const wire = wrapper((os) => os.writeString(0, "far too long"));
    const out = ["kept"];
    // The schema maxlen: a statement about validity.
    expect(codeOf(() => reuseStrings(wire, out, UNBOUNDED, 4))).toBe(SofabErrorCode.InvalidMsg);
    // And the receiver cap where the schema left the element open: policy.
    const capped = new StringSeq(
      out,
      new PayloadAcc(),
      UNBOUNDED,
      UNBOUNDED,
      "tags",
      WIDE_INDEX,
      4,
    ).reuse();
    expect(codeOf(() => decode(wire, router(capped, FixlenSubtype.String)))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    expect(out).toStrictEqual(["kept"]);
  });

  it("rejects an index past the receiver cap, leaving the previous message in place", () => {
    const out: string[] = [];
    reuseStrings(SHAPES[0]!.wire, out);
    const capped = (dst: string[]): StringSeq =>
      new StringSeq(dst, new PayloadAcc(), UNBOUNDED, UNBOUNDED, "tags", 3, WIDE_LEN).reuse();

    const past = wrapper((os) => os.writeString(3, "one too far"));
    expect(codeOf(() => decode(past, router(capped(out), FixlenSubtype.String)))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    // Rejected at the length word, before the element could be placed: the array
    // is still the one the previous decode left, in full.
    expect(out).toStrictEqual(["alpha", "beta", "gamma"]);

    // …and an index the cap admits still lands, into that same destination.
    const inside = wrapper((os) => os.writeString(2, "last"));
    decode(inside, router(capped(out), FixlenSubtype.String));
    expect(out).toStrictEqual(["", "", "last"]);
  });
});

describe("BlobSeq writes the payload into the buffer that is already there", () => {
  it("keeps the buffer when the new payload is exactly its length", () => {
    const out: Uint8Array[] = [];
    reuseBlobs(wrapper((os) => os.writeBlob(0, Uint8Array.of(1, 2, 3, 4))), out);
    const buf = out[0]!;
    reuseBlobs(wrapper((os) => os.writeBlob(0, Uint8Array.of(5, 6, 7, 8))), out);
    expect(out[0]).toBe(buf);
    expect([...buf]).toStrictEqual([5, 6, 7, 8]);
  });

  it("allocates when the length differs, and leaves the old buffer alone", () => {
    const out: Uint8Array[] = [];
    reuseBlobs(wrapper((os) => os.writeBlob(0, Uint8Array.of(1, 2, 3, 4))), out);
    const buf = out[0]!;
    reuseBlobs(wrapper((os) => os.writeBlob(0, Uint8Array.of(9, 9))), out);
    expect(out[0]).not.toBe(buf);
    expect([...out[0]!]).toStrictEqual([9, 9]);
    expect([...buf]).toStrictEqual([1, 2, 3, 4]);
  });

  it("reuses the buffer on the chunked path too, byte-fed", () => {
    // The half a caller cannot write for itself: the payload is adopted at offset
    // 0 and the pieces land in it as they arrive, across `feed` calls.
    const out: Uint8Array[] = [];
    reuseBlobs(wrapper((os) => os.writeBlob(0, Uint8Array.of(1, 2, 3, 4, 5, 6))), out);
    const buf = out[0]!;

    const wire = wrapper((os) => os.writeBlob(0, Uint8Array.of(7, 8, 9, 10, 11, 12)));
    const seq = new BlobSeq(
      out,
      new PayloadAcc(),
      UNBOUNDED,
      UNBOUNDED,
      "chunks",
      WIDE_INDEX,
      WIDE_LEN,
    ).reuse();
    const is = new IStream(router(seq, FixlenSubtype.Blob));
    let st: DecodeStatus = DecodeStatus.Complete;
    for (let i = 0; i < wire.length; i++) st = is.feed(wire.subarray(i, i + 1));
    expect(st).toBe(DecodeStatus.Complete);
    expect(out[0]).toBe(buf);
    expect([...buf]).toStrictEqual([7, 8, 9, 10, 11, 12]);
  });

  it("makes a gap an empty blob, not the buffer that was there", () => {
    const out: Uint8Array[] = [];
    reuseBlobs(
      wrapper((os) => {
        os.writeBlob(0, Uint8Array.of(1, 2));
        os.writeBlob(1, Uint8Array.of(3, 4));
      }),
      out,
    );
    const gap = out[0]!;
    reuseBlobs(wrapper((os) => os.writeBlob(1, Uint8Array.of(5, 6))), out);
    expect(out[0]).not.toBe(gap);
    expect(out[0]).toHaveLength(0);
    expect([...out[1]!]).toStrictEqual([5, 6]);
  });

  it("gives the same answer for every pair of messages as a fresh decode", () => {
    const shapes = [
      wrapper((os) => {
        os.writeBlob(0, Uint8Array.of(1, 2));
        os.writeBlob(1, Uint8Array.of(3));
        os.writeBlob(2, Uint8Array.of(4, 5, 6));
      }),
      wrapper((os) => os.writeBlob(0, Uint8Array.of(7))),
      wrapper((os) => {
        os.writeBlob(0, Uint8Array.of(8, 9));
        os.writeBlob(2, Uint8Array.of(10));
      }),
      wrapper(() => {}),
    ];
    const bytes = (a: Uint8Array[]): number[][] => a.map((b) => [...b]);
    for (const first of shapes) {
      for (const second of shapes) {
        const out: Uint8Array[] = [];
        reuseBlobs(first, out);
        reuseBlobs(second, out);
        const fresh: Uint8Array[] = [];
        reuseBlobs(second, fresh);
        expect(bytes(out)).toStrictEqual(bytes(fresh));
      }
    }
  });

  it("copies out of the fed chunk, into the buffer it is reusing", () => {
    // §6.0 / §6.7 are unchanged by reuse mode: what lands in the destination is a
    // copy, so the caller's chunk is reusable the moment `feed` returns.
    const out: Uint8Array[] = [];
    reuseBlobs(wrapper((os) => os.writeBlob(0, Uint8Array.of(1, 2, 3, 4))), out);
    const buf = out[0]!;
    const wire = wrapper((os) => os.writeBlob(0, Uint8Array.of(5, 6, 7, 8)));
    const scratch = new Uint8Array(wire.length);
    scratch.set(wire);
    const seq = new BlobSeq(
      out,
      new PayloadAcc(),
      UNBOUNDED,
      UNBOUNDED,
      "chunks",
      WIDE_INDEX,
      WIDE_LEN,
    ).reuse();
    decode(scratch, router(seq, FixlenSubtype.Blob));
    scratch.fill(0xee);
    expect(out[0]).toBe(buf);
    expect([...buf]).toStrictEqual([5, 6, 7, 8]);
  });
});
