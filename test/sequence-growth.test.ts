/**
 * The shared `sequence_growth` block — CORELIB_PLAN §7.2 item 8.
 *
 * A wrapper (sequence) array carries no element count on the wire: its length is
 * *highest present id + 1* (MESSAGE_SPEC §5.1), so the container **grows** as
 * elements arrive. That is the one allocation shape where growth is conformant
 * (ARCHITECTURE §9.5 shape B) — and it happens in the static helper layer, never
 * in the codec (§6.6.1).
 *
 * The positive vectors are structurally blind to it: two ports that grow
 * differently emit **identical bytes** and reach **identical outcomes**, so no
 * `serialized.hex` can tell them apart. Hence a block keyed by a *delivery
 * sequence of element ids*, which the port replays itself — building the message
 * from `deliver` and asserting `expect`, container length and outcome only, with
 * no allocator instrumentation.
 *
 * Two things this file pins that nothing else does:
 *
 * - **the index is the bound, not the element kind.** A `string` element reaches
 *   the container through the collector's leaf path and a `struct` element through
 *   its sequence path, and a port can get one right and the other wrong. Both are
 *   asserted, with identical expectations.
 * - **cap-relative indices.** `max_dyn_array_count` is per-target configuration
 *   (§6.2.1 fixes no family-wide number), so the cases name offsets from *this*
 *   port's cap. The block is run with a small cap installed, which is what
 *   "a port configured below 4 raises it for the block's run" allows in reverse:
 *   the numbers are the port's to choose, and 2^20 elements is a slow way to
 *   assert an off-by-one.
 */

import { describe, expect, it } from "vitest";
import {
  ElementSeq,
  IStream,
  PayloadAcc,
  SofabError,
  SofabErrorCode,
  StringSeq,
  decode,
  growingOStream,
  type Visitor,
} from "../src/index.js";
import { loadGrowthCases, type GrowthCase } from "./helpers/vectors.js";

const cases = loadGrowthCases();

/**
 * The cap this port runs the block with — its `max_dyn_array_count` for the run.
 * Well above the block's minimum of 4, and small enough that a `cap - 1` index
 * builds a container the test can compare in full.
 */
const CAP = 8;

/** Resolve an absolute-or-cap-relative index. */
function index(el: GrowthCase["deliver"][number]): number {
  return el.id !== undefined ? Number(el.id) : CAP + Number(el.id_from_cap);
}

/** Resolve the expected length, absolute or cap-relative. */
function expectedLength(e: GrowthCase["expect"]): number {
  return e.length !== undefined ? e.length : CAP + Number(e.length_from_cap);
}

/** Build the case's message: a wrapper array at `field_id`, framed even when empty. */
function build(c: GrowthCase): Uint8Array {
  const os = growingOStream();
  os.writeSequenceBeginLazy(c.field_id);
  for (const el of c.deliver) {
    const id = index(el);
    if (c.element_type === "string") {
      os.writeString(id, String(el.value));
    } else {
      // A struct element: a framed sub-sequence carrying one `unsigned` at id 0.
      os.writeSequenceBeginLazy(id);
      os.writeUnsigned(0, el.value as bigint);
      os.writeSequenceEndKeep();
    }
  }
  // The wrapper itself always reaches the wire — including the explicit-empty
  // form, which is the whole of the `growth_empty_array` case (§5.1).
  os.writeSequenceEndKeep();
  return os.bytes().slice();
}

/**
 * The generated-layer stand-in for `array<string>`: the wrapper's scope is
 * recognised by its (id, depth), and the elements go to a {@link StringSeq}.
 */
function stringCollector(c: GrowthCase, out: string[], cap = CAP): Visitor {
  const seq = new StringSeq(out, new PayloadAcc(), -1, -1, "elements", cap);
  let inArray = false;
  return {
    sequenceBegin: (id, depth) => {
      if (inArray) return false; // a scope inside a leaf array is not an element
      if (id === c.field_id && depth === 1) inArray = true;
      return undefined;
    },
    sequenceEnd: (id) => {
      if (id === c.field_id) inArray = false;
    },
    fixlenBegin: (id, subtype, total) => {
      if (inArray) seq.begin(id, subtype, total);
    },
    string: (id, total, offset, src, start, end) => {
      if (inArray) seq.element(id, total, offset, src, start, end);
    },
  };
}

