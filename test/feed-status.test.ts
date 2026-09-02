/**
 * CORELIB_PLAN §6 (Decoder capabilities): "`feed(bytes)` accepting arbitrarily
 * small chunks, **returning** the three-valued decode outcome `COMPLETE` /
 * `INCOMPLETE` / `INVALID` (§5.2). **No** separate `finish`/`finalize`/`end`
 * step". §5.2 says the same from the other side: "the status `feed`/`decode`
 * returns *is* the answer", computable at any byte boundary.
 *
 * So `IStream.feed` must hand the caller the outcome for the bytes consumed so
 * far, and reading it must not require a second call of any shape
 * (corelib-ts#112) — not an `end`-shaped one, and not a `status()` accessor
 * either. `INVALID` travels on the error channel, which is this port's
 * idiomatic surfacing of it, and there it stays: it is *not* also readable back
 * as a status, because one fact reachable two ways is one fact that can drift,
 * and this family shipped exactly that drift (a `status()` answering `COMPLETE`
 * for a message `feed` had already refused).
 *
 * What every test below asserts, in one form or another: after any `feed` call
 * the caller already knows where it stands — from the value returned, or from
 * the code on the error thrown — and never needs to ask again.
 */

import { describe, expect, it } from "vitest";
import {
  DecodeStatus,
  IStream,
  SofabError,
  SofabErrorCode,
} from "../src/index.js";

/** `08 2a` — unsigned(id 1) = 42, a whole message ending on a field boundary. */
const WHOLE = Uint8Array.of(0x08, 0x2a);

/** The code `fn` threw — the only channel a refusal has (§6.3). */
function codeOfThrow(fn: () => unknown): SofabErrorCode {
  try {
    fn();
  } catch (e) {
    if (e instanceof SofabError) return e.code;
    throw e;
  }
  throw new Error("expected a SofabError, but nothing was thrown");
}

describe("feed returns the three-valued decode outcome (§6)", () => {
  it("returns COMPLETE at a field boundary", () => {
    const is = new IStream({});
    expect(is.feed(WHOLE)).toBe(DecodeStatus.Complete);
  });

  it("returns COMPLETE for an empty feed on a fresh stream", () => {
    const is = new IStream({});
    expect(is.feed(new Uint8Array(0))).toBe(DecodeStatus.Complete);
  });

  it("returns INCOMPLETE mid-field and COMPLETE once the field lands", () => {
    const is = new IStream({});
    const seen: DecodeStatus[] = [];
    for (const b of WHOLE) seen.push(is.feed(Uint8Array.of(b)));
    expect(seen).toEqual([DecodeStatus.Incomplete, DecodeStatus.Complete]);
  });

  it("returns INCOMPLETE for a dangling varint prefix", () => {
    const is = new IStream({});
    expect(is.feed(Uint8Array.of(0x80))).toBe(DecodeStatus.Incomplete);
  });

  it("returns INCOMPLETE for a truncated string payload", () => {
    // 0a 12 68 — a 2-byte string (fixlen word (2<<3)|2) with one payload byte.
    const is = new IStream({});
    expect(is.feed(Uint8Array.of(0x0a, 0x12, 0x68))).toBe(DecodeStatus.Incomplete);
  });

  it("returns INCOMPLETE while a nested sequence is still open", () => {
    // 0e = sequence start (id 1); 08 2a = a field inside it; no `07` end marker.
    const is = new IStream({});
    expect(is.feed(Uint8Array.of(0x0e, 0x08, 0x2a))).toBe(DecodeStatus.Incomplete);
    expect(is.feed(Uint8Array.of(0x07))).toBe(DecodeStatus.Complete);
  });

  it("the returned status is the answer at every boundary, and re-reading it changes nothing", () => {
    // A nested sequence carrying a string, fed one byte at a time. There is no
    // accessor to agree with: the only way to see the same value again is an
    // empty feed, which consumes nothing.
    const bytes = Uint8Array.of(0x0e, 0x0a, 0x12, 0x68, 0x69, 0x07, 0x08, 0x01);
    const is = new IStream({});
    let returned: DecodeStatus = DecodeStatus.Complete;
    for (const b of bytes) {
      returned = is.feed(Uint8Array.of(b));
      expect(is.feed(new Uint8Array(0))).toBe(returned);
      expect(is.feed(new Uint8Array(0))).toBe(returned);
    }
    expect(returned).toBe(DecodeStatus.Complete);
  });

  it("an empty feed reports the status without changing it", () => {
    const is = new IStream({});
    expect(is.feed(Uint8Array.of(0x08))).toBe(DecodeStatus.Incomplete);
    expect(is.feed(new Uint8Array(0))).toBe(DecodeStatus.Incomplete);
    expect(is.feed(Uint8Array.of(0x2a))).toBe(DecodeStatus.Complete);
    expect(is.feed(new Uint8Array(0))).toBe(DecodeStatus.Complete);
  });
});

