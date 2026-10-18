/**
 * {@link BulkMode}: a target that **states** which destination it sets, so the
 * decoder stops working that out for every array of every message (#214).
 *
 * Three things have to hold, and they are what this file is:
 *
 * - **Stating the mode changes nothing about the decode.** Every destination shape
 *   is filled here twice from the same bytes — once with the mode and once
 *   without — and the two results are compared. That is the whole correctness
 *   claim: the fast path is a shortcut through the *checks*, not a second fill.
 * - **The length is still compared.** It is the one question about this array
 *   rather than about the schema, so it survives the shortcut, for every
 *   destination that has a length at all.
 * - **A stated field that is not set is an `ARGUMENT` refusal**, not a `TypeError`
 *   somewhere inside a fill loop. The destination is read either way, so this is
 *   the one wrong statement the decoder catches for free.
 *
 * And one thing that deliberately does *not* hold: a tagged target is **not**
 * checked for the other destinations being absent. The last case pins that, so the
 * trade-off this feature is sits in the suite rather than only in a doc comment.
 */

import { describe, expect, it } from "vitest";
import {
  BulkMode,
  Long,
  OStream,
  SofabErrorCode,
  decode,
  type ArrayTarget,
  type Visitor,
} from "../src/index.js";

const U16 = { minLo: 0, minHi: 0, maxLo: 0xffff, maxHi: 0 };
const U64 = { minLo: 0, minHi: 0, maxLo: 0xffffffff, maxHi: 0xffffffff };
const I32 = { minLo: 0x80000000, minHi: 0xffffffff, maxLo: 0x7fffffff, maxHi: 0 };

const UVALS = [11, 22, 33, 44, 55];
const SVALS = [-11, 22, -33, 44, -55];
const FVALS = [1.5, -2.5, 3.5, -4.5, 5.5];
/** Past 2^32, so the wide arm is the only correct one for it. */
const BIG = [1n, 0x1_0000_0001n, 0xffff_ffff_ffffn];

function wire(write: (os: OStream) => void): Uint8Array {
  const os = new OStream(new Uint8Array(256));
  write(os);
  return os.bytes().slice();
}
const handing = (t: ArrayTarget): Visitor => ({ arrayBulk: () => t });

/** Decode `bytes` into a freshly built target, with and without its mode. */
function both<T>(bytes: Uint8Array, make: () => { target: ArrayTarget; read: () => T }): [T, T] {
  const tagged = make();
  const plain = make();
  delete (plain.target as { mode?: BulkMode }).mode;
  decode(bytes, handing(tagged.target));
  decode(bytes, handing(plain.target));
  return [tagged.read(), plain.read()];
}