/**
 * The same for `array<struct>`: the element is a **framed** child, so the index is
 * bound at the element's own `sequenceBegin` — before the frame is entered and
 * before the container grows — and the child's field lands in the reserved slot.
 */
function structCollector(c: GrowthCase, out: number[], cap = CAP): Visitor {
  const slots = new ElementSeq<number>(out, 0, -1, "elements", cap);
  let depthOfArray = -1;
  let current = -1;
  return {
    sequenceBegin: (id, depth) => {
      if (depthOfArray < 0) {
        if (id === c.field_id && depth === 1) depthOfArray = depth;
        return undefined;
      }
      if (depth === depthOfArray + 1) {
        // An element: bound-check and reserve its slot, then let the frame open.
        slots.reserve(id);
        current = id;
        return undefined;
      }
      return false; // deeper than an element: not this array's business
    },
    sequenceEnd: (id, depth) => {
      if (depth === depthOfArray && id === c.field_id) depthOfArray = -1;
      else if (depth === depthOfArray + 1) current = -1;
    },
    unsigned: (id, value) => {
      if (current >= 0 && id === 0) out[current] = Number(value);
    },
  };
}

/** The outcome of a replay: the container, and the error if one was thrown. */
function replay(
  c: GrowthCase,
  drive: (bytes: Uint8Array, visitor: Visitor) => void,
): { out: (string | number)[]; error: SofabError | undefined } {
  const bytes = build(c);
  const out: (string | number)[] = [];
  const visitor =
    c.element_type === "string"
      ? stringCollector(c, out as string[])
      : structCollector(c, out as number[]);
  try {
    drive(bytes, visitor);
    return { out, error: undefined };
  } catch (e) {
    if (e instanceof SofabError) return { out, error: e };
    throw e;
  }
}

/** One-shot, and chunked at every size from one byte up — the outcome must not move. */
const DRIVES: [string, (bytes: Uint8Array, visitor: Visitor) => void][] = [
  ["one-shot", (bytes, visitor) => decode(bytes, visitor, { maxArrayCount: CAP })],
  [
    "one byte at a time",
    (bytes, visitor) => {
      const is = new IStream(visitor, { maxArrayCount: CAP });
      for (let i = 0; i < bytes.length; i++) is.feed(bytes.subarray(i, i + 1));
    },
  ],
  [
    "three bytes at a time",
    (bytes, visitor) => {
      const is = new IStream(visitor, { maxArrayCount: CAP });
      for (let i = 0; i < bytes.length; i += 3) is.feed(bytes.subarray(i, i + 3));
    },
  ],
];

