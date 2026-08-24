/**
 * The bulk destination hand-off: {@link Visitor.arrayBulk}.
 *
 * A flat visitor pays its per-callback routing *per element*, which for an array
 * is the whole cost of decoding it. `arrayBulk` hands the destination over once
 * instead and the decoder fills it directly, with no element callback at all.
 *
 * Four properties are tested here, and each of them is a way the fill could be
 * wrong while still producing the right values on a happy path:
 *
 * - it is **additive** — a visitor that does not implement it, or declines a
 *   given array, decodes exactly as before;
 * - the destination's declared width is **applied as the fill runs** (§7.1), so a
 *   truncation behind an out-of-range element cannot downgrade the verdict
 *   (§5.2.3) — the property the per-element path already owed;
 * - a chunk boundary **anywhere** inside the fill is invisible, including one
 *   that lands mid-varint, where the resumable single-element path takes over
 *   from the bulk drain and has to reach the same destination;
 * - the decoder **drops** the destination at the end of the array, so a pooled
 *   machine keeps nothing of the caller's alive (§6.6) and the next array cannot
 *   inherit a destination its own `arrayBulk` declined.
 */

import { describe, expect, it } from "vitest";
import { BULK_MIN } from "../src/constants.js";
import {
  ArrayKind,
  IStream,
  SofabError,
  SofabErrorCode,
  decode,
  growingOStream,
  type ArrayTarget,
  type Visitor,
} from "../src/index.js";

function wire(build: (os: ReturnType<typeof growingOStream>) => void): Uint8Array {
  const os = growingOStream();
  build(os);
  return os.bytes().slice();
}

/** A generated-layer stand-in: one reused target, re-pointed per array. */
class Bulk implements Visitor {
  readonly got = new Map<number, number[]>();
  readonly viaElement: number[] = [];
  private readonly t: ArrayTarget = { out: [], min: 0, max: 0 };

  constructor(
    private readonly accept: (id: number) => { min: number; max: number } | null,
  ) {}

  arrayBulk(id: number, _kind: ArrayKind, _count: number): ArrayTarget | null {
    const w = this.accept(id);
    if (w === null) return null;
    const out: number[] = [];
    this.got.set(id, out);
    this.t.out = out;
    this.t.min = w.min;
    this.t.max = w.max;
    return this.t;
  }
  // Present so a DECLINED array still lands somewhere observable — the point of
  // the additive claim is that this path is untouched.
  arrayUnsigned(_id: number, i: number, v: number | bigint): void {
    this.viaElement[i] = Number(v);
  }
  arraySigned(_id: number, i: number, v: number | bigint): void {
    this.viaElement[i] = Number(v);
  }
}

const U32 = { min: 0, max: 0xffff_ffff };
const I16 = { min: -32768, max: 32767 };

/**
 * Pad a value list past {@link BULK_MIN}, so the decoder actually offers.
 *
 * The threshold is not incidental to these tests — below it there is no
 * hand-off to test, by design (see BULK_MIN), and its own behaviour is pinned
 * separately at the bottom of this file.
 */
function long_(vals: number[], fill = 0): number[] {
  const out = vals.slice();
  while (out.length < BULK_MIN + 4) out.push(fill);
  return out;
}

