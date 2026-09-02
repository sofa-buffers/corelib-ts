/**
 * CORELIB_TS-01 — an invalid-UTF-8 rejection must be latched like every other
 * `INVALID`, and it is not.
 *
 * CORELIB_PLAN §5.2.2 lists "an invalid-UTF-8 `string` payload that is read,
 * with the strict check enabled" as an `INVALID` condition, and §5.2.1's outcome
 * table makes `INVALID` "the bytes are malformed **regardless of what follows**
 * … no — terminal". §5.2.3: "A decoder **MUST NOT** report `INCOMPLETE` for
 * input it has already determined malformed" — and `COMPLETE` is further still
 * from the required verdict. §6.3 keeps this distinct from the well-formed
 * `LimitExceeded` policy rejection: these bytes really are broken.
 *
 * This port validates UTF-8 outside the codec — legitimate under §6.4.5 — in the
 * `decodeUtf8` helper the caller calls from inside `Visitor.string`, which is the
 * port's own documented materialising pattern (`istream.ts` `Visitor.string`,
 * README "decode a string"). But that verdict was thrown *around*
 * `DecoderState.fail()` rather than through it, so `invalidReason` was never
 * latched: the decode read back as `COMPLETE`, a further `feed` re-entered
 * header parsing at a desynchronised position, and the refused payload's *own*
 * bytes were handed to the visitor as fields that were never on the wire.
 *
 * A refusal has exactly one channel — the throw — so "terminal" is asserted by
 * re-raising: a refused stream can never *return* a status again, which is why
 * no test below reads one back after the rejection.
 *
 * The same hole is the *shape* of the defect rather than a fact about UTF-8:
 * §6.3's other terminal rejection, `LimitExceeded`, is raised from a visitor
 * callback too — by the layer that holds the receiver cap (§6.2.1) — and went
 * unlatched in exactly the same way, so the second `describe` below is the cap
 * sibling of the first, asserting the same three things. What it must *not* share
 * is the code: §6.3 makes a cap rejection a policy rejection of well-formed bytes
 * that "**MUST NOT** be reported as `InvalidMessage`", so it stays
 * `LIMIT_EXCEEDED` and never becomes the `INVALID` outcome.
 *
 * Every case is fed at four chunk sizes, because the wrong answer differs per
 * chunking — which is itself the bug: the same bytes must yield the same verdict
 * and the same field events however the chunk boundaries fell.
 */

import { describe, expect, it } from "vitest";
import {
  DecodeStatus,
  FixlenSubtype,
  IStream,
  SofabError,
  SofabErrorCode,
  decode,
  decodeUtf8,
  type Visitor,
} from "../src/index.js";

/**
 * A visitor that materialises strings the documented way — `decodeUtf8` inside
 * `string` — and records every field event it is handed.
 *
 * Payload *pieces* are recorded separately from field events: where a piece
 * boundary falls is chunk-dependent by design (§6.6.3), so only {@link fields}
 * is comparable across chunkings.
 */
class MaterializingVisitor implements Visitor {
  /** Field-level events, in order — chunking-independent. */
  readonly fields: string[] = [];
  /** Every call including payload pieces, in order. */
  readonly calls: string[] = [];