describe("sequence-array growth (§7.2 item 8)", () => {
  it("has the shared cases to replay", () => {
    // A vector file without the block would silently pass every `it.each` below.
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((c) => c.requires?.includes("dynamic_arrays"))).toBe(true);
  });

  it("runs with a cap the cases can express boundaries against", () => {
    expect(CAP).toBeGreaterThanOrEqual(4);
  });

  for (const [driveName, drive] of DRIVES) {
    describe(driveName, () => {
      it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
        const { out, error } = replay(c, drive);

        if (c.expect.outcome === "complete") {
          expect(error, c.description).toBeUndefined();
          expect(out).toHaveLength(expectedLength(c.expect));
          for (const id of c.expect.default_ids ?? []) {
            // The element default: "" for a string element, 0 for the struct's
            // single unsigned field. A gap holds it; it is not skipped over.
            expect(out[id]).toBe(c.element_type === "string" ? "" : 0);
          }
          // Every delivered element sits at its own index, unshifted by a gap.
          for (const el of c.deliver) {
            const want = c.element_type === "string" ? String(el.value) : Number(el.value);
            expect(out[index(el)]).toBe(want);
          }
        } else {
          expect(error, c.description).toBeInstanceOf(SofabError);
          // A capacity rejection, not a validity one: the bytes are well-formed
          // and the same message decodes under a looser cap (§6.2.1).
          expect(error!.code).toBe(SofabErrorCode.LimitExceeded);
          // The container was never extended toward the rejected index — and,
          // because the rejection is terminal, nothing delivered after it landed.
          expect(out.length).toBeLessThanOrEqual(c.expect.max_length!);
        }
      });
    });
  }

  it("rejects the over-cap index before the container grows, not after", () => {
    // The mechanism behind every `max_length` above, asserted directly: the bound
    // runs first, so a rejected index leaves the array exactly as it was.
    const out: string[] = [];
    const slots = new ElementSeq<string>(out, "", -1, "elements", CAP);
    slots.reserve(0);
    expect(out).toHaveLength(1);
    expect(() => slots.reserve(CAP)).toThrow(SofabError);
    expect(out).toHaveLength(1);
    slots.reserve(2);
    expect(out).toStrictEqual(["", "", ""]);
  });

  it("fills a sparse array linearly — one write per slot, no re-copying", () => {
    // Growth *geometry* (ARCHITECTURE §9.5 shape B: grow to at least id + 1, so a
    // sparse array is not O(n²)) splits in two here, and only one half is this
    // port's. The backing store belongs to the engine — a JS array's reallocation
    // strategy is V8's amortised doubling, which no test of ours can or should
    // pin. What is ours is the *fill*: each slot written once, in one pass, with no
    // pass over the slots already there. Counting the writes is exactly that
    // assertion, and it is the allocation-counting facility §7.2 item 8 asks for
    // where the language offers one.
    const out: string[] = [];
    const slots = new ElementSeq<string>(out, "", -1, "elements", 100_000);
    const push = Array.prototype.push;
    let writes = 0;
    Array.prototype.push = function (this: unknown[], ...args: unknown[]) {
      writes += args.length;
      return push.apply(this, args);
    } as typeof push;
    try {
      slots.place(0, "a");
      slots.place(9_999, "b"); // one sparse jump: 9,998 defaults plus the two ends
    } finally {
      Array.prototype.push = push;
    }
    expect(out).toHaveLength(10_000);
    expect(writes).toBe(10_000);
    expect(out[0]).toBe("a");
    expect(out[9_999]).toBe("b");
    expect(out[5_000]).toBe("");
  });

  it("keeps a decoder-side cap rejection terminal (§6.3)", () => {
    // The count-prefixed twin: a cap the *decoder* enforces latches, so a caller
    // that catches the throw and feeds on is re-told rather than resumed inside
    // the field the throw abandoned.
    const os = growingOStream();
    os.writeUnsignedArray(1, new Array(CAP + 1).fill(0));
    const is = new IStream({ arrayBegin: () => undefined }, { maxArrayCount: CAP });
    expect(() => is.feed(os.bytes().slice())).toThrow(
      expect.objectContaining({ code: SofabErrorCode.LimitExceeded }),
    );
    expect(() => is.feed(Uint8Array.of(0x08, 0x01))).toThrow(
      expect.objectContaining({ code: SofabErrorCode.LimitExceeded }),
    );
  });

  it.each(
    cases.filter((c) => c.expect.outcome === "limit_exceeded").map((c) => [c.name, c] as const),
  )("%s decodes under a looser cap — the bytes were never at fault", (_name, c) => {
    // What makes LIMIT_EXCEEDED a policy rejection rather than a verdict on the
    // message (§6.2.1): raise the cap and the identical bytes complete.
    const loose = CAP * 4;
    const bytes = build(c);
    const out: (string | number)[] = [];
    const visitor =
      c.element_type === "string"
        ? stringCollector(c, out as string[], loose)
        : structCollector(c, out as number[], loose);
    expect(() => decode(bytes, visitor, { maxArrayCount: loose })).not.toThrow();
    expect(out.length).toBeGreaterThan(c.expect.max_length!);
  });
});
