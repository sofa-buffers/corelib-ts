/**
 * The shared `header_limits` block — CORELIB_PLAN §6.2.1 / §6.3, MESSAGE_SPEC §5.2.
 *
 * The truncated over-ceiling header: bytes that **declare** a length or an element
 * count and then end, with not one payload byte behind them.
 *
 * ```
 * 02 a2 06   then EOF
 * ^^ id 0, wire type 2 (fixlen)
 *    ^^^^^ length word (100 << 3) | 2  ->  a 100-byte STRING is declared
 *            ... and the message ends.
 * ```
 *
 * A conformant decoder answers **at that word**, before the payload is asked for,
 * so the answer is the ceiling's and it is **terminal**. `INCOMPLETE` is not merely
 * unhelpful here: §5.2.1 defines it as the verdict more bytes *can* change and
 * §5.2.4 has a streaming caller read it as "feed me the next chunk", and after a
 * ceiling has fired both are false statements about the state.
 *
 * **Which ceiling speaks is the subject.** A case states one and never both —
 * §6.2.1 keeps a receiver cap off a field the schema already bounds — and the two
 * give opposite answers on the same word:
 *
 * - `schema.maxlen` — the schema bound, and a breach is `INVALID`: a statement
 *   about validity (MESSAGE_SPEC §7.1);
 * - `limits.max_dyn_*` — the receiver cap, and a breach is `LIMIT_EXCEEDED`: the
 *   bytes are well-formed and this receiver declines to hold that much (§6.2.1).
 *
 * `header_string_schema_bounded` and `header_string_over_cap` carry the **identical
 * bytes** and differ only in which ceiling the case configures. That pair is what
 * keeps the categories apart, and it is asserted directly below.
 *
 * **Where the ceiling lives in this port.** This codec holds no limit (§6.2.1): the
 * numbers are generated code's, and it compares them inside its own flat visitor —
 * at {@link Visitor.fixlenBegin} for a declared byte length and at
 * {@link Visitor.arrayBegin} for a declared element count. The library's half of
 * the contract is that those two events are **raised at the header word, with the
 * length / count consumed and the payload not yet entered** (`src/decode/state.ts`),
 * and that a rejection thrown out of them is latched terminal by
 * {@link IStream.feed}. So the visitor built here is the generated layer's
 * stand-in, and what the block actually pins is the enforcement *point*: delay
 * either event past the payload and every case in this file fails.
 *
 * The wrapper-array twin of the same rule — where the bound is the element index,
 * which has no header word — is `sequence-growth.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  DecodeStatus,
  FixlenSubtype,
  IStream,
  SofabError,
  SofabErrorCode,
  type FeedStatus,
  type Visitor,
} from "../src/index.js";
import { hexToBytes } from "./helpers/hex.js";
import { reportingTally } from "./helpers/vector-tally.js";
import {
  loadHeaderLimitCases,
  missingBlockCapabilities,
  unknownBlockCapabilityTags,
  type HeaderLimitCase,
} from "./helpers/vectors.js";

const cases = loadHeaderLimitCases();
const tally = reportingTally("header-limits");

/** The error code each stated outcome must arrive under (§6.3 keeps the two apart). */
const CODE = {
  limit_exceeded: SofabErrorCode.LimitExceeded,
  invalid: SofabErrorCode.InvalidMsg,
} as const;

/**
 * The ceiling a case configures, in the shape the generated layer would hold it:
 * a receiver cap on one declared quantity, or the schema's own bound.
 */
type Ceiling =
  | { kind: "cap"; on: "string" | "blob" | "array"; limit: number }
  | { kind: "schema"; limit: number };

/** Read the case's stated ceiling — exactly one, which the loader already enforced. */
function ceilingOf(c: HeaderLimitCase): Ceiling {
  if (c.schema !== undefined) return { kind: "schema", limit: c.schema.maxlen! };
  const l = c.limits!;
  if (l.max_dyn_string_len !== undefined) {
    return { kind: "cap", on: "string", limit: l.max_dyn_string_len };
  }
  if (l.max_dyn_blob_len !== undefined) return { kind: "cap", on: "blob", limit: l.max_dyn_blob_len };
  if (l.max_dyn_array_count !== undefined) {
    return { kind: "cap", on: "array", limit: l.max_dyn_array_count };
  }
  throw new Error(`${c.name}: limits states no cap this reader knows`);
}

/** What the visitor was told, in order — the header word first, payload after it. */
type Event =
  | { at: "fixlenBegin"; id: number; subtype: FixlenSubtype; declared: number }
  | { at: "arrayBegin"; id: number; declared: number }
  | { at: "payload" };

