/**
 * The `skip-ids` conformance scenario (`test_vectors_README.md`, CORELIB_PLAN
 * §7.1 / §7.2 item 7): for every vector that carries a `skip_ids` array, a
 * receiver that ignores those field ids — at every nesting level, and for *any*
 * wire type including a whole nested sequence — must still decode the remaining
 * fields with their exact values and consume the message cleanly.
 *
 * In the visitor model "skip" is simply not handling a field; the decoder walks
 * its bytes regardless, and a {@link SkipVisitor} declines a skipped sequence at
 * `sequenceBegin` so its entire sub-tree is consumed and never reported. Each
 * vector is checked against **two independent expectations**:
 *
 *   * the *shape* — which fields survive, in order — computed from the vector's
 *     own `fields` list, so it does not depend on the decoder at all; and
 *   * the *values* — computed by decoding everything and filtering out what a
 *     skipping receiver drops, which pins each surviving value bit-exactly.
 *
 * and in three delivery shapes: one contiguous buffer, one byte at a time, and
 * split in two at every byte boundary. The skip length computations differ per
 * wire type (a varint ends at its continuation bit, a fixlen at its length word,
 * an array after `count` elements or `count × element_length`, a sequence at its
 * end marker — §4.6/§4.7/§4.8/§4.9), each can be off by a byte on its own, and
 * the symptom is always the same: the *next* field is read from the wrong offset,
 * so the anchor field after every skipped one fails to match. Chunking is where a
 * resync bug that a single-buffer feed hides tends to surface.
 */

import { describe, expect, it } from "vitest";
import { DecodeStatus, IStream, decode } from "../src/index.js";
import { hexToBytes } from "./helpers/hex.js";
import {
  type Event,
  RecordingVisitor,
  SkipVisitor,
  filterSkipped,
} from "./helpers/recording-visitor.js";
import { reportingTally } from "./helpers/vector-tally.js";
import { type Field, loadVectors, missingCapabilities } from "./helpers/vectors.js";

const vectors = loadVectors();
const withSkips = vectors.filter((v) => v.skip_ids && v.skip_ids.length > 0);
const tally = reportingTally("skip-ids");

/** A compact, comparison-stable key for one decoded event — kind, id and value. */
function key(ev: Event): string {
  switch (ev.kind) {
    case "unsigned":
      return `u${ev.id}=${ev.value}`;
    case "signed":
      return `s${ev.id}=${ev.value}`;
    case "fp32":
      return `f${ev.id}=${ev.value}`;
    case "fp64":
      return `d${ev.id}=${ev.value}`;
    case "string":
      return `str${ev.id}=${ev.text}`;
    case "blob":
      return `b${ev.id}=${Array.from(ev.bytes, (x) => x.toString(16).padStart(2, "0")).join("")}`;
    case "array":
      return `a${ev.id}:${ev.arrayKind}:[${ev.values.join(",")}]`;
    case "sequenceBegin":
      return `(${ev.id}`;
    case "sequenceEnd":
      return ")";
  }
}

/** The same event, reduced to kind and id — the *shape* half of the expectation. */
function shape(ev: Event): string {
  return ev.kind === "sequenceEnd" ? ")" : `${ev.kind}@${ev.id}`;
}

/**
 * Which visitor callback a vector `op` arrives on. `boolean` is not a wire type:
 * it is written as the unsigned value 0 or 1 (§4.3), so it comes back `unsigned`.
 */
const EVENT_OF_OP: Readonly<Record<string, string>> = {
  unsigned: "unsigned",
  boolean: "unsigned",
  signed: "signed",
  fp32: "fp32",
  fp64: "fp64",
  string: "string",
  blob: "blob",
  array: "array",
};

/**
 * The shape a skipping receiver must see, derived from the vector's `fields`
 * list alone — no decoder involved.
 *
 * This is the independent half of the oracle: the value comparison below is
 * built by *decoding* and filtering, so it would agree with a decoder that
 * mis-skips in a self-consistent way; this one cannot. A skipped id is dropped at
 * every nesting level, and a skipped `sequence_begin` takes its whole sub-tree —
 * at any depth — and its own end marker with it.
 */
function expectedShape(fields: Field[], skip: ReadonlySet<number>): string[] {
  const out: string[] = [];
  let depth = 0;
  let skipFrom = -1; // depth of the sub-tree currently being skipped (-1 = none)
  for (const f of fields) {
    const id = f.id ?? 0;
    if (f.op === "sequence_begin") {
      if (skipFrom < 0) {
        if (skip.has(id)) skipFrom = depth;
        else out.push(`sequenceBegin@${id}`);
      }
      depth++;
      continue;
    }
    if (f.op === "sequence_end") {
      depth--;
      if (skipFrom >= 0) {
        if (depth === skipFrom) skipFrom = -1;
        continue;
      }
      out.push(")");
      continue;
    }
    if (skipFrom >= 0 || skip.has(id)) continue;
    const kind = EVENT_OF_OP[f.op];
    if (kind === undefined) throw new Error(`unknown vector op: ${f.op}`);
    out.push(`${kind}@${id}`);
  }
  return out;
}

