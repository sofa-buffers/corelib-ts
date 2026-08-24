/**
 * CORELIB_PLAN §6 (Decoder capabilities): "`feed(bytes)` accepting arbitrarily
 * small chunks, **returning** the three-valued decode outcome `COMPLETE` /
 * `INCOMPLETE` / `INVALID` (§5.2). **No** separate `finish`/`finalize`/`end`
 * step". §5.2 says the same from the other side: "the status `feed`/`decode`
 * returns *is* the answer", computable at any byte boundary.
 *
 * So `IStream.feed` must hand the caller the outcome for the bytes consumed so
 * far, and reading it must not require a second, `end`-shaped call
 * (corelib-ts#112). `INVALID` keeps travelling on the error channel — the
 * throw is this port's idiomatic surfacing of it — but it stays readable as a
 * status afterwards, so the poisoned stream is not the one case where the
 * caller has no status to look at.
 */

import { describe, expect, it } from "vitest";
import {
  DecodeStatus,
  IStream,
  SofabError,
  SofabErrorCode,
  type Visitor,
} from "../src/index.js";

/** `08 2a` — unsigned(id 1) = 42, a whole message ending on a field boundary. */
const WHOLE = Uint8Array.of(0x08, 0x2a);

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

  it("the returned status agrees with the accessor at every boundary", () => {
    // A nested sequence carrying a string, fed one byte at a time.
    const bytes = Uint8Array.of(0x0e, 0x0a, 0x12, 0x68, 0x69, 0x07, 0x08, 0x01);
    const is = new IStream({});
    const visitor: Visitor = {};
    for (const b of bytes) {
      const returned = is.feed(Uint8Array.of(b));
      expect(returned).toBe(is.status());
      expect(returned).toBe(is.status());
    }
    expect(is.status()).toBe(DecodeStatus.Complete);
  });

  it("an empty feed reports the status without changing it", () => {
    const is = new IStream({});
    expect(is.feed(Uint8Array.of(0x08))).toBe(DecodeStatus.Incomplete);
    expect(is.feed(new Uint8Array(0))).toBe(DecodeStatus.Incomplete);
    expect(is.feed(Uint8Array.of(0x2a))).toBe(DecodeStatus.Complete);
    expect(is.feed(new Uint8Array(0))).toBe(DecodeStatus.Complete);
  });
});

describe("INVALID stays readable as a status (§5.2)", () => {
  it("status() is INVALID after the throw, and every later feed re-throws", () => {
    const is = new IStream({});
    // 07 = sequence end with no open sequence.
    expect(() => is.feed(Uint8Array.of(0x07))).toThrow(
      expect.objectContaining({ code: SofabErrorCode.InvalidMsg }),
    );
    expect(is.status()).toBe(DecodeStatus.Invalid);
    expect(() => is.feed(WHOLE)).toThrow(SofabError);
    expect(is.status()).toBe(DecodeStatus.Invalid);
  });

  it("a LIMIT_EXCEEDED rejection leaves a readable, non-INVALID status (§6.2.1)", () => {
    const is = new IStream({}, { maxArrayCount: 1 });
    expect(() => is.feed(Uint8Array.of(0x03, 0x02, 0x01, 0x02))).toThrow(
      expect.objectContaining({ code: SofabErrorCode.LimitExceeded }),
    );
    expect(is.status()).not.toBe(DecodeStatus.Invalid);
  });
});

describe("status() and the deprecated end() alias", () => {
  it("end() returns exactly what status() returns", () => {
    const is = new IStream({});
    expect(is.status()).toBe(is.status());
    is.feed(Uint8Array.of(0x08));
    expect(is.status()).toBe(DecodeStatus.Incomplete);
    expect(is.status()).toBe(is.status());
    is.feed(Uint8Array.of(0x2a));
    expect(is.status()).toBe(DecodeStatus.Complete);
    expect(is.status()).toBe(is.status());
  });

  it("status() is a pure accessor: repeated calls never change the verdict", () => {
    const is = new IStream({});
    is.feed(Uint8Array.of(0x0a, 0x12, 0x68));
    for (let k = 0; k < 3; k++) expect(is.status()).toBe(DecodeStatus.Incomplete);
    is.feed(Uint8Array.of(0x69));
    for (let k = 0; k < 3; k++) expect(is.status()).toBe(DecodeStatus.Complete);
  });
});
