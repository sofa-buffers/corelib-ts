/**
 * The shared `header_limits_nested` block — CORELIB_PLAN §6.2.1 / §6.3,
 * MESSAGE_SPEC §7.1 / §5.2.
 *
 * The same truncated over-ceiling header `header-limits.test.ts` feeds, one or two
 * sequence frames deeper:
 *
 * ```
 * 3e   1e   02 a2 06   then EOF
 * ^^ id 7, wire type 6 — sequence open
 *      ^^ id 3, wire type 6 — a second sequence, inside the first
 *           ^^ id 0, wire type 2 (fixlen)
 *              ^^^^^ length word (100 << 3) | 2  ->  a 100-byte STRING is declared
 *                      ... and the message ends, with both frames still open.
 * ```
 *
 * **Why depth is an axis of its own.** Every case in the flat block puts its field
 * at `field_id 0` in the top-level scope, so the identical word delivered *inside*
 * an open sequence is untested there — and a port can bind its ceiling to the
 * top-level scope, or wire the cap into a flat visitor and not into the nested
 * path, and pass the whole flat block while capping nothing one frame down. Nothing
 * else changes: the key set, the outcome vocabulary, the terminality rule and the
 * pairing of each rejection with an in-cap control are inherited unchanged, and the
 * **leaf is literally shared** — `helpers/header-limits.ts` holds the ceiling
 * comparison both blocks run, because a nested leaf of its own could make this
 * block pass by a mechanism the library never performs.
 *
 * **And why the negative control below is load-bearing rather than decorative.**
 * These cases end with the sequence still open and no payload behind the header, so
 * a decoder has a *second, independent* reason to answer `incomplete`. A port that
 * rejects for some unrelated reason — a depth guard, a frame-count guard, a general
 * refusal of unclosed frames — answers `limit_exceeded` or `invalid` and passes the
 * forward pass while never having consulted the ceiling under test. Only lifting
 * the ceiling and watching the answer *change* tells those two apart, which is why
 * the control here counts what it checked and asserts that count.
 */

import { describe, expect, it } from "vitest";
import {
  DecodeStatus,
  IStream,
  SofabError,
  SofabErrorCode,
  type FeedStatus,
  type Visitor,
  type WireType,
} from "../src/index.js";
import {
  CODE,
  LIFTED,
  ceilingLeaf,
  ceilingOf,
  chunksOf,
  emptyDestination,
  isEmpty,
  lifted,
  promisedPayload,
  type Ceiling,
  type Destination,
  type Event,
} from "./helpers/header-limits.js";
import { reportingTally } from "./helpers/vector-tally.js";
import {
  loadNestedHeaderLimitCases,
  missingBlockCapabilities,
  unknownBlockCapabilityTags,
  type NestedHeaderLimitCase,
} from "./helpers/vectors.js";

const cases = loadNestedHeaderLimitCases();
const tally = reportingTally("header-limits-nested");

/**
 * The receiver's frame chain: the sequence ids a case names, entered outermost
 * first, and nothing else.
 *
 * This visitor is flat (`IStream` reports nesting as `sequenceBegin` /
 * `sequenceEnd` events carrying id and depth, not as a visitor per scope), so
 * "descend into `frames[0]`, then into `frames[1]`" is exactly: accept the sequence
 * whose id the chain expects at that depth and decline every other one. A declined
 * subtree raises no callback of any kind, so **every field callback that arrives is
 * in a scope this chain accepted** — which makes {@link depth} the scope's real
 * depth and {@link atTarget} the honest answer to "is the ceiling's field here?".
 */
class FrameChain {
  private entered = 0;

  constructor(private readonly frames: readonly number[]) {}

  /** `sequenceBegin`: descend only into the next frame the chain names. */
  begin(id: number, depth: number): boolean {
    if (depth === this.entered + 1 && id === this.frames[depth - 1]) {
      this.entered = depth;
      return true;
    }
    return false;
  }

  /** `sequenceEnd`: the scope that closed was at `depth`, so we are back above it. */
  end(depth: number): void {
    this.entered = depth - 1;
  }

  /** How many frames deep the fields arriving now are — 0 at the top level. */
  depth(): number {
    return this.entered;
  }

  /** The innermost frame of the chain, and only there, is where the ceiling binds. */
  atTarget(): boolean {
    return this.entered === this.frames.length;
  }
}