describe("Visitor.arrayBulk", () => {
  it("fills the destination and fires no element callback", () => {
    const vals = long_([0, 1, 127, 128, 300, 0xffff_ffff]);
    const v = new Bulk(() => U32);
    decode(wire((os) => os.writeUnsignedArray(3, vals)), v);
    expect(v.got.get(3)).toEqual(vals);
    expect(v.viaElement).toEqual([]);
  });

  it("undoes zig-zag for a signed array", () => {
    const vals = long_([0, -1, 1, -32768, 32767]);
    const v = new Bulk(() => I16);
    decode(wire((os) => os.writeSignedArray(4, vals)), v);
    expect(v.got.get(4)).toEqual(vals);
    expect(v.viaElement).toEqual([]);
  });

  it("is additive: a visitor without the hook decodes element by element", () => {
    const seen: number[] = [];
    const v: Visitor = {
      arrayUnsigned(_id, i, x) {
        seen[i] = Number(x);
      },
    };
    const vals = long_([7, 8, 9]);
    decode(wire((os) => os.writeUnsignedArray(1, vals)), v);
    expect(seen).toEqual(vals);
  });

  it("is additive per array: a declined one keeps the element callbacks", () => {
    const a = long_([1, 2, 3]);
    const b = long_([40, 50], 7);
    const v = new Bulk((id) => (id === 1 ? U32 : null));
    decode(
      wire((os) => {
        os.writeUnsignedArray(1, a);
        os.writeUnsignedArray(2, b);
      }),
      v,
    );
    expect(v.got.get(1)).toEqual(a);
    expect(v.got.has(2)).toBe(false);
    expect(v.viaElement).toEqual(b);
  });

  it("rejects an element above the declared width, at that element", () => {
    const bad = long_([1, 2, 256]);
    const v = new Bulk(() => ({ min: 0, max: 255 }));
    expect(() => decode(wire((os) => os.writeUnsignedArray(1, bad)), v)).toThrow(SofabError);
    try {
      decode(wire((os) => os.writeUnsignedArray(1, bad)), v);
    } catch (e) {
      expect((e as SofabError).code).toBe(SofabErrorCode.InvalidMsg);
    }
  });

  it("rejects an element below the declared width", () => {
    const v = new Bulk(() => I16);
    expect(() =>
      decode(wire((os) => os.writeSignedArray(1, long_([0, -32769]))), v),
    ).toThrow(SofabError);
  });

  it("INVALID beats INCOMPLETE: truncating right after a bad element still throws INVALID", () => {
    const full = wire((os) => os.writeUnsignedArray(1, long_([1, 300, 4, 5])));
    // Cut somewhere after the offending element but before the array completes.
    for (let cut = 4; cut < full.length; cut++) {
      const v = new Bulk(() => ({ min: 0, max: 255 }));
      let code: SofabErrorCode | null = null;
      try {
        decode(full.subarray(0, cut), v);
      } catch (e) {
        code = (e as SofabError).code;
      }
      // Either the bad element has not been reached yet (INCOMPLETE) or it has,
      // and then the verdict must be INVALID — never the other way round.
      expect(code === SofabErrorCode.Incomplete || code === SofabErrorCode.InvalidMsg).toBe(
        true,
      );
    }
  });

  it("a wide destination is declined, so u64 keeps the element callbacks", () => {
    // The visitor OFFERS one; the decoder refuses it, because an element above
    // 2^32-1 is not exactly representable in the destination's element type and a
    // bulk path that narrowed it would be the truncation §7.1 forbids. So the
    // offered array stays untouched and the elements arrive one at a time.
    const vals = long_([1, 2, 3]);
    const v = new Bulk(() => ({ min: 0, max: Number.MAX_SAFE_INTEGER }));
    decode(wire((os) => os.writeUnsignedArray(1, vals)), v);
    expect(v.got.get(1)).toEqual([]);
    expect(v.viaElement).toEqual(vals);
  });

  it("a chunk boundary anywhere inside the fill is invisible", () => {
    const vals = long_([0, 1, 127, 128, 16384, 300, 7]);
    const full = wire((os) => os.writeUnsignedArray(2, vals));
    for (let cut = 1; cut < full.length; cut++) {
      const v = new Bulk(() => U32);
      const is = new IStream(v);
      is.feed(full.subarray(0, cut));
      is.feed(full.subarray(cut));
      expect(v.got.get(2), `cut at ${cut}`).toEqual(vals);
      expect(v.viaElement).toEqual([]);
    }
  });

  it("one byte at a time reaches the same values", () => {
    const vals = long_([5, 128, 65535, 0]);
    const full = wire((os) => os.writeUnsignedArray(9, vals));
    const v = new Bulk(() => U32);
    const is = new IStream(v);
    for (const b of full) is.feed(Uint8Array.of(b));
    expect(v.got.get(9)).toEqual(vals);
  });

  it("the destination is dropped at the end of the array", () => {
    // Second array declines; if the decoder kept the first target it would fill
    // it again and the two would collide.
    const a = long_([1, 2]);
    const b = long_([9, 9, 9], 9);
    const v = new Bulk((id) => (id === 1 ? U32 : null));
    decode(
      wire((os) => {
        os.writeUnsignedArray(1, a);
        os.writeUnsignedArray(2, b);
      }),
      v,
    );
    expect(v.got.get(1)).toEqual(a);
    expect(v.viaElement).toEqual(b);
  });

  it("an empty array offers nothing and still ends", () => {
    let ends = 0;
    const v: Visitor = {
      arrayBulk: () => null,
      arrayEnd: () => {
        ends++;
      },
    };
    decode(wire((os) => os.writeUnsignedArray(1, [])), v);
    expect(ends).toBe(1);
  });

  it("a short array is not offered one at all", () => {
    // The offer costs a call out to the visitor; below BULK_MIN it cannot pay for
    // itself, so it is not made and the elements arrive one at a time. Measured:
    // offering on every array of a short-array message cost +7572 Ir and returned
    // 1740 (see BULK_MIN).
    let offered = 0;
    const seen: number[] = [];
    const v: Visitor = {
      arrayBulk: () => {
        offered++;
        return null;
      },
      arrayUnsigned: (_id, i, x) => {
        seen[i] = Number(x);
      },
    };
    const short = Array.from({ length: BULK_MIN - 1 }, (_, i) => i);
    decode(wire((os) => os.writeUnsignedArray(1, short)), v);
    expect(offered).toBe(0);
    expect(seen).toEqual(short);
  });

  it("an array exactly at the threshold IS offered one", () => {
    const at = Array.from({ length: BULK_MIN }, (_, i) => i * 3);
    const v = new Bulk(() => U32);
    decode(wire((os) => os.writeUnsignedArray(1, at)), v);
    expect(v.got.get(1)).toEqual(at);
    expect(v.viaElement).toEqual([]);
  });

  it("float arrays are never offered a destination", () => {
    let offered = 0;
    const seen: number[] = [];
    const v: Visitor = {
      arrayBulk: () => {
        offered++;
        return null;
      },
      arrayFp32: (_id, i, x) => {
        seen[i] = x;
      },
    };
    const vals = long_([1.5, 2.5]);
    decode(wire((os) => os.writeFp32Array(1, vals)), v);
    expect(offered).toBe(0);
    expect(seen).toEqual(vals);
  });
});
