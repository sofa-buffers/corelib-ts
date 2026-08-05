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
});