/** Where each field header arrived — the evidence that the ceiling bound at the right depth. */
interface Arrival {
  id: number;
  wire: WireType;
  depth: number;
}

/**
 * The receiver a case asks for: the frame chain it names, and at the innermost
 * depth the **shared** leaf, with its ceiling comparison gated on being there.
 *
 * Nothing about the verdict is decided in this file — `ceilingLeaf` is the flat
 * block's own guard, imported unchanged. All that is added is where it applies.
 */
function receiver(
  c: NestedHeaderLimitCase,
  log: Event[],
  ceiling: Ceiling | null,
  dest: Destination,
  arrivals: Arrival[],
): Visitor {
  const chain = new FrameChain(c.frames);
  const leaf = ceilingLeaf(c, log, ceiling, dest, () => chain.atTarget());
  return {
    ...leaf,
    // Fires for every field, in every scope, before the value's own header word —
    // so it is the cheapest place to record the depth each header really arrived
    // at, without wrapping (and so weakening) the shared leaf.
    fieldBegin(id, wire) {
      arrivals.push({ id, wire, depth: chain.depth() });
    },
    sequenceBegin: (id, depth) => chain.begin(id, depth),
    sequenceEnd: (_id, depth) => chain.end(depth),
  };
}

/** Feed one case and report what came back — a status, or the rejection it threw. */
function run(
  c: NestedHeaderLimitCase,
  ceiling: Ceiling | null,
  log: Event[] = [],
  arrivals: Arrival[] = [],
  dest: Destination = emptyDestination(),
): { stream: IStream; dest: Destination; status?: FeedStatus; error?: SofabError } {
  const stream = new IStream(receiver(c, log, ceiling, dest, arrivals));
  const chunks = chunksOf(c);
  if (chunks.length === 0) throw new Error(`${c.name}: nothing to feed`);
  try {
    let status = stream.feed(chunks[0]!);
    for (let i = 1; i < chunks.length; i++) {
      // Every feed before the last must answer `incomplete`: an earlier verdict
      // would mean the decoder answered on bytes it had not yet seen. (No case in
      // this block is chunked today; the key is honoured because the two blocks
      // share one key set and the flat block has such a case.)
      expect(status, `${c.name}: chunk ${i - 1} answered before the last chunk`).toBe(
        DecodeStatus.Incomplete,
      );
      status = stream.feed(chunks[i]!);
    }
    return { stream, dest, status };
  } catch (e) {
    if (e instanceof SofabError) return { stream, dest, error: e };
    throw e;
  }
}

const gated = new Map<string, string[]>();
for (const c of cases) {
  const missing = missingBlockCapabilities(c);
  if (missing.length > 0) gated.set(c.name, missing);
}
const admitted = cases.filter((c) => !gated.has(c.name));
const rejections = admitted.filter((c) => c.expect.outcome !== "incomplete");
const controls = cases.filter((c) => c.expect.outcome === "incomplete");