describe("a refusal travels on the error channel, and only there (§6.3)", () => {
  it("INVALID is thrown with its code, and every later feed re-throws it", () => {
    const is = new IStream({});
    // 07 = sequence end with no open sequence.
    const first = codeOfThrow(() => is.feed(Uint8Array.of(0x07)));
    expect(first).toBe(SofabErrorCode.InvalidMsg);
    // Terminal: the caller who caught it holds the verdict, and a caller who
    // ignored it is told again rather than being handed a status that forgot.
    expect(codeOfThrow(() => is.feed(WHOLE))).toBe(SofabErrorCode.InvalidMsg);
    expect(codeOfThrow(() => is.feed(new Uint8Array(0)))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("a LIMIT_EXCEEDED rejection keeps its own code and is terminal too (§6.2.1)", () => {
    // The cap is the generated layer's — the codec holds none (§6.2.1) — so it is
    // this visitor that compares it, at the header `arrayBegin` is raised from.
    const is = new IStream({
      arrayBegin(_id, _kind, count) {
        if (count > 1) throw new SofabError(SofabErrorCode.LimitExceeded, "over cap");
      },
    });
    expect(codeOfThrow(() => is.feed(Uint8Array.of(0x03, 0x02, 0x01, 0x02)))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    // Never folded into INVALID — the bytes are well-formed (§6.3) — and never
    // silently downgraded to a returned status by a later call.
    expect(codeOfThrow(() => is.feed(WHOLE))).toBe(SofabErrorCode.LimitExceeded);
  });

  it("a refused stream never answers with a returned status again", () => {
    const is = new IStream({});
    expect(() => is.feed(Uint8Array.of(0x07))).toThrow(SofabError);
    // The defect this API shape closes: after the refusal there is no second
    // route that could answer COMPLETE. Every later call raises, so a returned
    // value is not something a refused stream can produce at all.
    for (const chunk of [WHOLE, new Uint8Array(0), Uint8Array.of(0x08)]) {
      expect(() => is.feed(chunk)).toThrow(SofabError);
    }
  });
});

describe("re-reading the outcome without a second surface", () => {
  it("an empty feed returns exactly what the last real feed returned", () => {
    const is = new IStream({});
    expect(is.feed(new Uint8Array(0))).toBe(DecodeStatus.Complete);
    expect(is.feed(Uint8Array.of(0x08))).toBe(DecodeStatus.Incomplete);
    expect(is.feed(new Uint8Array(0))).toBe(DecodeStatus.Incomplete);
    expect(is.feed(Uint8Array.of(0x2a))).toBe(DecodeStatus.Complete);
    expect(is.feed(new Uint8Array(0))).toBe(DecodeStatus.Complete);
  });

  it("repeated empty feeds never change the verdict", () => {
    const is = new IStream({});
    is.feed(Uint8Array.of(0x0a, 0x12, 0x68));
    for (let k = 0; k < 3; k++) {
      expect(is.feed(new Uint8Array(0))).toBe(DecodeStatus.Incomplete);
    }
    is.feed(Uint8Array.of(0x69));
    for (let k = 0; k < 3; k++) {
      expect(is.feed(new Uint8Array(0))).toBe(DecodeStatus.Complete);
    }
  });
});
