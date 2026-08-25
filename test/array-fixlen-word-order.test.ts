/**
 * §4.8.1 decode order: both words first, then the subtype, then the schema bound.
 *
 * A fixlen array carries two words — `element_count` then `fixlen_word` — and they
 * answer to different authorities. The **format** bounds the count (`ARRAY_MAX`,
 * §6.2) and the receiver caps it (§6.2.1), both at the count word and before any
 * allocation. The **schema** `count` (MESSAGE_SPEC §7.1) may only be applied once
 * the `fixlen_word` has shown that the field really is this array: a subtype that
 * contradicts the declared element type means the bytes were never this field's
 * value, so its element count is not this field's count.
 *
 * CORELIB_PLAN §4.8.1 spells out the consequence it calls intended:
 *
 *   > A message that ends **between** the two words is `INCOMPLETE`, not
 *   > `INVALID`, even when the `element_count` already exceeds the schema
 *   > `count`. The decoder cannot yet know whether this is the field it must
 *   > bound.
 *
 * With the visitor as the only decode surface (§5.3.1), that ordering is
 * observable exactly as `arrayBegin` timing: the corelib never learns a schema, so
 * the schema `count` is applied by whoever implements `arrayBegin` — and for a
 * fixlen array that event fires **after** the element word, never at the count
 * word. (corelib-ts#104 was the same rule broken on the removed pull surface.)
 */

