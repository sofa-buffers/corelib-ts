/**
 * CORELIB_PLAN §5.2: `INVALID` is **terminal** — "the bytes are malformed
 * regardless of what follows … no — terminal", and a decoder MUST NOT report
 * `INCOMPLETE` (let alone `COMPLETE`) for input it has already determined to be
 * malformed.
 *
 * `IStream` reports `INVALID` by throwing `INVALID_MSG` from `feed`, so the
 * verdict has to survive a caller that catches that throw and keeps feeding:
 * once poisoned, the stream decodes nothing further, drives no visitor
 * callbacks, and every later `feed` raises the same refusal again
 * (corelib-ts#103). The throw is the *only* channel it travels on — there is no
 * accessor to poll — so "the verdict survives" is tested by re-raising, and a
 * caller that wants the three-valued vocabulary derives it from the code it
 * caught, which is what {@link outcomeOf} does here.
 *
 * Every case is fed both one byte at a time and as a single whole buffer, so
 * the verdict cannot depend on where the chunk boundaries fell.
 */

import { describe, expect, it } from "vitest";
import {
  DecodeStatus,
  IStream,
  SofabError,
  SofabErrorCode,
  type Visitor,
} from "../src/index.js";

/** Records every visitor call as a `name(args)` string, in order. */
class RecordingVisitor implements Visitor {
  readonly calls: string[] = [];
  unsigned(id: number, v: number | bigint) {
    this.calls.push(`unsigned(${id},${v})`);
  }
  signed(id: number, v: number | bigint) {
    this.calls.push(`signed(${id},${v})`);
  }
  fixlenBegin(id: number, sub: number, total: number) {
    this.calls.push(`fixlenBegin(${id},${sub},${total})`);
  }
  string(id: number, total: number, offset: number) {
    this.calls.push(`string(${id},${total},${offset})`);
  }
  arrayBegin(id: number, kind: number, count: number) {
    this.calls.push(`arrayBegin(${id},${kind},${count})`);
  }
  arrayUnsigned(id: number, index: number, v: number | bigint) {
    this.calls.push(`arrayUnsigned(${id},${index},${v})`);
  }
  arrayEnd(id: number) {
    this.calls.push(`arrayEnd(${id})`);
  }
  sequenceBegin(id: number): void {
    this.calls.push(`sequenceBegin(${id})`);
  }
  sequenceEnd() {
    this.calls.push("sequenceEnd()");
  }
}

/** The three-valued outcome a caught refusal stands for (§6.3: INVALID ↔ InvalidMsg). */
function outcomeOf(e: unknown): DecodeStatus {
  if (e instanceof SofabError && e.code === SofabErrorCode.InvalidMsg) {
    return DecodeStatus.Invalid;
  }
  throw e;
}

/**
 * Feed `bytes` in `chunkSize`-byte pieces, swallowing the `INVALID_MSG` throw
 * the way a lenient caller would, and report what the stream said afterwards:
 * the value the last `feed` returned, or — once it starts throwing — the outcome
 * the code it threw stands for. Either way the answer comes from the `feed` call
 * itself; there is nothing else to ask.
 */
function feedCatching(
  bytes: Uint8Array,
  chunkSize: number,
): { status: DecodeStatus; codes: string[]; calls: string[] } {
  const visitor = new RecordingVisitor();
  const is = new IStream(visitor);
  const codes: string[] = [];
  let status: DecodeStatus = DecodeStatus.Complete; // zero bytes end on a boundary
  for (let i = 0; i < bytes.length; i += chunkSize) {
    try {
      status = is.feed(bytes.subarray(i, i + chunkSize));
    } catch (e) {
      expect(e).toBeInstanceOf(SofabError);
      codes.push((e as SofabError).code);
      status = outcomeOf(e);
    }
  }
  return { status, codes, calls: visitor.calls };
}

/** Malformed byte in the middle, valid field on either side. */
const cases: readonly (readonly [string, number[]])[] = [
  // 00 2a = unsigned(0)=42 | 07 = sequence end with no open sequence (INVALID)
  // | 08 01 = unsigned(1)=1
  ["dangling sequence end", [0x00, 0x2a, 0x07, 0x08, 0x01]],
  // 00 2a | 80 80 80 80 40 = header id 2^31 > ID_MAX (INVALID) | 08 01
  ["id above ID_MAX", [0x00, 0x2a, 0x80, 0x80, 0x80, 0x80, 0x40, 0x08, 0x01]],
  // 00 2a | 0a 00 = fixlen fp32 (subtype 0) declaring length 0 ≠ 4 (INVALID) | 08 01
  ["wrong-width fp32 fixlen", [0x00, 0x2a, 0x0a, 0x00, 0x08, 0x01]],
  // 00 2a | 0a 07 = reserved fixlen subtype 7 (INVALID) | 08 01
  ["reserved fixlen subtype", [0x00, 0x2a, 0x0a, 0x07, 0x08, 0x01]],
];

