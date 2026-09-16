/**
 * An array element outside its declared width is rejected AT THAT ELEMENT.
 *
 * CORELIB_PLAN §5.2.3 makes INVALID dominate INCOMPLETE: once the bytes seen so
 * far are already malformed, running out of input cannot downgrade the verdict.
 * An element carrying a value wider than the field's declared type is fully
 * established by that element, so truncating the message immediately after it
 * must still be INVALID (generator#267).
 *
 * The declared width is **schema** knowledge, and the corelib never learns a
 * schema (§6.2.1) — so what is tested here is the property the corelib owes the
 * generated layer that does know it: the interval the reader states travels with
 * its destination (`ArrayTarget`), and is compared **at the element**, as the
 * element arrives — before the decoder discovers that the array is truncated. The
 * comparison lives in the codec and the number never does.
 */

import { describe, expect, it } from "vitest";
import {
  ArrayKind,
  Long,
  SofabError,
  SofabErrorCode,
  decode,
  growingOStream,
  type ArrayTarget,
  type Visitor,
} from "../src/index.js";

function arrayBytes(id: number, values: number[], signed: boolean): Uint8Array {
  const os = growingOStream();
  if (signed) os.writeSignedArray(id, values);
  else os.writeUnsignedArray(id, values);
  return os.bytes().slice();
}

/**
 * A generated-layer stand-in: it knows the declared element range and states it
 * with the destination, which is where the comparison then happens.
 *
 * An absent bound is the *widest* one the element kind can carry — "this reader
 * declares no narrower width", not "unbounded", which the hand-off has no
 * spelling for and needs none: an integer element always has a declared width.
 */
function widthChecked(out: (number | bigint)[], min?: number, max?: number): Visitor {
  return {
    arrayBulk: (_id, kind): ArrayTarget => {
      const unsigned = kind === ArrayKind.Unsigned;
      const lo = Long.fromBigInt(min !== undefined ? BigInt(min) : unsigned ? 0n : -(2n ** 63n));
      const hi = Long.fromBigInt(
        max !== undefined ? BigInt(max) : unsigned ? 2n ** 64n - 1n : 2n ** 63n - 1n,
      );
      return {
        values: out,
        minLo: lo.low,
        minHi: lo.high,
        maxLo: hi.low,
        maxHi: hi.high,
      };
    },
  };
}

/** Decode `bytes`, bounding elements to `[min, max]`; returns the elements read. */
function read(
  bytes: Uint8Array,
  min?: number,
  max?: number,
): (number | bigint)[] {
  const out: (number | bigint)[] = [];
  decode(bytes, widthChecked(out, min, max));
  return out;
}

/** The `SofabError` code `fn` throws, or `undefined` if it does not throw. */
function code(fn: () => void): unknown {
  try {
    fn();
  } catch (e) {
    return (e as SofabError).code;
  }
  return undefined;
}

describe("array element width bound", () => {
  it("accepts elements inside the declared width", () => {
    expect(read(arrayBytes(1, [0, 127, 255], false), undefined, 255)).toEqual([0, 127, 255]);
    expect(read(arrayBytes(1, [-128, 0, 127], true), -128, 127)).toEqual([-128, 0, 127]);
  });

  it("rejects an unsigned element above the declared width", () => {
    expect(() => read(arrayBytes(1, [1, 300], false), undefined, 255)).toThrow(SofabError);
  });

  it("rejects a signed element outside the declared width", () => {
    expect(() => read(arrayBytes(1, [1, 300], true), -128, 127)).toThrow(SofabError);
    expect(() => read(arrayBytes(1, [1, -300], true), -128, 127)).toThrow(SofabError);
  });

  it("stays INVALID when the message is truncated right after the bad element", () => {
    // The case the timing is about: cut the array short after the offending
    // element. A decoder that assembled the whole array before handing anything
    // over would raise INCOMPLETE and lose the INVALID verdict §5.2.3 requires.
    const whole = arrayBytes(1, [300, 1], true);
    const cut = whole.subarray(0, whole.length - 1);
    expect(code(() => read(cut, -128, 127))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("leaves an unbounded array alone", () => {
    expect(read(arrayBytes(1, [1, 300], false))).toEqual([1, 300]);
  });

  // corelib-ts#99. The truncation above cuts one byte off, which leaves
  // `count <= remaining`. These cut deeper, to where the declared count is larger
  // than the bytes that remain: the case in which a reader that decided from the
  // count word alone reported INCOMPLETE without examining a single element.
  describe("a count larger than the bytes left still lets the elements decide", () => {
    // id 1, signed array, count 5, one element = zigzag(5208) = 10416, end.
    // Crucible's width_elem_trunc.bin, without its enclosing sequence.
    const overWide = Uint8Array.from([(1 << 3) | 4, 5, 0xb0, 0x51]);
    // The same shape with an in-range element. Nothing is decided yet, so the
    // truncation IS the verdict — the control that makes the case above an
    // ordering fix rather than a blanket reject.
    const inRange = Uint8Array.from([(1 << 3) | 4, 5, 0x02]);

    it("is INVALID when an element already breaches its declared width", () => {
      expect(code(() => read(overWide, -128, 127))).toBe(SofabErrorCode.InvalidMsg);
    });

    it("is INCOMPLETE when every element in hand is in range", () => {
      expect(code(() => read(inRange, -128, 127))).toBe(SofabErrorCode.Incomplete);
    });

    it("is INCOMPLETE when there is no bound to breach", () => {
      expect(code(() => read(overWide))).toBe(SofabErrorCode.Incomplete);
    });

    it("never sizes anything from the count", () => {
      // corelib-ts#38's protection, restated as the property it needs: a declared
      // count of ~16 million against five bytes of input must allocate nothing at
      // all — which is now the general rule (§6.6), not an array special case.
      // 0x80 0x80 0x80 0x08 = 16,777,216 elements. No receiver cap is in play —
      // the codec holds none (§6.2.1) and this visitor states none — so what is
      // on trial is that nothing is *sized* from the count, unaided by a cap.
      const hostile = Uint8Array.from([(1 << 3) | 4, 0x80, 0x80, 0x80, 0x08]);
      let biggest = 0;
      const saved = globalThis.Array;
      const spy = new Proxy(saved, {
        construct(t, a: unknown[]) {
          if (a.length === 1 && typeof a[0] === "number") biggest = Math.max(biggest, a[0]);
          return Reflect.construct(t, a) as unknown[];
        },
      });
      (globalThis as { Array: unknown }).Array = spy;
      let err: unknown;
      try {
        decode(hostile, {});
      } catch (e) {
        err = e;
      } finally {
        (globalThis as { Array: unknown }).Array = saved;
      }
      expect(biggest).toBe(0);
      expect(err).toBeInstanceOf(SofabError);
      expect((err as SofabError).code).toBe(SofabErrorCode.Incomplete);
    });
  });
});