import { describe, expect, it } from "vitest";
import {
  ArrayKind,
  DecodeStatus,
  IStream,
  SofabError,
  SofabErrorCode,
  decode,
  type DecodeLimits,
  type Visitor,
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

/**
 * A generated-layer stand-in for `array<fp32, count=N>`: it applies the schema
 * bound where the corelib hands it the count — which is the whole point of the
 * test, since for a fixlen array that is after the element word.
 */
function boundedFp32(schemaCount?: number): Visitor {
  return {
    arrayBegin(_id, kind, count) {
      if (kind !== ArrayKind.Fp32) return; // §7.3: a contradicting element type is skipped
      if (schemaCount !== undefined && count > schemaCount) {
        throw new SofabError(
          SofabErrorCode.InvalidMsg,
          `element count ${count} above schema count ${schemaCount}`,
        );
      }
    },
  };
}

/** One-shot decode of `buf` against a schema-bounded fp32 array. */
function oneShot(buf: Uint8Array, schemaCount?: number, limits?: DecodeLimits): SofabErrorCode {
  return codeOf(() => decode(buf, boundedFp32(schemaCount), limits));
}

/**
 * The same bytes fed one byte at a time. `feed` signals INVALID by throwing, so a
 * throw is reported as {@link DecodeStatus.Invalid}; otherwise the verdict is
 * whatever `status()` says.
 */
function streamStatus(buf: Uint8Array, schemaCount?: number): DecodeStatus {
  const is = new IStream(boundedFp32(schemaCount));
  try {
    for (const b of buf) is.feed(Uint8Array.of(b));
  } catch (e) {
    if (e instanceof SofabError) return DecodeStatus.Invalid;
    throw e;
  }
  return is.status();
}

describe("fixlen array: the schema count is applied after the element word (§4.8.1)", () => {
  // The count word already exceeds the schema bound (5 > 2) in every row, but the
  // element word has not arrived, so the decoder cannot yet know the field is one
  // it must bound — and `arrayBegin` must not have fired.
  const cutCases: [string, Uint8Array][] = [
    ["cut after its first byte", Uint8Array.of(HDR, 0x05, 0x80)],
    ["a non-minimal element word, cut", Uint8Array.of(HDR, 0x05, 0xa0)],
    ["absent entirely", Uint8Array.of(HDR, 0x05)],
  ];

  it.each(cutCases)("reports INCOMPLETE when the element word is %s", (_name, buf) => {
    expect(oneShot(buf, 2)).toBe(SofabErrorCode.Incomplete);
  });

  it("the streaming path agrees on the same bytes", () => {
    for (const [, buf] of cutCases) {
      expect(streamStatus(buf, 2)).toBe(DecodeStatus.Incomplete);
    }
  });

  it("never announces the array before the element word", () => {
    // The observable form of the rule: no arrayBegin, so nothing downstream can
    // apply a bound it has no business applying yet.
    const seen: string[] = [];
    const spy: Visitor = { arrayBegin: (id, kind, count) => void seen.push(`${id}/${kind}/${count}`) };
    expect(codeOf(() => decode(Uint8Array.of(HDR, 0x05, 0x80), spy))).toBe(
      SofabErrorCode.Incomplete,
    );
    expect(seen).toEqual([]);
  });

  // Controls: nothing above may weaken the bound once the word *has* arrived.
  it("still rejects an over-count array once the element word completes", () => {
    // 0x20 = (4 << 3) | 0 → fp32, 4 bytes/element; count 5 > schema count 2.
    expect(oneShot(Uint8Array.of(HDR, 0x05, 0x20), 2)).toBe(SofabErrorCode.InvalidMsg);
    // …and with the payload present, too.
    const withPayload = Uint8Array.of(HDR, 0x05, 0x20, ...new Uint8Array(20));
    expect(oneShot(withPayload, 2)).toBe(SofabErrorCode.InvalidMsg);
  });

  it("still reports INCOMPLETE for an in-bound count with a truncated word", () => {
    expect(oneShot(Uint8Array.of(HDR, 0x01, 0xa0), 2)).toBe(SofabErrorCode.Incomplete);
  });

  it("still rejects a contradicting element subtype before the schema bound", () => {
    // subtype 2 (string) is not a legal fixlen-array element type; the element
    // word decides, and it decides INVALID whatever the count says.
    expect(oneShot(Uint8Array.of(HDR, 0x05, 0x22), 2)).toBe(SofabErrorCode.InvalidMsg);
  });

  // The *format* ceiling and the *receiver* cap keep firing at the count word,
  // before any allocation — §4.8.1 ("whatever the subtype turns out to be") and
  // §6.2.1. Both are asserted on input truncated inside the element word, which is
  // exactly where the schema bound must no longer fire.
  it("still enforces ARRAY_MAX at the count word", () => {
    // 0x80808080 0x08 → 2^31, one past ARRAY_MAX; element word cut.
    const buf = Uint8Array.of(HDR, 0x80, 0x80, 0x80, 0x80, 0x08, 0x80);
    expect(oneShot(buf, 2)).toBe(SofabErrorCode.InvalidMsg);
  });

  it("still enforces maxArrayCount at the count word (unbounded field)", () => {
    // The receiver cap applies to a schema-UNBOUNDED array (§6.2.1), so this reads
    // without a schema count. It still fires at the count word, before the element
    // word arrives.
    const buf = Uint8Array.of(HDR, 0x05, 0x80);
    expect(oneShot(buf, undefined, { maxArrayCount: 2 })).toBe(SofabErrorCode.LimitExceeded);
    // With a schema bound in play the cap is out of the picture for this field:
    // the count is within the schema bound, so the verdict is decided by the
    // bytes — here the truncated element word, INCOMPLETE.
    expect(oneShot(buf, 8, { maxArrayCount: 8 })).toBe(SofabErrorCode.Incomplete);
  });

  it("holds for an fp64 array as well", () => {
    const cut = Uint8Array.of(HDR, 0x05, 0x80);
    const fp64Bounded: Visitor = {
      arrayBegin(_id, kind, count) {
        if (kind === ArrayKind.Fp64 && count > 2) {
          throw new SofabError(SofabErrorCode.InvalidMsg, "over schema count");
        }
      },
    };
    expect(codeOf(() => decode(cut, fp64Bounded))).toBe(SofabErrorCode.Incomplete);
    // Control: complete fp64 element word, count still over the bound.
    const whole = Uint8Array.of(HDR, 0x05, 0x41); // (8 << 3) | 1 → fp64, 8 bytes
    expect(codeOf(() => decode(whole, fp64Bounded))).toBe(SofabErrorCode.InvalidMsg);
  });
});

/**
 * §4.8.1 **step 3**, made explicit in `CORELIB_PLAN@c837108`: the subtype decides
 * before any schema is consulted, and only `fp32` / `fp64` are fixlen-array
 * subtypes at all.
 *
 * > rejects the field as **`INVALID`** if that subtype is anything other than
 * > `fp32` or `fp64` — a `string` or `blob` subtype, or a reserved one — before
 * > any schema is consulted (§4.8, §5.2.2).
 *
 * §5.2.2's single list now carries the row alongside the reserved-subtype one:
 * "a fixlen **array** whose `fixlen_word` subtype is not `fp32`/`fp64`". It is a
 * *format* violation, so it must not be routed into §7.3's skip — which is the
 * mistake the clause was rewritten to close. Step 4's skip is for a fixed-width
 * subtype that merely contradicts the declared element type (an `fp64` array
 * where the schema said `fp32`), and that case is covered in `skip.test.ts`.
 */
describe("fixlen array: only fp32/fp64 are subtypes at all (§4.8.1 step 3, §5.2.2)", () => {
  const greedy: Visitor = {
    arrayBegin: () => true,
    arrayFp32: () => undefined,
    arrayFp64: () => undefined,
    fixlenBegin: () => undefined,
    string: () => undefined,
    blob: () => undefined,
  };

  /** `count = 2`, then a `fixlen_word` of `(len << 3) | sub`, then the payload. */
  function array(sub: number, len: number, withPayload: boolean): Uint8Array {
    const head = [HDR, 0x02, (len << 3) | sub];
    return Uint8Array.from(withPayload ? [...head, ...new Array<number>(2 * len).fill(0)] : head);
  }

  function streamed(buf: Uint8Array): DecodeStatus {
    const is = new IStream(greedy);
    try {
      for (const b of buf) is.feed(Uint8Array.of(b));
    } catch (e) {
      if (e instanceof SofabError) return DecodeStatus.Invalid;
      throw e;
    }
    return is.status();
  }

  it.each([
    ["string", 2],
    ["blob", 3],
  ])("rejects a %s element word as INVALID, not as a skip", (_name, sub) => {
    // With the payload present, a decoder that skipped instead would report
    // COMPLETE — which is exactly the reading §4.8.1 step 3 forbids.
    expect(codeOf(() => decode(array(sub, 4, true), greedy))).toBe(SofabErrorCode.InvalidMsg);
    expect(streamed(array(sub, 4, true))).toBe(DecodeStatus.Invalid);

    // …and without it, so the verdict cannot be coming from a short payload.
    expect(codeOf(() => decode(array(sub, 4, false), greedy))).toBe(SofabErrorCode.InvalidMsg);
    expect(streamed(array(sub, 4, false))).toBe(DecodeStatus.Invalid);
  });

  it("rejects a reserved element word the same way — the neighbouring §5.2.2 row", () => {
    for (const sub of [4, 5, 6, 7]) {
      expect(codeOf(() => decode(array(sub, 4, true), greedy))).toBe(SofabErrorCode.InvalidMsg);
    }
  });

  it("accepts the two subtypes that exist — the control", () => {
    expect(() => decode(array(0, 4, true), greedy)).not.toThrow();
    expect(() => decode(array(1, 8, true), greedy)).not.toThrow();
    expect(streamed(array(0, 4, true))).toBe(DecodeStatus.Complete);
    expect(streamed(array(1, 8, true))).toBe(DecodeStatus.Complete);
  });
});
