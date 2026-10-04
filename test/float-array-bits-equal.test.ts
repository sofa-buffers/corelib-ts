/**
 * `floatArrayBitsEqual` — the float form of the array ≠-default test
 * (MESSAGE_SPEC §2, CORELIB_PLAN §4.6): equality of IEEE-754 bit patterns, not
 * of IEEE values. `elementsEqual` calls `-0` and `+0` equal, so a `[-0, 1.5]`
 * field would be dropped as the default `[0, 1.5]`.
 */

import { describe, expect, it } from "vitest";
import { elementsEqual, floatArrayBitsEqual } from "../src/index.js";

/** A double with the given high/low words (so a NaN payload can be chosen). */
function dbl(hi: number, lo: number): number {
  const f = new Float64Array(1);
  const u = new Uint32Array(f.buffer);
  u[0] = lo;
  u[1] = hi;
  return f[0]!;
}

function bits(v: number): [number, number] {
  const f = new Float64Array([v]);
  const u = new Uint32Array(f.buffer);
  return [u[0]!, u[1]!];
}

/** The plain reference: length, then both words of every element. */
function reference(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const [al, ah] = bits(a[i]!);
    const [bl, bh] = bits(b[i]!);
    if (al !== bl || ah !== bh) return false;
  }
  return true;
}

const NaN_A = dbl(0x7ff80000, 0);
const NaN_PAYLOAD = dbl(0x7ff80000, 1);
const NaN_NEG = dbl(0xfff80000, 0);
const NaN_SIGNALING = dbl(0x7ff00000, 1);

