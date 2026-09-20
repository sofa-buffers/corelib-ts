/**
 * `FramedSeq` — the element slots of a wrapper-sequence array whose element
 * default is a fresh object: a `struct` / `union` element, or a nested row
 * (MESSAGE_SPEC §5.1).
 *
 * Every test here brings its **own container** and calls the helper directly.
 * That is deliberate and it is the point of the file: what a gap, a repeated
 * index or an over-capacity index turns into is a property of the decoded
 * *value*, not of the bytes, so the shared vectors cannot tell a collector that
 * gets it right from one that does not — CORELIB_PLAN §7.2 item 8 asks for these
 * separately for exactly that reason. Driving the class without a decoder also
 * makes the *cost* visible: an index near 2^31 has to be refused before a single
 * slot is allocated, which no round-trip test can observe.
 *
 * The first `describe` is the reason the class exists at all: `ElementSeq` writes
 * one shared `def` into every gap, which is right for `""` and a zero-length
 * `Uint8Array` and catastrophically wrong for a mutable element.
 */

import { describe, expect, it } from "vitest";
import {
  ARRAY_MAX,
  ElementSeq,
  FramedSeq,
  Long,
  SofabError,
  SofabErrorCode,
  UNBOUNDED,
} from "../src/index.js";

/** A framed element: what a generated `struct` / `union` element class stands for. */
class Elem {
  n = 0;
  tag = "";
}

/** The receiver index cap a test that is not about caps states anyway (§6.2.1). */
const WIDE_INDEX = ARRAY_MAX;

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

describe("a gap value is built per slot, never shared", () => {
  it("gives every gap and every element its own object", () => {
    // The regression `ElementSeq` would fail today, and the whole reason
    // `FramedSeq` is a second class. With a shared `def`, `out[0]`, `out[1]` and
    // `out[2]` would be three references to one `Elem`: writing element 2's
    // fields would rewrite the two gaps, and a second element would rewrite the
    // first. `toBe` (identity), not `toStrictEqual` — the three are structurally
    // equal, which is precisely what a structural assertion could not see.
    const out: Elem[] = [];
    const slots = new FramedSeq<Elem>(out, () => new Elem(), 8, "codes", WIDE_INDEX);

    slots.reserve(2);
    expect(out).toHaveLength(3);
    expect(out[0]).not.toBe(out[1]);
    expect(out[1]).not.toBe(out[2]);
    expect(out[0]).not.toBe(out[2]);

    // And the aliasing is gone where it would have shown: decoding into the
    // reserved slot leaves the gaps at their defaults.
    out[2]!.n = 7;
    expect([out[0]!.n, out[1]!.n, out[2]!.n]).toStrictEqual([0, 0, 7]);
  });

  it("gives a nested row its own array per slot", () => {
    // The same defect one level up: a row's default is `[]`, so a shared default
    // would make every row of a matrix the same array.
    const out: number[][] = [];
    const rows = new FramedSeq<number[]>(out, () => [], 4, "matrix", WIDE_INDEX);
    rows.reserve(1);
    out[1]!.push(5);
    expect(out).toStrictEqual([[], [5]]);
    expect(out[0]).not.toBe(out[1]);
  });

  it("gives a Long[] row its own array too — the int64 long/number shape", () => {
    // `int64: long | number` backs a 64-bit matrix row with `Long[]` rather than
    // a `BigUint64Array`, so this is a real generated shape and not a hypothetical.
    const out: Long[][] = [];
    const rows = new FramedSeq<Long[]>(out, () => [], UNBOUNDED, "cells", 16);
    rows.place(2, [Long.fromBits(1, 0)]);
    expect(out).toHaveLength(3);
    expect(out[0]).toStrictEqual([]);
    expect(out[0]).not.toBe(out[1]);
    expect(out[2]![0]!.low).toBe(1);
  });

  it("does not call the factory for a slot that is already there", () => {
    // A re-opened `struct` / `union` element MERGES into the object earlier
    // fields decoded into: §7.4's "last occurrence wins" is about the value, and
    // for a framed element the scope *is* the value. Rebuilding the slot would
    // silently drop every field of the first opening.
    let built = 0;
    const out: Elem[] = [];
    const slots = new FramedSeq<Elem>(
      out,
      () => {
        built++;
        return new Elem();
      },
      8,
      "codes",
      WIDE_INDEX,
    );
    slots.reserve(1);
    expect(built).toBe(2);
    const first = out[1]!;
    first.n = 3;

    slots.reserve(1);
    expect(built).toBe(2); // no new object
    expect(out[1]).toBe(first);
    expect(out[1]!.n).toBe(3); // and the earlier field survived
  });
});