describe("a target that states its destination (BulkMode, #214)", () => {
  it("fills `values` exactly as an untagged target does", () => {
    const [a, b] = both(
      wire((os) => os.writeUnsignedArray(1, UVALS)),
      () => {
        const values: (number | bigint)[] = [];
        return { target: { mode: BulkMode.Values, values, ...U16 }, read: () => values };
      },
    );
    expect(a).toStrictEqual(UVALS);
    expect(a).toStrictEqual(b);
  });

  it("keeps the wide arm for a bound that reaches the high half", () => {
    // The mode names the field, not the fill: `Values` with a 64-bit bound must
    // still join both halves, or every element past 2^32 would be refused.
    const [a, b] = both(
      wire((os) => os.writeUnsignedArray(1, BIG)),
      () => {
        const values: (number | bigint)[] = [];
        return { target: { mode: BulkMode.Values, values, ...U64 }, read: () => values };
      },
    );
    expect(a).toStrictEqual([1, 0x1_0000_0001, 0xffff_ffff_ffff]);
    expect(a).toStrictEqual(b);
  });

  it("fills an exact-width `typed` destination exactly as an untagged target does", () => {
    const [a, b] = both(
      wire((os) => os.writeUnsignedArray(1, UVALS)),
      () => {
        const typed = new Uint16Array(5);
        return { target: { mode: BulkMode.Typed, typed, ...U16 }, read: () => [...typed] };
      },
    );
    expect(a).toStrictEqual(UVALS);
    expect(a).toStrictEqual(b);
  });

  it("picks the halves-filled store for a 64-bit `typed` destination", () => {
    // Eight bytes an element, so the fill goes through the `Uint32Array` view —
    // the one refinement `statedMode` makes from the destination itself.
    const [a, b] = both(
      wire((os) => os.writeUnsignedArray(1, BIG)),
      () => {
        const typed = new BigUint64Array(3);
        return { target: { mode: BulkMode.Typed, typed, ...U64 }, read: () => [...typed] };
      },
    );
    expect(a).toStrictEqual(BIG);
    expect(a).toStrictEqual(b);
  });

  it("fills a signed array's `typed` destination exactly as an untagged target does", () => {
    const [a, b] = both(
      wire((os) => os.writeSignedArray(1, SVALS)),
      () => {
        const typed = new Int32Array(5);
        return { target: { mode: BulkMode.Typed, typed, ...I32 }, read: () => [...typed] };
      },
    );
    expect(a).toStrictEqual(SVALS);
    expect(a).toStrictEqual(b);
  });

  it("fills `longs`, `lo`/`hi` and `bool` exactly as an untagged target does", () => {
    const [la, lb] = both(
      wire((os) => os.writeUnsignedArray(1, UVALS)),
      () => {
        const longs: Long[] = [];
        return {
          target: { mode: BulkMode.Longs, longs, ...U64 },
          read: () => longs.map((l) => l.low),
        };
      },
    );
    expect(la).toStrictEqual(UVALS);
    expect(la).toStrictEqual(lb);

    const [ha, hb] = both(
      wire((os) => os.writeUnsignedArray(1, UVALS)),
      () => {
        const lo = new Uint32Array(5);
        const hi = new Uint32Array(5);
        return { target: { mode: BulkMode.Halves, lo, hi, ...U64 }, read: () => [...lo, ...hi] };
      },
    );
    expect(ha.slice(0, 5)).toStrictEqual(UVALS);
    expect(ha).toStrictEqual(hb);

    const [ba, bb] = both(
      wire((os) => os.writeUnsignedArray(1, [1, 0, 7, 0, 9])),
      () => {
        const bool = new Uint8Array(5);
        return { target: { mode: BulkMode.Bool, bool }, read: () => [...bool] };
      },
    );
    expect(ba).toStrictEqual([1, 0, 1, 0, 1]);
    expect(ba).toStrictEqual(bb);
  });

  it("fills the three float destinations exactly as an untagged target does", () => {
    const [a, b] = both(
      wire((os) => os.writeFp32Array(1, FVALS)),
      () => {
        const f32 = new Float32Array(5);
        return { target: { mode: BulkMode.F32, f32 }, read: () => [...f32] };
      },
    );
    expect(a).toStrictEqual(FVALS);
    expect(a).toStrictEqual(b);

    const [ra, rb] = both(
      wire((os) => os.writeFp32Array(1, FVALS)),
      () => {
        const bits = new Uint32Array(5);
        return { target: { mode: BulkMode.F32Bits, bits }, read: () => [...bits] };
      },
    );
    expect(ra[0]).toBe(0x3fc0_0000); // 1.5
    expect(ra).toStrictEqual(rb);

    const [da, db] = both(
      wire((os) => os.writeFp64Array(1, FVALS)),
      () => {
        const f64 = new Float64Array(5);
        return { target: { mode: BulkMode.F64, f64 }, read: () => [...f64] };
      },
    );
    expect(da).toStrictEqual(FVALS);
    expect(da).toStrictEqual(db);
  });

  describe("what the shortcut still refuses", () => {
    const bytes = wire((os) => os.writeUnsignedArray(1, UVALS));
    const argument = expect.objectContaining({ code: SofabErrorCode.Argument });

    it("a destination too short for the element count", () => {
      for (const target of [
        { mode: BulkMode.Typed, typed: new Uint16Array(4), ...U16 },
        { mode: BulkMode.Typed, typed: new BigUint64Array(4), ...U64 },
        { mode: BulkMode.Halves, lo: new Uint32Array(4), hi: new Uint32Array(5), ...U64 },
        { mode: BulkMode.Halves, lo: new Uint32Array(5), hi: new Uint32Array(4), ...U64 },
        { mode: BulkMode.Bool, bool: new Uint8Array(4) },
      ] satisfies ArrayTarget[]) {
        expect(() => decode(bytes, handing(target)), JSON.stringify(target.mode)).toThrow(argument);
      }
      expect(() =>
        decode(wire((os) => os.writeFp32Array(1, FVALS)), {
          arrayBulk: () => ({ mode: BulkMode.F32, f32: new Float32Array(4) }),
        }),
      ).toThrow(argument);
    });

    it("a stated destination the target does not set", () => {
      // Not a TypeError inside the fill: the destination is read to compare its
      // length, so an absent one is caught there and refused as what it is.
      for (const mode of [
        BulkMode.Typed,
        BulkMode.Values,
        BulkMode.Longs,
        BulkMode.Halves,
        BulkMode.Bool,
        BulkMode.F32,
        BulkMode.F64,
        BulkMode.F32Bits,
      ]) {
        expect(() => decode(bytes, handing({ mode, ...U16 } as ArrayTarget)), String(mode)).toThrow(
          argument,
        );
      }
    });

    it("a mode that is not one of the eight", () => {
      expect(() =>
        decode(bytes, handing({ mode: 42, typed: new Uint16Array(5), ...U16 } as unknown as ArrayTarget)),
      ).toThrow(argument);
    });
  });

  it("does NOT check that the other destinations are absent — the trade-off, pinned", () => {
    // An untagged target carrying two destinations is a caller mistake and is
    // refused. A tagged one is taken at its word: the stated field is filled and
    // the stray one is left alone. This is the whole of what stating a mode gives
    // up, and it is why a visitor that is not sure leaves the mode out.
    const typed = new Uint16Array(5);
    const stray: (number | bigint)[] = [1, 2, 3];
    const bytes = wire((os) => os.writeUnsignedArray(1, UVALS));

    expect(() => decode(bytes, handing({ typed, values: stray, ...U16 }))).toThrow(
      expect.objectContaining({ code: SofabErrorCode.Argument }),
    );

    decode(bytes, handing({ mode: BulkMode.Typed, typed, values: stray, ...U16 }));
    expect([...typed]).toStrictEqual(UVALS);
    expect(stray).toStrictEqual([1, 2, 3]);
  });
});