/** Decode `bytes` with `visitor`, fed in `chunk`-byte pieces; assert it completes. */
function feedInChunks(bytes: Uint8Array, visitor: SkipVisitor, chunk: number): void {
  const is = new IStream(visitor);
  let status: DecodeStatus = DecodeStatus.Complete;
  for (let i = 0; i < bytes.length; i += chunk) {
    status = is.feed(bytes.subarray(i, i + chunk));
  }
  // Every `feed` returns the outcome for the bytes so far and no end step is
  // needed (§6): a message whose skips landed correctly ends COMPLETE, and a
  // skip that consumed too much or too little leaves the decoder mid-field.
  expect(status).toBe(DecodeStatus.Complete);
  expect(is.status()).toBe(DecodeStatus.Complete);
}

describe("skip-ids scenario", () => {
  it("covers every vector that declares skip_ids", () => {
    // 58 in the current shared file (36 `skip/matrix` + 16 `skip` + 6 older
    // ones); asserted as a floor so adopting a larger file cannot shrink it.
    expect(withSkips.length).toBeGreaterThanOrEqual(58);
    expect(withSkips.filter((v) => v.group === "skip/matrix")).toHaveLength(36);
    expect(withSkips.filter((v) => v.group === "skip").length).toBeGreaterThanOrEqual(16);
  });

  it("has a skip scenario for every vector in the skip groups", () => {
    const skipGroups = vectors.filter((v) => v.group === "skip" || v.group === "skip/matrix");
    expect(skipGroups.every((v) => v.skip_ids !== undefined && v.skip_ids.length > 0)).toBe(true);
  });

  describe.each(withSkips.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    const missing = missingCapabilities(vector);
    if (missing.length > 0) tally.gatedOut(vector.name, missing);

    // A vector this build cannot represent is *reported* as gated out, never
    // silently dropped (`requires`, test_vectors_README.md). This port compiles
    // no feature out, so nothing is ever gated here.
    describe.skipIf(missing.length > 0)("runs", () => {
      const bytes = hexToBytes(vector.serialized.hex);
      const skip = new Set(vector.skip_ids!);

      // Ground truth: decode everything, then filter to what a skipping receiver
      // keeps. `full` doubles as the check that the vector's own field list and
      // the decoder agree before any skipping is involved.
      const full = new RecordingVisitor();
      decode(bytes, full);
      const expectedKeys = filterSkipped(full.events, skip).map(key);
      const wantShape = expectedShape(vector.fields, skip);

      it("the vector's fields and a full decode describe the same message", () => {
        tally.vector(vector.name);
        expect(full.events.map(shape)).toEqual(expectedShape(vector.fields, new Set()));
        tally.check();
      });

      it("actually skips something", () => {
        // The scenario is worthless if nothing is dropped — which is exactly what
        // a mistyped id (a `bigint` from the JSON against the decoder's `number`)
        // silently produced here before. Every skip vector must lose at least one
        // event relative to a full decode.
        expect(wantShape.length).toBeLessThan(full.events.length);
        expect(expectedKeys.length).toBe(wantShape.length);
        tally.check();
      });

      it("auto-skips the listed ids and keeps the rest (contiguous)", () => {
        const sv = new SkipVisitor(skip);
        decode(bytes, sv); // throws unless the message is fully consumed
        expect(sv.events.map(shape)).toEqual(wantShape);
        expect(sv.events.map(key)).toEqual(expectedKeys);
        tally.check();
      });

      it("auto-skips correctly when fed one byte at a time", () => {
        const sv = new SkipVisitor(skip);
        feedInChunks(bytes, sv, 1);
        expect(sv.events.map(shape)).toEqual(wantShape);
        expect(sv.events.map(key)).toEqual(expectedKeys);
        tally.check();
      });

      it("auto-skips correctly when split in two at every byte boundary", () => {
        // One byte at a time only ever exercises the resumable route. Splitting
        // once puts the boundary inside a skipped field while both halves are
        // wide enough for the bulk route — where a skip that resumes from a
        // stale offset shows up and a byte-at-a-time feed does not.
        for (let cut = 1; cut < bytes.length; cut++) {
          const sv = new SkipVisitor(skip);
          const is = new IStream(sv);
          is.feed(bytes.subarray(0, cut));
          const status = is.feed(bytes.subarray(cut));
          expect(status, `split at ${cut}`).toBe(DecodeStatus.Complete);
          expect(sv.events.map(key), `split at ${cut}`).toEqual(expectedKeys);
          tally.check();
        }
      });
    });
  });
});