describe("placement, gaps and length (§5.1)", () => {
  it("places at the id and keeps every index after a gap", () => {
    // An interior element equal to its default is not written at all, so ids
    // 0, 2, 3 are well-formed and the missing index is FILLED, never skipped
    // over: element 2 must still be at index 2.
    const out: Elem[] = [];
    const slots = new FramedSeq<Elem>(out, () => new Elem(), 8, "codes", WIDE_INDEX);
    for (const id of [0, 2, 3]) {
      slots.reserve(id);
      out[id]!.n = id * 10;
    }
    expect(out.map((e) => e.n)).toStrictEqual([0, 0, 20, 30]);
  });

  it("is the highest present id + 1 long", () => {
    // The wrapper carries no length and the last element is never elided
    // (PR #29), so growing to id + 1 per element is exactly right and no
    // trailing fill is ever needed.
    const out: Elem[] = [];
    const slots = new FramedSeq<Elem>(out, () => new Elem(), 6, "codes", WIDE_INDEX);
    slots.reserve(4);
    expect(out).toHaveLength(5);
    slots.reserve(1);
    expect(out).toHaveLength(5); // a lower id does not shrink it either
  });

  it("place replaces what an earlier opening built — a row wrapper (§7.4)", () => {
    const out: number[][] = [];
    const rows = new FramedSeq<number[]>(out, () => [], 4, "matrix", WIDE_INDEX);
    const first = [1, 2];
    rows.place(1, first);
    const second = [9];
    rows.place(1, second);
    expect(out[1]).toBe(second);
    expect(out).toHaveLength(2);
  });

  it("place fills the gap below the id without allocating the slot twice", () => {
    // The slot is about to be overwritten, so the factory runs for the gap only.
    let built = 0;
    const out: number[][] = [];
    const rows = new FramedSeq<number[]>(
      out,
      () => {
        built++;
        return [];
      },
      8,
      "matrix",
      WIDE_INDEX,
    );
    const row = [7];
    rows.place(3, row);
    expect(built).toBe(3); // ids 0..2, not 0..3
    expect(out).toHaveLength(4);
    expect(out[3]).toBe(row);
    expect(out[2]).toStrictEqual([]);
  });

  it("fills a sparse array linearly — one write per slot, no re-copying", () => {
    // Growth geometry (ARCHITECTURE §9.5 shape B: grow to at least id + 1, so a
    // sparse array is not O(n²)). The backing store's reallocation strategy is
    // the engine's; what is ours is the FILL — each slot written once, in one
    // pass, with no pass over the slots already there.
    const out: number[][] = [];
    const rows = new FramedSeq<number[]>(out, () => [], UNBOUNDED, "matrix", 100_000);
    const push = Array.prototype.push;
    let writes = 0;
    Array.prototype.push = function (this: unknown[], ...args: unknown[]) {
      if (this === out) writes += args.length;
      return push.apply(this, args);
    } as typeof push;
    try {
      rows.reserve(0);
      rows.reserve(9_999);
    } finally {
      Array.prototype.push = push;
    }
    expect(out).toHaveLength(10_000);
    expect(writes).toBe(10_000);
  });
});