describe("floatArrayBitsEqual", () => {
  it("empty arrays are equal; one element", () => {
    expect(floatArrayBitsEqual([], [])).toBe(true);
    expect(floatArrayBitsEqual(new Float32Array(0), [])).toBe(true);
    expect(floatArrayBitsEqual([1.5], [1.5])).toBe(true);
    expect(floatArrayBitsEqual([1.5], [2.5])).toBe(false);
  });

  it("equal arrays, plain and typed, against itself and a copy", () => {
    const a = [0, 1.5, -2.25];
    expect(floatArrayBitsEqual(a, a)).toBe(true);
    expect(floatArrayBitsEqual(a, a.slice())).toBe(true);
    expect(floatArrayBitsEqual(Float64Array.from(a), a)).toBe(true);
    expect(floatArrayBitsEqual(Float32Array.from(a), Float32Array.from(a))).toBe(true);
  });

  it("-0 differs from +0 at the first, a middle and the last index", () => {
    for (const i of [0, 1, 2]) {
      const a = [0, 1.5, 3];
      const b = a.slice();
      b[i] = -0;
      a[i] = 0;
      expect(floatArrayBitsEqual(a, b)).toBe(false);
      expect(floatArrayBitsEqual(b, a)).toBe(false);
    }
    expect(floatArrayBitsEqual([-0, 1.5], [0, 1.5])).toBe(false);
    expect(floatArrayBitsEqual([-0, 1.5], [-0, 1.5])).toBe(true);
    expect(floatArrayBitsEqual(Float32Array.of(-0, 1.5), Float32Array.of(0, 1.5))).toBe(false);
  });

  it("the old IEEE comparison is what this replaces", () => {
    expect(elementsEqual([-0, 1.5], [0, 1.5])).toBe(true);
    expect(floatArrayBitsEqual([-0, 1.5], [0, 1.5])).toBe(false);
  });

  it("NaN equals itself only for identical bits", () => {
    // Payload cases go through Float64Array: a plain number[] may canonicalise
    // a NaN on store (V8 does, to keep the hole pattern free), which is a limit
    // of the container, not of the comparison.
    const f = (...v: number[]): Float64Array => Float64Array.from(v);
    expect(floatArrayBitsEqual(f(NaN_A), f(NaN_A))).toBe(true);
    expect(floatArrayBitsEqual(f(NaN_A, 1), f(dbl(0x7ff80000, 0), 1))).toBe(true);
    expect(floatArrayBitsEqual(f(NaN_A), f(NaN_PAYLOAD))).toBe(false);
    expect(floatArrayBitsEqual(f(NaN_A), f(NaN_NEG))).toBe(false);
    expect(floatArrayBitsEqual(f(NaN_PAYLOAD), f(NaN_PAYLOAD))).toBe(true);
    expect(floatArrayBitsEqual(f(NaN_SIGNALING), f(NaN_SIGNALING))).toBe(true);
    // The same NaN in a plain array, whatever its bits, equals itself.
    expect(floatArrayBitsEqual([NaN], [NaN])).toBe(true);
    // A NaN against a non-NaN, in both positions.
    expect(floatArrayBitsEqual([NaN_A], [1])).toBe(false);
    expect(floatArrayBitsEqual([1], [NaN_A])).toBe(false);
    expect(floatArrayBitsEqual([NaN_A], [Infinity])).toBe(false);
  });

  it("infinities, subnormals and extremes", () => {
    expect(floatArrayBitsEqual([Infinity, -Infinity], [Infinity, -Infinity])).toBe(true);
    expect(floatArrayBitsEqual([Infinity], [-Infinity])).toBe(false);
    expect(floatArrayBitsEqual([Number.MIN_VALUE], [Number.MIN_VALUE])).toBe(true);
    expect(floatArrayBitsEqual([Number.MIN_VALUE], [2 * Number.MIN_VALUE])).toBe(false);
    expect(floatArrayBitsEqual([Number.MIN_VALUE], [-Number.MIN_VALUE])).toBe(false);
    const f32sub = Math.fround(1e-45);
    expect(floatArrayBitsEqual([f32sub], [f32sub])).toBe(true);
    expect(floatArrayBitsEqual(Float32Array.of(1e-45), Float32Array.of(3e-45))).toBe(false);
    expect(floatArrayBitsEqual([Number.MAX_VALUE], [Number.MAX_VALUE])).toBe(true);
  });

  it("a length mismatch is unequal in both directions, even over a shared prefix", () => {
    expect(floatArrayBitsEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(floatArrayBitsEqual([1, 2, 3], [1, 2])).toBe(false);
    expect(floatArrayBitsEqual([], [0])).toBe(false);
    expect(floatArrayBitsEqual([0], [])).toBe(false);
  });

  it("long arrays: exactly one difference at the start, middle and end", () => {
    for (const make of [
      (n: number) => new Array<number>(n).fill(1.25),
      (n: number) => new Float64Array(n).fill(1.25),
      (n: number) => new Float32Array(n).fill(1.25),
    ]) {
      for (const n of [65, 130, 4096]) {
        for (const i of [0, n >> 1, n - 1]) {
          for (const other of [-1.25, 1.5, NaN]) {
            const a = make(n);
            const b = make(n);
            expect(floatArrayBitsEqual(a, b)).toBe(true);
            b[i] = other;
            expect(floatArrayBitsEqual(a, b)).toBe(false);
          }
          const z = make(n);
          const nz = make(n);
          z[i] = 0;
          nz[i] = -0;
          expect(floatArrayBitsEqual(z, nz)).toBe(false);
        }
      }
    }
  });

  it("agrees with a plain bit loop on pseudo-random inputs", () => {
    let s = 0x2545f491;
    const next = (): number => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return s >>> 0;
    };
    const pool = [0, -0, 1.5, -1.5, Infinity, -Infinity, NaN, Number.MIN_VALUE];
    let equal = 0;
    for (let t = 0; t < 3000; t++) {
      const n = next() % 70;
      const a: number[] = [];
      for (let i = 0; i < n; i++) a.push(pool[next() % pool.length]!);
      const b = a.slice();
      if (next() % 3 !== 0 && n > 0) b[next() % n] = pool[next() % pool.length]!;
      if (next() % 11 === 0) b.push(0);
      const want = reference(a, b);
      if (want) equal++;
      expect(floatArrayBitsEqual(a, b)).toBe(want);
    }
    expect(equal).toBeGreaterThan(100);
  });
});