describe("nested header ceilings (§6.2.1, §6.3)", () => {
  it("has the shared cases to run", () => {
    // A vector file without the block — or with an empty one — would silently pass
    // every `it.each` below. That is a failure, not a skip: this port implements
    // the runner, so the block not being there is news.
    expect(cases.length).toBeGreaterThan(0);
  });

  it("states how many cases ran and how many were gated out", () => {
    // The block's whole value is that these cases *execute*. A mis-spelled
    // capability name or a probe that answers "unsupported" by accident turns the
    // runner into a no-op that reports green, so the counts are asserted and the
    // tally prints them. This port declares every wire tag and `receiver_caps`, so
    // nothing is gated — but the sum is what would show it if that changed.
    expect(admitted.length + gated.size, "ran + gated must be the whole block").toBe(cases.length);
    expect(admitted.length, "the block ran nothing at all").toBeGreaterThan(0);
    for (const [name, missing] of gated) tally.gatedOut(name, missing);
  });

  it("knows every capability tag the block uses", () => {
    // An unrecognised `requires` tag is *satisfied* by the rule (a newer file must
    // stay runnable by an older runner) — which is right, and is also how a whole
    // block quietly stops asserting anything. Fail here instead.
    expect(unknownBlockCapabilityTags(cases)).toEqual([]);
  });

  it("names a non-empty frame chain for every case", () => {
    // `frames` is the block. An empty chain would degrade every case to the flat
    // top-level assertion `header-limits.test.ts` already makes — green, and
    // testing nothing this file exists for. (The loader refuses it too; this is
    // the assertion that says so out loud.)
    for (const c of cases) {
      expect(c.frames.length, `${c.name}: frames is empty`).toBeGreaterThan(0);
    }
  });

  it("exercises more than one depth", () => {
    // "One level may be special-cased." A runner that descends once and then treats
    // the inner sequence header as the target field passes every depth-1 case, so
    // the depth-2 pair has to be present and admitted, not merely in the file.
    expect(
      admitted.filter((c) => c.frames.length >= 2).map((c) => c.name).length,
      "no depth-2 case ran",
    ).toBeGreaterThan(0);
  });

  it("carries an in-cap control for every rejection", () => {
    // The same shape at a size the ceiling admits, which must still answer
    // `incomplete`. Without it a port that rejects everything nested — an unclosed
    // frame is an easy thing to refuse — passes all four rejections and is badly
    // broken. A missing control is a bug in the block, and this is where it shows.
    const controlled = new Set(controls.map((c) => JSON.stringify([c.frames, ceilingOf(c)])));
    for (const c of rejections) {
      expect(controlled, `${c.name} has no in-cap control at its own depth`).toContain(
        JSON.stringify([c.frames, ceilingOf(c)]),
      );
    }
  });

  it("feeds a case's chunks exactly its serialized bytes", () => {
    for (const c of cases) {
      const joined = (c.chunks ?? [c.serialized]).join("");
      expect(joined, `${c.name}: chunks do not reassemble serialized`).toBe(c.serialized);
    }
  });

  describe.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    // An unsatisfied `requires` means SKIP in this block — for every tag. These
    // cases assert a rejection with a specific category, so a build that cannot
    // represent the construct would reject it for an unrelated reason and appear to
    // pass while testing nothing (test_vectors_README.md).
    const missing = gated.get(c.name) ?? [];

    describe.skipIf(missing.length > 0)("runs", () => {
      it("answers the stated outcome, with the ceiling bound at the innermost frame", () => {
        tally.vector(c.name);
        const log: Event[] = [];
        const arrivals: Arrival[] = [];
        const { status, error } = run(c, ceilingOf(c), log, arrivals);

        if (c.expect.outcome === "incomplete") {
          // The in-cap control: the ceiling admits this size, so the truncation —
          // and the open frame — is exactly what `INCOMPLETE` is for.
          expect(error, c.description).toBeUndefined();
          expect(status).toBe(DecodeStatus.Incomplete);
        } else {
          expect(error, c.description).toBeInstanceOf(SofabError);
          // §6.3: the two categories never collapse into one, at any depth.
          expect(error!.code).toBe(CODE[c.expect.outcome]);
          // Decided at the word, before the payload was asked for.
          expect(log.filter((e) => e.at === "payload")).toStrictEqual([]);
        }

        // The mechanism behind both answers, and the axis this block adds: the
        // header word reached the ceiling's layer **at the innermost depth of the
        // chain**, carrying the declared number, through the ordinary nested decode
        // path — and the frames were entered outermost first on the way. A port
        // that bound its ceiling at the top level cannot produce this.
        expect(log[0], c.description).toMatchObject({ id: c.field_id, declared: c.declared });
        expect(arrivals.map((a) => a.depth)).toStrictEqual([
          ...c.frames.map((_id, i) => i),
          c.frames.length,
        ]);
        expect(arrivals.map((a) => a.id)).toStrictEqual([...c.frames, c.field_id]);
        tally.check(3);
      });

      it.runIf(c.expect.terminal === true)("re-raises on a further feed", () => {
        // §6.3 / §5.2.1: the rejection is terminal, and an open frame does not make
        // it less so. A caller that catches it and feeds the payload the header
        // promised gets the same rejection again, under the same code, with no byte
        // consumed and no visitor method driven — asked by *feeding bytes*, never by
        // re-reading a stored status, which a decoder that would have consumed the
        // payload and moved on would also answer.
        const log: Event[] = [];
        const { stream, dest, error } = run(c, ceilingOf(c), log);
        expect(error).toBeInstanceOf(SofabError);
        const before = log.length;

        for (const next of [promisedPayload(c), new Uint8Array(0)]) {
          expect(() => stream.feed(next)).toThrow(
            expect.objectContaining({ code: CODE[c.expect.outcome as keyof typeof CODE] }),
          );
        }
        expect(log).toHaveLength(before);
        // §6.2.1 is "rejected, never clamped": a decoder that truncated to the
        // ceiling and reported the error anyway passes every assertion above and
        // only fails this one. Checked after the further feed, so a late
        // materialization is caught too.
        expect(isEmpty(dest), `${c.name}: materialized past a rejected ceiling`).toBe(true);
        tally.check(2);
      });
    });
  });

  it("routes identical nested bytes to opposite categories, by the ceiling alone", () => {
    // The highest-value pair in the block. Same frames, same word, same declared
    // length, same truncation — `INVALID` on one side and `LIMIT_EXCEEDED` on the
    // other, decided by nothing but which ceiling the case configures. A port that
    // collapses the two into one rejection category passes seven of the eight cases
    // and fails this.
    const capped = cases.find((c) => c.name === "nested_string_over_cap");
    const bounded = cases.find((c) => c.name === "nested_string_schema_bounded");
    expect(capped, "nested_string_over_cap is missing from the block").toBeDefined();
    expect(bounded, "nested_string_schema_bounded is missing from the block").toBeDefined();
    expect(capped!.serialized).toBe(bounded!.serialized);
    expect(capped!.frames).toStrictEqual(bounded!.frames);

    const codes = [capped!, bounded!].map((c) => run(c, ceilingOf(c)).error?.code);
    expect(codes).toStrictEqual([SofabErrorCode.LimitExceeded, SofabErrorCode.InvalidMsg]);
  });

  describe("the negative control — the ceiling lifted out of the way", () => {
    // The forward pass above cannot, on its own, tell "the ceiling fired" from
    // "something else refused a message with an open frame": both produce a
    // rejection on the same bytes. So every rejection is run again with its ceiling
    // — the **same kind** of ceiling, at `LIFTED`, far above every `declared` here —
    // and the answer must *change*. What it changes to is not asserted: that would
    // be a claim about the alternative, where the control's job is only to show the
    // ceiling caused the verdict.
    const checked: string[] = [];

    it.each(rejections.map((c) => [c.name, c] as const))(
      "%s stops rejecting once its own ceiling is lifted",
      (_name, c) => {
        const ceiling = ceilingOf(c);
        // `declared` is baked into the bytes, so a case can only be controlled if
        // the lifted ceiling is above it. Every case in this block is (the flat
        // block's gibibyte amplification case, which cannot be lifted past, has no
        // counterpart here) — and if one ever is not, it must be visibly excluded
        // rather than silently passing on a `continue`.
        expect(c.declared, `${c.name}: cannot be lifted past`).toBeLessThan(LIFTED);

        const log: Event[] = [];
        const arrivals: Arrival[] = [];
        const { error } = run(c, lifted(ceiling), log, arrivals);

        // Only that the answer *changed*, deliberately — not that it is now
        // `incomplete`. (It is: a frame is open. But asserting the alternative
        // would make the control a claim about that, where its whole job is to
        // show the ceiling caused the rejection.)
        expect(
          error?.code,
          `${c.name}: still rejects with the ceiling lifted — the verdict is not the ceiling's`,
        ).not.toBe(CODE[c.expect.outcome as keyof typeof CODE]);
        // And the bytes still got where they were going: the same header word, at
        // the same innermost depth, so the run really was the case's run.
        expect(log[0]).toMatchObject({ id: c.field_id, declared: c.declared });
        expect(arrivals[arrivals.length - 1]).toMatchObject({
          id: c.field_id,
          depth: c.frames.length,
        });

        checked.push(c.name);
        tally.check(2);
      },
    );

    it("checked every rejection the gate admitted", () => {
      // A control loop that examines nothing is green and proves nothing — a wrong
      // outcome-name comparison or a gate evaluated differently in the second pass
      // is enough. The count is the guard. With full capabilities that is all four
      // rejections in the block; a port without receiver caps would check one.
      expect(checked.length, `controlled: ${checked.join(", ") || "nothing"}`).toBe(
        rejections.length,
      );
      expect(rejections.length).toBeGreaterThan(0);
    });
  });
});