describe("INVALID is terminal: a poisoned IStream never answers COMPLETE (§5.2)", () => {
  describe.each(cases)("%s", (_name, raw) => {
    const bytes = Uint8Array.from(raw);

    it.each([1, bytes.length])("stays INVALID at chunk size %i", (chunkSize) => {
      const { status, codes } = feedCatching(bytes, chunkSize);
      expect(codes).toContain(SofabErrorCode.InvalidMsg);
      expect(status).toBe(DecodeStatus.Invalid);
    });
  });

  it("an overlong (>64-bit) varint poisons the stream", () => {
    const visitor = new RecordingVisitor();
    const is = new IStream(visitor);
    expect(() => is.feed(new Uint8Array(10).fill(0x80))).toThrow(
      expect.objectContaining({ code: SofabErrorCode.InvalidMsg }),
    );
    // A well-formed message afterwards must not resurrect the stream.
    expect(() => is.feed(Uint8Array.of(0x00, 0x01))).toThrow(
      expect.objectContaining({ code: SofabErrorCode.InvalidMsg }),
    );
    expect(visitor.calls).toEqual([]);
  });

  it("a further feed decodes nothing and drives no visitor callbacks", () => {
    const { calls } = feedCatching(Uint8Array.from([0x00, 0x2a, 0x07, 0x08, 0x01]), 1);
    // unsigned(0,42) was delivered before the malformed byte; the trailing
    // `08 01` (unsigned(1)=1) must never reach the visitor.
    expect(calls).toEqual(["unsigned(0,42)"]);
  });

  it("every later feed re-throws INVALID_MSG rather than silently accepting bytes", () => {
    const visitor = new RecordingVisitor();
    const is = new IStream(visitor);
    expect(() => is.feed(Uint8Array.of(0x07))).toThrow(SofabError);
    for (let k = 0; k < 3; k++) {
      expect(() => is.feed(Uint8Array.of(0x00, 0x01))).toThrow(
        expect.objectContaining({ code: SofabErrorCode.InvalidMsg }),
      );
    }
    expect(visitor.calls).toEqual([]);
  });

  it("the verdict is re-raised, not re-read: repeated calls all carry the same code", () => {
    const is = new IStream({});
    expect(() => is.feed(Uint8Array.of(0x07))).toThrow(SofabError);
    for (let k = 0; k < 3; k++) {
      // A poisoned stream has exactly one thing to say and says it every time.
      // It can never *return* a value, so no caller can read COMPLETE off it.
      expect(() => is.feed(new Uint8Array(0))).toThrow(
        expect.objectContaining({ code: SofabErrorCode.InvalidMsg }),
      );
    }
  });

  it("an empty feed on a poisoned stream still reports INVALID", () => {
    const is = new IStream({});
    expect(() => is.feed(Uint8Array.of(0x07))).toThrow(SofabError);
    let caught: unknown;
    try {
      is.feed(new Uint8Array(0));
    } catch (e) {
      caught = e;
    }
    expect((caught as SofabError).code).toBe(SofabErrorCode.InvalidMsg);
    expect(outcomeOf(caught)).toBe(DecodeStatus.Invalid);
  });

  it("INVALID beats INCOMPLETE: a malformed field then a truncated tail is INVALID", () => {
    // 07 (INVALID) then `0a 12 68` — a 2-byte string with only one payload byte.
    const { status } = feedCatching(Uint8Array.from([0x07, 0x0a, 0x12, 0x68]), 1);
    expect(status).toBe(DecodeStatus.Invalid);
  });

  it("a well-formed stream is unaffected: COMPLETE and INCOMPLETE still work", () => {
    const ok = feedCatching(Uint8Array.from([0x00, 0x2a, 0x08, 0x01]), 1);
    expect(ok.codes).toEqual([]);
    expect(ok.status).toBe(DecodeStatus.Complete);
    expect(ok.calls).toEqual(["unsigned(0,42)", "unsigned(1,1)"]);

    // A lone dangling 0x80 is a well-formed varint *prefix* — INCOMPLETE, never
    // INVALID (§5.2's framing invariant).
    const partial = feedCatching(Uint8Array.of(0x80), 1);
    expect(partial.codes).toEqual([]);
    expect(partial.status).toBe(DecodeStatus.Incomplete);
  });

  it("a receiver-side LIMIT_EXCEEDED is not INVALID (§6.2.1)", () => {
    // The bytes are well-formed — the same message decodes under a looser
    // limit — so hitting a configured cap must not poison the stream into the
    // INVALID outcome.
    // The cap is the generated layer's — the codec holds none (§6.2.1) — so it is
    // this visitor that compares it, at the header `arrayBegin` is raised from.
    const is = new IStream({
      arrayBegin(_id, _kind, count) {
        if (count > 1) throw new SofabError(SofabErrorCode.LimitExceeded, "over cap");
      },
    });
    expect(() => is.feed(Uint8Array.of(0x03, 0x02, 0x01, 0x02))).toThrow(
      expect.objectContaining({ code: SofabErrorCode.LimitExceeded }),
    );
    // The distinction lives in the code, which is the only place it *can* live:
    // §6.3 gives the outcome triple no value for a cap rejection, so re-raising
    // `LIMIT_EXCEEDED` — never `INVALID_MSG` — is the whole of keeping the two
    // apart. It is terminal like INVALID, so the later feed raises it again.
    expect(() => is.feed(Uint8Array.of(0x00, 0x01))).toThrow(
      expect.objectContaining({ code: SofabErrorCode.LimitExceeded }),
    );
  });
});
