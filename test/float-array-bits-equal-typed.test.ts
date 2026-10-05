/**
 * `fp32ArrayBitsEqual` / `fp64ArrayBitsEqual` — the typed-array entry points of
 * the float ≠-default test. Same rule as `floatArrayBitsEqual`: same length and
 * the same IEEE-754 bits at every index. Each is checked against a plain
 * reference on the container it is made for, and against the general function.
 */

import { describe, expect, it } from "vitest";
import { floatArrayBitsEqual, fp32ArrayBitsEqual, fp64ArrayBitsEqual } from "../src/index.js";

type Typed = Float32Array | Float64Array;

/** A NaN given by its sign and payload bits, written to the array as raw words. */
interface NaNBits {
  readonly sign: 0 | 1;
  readonly payload: number;
}

interface Impl {
  readonly name: string;
  readonly make: (v: ArrayLike<number>) => Typed;
  /** Like `make`, but a {@link NaNBits} element is stored bit for bit. */
  readonly makeBits: (v: ArrayLike<number | NaNBits>) => Typed;
  readonly eq: (a: never, b: never) => boolean;
}

// A NaN written through a number goes through a double register, and whether its
// sign and payload survive the trip depends on the engine's tier; a NaN case
// therefore stores the words directly.
const LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function bits32(v: ArrayLike<number | NaNBits>): Float32Array {
  const f = new Float32Array(v.length);
  const dv = new DataView(f.buffer);
  for (let i = 0; i < v.length; i++) {
    const e = v[i]!;
    if (typeof e === "number") f[i] = e;
    else dv.setUint32(4 * i, ((e.sign << 31) | 0x7fc00000 | e.payload) >>> 0, LE);
  }
  return f;
}

function bits64(v: ArrayLike<number | NaNBits>): Float64Array {
  const f = new Float64Array(v.length);
  const dv = new DataView(f.buffer);
  // The high word sits at the far end of a little-endian double and at the near
  // end of a big-endian one, so the offsets follow the host.
  const hi = LE ? 4 : 0;
  const lo = LE ? 0 : 4;
  for (let i = 0; i < v.length; i++) {
    const e = v[i]!;
    if (typeof e === "number") f[i] = e;
    else {
      dv.setUint32(8 * i + hi, ((e.sign << 31) | 0x7ff80000) >>> 0, LE);
      dv.setUint32(8 * i + lo, e.payload, LE);
    }
  }
  return f;
}

const impls: Impl[] = [
  { name: "fp32ArrayBitsEqual", make: (v) => Float32Array.from(v), makeBits: bits32, eq: fp32ArrayBitsEqual as Impl["eq"] },
  { name: "fp64ArrayBitsEqual", make: (v) => Float64Array.from(v), makeBits: bits64, eq: fp64ArrayBitsEqual as Impl["eq"] },
];

/** The raw bytes of every element, in the container's own width. */
function bytesOf(a: Typed): string {
  return Array.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).join(",");
}

/** The plain reference: length, then every byte of every element. */
function reference(a: Typed, b: Typed): boolean {
  return a.length === b.length && bytesOf(a) === bytesOf(b);
}