/**
 * The generated layer's stand-in: the case's ceiling, compared where §6.2.1 puts
 * the comparison — inside the visitor, at the header word.
 *
 * `ceiling` is `null` for the **negative control**, which runs the identical bytes
 * with no ceiling configured at all. A schema bound is applied only to a subtype
 * that carries a byte length (§7.3: a field whose subtype contradicts the schema is
 * skipped, not rejected), and a receiver cap only to the quantity it names — a port
 * can wire the string cap and miss the blob one, which is why §6.2.1 keeps them
 * separate and why the block asserts both.
 */
function generatedGuard(c: HeaderLimitCase, log: Event[], ceiling: Ceiling | null): Visitor {
  const payload = (): void => void log.push({ at: "payload" });
  return {
    fixlenBegin(id, subtype, total) {
      log.push({ at: "fixlenBegin", id, subtype, declared: total });
      if (id !== c.field_id || ceiling === null) return;
      const isBytes = subtype === FixlenSubtype.String || subtype === FixlenSubtype.Blob;
      if (ceiling.kind === "schema") {
        if (isBytes && total > ceiling.limit) {
          throw new SofabError(
            SofabErrorCode.InvalidMsg,
            `field ${id}: declared length ${total} above schema maxlen ${ceiling.limit}`,
          );
        }
        return;
      }
      const capped =
        (ceiling.on === "string" && subtype === FixlenSubtype.String) ||
        (ceiling.on === "blob" && subtype === FixlenSubtype.Blob);
      if (capped && total > ceiling.limit) {
        throw new SofabError(
          SofabErrorCode.LimitExceeded,
          `field ${id}: declared length ${total} exceeds the receiver cap ${ceiling.limit}`,
        );
      }
    },
    arrayBegin(id, _kind, count) {
      log.push({ at: "arrayBegin", id, declared: count });
      if (id !== c.field_id || ceiling === null) return;
      if (ceiling.kind === "cap" && ceiling.on === "array" && count > ceiling.limit) {
        throw new SofabError(
          SofabErrorCode.LimitExceeded,
          `field ${id}: declared count ${count} exceeds the receiver cap ${ceiling.limit}`,
        );
      }
    },
    string: payload,
    blob: payload,
    arrayUnsigned: payload,
    arraySigned: payload,
    arrayFp32: payload,
    arrayFp64: payload,
  };
}

/** The case's bytes, as the chunks it asks to be fed in (one chunk by default). */
function chunksOf(c: HeaderLimitCase): Uint8Array[] {
  return (c.chunks ?? [c.serialized]).map(hexToBytes);
}

/** Feed one case and report what came back — a status, or the rejection it threw. */
function run(
  c: HeaderLimitCase,
  ceiling: Ceiling | null,
  log: Event[],
): { stream: IStream; status?: FeedStatus; error?: SofabError } {
  const stream = new IStream(generatedGuard(c, log, ceiling));
  const chunks = chunksOf(c);
  if (chunks.length === 0) throw new Error(`${c.name}: nothing to feed`);
  try {
    let status = stream.feed(chunks[0]!);
    for (let i = 1; i < chunks.length; i++) status = stream.feed(chunks[i]!);
    return { stream, status };
  } catch (e) {
    if (e instanceof SofabError) return { stream, error: e };
    throw e;
  }
}

/** The payload the header promised, for the further feed a terminal rejection must refuse. */
function promisedPayload(c: HeaderLimitCase): Uint8Array {
  // Capped: `header_string_amplification` claims a gibibyte, and the assertion is
  // that not one byte of it is consumed — a few of them prove that as well as 2^30.
  return new Uint8Array(Math.min(c.declared, 64)).fill(0x61);
}

const rejections = cases.filter((c) => c.expect.outcome !== "incomplete");
const controls = cases.filter((c) => c.expect.outcome === "incomplete");