  unsigned(id: number, v: number | bigint) {
    this.fields.push(`unsigned(${id},${v})`);
    this.calls.push(`unsigned(${id},${v})`);
  }
  signed(id: number, v: number | bigint) {
    this.fields.push(`signed(${id},${v})`);
    this.calls.push(`signed(${id},${v})`);
  }
  fixlenBegin(id: number, sub: FixlenSubtype, total: number) {
    this.fields.push(`fixlenBegin(${id},${sub},${total})`);
    this.calls.push(`fixlenBegin(${id},${sub},${total})`);
  }
  string(
    id: number,
    total: number,
    offset: number,
    src: Uint8Array,
    start: number,
    end: number,
  ) {
    this.calls.push(`string(${id},${total},${offset},${hex(src, start, end)})`);
    // The port's documented materialising pattern: the caller who turns the
    // bytes into a value owns the strict UTF-8 check (§6.4.5).
    decodeUtf8(src, start, end);
  }
  blob(id: number, total: number, offset: number) {
    this.calls.push(`blob(${id},${total},${offset})`);
  }
  arrayBegin(id: number, kind: number, count: number) {
    this.fields.push(`arrayBegin(${id},${kind},${count})`);
    this.calls.push(`arrayBegin(${id},${kind},${count})`);
  }
  arrayUnsigned(id: number, index: number, v: number | bigint) {
    this.fields.push(`arrayUnsigned(${id},${index},${v})`);
    this.calls.push(`arrayUnsigned(${id},${index},${v})`);
  }
  arrayEnd(id: number) {
    this.fields.push(`arrayEnd(${id})`);
    this.calls.push(`arrayEnd(${id})`);
  }
  sequenceBegin(id: number) {
    this.fields.push(`sequenceBegin(${id})`);
    this.calls.push(`sequenceBegin(${id})`);
  }
  sequenceEnd() {
    this.fields.push("sequenceEnd()");
    this.calls.push("sequenceEnd()");
  }
}

function hex(src: Uint8Array, start: number, end: number): string {
  return `[${[...src.subarray(start, end)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ")}]`;
}

/**
 * One field: id 1, wire `fixlen`, `fixlen_word` 0x1a = subtype `String` (2),
 * length 3; payload `ff 00 2a`. `ff` is not valid UTF-8, so a materialising
 * visitor refuses the field — and the payload's remaining two bytes, `00 2a`,
 * happen to spell a well-formed field header (`unsigned(0) = 42`). If the
 * refusal is not latched, those two bytes are re-parsed as that field and
 * delivered as a value the sender never wrote.
 */
const REFUSED = Uint8Array.from([0x0a, 0x1a, 0xff, 0x00, 0x2a]);

/** A well-formed field, fed after the refusal: `unsigned(1) = 99`. */
const AFTER = Uint8Array.of(0x08, 0x63);

/** The chunk sizes the wire above is fed at — whole, and three splits. */
const CHUNKS = [REFUSED.length, 3, 2, 1] as const;

/**
 * A visitor that also carries a receiver cap on a `string`'s declared length and
 * compares it where §6.2.1 says generated code compares it: inside `fixlenBegin`,
 * which the decoder raises at the length word, before any payload. Exceeding it
 * is `LIMIT_EXCEEDED`, never `INVALID_MSG` — the bytes are well-formed (§6.3).
 */
class CappingVisitor extends MaterializingVisitor {
  constructor(private readonly maxStringLen: number) {
    super();
  }

  override fixlenBegin(id: number, sub: FixlenSubtype, total: number) {
    super.fixlenBegin(id, sub, total);
    if (sub === FixlenSubtype.String && total > this.maxStringLen) {
      throw new SofabError(
        SofabErrorCode.LimitExceeded,
        `string length ${total} exceeds the receiver cap ${this.maxStringLen}`,
      );
    }
  }
}

/**
 * Feed `REFUSED` in `chunkSize`-byte pieces, swallowing the rejection the
 * `visitor` raises and collecting its codes.
 */
function feedRefused(
  chunkSize: number,
  visitor: MaterializingVisitor = new MaterializingVisitor(),
) {
  const is = new IStream(visitor);
  const codes: string[] = [];
  // What the stream last said, from the one place it says anything: the value
  // the last `feed` returned, or the code the last `feed` threw.
  let verdict: string = DecodeStatus.Complete;
  for (let i = 0; i < REFUSED.length; i += chunkSize) {
    try {
      verdict = is.feed(REFUSED.subarray(i, i + chunkSize));
    } catch (e) {
      expect(e).toBeInstanceOf(SofabError);
      codes.push((e as SofabError).code);
      verdict = (e as SofabError).code;
    }
  }
  return { is, visitor, codes, verdict };
}

/** Assert that `is` is refused terminally: it raises `code` instead of returning. */
function expectTerminal(is: IStream, code: SofabErrorCode, chunk: Uint8Array): void {
  expect(() => is.feed(chunk)).toThrow(expect.objectContaining({ code }));
}

