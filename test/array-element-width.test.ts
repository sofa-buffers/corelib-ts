/**
 * An array element outside its declared width is rejected AT THAT ELEMENT.
 *
 * CORELIB_PLAN §5.2 makes INVALID dominate INCOMPLETE: once the bytes seen so
 * far are already malformed, running out of input cannot downgrade the verdict.
 * An element carrying a value wider than the field's declared type is fully
 * established by that element, so truncating the message immediately after it
 * must still be INVALID — which only holds if the bound is applied during the
 * read rather than to the assembled array (generator#267).
 */

import { describe, expect, it } from "vitest";
import { Cursor, OStream, SofabError, SofabErrorCode } from "../src/index.js";

function arrayBytes(id: number, values: number[], signed: boolean): Uint8Array {
  const os = new OStream();
  if (signed) os.writeSignedArray(id, values);
  else os.writeUnsignedArray(id, values);
  return os.bytes().slice();
}

function read(bytes: Uint8Array, signed: boolean, count?: number, min?: number, max?: number) {
  const c = new Cursor(bytes);
  c.readHeader();
  return signed ? c.readSignedArray(count, min, max) : c.readUnsignedArray(count, max);
}

describe("array element width bound", () => {
  it("accepts elements inside the declared width", () => {
    expect(read(arrayBytes(1, [0, 127, 255], false), false, 5, undefined, 255)).toEqual([0, 127, 255]);
    expect(read(arrayBytes(1, [-128, 0, 127], true), true, 5, -128, 127)).toEqual([-128, 0, 127]);
  });

  it("rejects an unsigned element above the declared width", () => {
    expect(() => read(arrayBytes(1, [1, 300], false), false, 5, undefined, 255))
      .toThrow(SofabError);
  });

  it("rejects a signed element outside the declared width", () => {
    expect(() => read(arrayBytes(1, [1, 300], true), true, 5, -128, 127)).toThrow(SofabError);
    expect(() => read(arrayBytes(1, [1, -300], true), true, 5, -128, 127)).toThrow(SofabError);
  });

  it("stays INVALID when the message is truncated right after the bad element", () => {
    // The case the timing is about: cut the array short after the offending
    // element. Reading the whole array first would raise INCOMPLETE and lose the
    // INVALID verdict §5.2 requires.
    const whole = arrayBytes(1, [300, 1], true);
    const cut = whole.subarray(0, whole.length - 1);
    let code: unknown;
    try {
      read(cut, true, 5, -128, 127);
    } catch (e) {
      code = (e as SofabError).code;
    }
    expect(code).toBe(SofabErrorCode.InvalidMsg);
  });

  it("leaves an unbounded array alone", () => {
    expect(read(arrayBytes(1, [1, 300], false), false)).toEqual([1, 300]);
  });

  // corelib-ts#99. The truncation above cuts one byte off, which leaves
  // `count <= remaining` — so it never reached the guard that used to decide the
  // outcome from the count word alone. These cut deeper, to where the declared
  // count is larger than the bytes that remain: exactly the case in which the
  // reader used to report INCOMPLETE without examining a single element.
  describe("a count larger than the bytes left still lets the elements decide", () => {
    // id 1, signed array, count 5, one element = zigzag(5208) = 10416, end.
    // Crucible's width_elem_trunc.bin, without its enclosing sequence.
    const overWide = Uint8Array.from([(1 << 3) | 4, 5, 0xb0, 0x51]);
    // The same shape with an in-range element. Nothing is decided yet, so the
    // truncation IS the verdict — the control that makes the case above an
    // ordering fix rather than a blanket reject.
    const inRange = Uint8Array.from([(1 << 3) | 4, 5, 0x02]);

    function code(bytes: Uint8Array): unknown {
      try {
        read(bytes, true, 5, -128, 127);
      } catch (e) {
        return (e as SofabError).code;
      }
      return undefined;
    }

    it("is INVALID when an element already breaches its declared width", () => {
      expect(code(overWide)).toBe(SofabErrorCode.InvalidMsg);
    });

    it("is INCOMPLETE when every element in hand is in range", () => {
      expect(code(inRange)).toBe(SofabErrorCode.Incomplete);
    });

    it("is INCOMPLETE when there is no bound to breach", () => {
      const c = new Cursor(overWide);
      c.readHeader();
      let got: unknown;
      try {
        c.readSignedArray();
      } catch (e) {
        got = (e as SofabError).code;
      }
      expect(got).toBe(SofabErrorCode.Incomplete);
    });

    it("still never sizes the destination from the count", () => {
      // corelib-ts#38's protection, restated as the property it needs rather
      // than as the rejection it was implemented as: a declared count of ~16
      // million against five bytes of input must not allocate 16 million slots.
      // Dropping the guard without capping the allocation would.
      const hostile = Uint8Array.from([(1 << 3) | 4, 0x80, 0x80, 0x80, 0x08]);
      const c = new Cursor(hostile);
      c.readHeader();
      let biggest = 0;
      const saved = globalThis.Array;
      const spy = new Proxy(saved, {
        construct(t, a: unknown[]) {
          if (a.length === 1 && typeof a[0] === "number") biggest = Math.max(biggest, a[0]);
          return Reflect.construct(t, a) as unknown[];
        },
      });
      let err: unknown;
      (globalThis as { Array: unknown }).Array = spy;
      try {
        c.readSignedArray();
      } catch (e) {
        err = e;
      } finally {
        (globalThis as { Array: unknown }).Array = saved;
      }
      expect(biggest).toBeLessThanOrEqual(hostile.length);
      expect(err).toBeInstanceOf(SofabError);
      expect((err as SofabError).code).toBe(SofabErrorCode.Incomplete);
    });
  });
});