describe("header ceilings (§6.2.1, §6.3)", () => {
  it("has the shared cases to run", () => {
    // A vector file without the block would silently pass every `it.each` below.
    expect(cases.length).toBeGreaterThan(0);
  });

  it("knows every capability tag the block uses", () => {
    // An unrecognised `requires` tag gates its cases out — silently running less
    // of the block. Fail here instead, as `vectors.test.ts` does for the vectors.
    expect(unknownBlockCapabilityTags(cases)).toEqual([]);
  });

  it("carries an in-cap control for every rejection", () => {
    // "Every rejection is paired with its in-cap control" (test_vectors_README.md):
    // the same shape at a length the ceiling admits, which must still answer
    // `incomplete`. Without it a port that rejects every short read passes all six
    // rejection cases and is badly broken — so a missing control is a bug in the
    // block, and this is where it surfaces.
    const controlled = new Set(controls.map((c) => JSON.stringify(ceilingOf(c))));
    for (const c of rejections) {
      expect(controlled, `${c.name} has no in-cap control`).toContain(
        JSON.stringify(ceilingOf(c)),
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
    // An unsatisfied `requires` means SKIP in this block — for every tag, and
    // unlike a *vector*, where a reduced build turns the construct into a negative
    // case. These cases already assert a rejection with a specific category, so a
    // build that cannot represent the construct would reject it for an unrelated
    // reason and appear to pass while testing nothing (test_vectors_README.md).
    // This port declares every wire tag and `receiver_caps`, so nothing is gated.
    const missing = missingBlockCapabilities(c);
    if (missing.length > 0) tally.gatedOut(c.name, missing);

    describe.skipIf(missing.length > 0)("runs", () => {
      it("answers the stated outcome", () => {
        tally.vector(c.name);
        const log: Event[] = [];
        const { status, error } = run(c, ceilingOf(c), log);

        if (c.expect.outcome === "incomplete") {
          // The control: the ceiling admits this length, so the truncation is
          // exactly what `INCOMPLETE` is for — more bytes would change it.
          expect(error, c.description).toBeUndefined();
          expect(status).toBe(DecodeStatus.Incomplete);
        } else {
          expect(error, c.description).toBeInstanceOf(SofabError);
          // §6.3: the two categories never collapse into one. A cap rejection is
          // not `INVALID` and a schema breach is not `LIMIT_EXCEEDED`.
          expect(error!.code).toBe(CODE[c.expect.outcome]);
          // Decided at the word, before the payload was asked for.
          expect(log.filter((e) => e.at === "payload")).toStrictEqual([]);
        }

        // And the mechanism behind both answers: the header word reached the
        // ceiling's layer at all, carrying the declared number, before any
        // payload — which for these bytes means before end of input. It holds
        // for the in-cap controls too, so a port that never raises the event
        // cannot pass this block by answering `incomplete` everywhere.
        expect(log[0], c.description).toMatchObject({ id: c.field_id, declared: c.declared });
        tally.check();
      });

      it.runIf(c.expect.terminal === true)("re-raises on a further feed", () => {
        // §6.3 / §5.2.1: the rejection is terminal. A caller that catches it and
        // feeds on gets the same rejection again, under the same code, with no
        // byte consumed and no visitor method driven — which is what makes the
        // verdict a statement about the message rather than about this chunk.
        const log: Event[] = [];
        const { stream, error } = run(c, ceilingOf(c), log);
        expect(error).toBeInstanceOf(SofabError);
        const before = log.length;

        for (const next of [promisedPayload(c), new Uint8Array(0)]) {
          expect(() => stream.feed(next)).toThrow(
            expect.objectContaining({ code: CODE[c.expect.outcome as keyof typeof CODE] }),
          );
        }
        expect(log).toHaveLength(before);
        tally.check();
      });
    });
  });

  it("routes identical bytes to opposite categories, by the ceiling alone", () => {
    // The pair the block exists for. Same word, same declared length, same
    // truncation — and `INVALID` on one side, `LIMIT_EXCEEDED` on the other,
    // decided by nothing but which ceiling the case configures. A port that
    // routes both to one category passes every other case here and fails this.
    const capped = cases.find((c) => c.name === "header_string_over_cap")!;
    const bounded = cases.find((c) => c.name === "header_string_schema_bounded")!;
    expect(capped.serialized).toBe(bounded.serialized);

    const codes = [capped, bounded].map((c) => run(c, ceilingOf(c), []).error?.code);
    expect(codes).toStrictEqual([SofabErrorCode.LimitExceeded, SofabErrorCode.InvalidMsg]);
  });

  it.each(rejections.map((c) => [c.name, c] as const))(
    "%s falls back to incomplete with no ceiling configured",
    (_name, c) => {
      // The negative control: run the identical bytes with the ceiling lifted. It
      // is what shows the verdicts above come from the guard rather than from
      // something incidental to the bytes — a port whose rejections survive this
      // is rejecting for a reason it has not identified.
      //
      // All six fall back here, where the block's own note leads one to expect
      // five: the sixth is `header_string_amplification`, whose gibibyte claim
      // stays *below* this port's `FIXLEN_MAX` (`INT32_MAX`, the format ceiling of
      // §6.2), so no format bound fires in the cap's absence. That is a property of
      // the ceiling's value, not of the enforcement point.
      const log: Event[] = [];
      const { status, error } = run(c, null, log);
      expect(error, c.description).toBeUndefined();
      expect(status).toBe(DecodeStatus.Incomplete);
      expect(log[0]).toMatchObject({ id: c.field_id, declared: c.declared });
    },
  );
});