describe("CORELIB_TS-01: a refused invalid-UTF-8 string is terminal (§5.2.1–§5.2.3)", () => {
  it.each(CHUNKS)(
    "CORELIB_TS-01 (a): the refusal is what the stream says afterwards, at chunk size %i",
    (chunkSize) => {
      const { is, codes, verdict } = feedRefused(chunkSize);
      expect(codes).toContain(SofabErrorCode.InvalidMsg);
      // §5.2.1: INVALID is terminal — not COMPLETE, and §5.2.3 forbids
      // INCOMPLETE for input already determined malformed. With the refusal on
      // the error channel that is one statement, not two: an empty feed cannot
      // return either of them, it raises INVALID_MSG again.
      expect(verdict).toBe(SofabErrorCode.InvalidMsg);
      expectTerminal(is, SofabErrorCode.InvalidMsg, new Uint8Array(0));
    },
  );

  it.each(CHUNKS)(
    "CORELIB_TS-01 (b): a further feed re-reports the verdict, at chunk size %i",
    (chunkSize) => {
      const { is } = feedRefused(chunkSize);
      // The stream must not resume: no continuation can change a terminal
      // verdict (§5.2.1), so the well-formed field that follows is not decoded.
      expectTerminal(is, SofabErrorCode.InvalidMsg, AFTER);
      expectTerminal(is, SofabErrorCode.InvalidMsg, AFTER);
    },
  );

  it.each(CHUNKS)(
    "CORELIB_TS-01 (c): no field the sender never wrote reaches the visitor, at chunk size %i",
    (chunkSize) => {
      const { is, visitor } = feedRefused(chunkSize);
      // The sender wrote exactly one field: a 3-byte string. The only field
      // event that may be delivered is its header.
      expect(visitor.fields).toEqual([`fixlenBegin(1,${FixlenSubtype.String},3)`]);
      // Specifically, the refused payload's own bytes `00 2a` must never be
      // re-parsed into the field `unsigned(0) = 42`, which was never on the wire.
      expect(visitor.calls).not.toContain("unsigned(0,42)");

      // And a further feed decodes nothing: not the field it carries, and not
      // its bytes swallowed as more payload of the already-refused string.
      const before = visitor.calls.length;
      try {
        is.feed(AFTER);
      } catch {
        /* the INVALID_MSG re-throw asserted in (b) */
      }
      expect(visitor.calls.slice(before)).toEqual([]);
    },
  );

  it("CORELIB_TS-01: whole and chunked feeds agree on verdict and fields", () => {
    const runs = CHUNKS.map((chunkSize) => {
      const { verdict, visitor } = feedRefused(chunkSize);
      return { chunkSize, verdict, fields: visitor.fields };
    });
    // Same bytes, same verdict and same field events, however they were split.
    for (const run of runs) {
      expect({ verdict: run.verdict, fields: run.fields }).toEqual({
        verdict: runs[0]!.verdict,
        fields: runs[0]!.fields,
      });
    }
  });
});

