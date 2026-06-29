/**
 * The `skip-ids` conformance scenario (test_vectors_README.md): for every vector
 * that carries a `skip_ids` array, a receiver that ignores those field ids — at
 * every nesting level, and for *any* wire type including a whole nested
 * sequence — must still decode the remaining fields and consume the message
 * cleanly.
 *
 * In the visitor model "skip" is simply not handling a field; the decoder walks
 * its bytes regardless, and a {@link SkipVisitor} returns a drain child for a
 * skipped sequence so its entire sub-tree is consumed and ignored. We check the
 * kept events against an independently-computed expectation, both for a single
 * contiguous decode and fed one byte at a time.
 */

import { describe, expect, it } from "vitest";
import { IStream, decode } from "../src/index.js";
import { hexToBytes } from "./helpers/hex.js";
import {
  type Event,
  RecordingVisitor,
  SkipVisitor,
  filterSkipped,
} from "./helpers/recording-visitor.js";
import { loadVectors } from "./helpers/vectors.js";

const withSkips = loadVectors().filter((v) => v.skip_ids && v.skip_ids.length > 0);

/** A compact, comparison-stable key for one decoded event. */
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

describe("skip-ids scenario", () => {
  it("covers the vectors that declare skip_ids", () => {
    expect(withSkips.length).toBeGreaterThan(0);
  });

  describe.each(withSkips.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    const bytes = hexToBytes(vector.serialized.hex);
    const skip = new Set(vector.skip_ids!);

    // Ground truth: decode everything, then filter to what a skipping receiver keeps.
    const full = new RecordingVisitor();
    decode(bytes, full);
    const expected = filterSkipped(full.events, skip).map(key);

    it("auto-skips the listed ids and keeps the rest (contiguous)", () => {
      const sv = new SkipVisitor(skip);
      expect(() => decode(bytes, sv)).not.toThrow();
      expect(sv.events.map(key)).toEqual(expected);
    });

    it("auto-skips correctly when fed one byte at a time", () => {
      const sv = new SkipVisitor(skip);
      const is = new IStream();
      for (let i = 0; i < bytes.length; i++) is.feed(bytes.subarray(i, i + 1), sv);
      expect(() => is.end()).not.toThrow();
      expect(sv.events.map(key)).toEqual(expected);
    });
  });
});
