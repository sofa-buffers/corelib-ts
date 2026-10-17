/**
 * The exact-width reuse family ({@link reuseU16} and its nine siblings): the choice
 * a decode into a destination that already holds a message makes at a native
 * array's header (#210).
 *
 * Three rules, and they are the whole surface:
 *
 * - **An exact fit is reused, in place and zeroed.** Identity, not equality — a
 *   copy would defeat the point, and the zero is what keeps a decode that stops
 *   early from reading the previous message's tail as this message's elements.
 * - **Anything else allocates**, including a destination that is *longer* than the
 *   array, for the reason {@link PayloadAcc.takeInto} refuses one: a longer array
 *   would overstate the count. The old destination is left untouched, because a
 *   caller may still be holding it.
 * - **The zero follows the array**: `0n` for the 64-bit pair, `0` elsewhere, which
 *   is the one thing a single shared helper could get wrong per element type.
 *
 * Driven through a table, because ten dull functions are exactly the shape where a
 * copy-paste slip — the wrong constructor, the wrong zero, `>=` for `===` — would
 * otherwise sit in the one width nobody wrote a case for.
 */

import { describe, expect, it } from "vitest";
import {
  reuseFp32,
  reuseFp64,
  reuseI8,
  reuseI16,
  reuseI32,
  reuseI64,
  reuseU8,
  reuseU16,
  reuseU32,
  reuseU64,
} from "../src/index.js";

/** Every destination shape the family covers, as one type for the table below. */
type AnyTyped =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array
  | BigUint64Array
  | BigInt64Array;

/**
 * One row per width. Each helper has its own `T`, so the row type widens them to
 * `AnyTyped` — one cast per row, at the table's edge, and nothing cast below it.
 */
interface Width {
  name: string;
  reuse: (kept: AnyTyped | null, count: number) => AnyTyped;
  Ctor: new (n: number) => AnyTyped;
  /** A value no `reuse` may leave behind, and the zero it must leave instead. */
  seed: number | bigint;
  zero: number | bigint;
}

const widen = (f: unknown): Width["reuse"] => f as Width["reuse"];

const WIDTHS: Width[] = [
  { name: "u8", reuse: widen(reuseU8), Ctor: Uint8Array, seed: 7, zero: 0 },
  { name: "u16", reuse: widen(reuseU16), Ctor: Uint16Array, seed: 4095, zero: 0 },
  { name: "u32", reuse: widen(reuseU32), Ctor: Uint32Array, seed: 0xdeadbeef, zero: 0 },
  { name: "i8", reuse: widen(reuseI8), Ctor: Int8Array, seed: -7, zero: 0 },
  { name: "i16", reuse: widen(reuseI16), Ctor: Int16Array, seed: -4095, zero: 0 },
  { name: "i32", reuse: widen(reuseI32), Ctor: Int32Array, seed: -123456, zero: 0 },
  { name: "fp32", reuse: widen(reuseFp32), Ctor: Float32Array, seed: 1.5, zero: 0 },
  { name: "fp64", reuse: widen(reuseFp64), Ctor: Float64Array, seed: -2.25, zero: 0 },
  { name: "u64", reuse: widen(reuseU64), Ctor: BigUint64Array, seed: 0x9e3779b97f4a7c15n, zero: 0n },
  { name: "i64", reuse: widen(reuseI64), Ctor: BigInt64Array, seed: -0x7f3779b97f4a7c15n, zero: 0n },
];

/** A destination of `n` elements, every one of them the row's `seed`. */
function seeded(w: Width, n: number): AnyTyped {
  const a = new w.Ctor(n);
  (a as { fill: (v: never) => void }).fill(w.seed as never);
  return a;
}

/** A destination's elements, as the plain values an assertion can compare. */
const elems = (a: AnyTyped): (number | bigint)[] => Array.from(a as Iterable<number | bigint>);

describe("the exact-width reuse family", () => {
  it("covers every width the decoder can fill", () => {
    // A width added to the library and not to this table would be untested, and
    // nothing else in the suite would notice.
    expect(WIDTHS.map((w) => w.name)).toStrictEqual([
      "u8", "u16", "u32", "i8", "i16", "i32", "fp32", "fp64", "u64", "i64",
    ]);
  });

  describe.each(WIDTHS.map((w) => [w.name, w] as const))("%s", (name, w) => {
    it("builds a destination of the wire count when there is none", () => {
      const out = w.reuse(null, 4);
      expect(out).toBeInstanceOf(w.Ctor);
      expect(out.length).toBe(4);
      expect(elems(out)).toStrictEqual([w.zero, w.zero, w.zero, w.zero]);
    });

    it("reuses an exact fit in place, zeroed", () => {
      const kept = seeded(w, 3);
      const out = w.reuse(kept, 3);
      // The same object: a receive loop reusing it is the whole point.
      expect(out).toBe(kept);
      expect(elems(out)).toStrictEqual([w.zero, w.zero, w.zero]);
    });

    it("zeroes with the array's own zero", () => {
      // The mistake a single shared helper can make once per element type: `0`
      // into a 64-bit array is a TypeError, and `0n` into a narrow one is too.
      const out = w.reuse(seeded(w, 2), 2);
      const first = elems(out)[0];
      expect(typeof first).toBe(name === "u64" || name === "i64" ? "bigint" : "number");
      expect(first).toStrictEqual(w.zero);
    });

    it("allocates for a shorter destination and leaves it untouched", () => {
      const kept = seeded(w, 2);
      const out = w.reuse(kept, 5);
      expect(out).not.toBe(kept);
      expect(out.length).toBe(5);
      expect(elems(kept)).toStrictEqual([w.seed, w.seed]);
    });

    it("allocates for a LONGER destination too — the fit is exact", () => {
      const kept = seeded(w, 6);
      const out = w.reuse(kept, 4);
      expect(out).not.toBe(kept);
      expect(out.length).toBe(4);
      expect(elems(kept)).toStrictEqual(Array.from({ length: 6 }, () => w.seed));
    });

    it("handles the empty array at both ends of the choice", () => {
      // An array that is empty on the wire: a kept empty one fits, a kept
      // non-empty one does not.
      const empty = seeded(w, 0);
      expect(w.reuse(empty, 0)).toBe(empty);
      const two = seeded(w, 2);
      const out = w.reuse(two, 0);
      expect(out).not.toBe(two);
      expect(out.length).toBe(0);
      // …and a fresh destination for an empty array is built, not refused.
      expect(w.reuse(null, 0).length).toBe(0);
    });
  });
});