describe("the schema count is a capacity, and its breach is INVALID (§7.1)", () => {
  const CAP = 3;

  function seq(out: Elem[]): FramedSeq<Elem> {
    return new FramedSeq<Elem>(out, () => new Elem(), CAP, "codes", WIDE_INDEX);
  }

  it("accepts the last index the capacity admits", () => {
    const out: Elem[] = [];
    seq(out).reserve(CAP - 1);
    expect(out).toHaveLength(CAP);
  });

  it("rejects the next one as INVALID, not LIMIT_EXCEEDED", () => {
    // `count` is a capacity, not a length: the container starts empty and the
    // wire carries the length, so `id >= count` is a statement about the
    // message's validity.
    expect(codeOf(() => seq([]).reserve(CAP))).toBe(SofabErrorCode.InvalidMsg);
    expect(codeOf(() => seq([]).place(CAP, new Elem()))).toBe(SofabErrorCode.InvalidMsg);
    expect(codeOf(() => seq([]).checkIndex(CAP))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("leaves the container exactly as it was, so a lower id still lands", () => {
    // §7.2 item 8: "after a rejected id the container is not left partially
    // extended". The bound runs BEFORE the growth, which is the whole of it.
    const out: Elem[] = [];
    const slots = seq(out);
    slots.reserve(0);
    expect(out).toHaveLength(1);

    expect(() => slots.reserve(CAP)).toThrow(SofabError);
    expect(out).toHaveLength(1); // not grown toward the rejected index
    expect(() => slots.place(1 << 30, new Elem())).toThrow(SofabError);
    expect(out).toHaveLength(1); // and an index near 2^31 allocates nothing

    slots.reserve(2);
    expect(out).toHaveLength(3); // the lower id afterwards still lands at its own index
  });

  it("never calls the factory for a rejected index", () => {
    let built = 0;
    const slots = new FramedSeq<Elem>(
      [],
      () => {
        built++;
        return new Elem();
      },
      CAP,
      "codes",
      WIDE_INDEX,
    );
    expect(() => slots.reserve(CAP)).toThrow(SofabError);
    expect(built).toBe(0);
  });
});

describe("where the schema left the array open, the receiver cap governs (§6.2.1)", () => {
  const RCAP = 4;

  function seq(out: Elem[]): FramedSeq<Elem> {
    return new FramedSeq<Elem>(out, () => new Elem(), UNBOUNDED, "codes", RCAP);
  }

  it("answers LIMIT_EXCEEDED, not INVALID — a policy rejection of well-formed bytes", () => {
    expect(codeOf(() => seq([]).reserve(RCAP))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => seq([]).reserve(RCAP - 1))).toBeUndefined();
  });

  it("does not leave the container partially extended either", () => {
    const out: Elem[] = [];
    const slots = seq(out);
    slots.reserve(1);
    expect(() => slots.reserve(RCAP)).toThrow(SofabError);
    expect(out).toHaveLength(2);
  });

  it("is inert beside a schema count — never both", () => {
    // §6.2.1: the caps "MUST NOT be applied to a field the schema already
    // bounds". With `cap` stated, a tiny `receiverCap` next to it changes
    // nothing: the verdict and the accepted range are the schema's alone.
    const out: Elem[] = [];
    const slots = new FramedSeq<Elem>(out, () => new Elem(), 8, "codes", 1);
    slots.reserve(7); // way over the cap beside it, and accepted
    expect(out).toHaveLength(8);
    expect(codeOf(() => slots.reserve(8))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("has one implementation of the rule, shared with ElementSeq", () => {
    // The two classes differ in the gap value and in nothing else. A second copy
    // of §6.2.1's which-verdict rule would be a second chance to get it wrong, so
    // the verdicts are pinned to be identical for both bound shapes.
    for (const [cap, rcap, id] of [
      [3, WIDE_INDEX, 3],
      [UNBOUNDED, 4, 4],
    ] as const) {
      const a = new ElementSeq<number>([], 0, cap, "x", rcap);
      const b = new FramedSeq<number[]>([], () => [], cap, "x", rcap);
      expect(codeOf(() => b.checkIndex(id))).toBe(codeOf(() => a.checkIndex(id)));
    }
  });
});

describe("a cap that states no cap is a caller mistake (§6.2.1, §6.3)", () => {
  const NO_CAP: number[] = [-1, -7, Number.NaN, Number.POSITIVE_INFINITY];

  it.each(NO_CAP)("refuses %s at construction with ARGUMENT", (bad) => {
    // Not LIMIT_EXCEEDED (there is no receiver limit to raise) and not silently
    // unlimited (`id >= NaN` is always false) — a mistake in the CALL.
    expect(codeOf(() => new FramedSeq<Elem>([], () => new Elem(), UNBOUNDED, "codes", bad))).toBe(
      SofabErrorCode.Argument,
    );
  });

  it.each(NO_CAP)("accepts %s where the schema bound governs instead", (bad) => {
    // A number that is forbidden to be applied cannot be required to be stated:
    // with `cap` stated the receiver cap never runs.
    expect(
      codeOf(() => new FramedSeq<Elem>([], () => new Elem(), 2, "codes", bad)),
    ).toBeUndefined();
  });

  it("has no default for the cap — it is a required argument", () => {
    // TypeScript refuses the short call at compile time; this pins the arity, so
    // a default cannot creep back in without the assertion noticing. Same pin as
    // `ElementSeq.length` in seq-collectors.test.ts.
    expect(FramedSeq.length).toBe(5);
    expect(new FramedSeq<Elem>([], () => new Elem(), UNBOUNDED, "codes", 16).receiverCap).toBe(16);
  });
});

describe("the rejection names the field", () => {
  it("carries the schema field name and the bound it broke", () => {
    const slots = new FramedSeq<Elem>([], () => new Elem(), 3, "recent_codes", WIDE_INDEX);
    expect(() => slots.reserve(3)).toThrow(/recent_codes: array index above schema capacity 3/);

    const open = new FramedSeq<Elem>([], () => new Elem(), UNBOUNDED, "energy_sources", 2);
    expect(() => open.reserve(2)).toThrow(
      /energy_sources: array index 2 exceeds the receiver cap 2/,
    );
  });
});

describe("a native matrix row: the shape that SHOULD share its gap value", () => {
  // The twin of the first describe, and the reason there are two classes rather
  // than one. A native matrix row is a typed array, and the module-level
  // zero-length instance generated code pads with holds nothing, drops an indexed
  // store and cannot be grown — so one instance may fill every gap, and
  // `ElementSeq` is what a row like that takes.
  //
  // Generated code drives it in two steps rather than one, because a row has a
  // SECOND bound — its element count, announced in the array header — and §7.2
  // item 8 wants a rejection by either bound to leave the matrix exactly as it
  // was. So the index is checked first (`checkIndex`), the count next, and only
  // then is the row allocated and placed (`place`).
  const EMPTY = new Uint32Array(0);

  it("fills every gap with the one shared instance", () => {
    const rows: Uint32Array[] = [];
    const seq = new ElementSeq<Uint32Array>(rows, EMPTY, 4, "cells", WIDE_INDEX);
    seq.place(2, Uint32Array.of(7, 8));

    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(EMPTY); // identity, not structure: sharing is intended here
    expect(rows[1]).toBe(EMPTY);
    expect(Array.from(rows[2]!)).toStrictEqual([7, 8]);
  });

  it("replaces a row a second header opens at the same index (§7.4)", () => {
    const rows: Uint32Array[] = [];
    const seq = new ElementSeq<Uint32Array>(rows, EMPTY, 4, "cells", WIDE_INDEX);
    seq.place(0, Uint32Array.of(1));
    seq.place(0, Uint32Array.of(2, 3));

    expect(rows).toHaveLength(1);
    expect(Array.from(rows[0]!)).toStrictEqual([2, 3]);
  });

  it("checkIndex takes the index verdict without touching the matrix", () => {
    const rows: Uint32Array[] = [];
    const seq = new ElementSeq<Uint32Array>(rows, EMPTY, 2, "cells", WIDE_INDEX);

    expect(codeOf(() => seq.checkIndex(1))).toBeUndefined();
    expect(rows).toStrictEqual([]); // accepted, and STILL nothing placed
    expect(codeOf(() => seq.checkIndex(2))).toBe(SofabErrorCode.InvalidMsg);
    expect(rows).toStrictEqual([]);

    // ...so a row rejected by the count bound that runs between checkIndex and
    // place leaves the matrix empty too, and a lower row id still lands.
    seq.place(0, Uint32Array.of(9));
    expect(rows).toHaveLength(1);
  });

  it("gives the two calls the same verdict, from the same rule", () => {
    const seq = new ElementSeq<Uint32Array>([], EMPTY, UNBOUNDED, "cells", 3);
    expect(codeOf(() => seq.checkIndex(3))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => seq.place(3, EMPTY))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => seq.reserve(3))).toBe(SofabErrorCode.LimitExceeded);
  });
});