describe.each(impls)("$name", ({ make, makeBits, eq }) => {
  const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => (eq as (x: Typed, y: Typed) => boolean)(make(a), make(b));

  it("empty arrays and one element", () => {
    expect(same([], [])).toBe(true);
    expect(same([1.5], [1.5])).toBe(true);
    expect(same([1.5], [2.5])).toBe(false);
  });

  it("an array against itself and against a copy", () => {
    const a = make([0, 1.5, -2.25]);
    const e = eq as (x: Typed, y: Typed) => boolean;
    expect(e(a, a)).toBe(true);
    expect(e(a, a.slice())).toBe(true);
  });

  it("a length mismatch is unequal in both directions, even over a shared prefix", () => {
    expect(same([1, 2], [1, 2, 3])).toBe(false);
    expect(same([1, 2, 3], [1, 2])).toBe(false);
    expect(same([], [0])).toBe(false);
    expect(same([0], [])).toBe(false);
  });

  it("-0 differs from +0 at the first, a middle and the last index", () => {
    for (const i of [0, 1, 2]) {
      const a = [0, 1.5, 3];
      const b = a.slice();
      b[i] = -0;
      expect(same(a, b)).toBe(false);
      expect(same(b, a)).toBe(false);
      expect(same(b, b)).toBe(true);
    }
    expect(same([-0, 1.5], [0, 1.5])).toBe(false);
    expect(same([-0, 1.5], [-0, 1.5])).toBe(true);
    expect(same([0, 0], [0, 0])).toBe(true);
  });

  it("NaN equals itself only for identical bits", () => {
    const e = eq as (x: Typed, y: Typed) => boolean;
    const q: NaNBits = { sign: 0, payload: 0 };
    const neg: NaNBits = { sign: 1, payload: 0 };
    const pay: NaNBits = { sign: 0, payload: 1 };
    expect(e(makeBits([q]), makeBits([q]))).toBe(true);
    expect(e(makeBits([q, 1]), makeBits([q, 1]))).toBe(true);
    expect(e(makeBits([pay]), makeBits([pay]))).toBe(true);
    expect(e(makeBits([neg]), makeBits([neg]))).toBe(true);
    expect(e(makeBits([q]), makeBits([neg]))).toBe(false);
    expect(e(makeBits([q]), makeBits([pay]))).toBe(false);
    expect(e(makeBits([pay]), makeBits([q]))).toBe(false);
    expect(e(makeBits([1, q]), makeBits([1, pay]))).toBe(false);
    expect(same([NaN, 1], [NaN, 1])).toBe(true);
    expect(e(makeBits([q]), make([1]))).toBe(false);
    expect(e(make([1]), makeBits([q]))).toBe(false);
    expect(e(makeBits([q]), make([Infinity]))).toBe(false);
    expect(e(makeBits([1, q]), make([1, 2]))).toBe(false);
  });

  it("infinities and subnormals", () => {
    expect(same([Infinity, -Infinity], [Infinity, -Infinity])).toBe(true);
    expect(same([Infinity], [-Infinity])).toBe(false);
    expect(same([1e-45], [1e-45])).toBe(true);
    expect(same([1e-45], [3e-45])).toBe(false);
    expect(same([1e-45], [-1e-45])).toBe(false);
  });

  it("long arrays: exactly one difference at the start, middle and end", () => {
    for (const n of [65, 130, 4096]) {
      for (const i of [0, n >> 1, n - 1]) {
        for (const other of [-1.25, 1.5, NaN]) {
          const a = make(new Array<number>(n).fill(1.25));
          const b = make(new Array<number>(n).fill(1.25));
          const e = eq as (x: Typed, y: Typed) => boolean;
          expect(e(a, b)).toBe(true);
          b[i] = other;
          expect(e(a, b)).toBe(false);
        }
        const z = make(new Array<number>(n).fill(1.25));
        const nz = make(new Array<number>(n).fill(1.25));
        z[i] = 0;
        nz[i] = -0;
        expect((eq as (x: Typed, y: Typed) => boolean)(z, nz)).toBe(false);
      }
    }
  });

  it("agrees with a plain bit loop and with floatArrayBitsEqual on pseudo-random inputs", () => {
    let s = 0x2545f491;
    const next = (): number => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return s >>> 0;
    };
    const pool = [0, -0, 1.5, -1.5, Infinity, -Infinity, NaN, 1e-45];
    let equal = 0;
    for (let t = 0; t < 3000; t++) {
      const n = next() % 70;
      const a: number[] = [];
      for (let i = 0; i < n; i++) a.push(pool[next() % pool.length]!);
      const b = a.slice();
      if (next() % 3 !== 0 && n > 0) b[next() % n] = pool[next() % pool.length]!;
      if (next() % 11 === 0) b.push(0);
      const ta = make(a);
      const tb = make(b);
      const want = reference(ta, tb);
      if (want) equal++;
      expect((eq as (x: Typed, y: Typed) => boolean)(ta, tb)).toBe(want);
      expect(floatArrayBitsEqual(ta, tb)).toBe(want);
    }
    expect(equal).toBeGreaterThan(100);
  });
});