describe("CORELIB_TS-01: a refused over-cap string is terminal too, under its own code (§6.3)", () => {
  /**
   * The same wire, refused one step earlier: the cap is compared at the length
   * word, so the field is refused before a payload byte is delivered. Its three
   * payload bytes are still on the wire, and `00 2a` still spells
   * `unsigned(0) = 42` if the machine is allowed to resume into them.
   */
  const feedCapped = (chunkSize: number) =>
    feedRefused(chunkSize, new CappingVisitor(2));

  it.each(CHUNKS)(
    "CORELIB_TS-01 (a): the refusal stays terminal — and is not INVALID, at chunk size %i",
    (chunkSize) => {
      const { is, codes, verdict } = feedCapped(chunkSize);
      expect(codes).toContain(SofabErrorCode.LimitExceeded);
      // §6.3: "MUST NOT be reported as `InvalidMessage`" — the bytes are
      // well-formed and the same message decodes under a looser cap.
      expect(codes).not.toContain(SofabErrorCode.InvalidMsg);
      expect(verdict).toBe(SofabErrorCode.LimitExceeded);
      // Nor COMPLETE, and this is the point of putting the rejection on the
      // error channel alone: the three-valued outcome has no value for "valid,
      // but more than I accept" (§6.3), so a refused stream returns nothing at
      // all — it raises, terminally, under its own code.
      expectTerminal(is, SofabErrorCode.LimitExceeded, new Uint8Array(0));
    },
  );

  it.each(CHUNKS)(
    "CORELIB_TS-01 (b): a further feed does not resume, at chunk size %i",
    (chunkSize) => {
      const { is } = feedCapped(chunkSize);
      // §6.3 calls the cap rejection terminal, so the well-formed field that
      // follows is not decoded — and the rejection re-reports under its own code.
      expectTerminal(is, SofabErrorCode.LimitExceeded, AFTER);
      expectTerminal(is, SofabErrorCode.LimitExceeded, AFTER);
    },
  );

  it.each(CHUNKS)(
    "CORELIB_TS-01 (c): no field the sender never wrote is delivered, at chunk size %i",
    (chunkSize) => {
      const { is, visitor } = feedCapped(chunkSize);
      // The refusal happened at the length word, so the header is the only event
      // the sender's single field may produce — and no payload piece follows it.
      expect(visitor.fields).toEqual([`fixlenBegin(1,${FixlenSubtype.String},3)`]);
      expect(visitor.calls).toEqual([`fixlenBegin(1,${FixlenSubtype.String},3)`]);
      // Specifically, the refused payload's own bytes `00 2a` must never be
      // re-parsed into the field `unsigned(0) = 42`, which was never on the wire.
      expect(visitor.calls).not.toContain("unsigned(0,42)");

      const before = visitor.calls.length;
      try {
        is.feed(AFTER);
      } catch {
        /* the LIMIT_EXCEEDED re-throw asserted in (b) */
      }
      expect(visitor.calls.slice(before)).toEqual([]);
    },
  );

  it("CORELIB_TS-01: whole and chunked feeds agree on verdict and fields", () => {
    const runs = CHUNKS.map((chunkSize) => {
      const { verdict, visitor } = feedCapped(chunkSize);
      return { verdict, fields: visitor.fields };
    });
    for (const run of runs) {
      expect(run).toEqual(runs[0]);
    }
  });

  it("CORELIB_TS-01: a refusal a callback handles itself does not latch", () => {
    // The other side of the latch: it must not over-reach. It is applied to what
    // escapes the decode loop, so a visitor that runs its own nested decode and
    // handles *that* decode's refusal has said nothing about the stream it is a
    // callback of — which must go on decoding normally.
    const seen: string[] = [];
    const outer = new IStream({
      unsigned(id, v) {
        seen.push(`unsigned(${id},${v})`);
        expect(() => decode(REFUSED, new CappingVisitor(2))).toThrow(
          expect.objectContaining({ code: SofabErrorCode.LimitExceeded }),
        );
      },
    });
    expect(outer.feed(AFTER)).toBe(DecodeStatus.Complete);
    expect(outer.feed(new Uint8Array(0))).toBe(DecodeStatus.Complete);
    expect(outer.feed(AFTER)).toBe(DecodeStatus.Complete);
    expect(seen).toEqual(["unsigned(1,99)", "unsigned(1,99)"]);
  });

  it("CORELIB_TS-01: a cap refusal poisons only the stream it was raised on", () => {
    // The other half of terminality: latching must not leak. `decode` reuses one
    // pooled machine, so a refusal latched on one call must be gone by the next —
    // and two IStreams share nothing at all.
    const { is } = feedCapped(REFUSED.length);
    expectTerminal(is, SofabErrorCode.LimitExceeded, new Uint8Array(0));

    const fresh = new MaterializingVisitor();
    const other = new IStream(fresh);
    expect(other.feed(AFTER)).toBe(DecodeStatus.Complete);
    expect(fresh.fields).toEqual(["unsigned(1,99)"]);

    // The pooled one-shot machine: a refused decode, then a clean one on the
    // same machine.
    const capped = new CappingVisitor(2);
    expect(() => decode(REFUSED, capped)).toThrow(
      expect.objectContaining({ code: SofabErrorCode.LimitExceeded }),
    );
    const reused = new MaterializingVisitor();
    expect(() => decode(AFTER, reused)).not.toThrow();
    expect(reused.fields).toEqual(["unsigned(1,99)"]);
  });
});
