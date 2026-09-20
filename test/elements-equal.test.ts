/**
 * `elementsEqual` — the array half of the ≠-default test (MESSAGE_SPEC §2).
 *
 * What it decides is whether a field is written at all, so an error either way
 * is a wire-visible bug that no vector catches: the vectors say what a *given*
 * message encodes to, not which fields a message with a schema default should
 * have contained. The two directions to pin are therefore both here — equal
 * contents in different objects must compare equal (or a canonical encoder emits
 * a field it should have omitted), and any difference at all must compare unequal
 * (or it silently drops a value).
 */

import { describe, expect, it } from "vitest";
import { Long, elementsEqual, longElementsEqual } from "../src/index.js";

describe("elementsEqual compares contents, not identity", () => {
  it("is true for distinct objects holding the same values", () => {
    expect(elementsEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(elementsEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
  });

  it("compares a typed array against a plain-array default", () => {
    // The real shape of the call: the field holds a Uint8Array, the schema
    // default is an array literal the generator emitted.
    expect(elementsEqual(Uint8Array.of(7, 8), [7, 8])).toBe(true);
    expect(elementsEqual(Uint8Array.of(7, 8), [7, 9])).toBe(false);
  });

  it("is true for two empty arrays of either kind", () => {
    expect(elementsEqual([], [])).toBe(true);
    expect(elementsEqual(new Uint8Array(0), [])).toBe(true);
  });

  it("handles the other element types a leaf array can hold", () => {
    expect(elementsEqual([1n, 2n], [1n, 2n])).toBe(true);
    expect(elementsEqual([1n, 2n], [1n, 3n])).toBe(false);
    expect(elementsEqual([true, false], [true, false])).toBe(true);
    expect(elementsEqual(["a", "b"], ["a", "b"])).toBe(true);
    expect(elementsEqual(["a", "b"], ["a", "c"])).toBe(false);
  });
});

describe("elementsEqual reports every difference", () => {
  it("is false when the lengths differ, whichever is longer", () => {
    expect(elementsEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(elementsEqual([1, 2, 3], [1, 2])).toBe(false);
    expect(elementsEqual([], [0])).toBe(false);
  });

  it("is false for a difference at the first, an interior, or the last index", () => {
    expect(elementsEqual([9, 2, 3], [1, 2, 3])).toBe(false);
    expect(elementsEqual([1, 9, 3], [1, 2, 3])).toBe(false);
    expect(elementsEqual([1, 2, 9], [1, 2, 3])).toBe(false);
  });

  it("does not confuse a number with the bigint of the same value", () => {
    // Both are legal element types for a 64-bit array in this port, and `===`
    // keeps them apart — which is what the scalar test does too.
    expect(elementsEqual([1n], [1])).toBe(false);
  });
});

describe("elementsEqual follows === at the IEEE-754 corners", () => {
  it("reports an array containing NaN as unequal to itself", () => {
    // Not an oversight: `!==` is what the scalar fields use, and it is the only
    // reading under which a NaN element is written rather than omitted as
    // "equal to the default" and lost.
    const a = [Number.NaN];
    expect(elementsEqual(a, [Number.NaN])).toBe(false);
    expect(elementsEqual(a, a)).toBe(false);
    expect(elementsEqual(a, a.slice())).toBe(false);
  });

  it("treats -0 and 0 as equal, exactly as === does", () => {
    expect(elementsEqual([-0], [0])).toBe(true);
  });
});

describe("longElementsEqual compares the 64-bit value, not the Long identity", () => {
  // The defect it exists to prevent: a `Long` is an object, so `elementsEqual`'s
  // `===` reports two arrays holding the same 64-bit values as unequal and the
  // ≠-default test emits a field that should have been omitted. The wire is
  // supposed to be canonical, and no vector catches this — the vectors say what a
  // GIVEN message encodes to, not which fields a defaulted one should carry.
  const one = () => [Long.fromBits(1, 2), Long.fromBits(3, 4)];

  it("is true for distinct Long objects holding the same halves", () => {
    expect(longElementsEqual(one(), one())).toBe(true);
    // …which is exactly the case elementsEqual gets wrong, and why this exists.
    expect(elementsEqual(one(), one())).toBe(false);
  });

  it("is true for the same array, and for two empties", () => {
    const a = one();
    expect(longElementsEqual(a, a)).toBe(true);
    expect(longElementsEqual([], [])).toBe(true);
  });

  it("is false on a different length", () => {
    expect(longElementsEqual(one(), [Long.fromBits(1, 2)])).toBe(false);
    expect(longElementsEqual([], one())).toBe(false);
  });

  it("is false when either half differs", () => {
    expect(longElementsEqual(one(), [Long.fromBits(9, 2), Long.fromBits(3, 4)])).toBe(false);
    expect(longElementsEqual(one(), [Long.fromBits(1, 9), Long.fromBits(3, 4)])).toBe(false);
    expect(longElementsEqual(one(), [Long.fromBits(1, 2), Long.fromBits(3, 9)])).toBe(false);
  });

  it("holds for Long.ZERO against a freshly built zero", () => {
    // The generated shape: a zero default compared against a decoded array that
    // happens to hold zeros. Sharing `Long.ZERO` must not be what makes it equal.
    expect(longElementsEqual([Long.ZERO, Long.ZERO], [Long.fromBits(0, 0), new Long(0, 0)])).toBe(
      true,
    );
  });

  it("normalizes the halves the way Long does — -1 and 0xFFFFFFFF are one value", () => {
    expect(longElementsEqual([Long.fromBits(-1, -1)], [Long.fromBits(0xffffffff, 0xffffffff)])).toBe(
      true,
    );
  });
});
