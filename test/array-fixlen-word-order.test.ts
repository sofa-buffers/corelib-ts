/**
 * §4.8 decode order: both words first, then the subtype, then the schema bound.
 *
 * A fixlen array carries two words — `element_count` then `fixlen_word` — and
 * they answer to different authorities. The **format** bounds the count
 * (`ARRAY_MAX`, §6.2) and the receiver caps it (§6.2.1), both at the count word
 * and before any allocation. The **schema** `count` (MESSAGE_SPEC §7.1) may only
 * be applied once the `fixlen_word` has shown that the field really is this
 * array: a subtype that contradicts the declared element type means the bytes
 * were never this field's value, so its element count is not this field's count.
 *
 * CORELIB_PLAN §4.8 spells out the consequence it calls intended:
 *
 *   > A message that ends **between** the two words is `INCOMPLETE`, not
 *   > `INVALID`, even when the `element_count` already exceeds the schema
 *   > `count`. The decoder genuinely cannot yet know whether the field is one it
 *   > must bound.
 *
 * `Cursor.arrayFixlenHeader` applied the schema bound at the count word, so a
 * message cut inside — or before — the `fixlen_word` was reported INVALID where
 * the push surfaces (`decode` / `IStream`) said INCOMPLETE on the same bytes
 * (corelib-ts#104).
 */

import { describe, expect, it } from "vitest";
import {
  Cursor,
  DecodeStatus,
  IStream,
  SofabError,
  SofabErrorCode,
} from "../src/index.js";

/** Run `fn` and return the SofabError code it throws (or fail loudly). */
function codeOf(fn: () => unknown): SofabErrorCode {
  try {
    fn();
  } catch (e) {
    if (e instanceof SofabError) return e.code;
    throw e;
  }
  throw new Error("expected a SofabError, but nothing was thrown");
}

// 0x05 = header(id 0, wire ArrayFixlen): (0 << 3) | 5.
const HDR = 0x05;

/** Read the buffer as a bounded fp32 array through the pull (Cursor) surface. */
function cursorFp32(buf: Uint8Array, schemaCount: number): SofabErrorCode {
  return codeOf(() => {
    const c = new Cursor(buf);
    c.readHeader();
    c.readFp32Array(schemaCount);
  });
}

/**
 * The same bytes fed to the push surface one byte at a time. `feed` signals
 * INVALID by throwing, so a throw is reported as {@link DecodeStatus.Invalid};
 * otherwise the verdict is whatever `end()` says.
 */
function streamStatus(buf: Uint8Array): DecodeStatus {
  const is = new IStream();
  try {
    for (const b of buf) is.feed(Uint8Array.of(b), {});
  } catch (e) {
    if (e instanceof SofabError) return DecodeStatus.Invalid;
    throw e;
  }
  return is.end();
}

describe("fixlen array: schema count is applied after the element word (§4.8, #104)", () => {
  // The count word already exceeds the schema bound (5 > 2) in every row, but
  // the element word has not arrived, so the decoder cannot yet know the field
  // is one it must bound.
  it("reports INCOMPLETE when the element word is cut after its first byte", () => {
    // 0x80: continuation bit set, input ends → the fixlen_word never completes.
    expect(cursorFp32(Uint8Array.of(HDR, 0x05, 0x80), 2)).toBe(
      SofabErrorCode.Incomplete,
    );
  });

  it("reports INCOMPLETE when a non-minimal element word is cut", () => {
    expect(cursorFp32(Uint8Array.of(HDR, 0x05, 0xa0), 2)).toBe(
      SofabErrorCode.Incomplete,
    );
  });

  it("reports INCOMPLETE when the element word is absent entirely", () => {
    expect(cursorFp32(Uint8Array.of(HDR, 0x05), 2)).toBe(
      SofabErrorCode.Incomplete,
    );
  });

  it("agrees with the push surfaces on the same bytes", () => {
    for (const buf of [
      Uint8Array.of(HDR, 0x05, 0x80),
      Uint8Array.of(HDR, 0x05, 0xa0),
      Uint8Array.of(HDR, 0x05),
    ]) {
      expect(streamStatus(buf)).toBe(DecodeStatus.Incomplete);
    }
  });

  // Controls: nothing above may weaken the bound once the word *has* arrived.
  it("still rejects an over-count array once the element word completes", () => {
    // 0x20 = (4 << 3) | 0 → fp32, 4 bytes/element; count 5 > schema count 2.
    expect(cursorFp32(Uint8Array.of(HDR, 0x05, 0x20), 2)).toBe(
      SofabErrorCode.InvalidMsg,
    );
    // …and with the payload present, too.
    const withPayload = Uint8Array.of(HDR, 0x05, 0x20, ...new Uint8Array(20));
    expect(cursorFp32(withPayload, 2)).toBe(SofabErrorCode.InvalidMsg);
  });

  it("still reports INCOMPLETE for an in-bound count with a truncated word", () => {
    expect(cursorFp32(Uint8Array.of(HDR, 0x01, 0xa0), 2)).toBe(
      SofabErrorCode.Incomplete,
    );
  });

  it("still rejects a contradicting element subtype before the schema bound", () => {
    // subtype 2 (string) is not a legal fixlen-array element type; the element
    // word decides, and it decides INVALID whatever the count says.
    expect(cursorFp32(Uint8Array.of(HDR, 0x05, 0x22), 2)).toBe(
      SofabErrorCode.InvalidMsg,
    );
  });

  // The *format* ceiling and the *receiver* cap keep firing at the count word,
  // before any allocation — §4.8 ("whatever the subtype turns out to be") and
  // §6.2.1. Both are asserted on input truncated inside the element word, which
  // is exactly where the schema bound must no longer fire.
  it("still enforces ARRAY_MAX at the count word", () => {
    // 0x80808080 0x08 → 2^31, one past ARRAY_MAX; element word cut.
    const buf = Uint8Array.of(HDR, 0x80, 0x80, 0x80, 0x80, 0x08, 0x80);
    expect(cursorFp32(buf, 2)).toBe(SofabErrorCode.InvalidMsg);
  });

  it("still enforces maxArrayCount at the count word", () => {
    const buf = Uint8Array.of(HDR, 0x05, 0x80);
    expect(
      codeOf(() => {
        const c = new Cursor(buf, { maxArrayCount: 2 });
        c.readHeader();
        c.readFp32Array(8);
      }),
    ).toBe(SofabErrorCode.LimitExceeded);
  });

  // The same ordering holds for the other two fixlen-array readers.
  it("holds for readFp64Array and readFp32ArrayRaw", () => {
    const cut = Uint8Array.of(HDR, 0x05, 0x80);
    expect(
      codeOf(() => {
        const c = new Cursor(cut);
        c.readHeader();
        c.readFp64Array(2);
      }),
    ).toBe(SofabErrorCode.Incomplete);
    expect(
      codeOf(() => {
        const c = new Cursor(cut);
        c.readHeader();
        c.readFp32ArrayRaw(2);
      }),
    ).toBe(SofabErrorCode.Incomplete);
    // Control: complete fp64 element word, count still over the bound.
    const whole = Uint8Array.of(HDR, 0x05, 0x41); // (8 << 3) | 1 → fp64, 8 bytes
    expect(
      codeOf(() => {
        const c = new Cursor(whole);
        c.readHeader();
        c.readFp64Array(2);
      }),
    ).toBe(SofabErrorCode.InvalidMsg);
  });
});
