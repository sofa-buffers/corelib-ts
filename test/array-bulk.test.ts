/**
 * The bulk array hand-off (`Visitor.arrayBulk` / {@link ArrayTarget}): the
 * decoder fills a destination the visitor already owns, instead of calling it
 * once per element.
 *
 * The properties under test are the ones the shared vectors cannot see, because
 * they are about *which surface delivered* a value rather than about the bytes:
 * the two paths must produce identical values from identical input at every
 * chunking, the element bound must be enforced here exactly where a generated
 * per-element guard enforces it today, a refused element must leave the
 * destination the way the per-element path leaves it, and a target this decoder
 * cannot fill must be refused as a caller mistake before anything is written.
 */

import { describe, expect, it } from "vitest";
import {
  IStream,
  Long,
  SofabErrorCode,
  decode,
  growingOStream,
  type ArrayTarget,
  type Visitor,
} from "../src/index.js";

const U16 = { minLo: 0, minHi: 0, maxLo: 0xffff, maxHi: 0 };
const U64 = { minLo: 0, minHi: 0, maxLo: 0xffffffff, maxHi: 0xffffffff };
/** `i16`: -32768 .. 32767, as two's-complement halves. */
const I16 = { minLo: 0xffff8000, minHi: 0xffffffff, maxLo: 0x7fff, maxHi: 0 };
/** `i64`: the whole domain. */
const I64 = { minLo: 0, minHi: 0x80000000, maxLo: 0xffffffff, maxHi: 0x7fffffff };

function wire(build: (os: ReturnType<typeof growingOStream>) => void): Uint8Array {
  const os = growingOStream();
  build(os);
  return os.bytes().slice();
}

/** Feed `bytes` to a fresh stream in `chunk`-sized pieces; returns the last status. */
function feedChunked(bytes: Uint8Array, visitor: Visitor, chunk: number): string {
  const is = new IStream(visitor);
  let status = "";
  for (let off = 0; off < bytes.length; off += chunk) {
    status = is.feed(bytes.subarray(off, Math.min(off + chunk, bytes.length)));
  }
  return status;
}

const CHUNKS = [1, 2, 3, 5, 7, 13, 64, Number.MAX_SAFE_INTEGER];

describe("bulk hand-off: it fills every destination shape", () => {
  const u16 = [0, 1, 255, 256, 65535, 4919];
  const u16Wire = wire((os) => os.writeUnsignedArray(1, u16));

  it("fills a number-first destination", () => {
    const out: (number | bigint)[] = [];
    decode(u16Wire, { arrayBulk: () => ({ values: out, ...U16 }) });
    expect(out).toEqual(u16);
  });

  it("fills a Long destination without materialising a bigint", () => {
    const out: Long[] = [];
    decode(u16Wire, { arrayBulk: () => ({ longs: out, ...U16 }) });
    expect(out.map((l) => l.toBigInt())).toEqual(u16.map((v) => BigInt(v)));
  });

  it("fills a halves destination", () => {
    const lo = new Uint32Array(u16.length);
    const hi = new Uint32Array(u16.length);
    decode(u16Wire, { arrayBulk: () => ({ lo, hi, ...U16 }) });
    expect([...lo]).toEqual(u16);
    expect([...hi]).toEqual(u16.map(() => 0));
  });

  it("carries 64-bit values exactly, in every destination", () => {
    const vals = [0n, 1n, 0x1fffffffffffffn, 0x9e3779b97f4a7c15n, 0xffffffffffffffffn];
    const w = wire((os) => os.writeUnsignedArray(1, vals));

    const values: (number | bigint)[] = [];
    decode(w, { arrayBulk: () => ({ values, ...U64 }) });
    expect(values.map((v) => BigInt(v))).toEqual(vals);

    const longs: Long[] = [];
    decode(w, { arrayBulk: () => ({ longs, ...U64 }) });
    expect(longs.map((l) => l.toBigInt())).toEqual(vals);

    const lo = new Uint32Array(vals.length);
    const hi = new Uint32Array(vals.length);
    decode(w, { arrayBulk: () => ({ lo, hi, ...U64 }) });
    expect(vals.map((_, k) => (BigInt(hi[k]!) << 32n) | BigInt(lo[k]!))).toEqual(vals);
  });

  it("fills a signed destination, zig-zag undone", () => {
    const vals = [0, -1, 1, -32768, 32767, -12345];
    const w = wire((os) => os.writeSignedArray(1, vals));

    const values: (number | bigint)[] = [];
    decode(w, { arrayBulk: () => ({ values, ...I16 }) });
    expect(values).toEqual(vals);

    const lo = new Uint32Array(vals.length);
    const hi = new Uint32Array(vals.length);
    decode(w, { arrayBulk: () => ({ lo, hi, ...I16 }) });
    expect(vals.map((_, k) => BigInt.asIntN(64, (BigInt(hi[k]!) << 32n) | BigInt(lo[k]!)))).toEqual(
      vals.map((v) => BigInt(v)),
    );
  });

  it("carries the signed 64-bit extremes", () => {
    const vals = [-(2n ** 63n), 2n ** 63n - 1n, -1n, 0n];
    const w = wire((os) => os.writeSignedArray(1, vals));
    const longs: Long[] = [];
    decode(w, { arrayBulk: () => ({ longs, ...I64 }) });
    expect(longs.map((l) => l.toBigInt(true))).toEqual(vals);
  });

  it("fills float destinations", () => {
    const f64s = [0, -0.5, 1e300, Number.MIN_SAFE_INTEGER, Infinity];
    const w64 = wire((os) => os.writeFp64Array(1, f64s));
    const f64 = new Float64Array(f64s.length);
    decode(w64, { arrayBulk: () => ({ f64 }) });
    expect([...f64]).toEqual(f64s);

    // Rounded to fp32 on the way out, so the expectation is rounded too.
    const f32s = Float32Array.from([0, 1.5, -2.25, 3.4e38]);
    const w32 = wire((os) => os.writeFp32Array(1, f32s));
    const f32 = new Float32Array(f32s.length);
    decode(w32, { arrayBulk: () => ({ f32 }) });
    expect([...f32]).toEqual([...f32s]);
  });
});

describe("bulk hand-off: it agrees with the per-element path at every chunking", () => {
  const cases: { name: string; bytes: Uint8Array; target: () => ArrayTarget; read: (t: ArrayTarget) => unknown[] }[] =
    (() => {
      const u = [0n, 1n, 300n, 0x9e3779b97f4a7c15n, 0xffffffffffffffffn, 7n];
      const s = [0, -1, 1, -2147483648, 2147483647, -99];
      const f = [1.5, -2.5, 3.25, 1e100, -0];
      const g = [1.5, -2.5, 3.25, 6.5];
      return [
        {
          name: "unsigned -> values",
          bytes: wire((os) => os.writeUnsignedArray(1, u)),
          target: () => ({ values: [], ...U64 }),
          read: (t) => (t as { values: unknown[] }).values.map((v) => BigInt(v as bigint)),
        },
        {
          name: "unsigned -> longs",
          bytes: wire((os) => os.writeUnsignedArray(1, u)),
          target: () => ({ longs: [], ...U64 }),
          read: (t) => (t as { longs: Long[] }).longs.map((l) => l.toBigInt()),
        },
        {
          name: "unsigned -> halves",
          bytes: wire((os) => os.writeUnsignedArray(1, u)),
          target: () => ({ lo: new Uint32Array(u.length), hi: new Uint32Array(u.length), ...U64 }),
          read: (t) => {
            const { lo, hi } = t as { lo: Uint32Array; hi: Uint32Array };
            return [...lo].map((l, k) => (BigInt(hi[k]!) << 32n) | BigInt(l));
          },
        },
        {
          name: "signed -> values",
          bytes: wire((os) => os.writeSignedArray(1, s)),
          target: () => ({ values: [], ...I64 }),
          read: (t) => (t as { values: unknown[] }).values.map((v) => BigInt(v as number)),
        },
        {
          name: "fp64 -> f64",
          bytes: wire((os) => os.writeFp64Array(1, f)),
          target: () => ({ f64: new Float64Array(f.length) }),
          read: (t) => [...(t as { f64: Float64Array }).f64],
        },
        {
          name: "fp32 -> f32",
          bytes: wire((os) => os.writeFp32Array(1, g)),
          target: () => ({ f32: new Float32Array(g.length) }),
          read: (t) => [...(t as { f32: Float32Array }).f32],
        },
      ];
    })();

  for (const c of cases) {
    it(`${c.name}: same values, COMPLETE, at every chunk size`, () => {
      // The whole-buffer decode is the reference: it takes the drain end to end,
      // where a small chunk forces the straddling-element path every few bytes.
      // The two must not differ by a single value.
      const whole = c.target();
      decode(c.bytes, { arrayBulk: () => whole });
      const reference = c.read(whole);

      for (const chunk of CHUNKS) {
        const t = c.target();
        const status = feedChunked(c.bytes, { arrayBulk: () => t }, chunk);
        expect(status, `chunk ${chunk}`).toBe("COMPLETE");
        expect(c.read(t), `chunk ${chunk}`).toEqual(reference);
      }
    });
  }
});

describe("bulk hand-off: arrays long enough to reach the drains", () => {
  // Regression: the float arm's handle route once returned straight out of the
  // fill, skipping the "array finished" check — so an array past
  // FP32_HANDLE_MIN / FP64_HANDLE_MIN filled its destination correctly, never
  // raised `arrayEnd`, and left the decode INCOMPLETE. Every shape below is long
  // enough to take the route its per-element twin takes for the same input.
  const N = 300;

  it("closes a float array that clears the handle threshold", () => {
    const f64s = Array.from({ length: N }, (_, k) => k + 0.5);
    const w = wire((os) => os.writeFp64Array(1, f64s));
    const f64 = new Float64Array(N);
    const ends: number[] = [];
    decode(w, { arrayBulk: () => ({ f64 }), arrayEnd: (id) => ends.push(id) });
    expect([...f64]).toEqual(f64s);
    expect(ends).toEqual([1]);

    const f32s = Float32Array.from({ length: N }, (_, k) => k + 0.25);
    const w32 = wire((os) => os.writeFp32Array(2, f32s));
    const f32 = new Float32Array(N);
    const ends32: number[] = [];
    decode(w32, { arrayBulk: () => ({ f32 }), arrayEnd: (id) => ends32.push(id) });
    expect([...f32]).toEqual([...f32s]);
    expect(ends32).toEqual([2]);
  });

  it("fills long arrays of every kind, at every chunking, and ends each one", () => {
    const u = Array.from({ length: N }, (_, k) => (k * 2654435761) % 4294967296);
    const s = Array.from({ length: N }, (_, k) => (k % 2 === 0 ? k : -k));
    const f = Array.from({ length: N }, (_, k) => k * 1.5);
    const bytes = wire((os) => {
      os.writeUnsignedArray(1, u);
      os.writeSignedArray(2, s);
      os.writeFp64Array(3, f);
    });
    const u32 = { minLo: 0, minHi: 0, maxLo: 0xffffffff, maxHi: 0 };

    for (const chunk of [1, 3, 9, 64, 1024, Number.MAX_SAFE_INTEGER]) {
      const values: (number | bigint)[] = [];
      const signed: (number | bigint)[] = [];
      const f64 = new Float64Array(N);
      const ends: number[] = [];
      const status = feedChunked(
        bytes,
        {
          arrayBulk: (id) =>
            id === 1
              ? { values, ...u32 }
              : id === 2
                ? { values: signed, ...I64 }
                : { f64 },
          arrayEnd: (id) => ends.push(id),
        },
        chunk,
      );
      expect(status, `chunk ${chunk}`).toBe("COMPLETE");
      expect(values, `chunk ${chunk}`).toEqual(u);
      expect(signed, `chunk ${chunk}`).toEqual(s);
      expect([...f64], `chunk ${chunk}`).toEqual(f);
      expect(ends, `chunk ${chunk}`).toEqual([1, 2, 3]);
    }
  });
});

describe("bulk hand-off: when it is offered, and to whom", () => {
  it("is offered once per non-empty array, after arrayBegin and before the elements", () => {
    const order: string[] = [];
    const w = wire((os) => os.writeUnsignedArray(3, [1, 2, 3]));
    decode(w, {
      arrayBegin: (id, _k, count) => order.push(`begin ${id} ${count}`),
      arrayBulk: (id, _k, count) => {
        order.push(`bulk ${id} ${count}`);
        return { values: [], ...U16 };
      },
      arrayEnd: (id) => order.push(`end ${id}`),
    });
    expect(order).toEqual(["begin 3 3", "bulk 3 3", "end 3"]);
  });

  it("is offered for an empty array too — there is nothing to write, but something to say", () => {
    const seen: string[] = [];
    const w = wire((os) => {
      os.writeUnsignedArray(1, []);
      os.writeFp64Array(2, []);
    });
    decode(w, {
      arrayBegin: (id, _k, count) => seen.push(`begin ${id} ${count}`),
      arrayBulk: (id, _k, count) => {
        seen.push(`bulk ${id} ${count}`);
        return null;
      },
      arrayEnd: (id) => seen.push(`end ${id}`),
    });
    expect(seen).toEqual(["begin 1 0", "bulk 1 0", "end 1", "begin 2 0", "bulk 2 0", "end 2"]);
  });

  it("returning null skips the elements — the decode completes, nothing is delivered", () => {
    const w = wire((os) => {
      os.writeUnsignedArray(1, [4, 5, 6]);
      os.writeUnsigned(2, 9); // the field after it must still arrive
    });
    const seen: string[] = [];
    decode(w, {
      arrayBulk: () => null,
      arrayEnd: (id) => seen.push(`end ${id}`),
      unsigned: (id, v) => seen.push(`u${id}=${v}`),
    });
    expect(seen).toEqual(["end 1", "u2=9"]);
  });

  it("takes some arrays and skips others, in one message", () => {
    const w = wire((os) => {
      os.writeUnsignedArray(1, [4, 5, 6]);
      os.writeUnsignedArray(2, [7, 8]);
    });
    const values: (number | bigint)[] = [];
    const ends: number[] = [];
    decode(w, {
      arrayBulk: (id) => (id === 1 ? { values, ...U16 } : null),
      arrayEnd: (id) => ends.push(id),
    });
    expect(values).toEqual([4, 5, 6]);
    expect(ends).toEqual([1, 2]); // the skipped array still opens and closes
  });

  it("is never offered inside a declined subtree", () => {
    const w = wire((os) => {
      os.writeSequenceBeginLazy(1);
      os.writeUnsignedArray(2, [1, 2, 3]);
      os.writeSequenceEnd();
    });
    let offered = 0;
    decode(w, {
      sequenceBegin: () => false,
      arrayBulk: () => {
        offered++;
        return null;
      },
    });
    expect(offered).toBe(0);
  });
});

describe("bulk hand-off: the element bound", () => {
  it("refuses an out-of-bound element as INVALID and leaves the prefix written", () => {
    const w = wire((os) => os.writeUnsignedArray(1, [1, 2, 70000, 4]));
    const values: (number | bigint)[] = [];
    try {
      decode(w, { arrayBulk: () => ({ values, ...U16 }) });
      expect.unreachable("an element above the schema bound must be refused");
    } catch (e) {
      expect((e as { code: string }).code).toBe(SofabErrorCode.InvalidMsg);
    }
    // Everything before the refused element is written; it and its successors are
    // not — the property the per-element path has today.
    expect(values).toEqual([1, 2]);
  });

  it("refuses at the same element whether or not the element straddles a chunk", () => {
    const w = wire((os) => os.writeUnsignedArray(1, [1, 2, 70000, 4]));
    for (const chunk of CHUNKS) {
      const values: (number | bigint)[] = [];
      expect(() => feedChunked(w, { arrayBulk: () => ({ values, ...U16 }) }, chunk)).toThrow();
      expect(values, `chunk ${chunk}`).toEqual([1, 2]);
    }
  });

  it("refuses below the minimum too, signed", () => {
    const w = wire((os) => os.writeSignedArray(1, [0, -32769]));
    const values: (number | bigint)[] = [];
    expect(() => decode(w, { arrayBulk: () => ({ values, ...I16 }) })).toThrow(/outside the schema bound/);
    expect(values).toEqual([0]);
  });

  it("a 32-bit bound refuses an element that has a high half at all", () => {
    // The u8..u32 arm tests `vHi !== 0` instead of comparing halves; an element
    // past 2^32 must be refused by it exactly as a smaller over-bound one is.
    const w = wire((os) => os.writeUnsignedArray(1, [7, 2n ** 33n]));
    const values: (number | bigint)[] = [];
    expect(() => decode(w, { arrayBulk: () => ({ values, ...U16 }) })).toThrow(
      /outside the schema bound/,
    );
    expect(values).toEqual([7]);
  });

  it("accepts the whole u32 range under a u32 bound", () => {
    const u32 = { minLo: 0, minHi: 0, maxLo: 0xffffffff, maxHi: 0 };
    const w = wire((os) => os.writeUnsignedArray(1, [0, 0xffffffff]));
    const values: (number | bigint)[] = [];
    decode(w, { arrayBulk: () => ({ values, ...u32 }) });
    expect(values).toEqual([0, 0xffffffff]);
  });

  it("accepts the bound's own endpoints", () => {
    const w = wire((os) => os.writeSignedArray(1, [-32768, 32767]));
    const values: (number | bigint)[] = [];
    decode(w, { arrayBulk: () => ({ values, ...I16 }) });
    expect(values).toEqual([-32768, 32767]);
  });

  it("latches the refusal: every later feed re-throws and delivers nothing", () => {
    const w = wire((os) => os.writeUnsignedArray(1, [1, 70000, 3]));
    const values: (number | bigint)[] = [];
    const is = new IStream({ arrayBulk: () => ({ values, ...U16 }) });
    expect(() => is.feed(w)).toThrow();
    expect(() => is.feed(new Uint8Array([0]))).toThrow(/outside the schema bound/);
    expect(values).toEqual([1]);
  });

  it("a float target carries no bound — every float is a value", () => {
    const w = wire((os) => os.writeFp64Array(1, [1e308, -1e308, NaN]));
    const f64 = new Float64Array(3);
    decode(w, { arrayBulk: () => ({ f64 }) });
    expect(f64[0]).toBe(1e308);
    expect(f64[1]).toBe(-1e308);
    expect(Number.isNaN(f64[2]!)).toBe(true);
  });
});

describe("bulk hand-off: a reused plain destination carries nothing over", () => {
  it("empties the destination at the hand-off, so a shorter array does not keep the tail", () => {
    // The reuse this feature is for: one array, handed over for every field.
    const w = wire((os) => {
      os.writeUnsignedArray(1, [1, 2, 3, 4, 5]);
      os.writeUnsignedArray(2, [9, 9]);
    });
    const values: (number | bigint)[] = [];
    const seen: (number | bigint)[][] = [];
    decode(w, {
      arrayBulk: () => ({ values, ...U16 }),
      arrayEnd: () => seen.push([...values]),
    });
    expect(seen).toEqual([
      [1, 2, 3, 4, 5],
      [9, 9],
    ]);
    expect(values.length).toBe(2);
  });

  it("empties a reused destination for an array that is empty on the wire", () => {
    // The case the offer exists for: a five-element array, then an empty one,
    // into one destination. Without the hand-off being offered for the empty
    // array there is nothing to trim it, and the second `arrayEnd` hands back the
    // first array's elements with no signal that they are stale.
    const w = wire((os) => {
      os.writeUnsignedArray(1, [1, 2, 3, 4, 5]);
      os.writeUnsignedArray(2, []);
    });
    const values: (number | bigint)[] = [];
    const seen: Record<number, (number | bigint)[]> = {};
    decode(w, {
      arrayBulk: () => ({ values, ...U16 }),
      arrayEnd: (id) => {
        seen[id] = [...values];
      },
    });
    expect(seen[1]).toEqual([1, 2, 3, 4, 5]);
    expect(seen[2]).toEqual([]);
    expect(values.length).toBe(0);
  });

  it("does the same across messages, and for a Long destination", () => {
    const longs: Long[] = [];
    const first = wire((os) => os.writeUnsignedArray(1, [1, 2, 3]));
    const second = wire((os) => os.writeUnsignedArray(1, [7]));
    decode(first, { arrayBulk: () => ({ longs, ...U64 }) });
    expect(longs.map((l) => l.toBigInt())).toEqual([1n, 2n, 3n]);
    decode(second, { arrayBulk: () => ({ longs, ...U64 }) });
    expect(longs.map((l) => l.toBigInt())).toEqual([7n]);
  });

  it("leaves only the prefix when an element is refused, with no stale tail", () => {
    const values: (number | bigint)[] = [1, 2, 3, 4, 5, 6, 7];
    const w = wire((os) => os.writeUnsignedArray(1, [10, 20, 70000, 40]));
    expect(() => decode(w, { arrayBulk: () => ({ values, ...U16 }) })).toThrow();
    expect(values).toEqual([10, 20]);
  });

  it("refuses a typed array where a plain one is required", () => {
    // It would take the writes and drop everything past its own length; the other
    // destinations are length-checked, so this one is checked for being the right
    // kind of thing at all.
    const w = wire((os) => os.writeUnsignedArray(1, [1, 2, 3]));
    try {
      decode(w, {
        arrayBulk: () =>
          ({ values: new Uint32Array(3), ...U16 }) as unknown as ArrayTarget,
      });
      expect.unreachable("expected an Argument refusal");
    } catch (e) {
      expect((e as { code: string }).code).toBe(SofabErrorCode.Argument);
      expect((e as Error).message).toMatch(/values destination must be an Array/);
    }
  });
});

describe("bulk hand-off: a target this decoder cannot fill is a caller mistake", () => {
  const w = wire((os) => os.writeUnsignedArray(1, [1, 2, 3]));
  const wFp64 = wire((os) => os.writeFp64Array(1, [1, 2, 3]));
  const wFp32 = wire((os) => os.writeFp32Array(1, [1, 2, 3]));

  function expectArgument(bytes: Uint8Array, target: unknown, match: RegExp): void {
    try {
      decode(bytes, { arrayBulk: () => target as ArrayTarget });
      expect.unreachable("expected an Argument refusal");
    } catch (e) {
      expect((e as { code: string }).code).toBe(SofabErrorCode.Argument);
      expect((e as Error).message).toMatch(match);
    }
  }

  it("refuses a target with no destination", () => {
    expectArgument(w, { ...U16 }, /exactly one destination/);
  });

  it("refuses a target with two destinations", () => {
    expectArgument(w, { values: [], longs: [], ...U16 }, /exactly one destination/);
  });

  it("refuses a float destination for an integer array", () => {
    expectArgument(w, { f64: new Float64Array(3), ...U16 }, /exactly one destination/);
  });

  it("refuses an integer destination for a float array", () => {
    expectArgument(wFp64, { values: [], ...U16 }, /needs exactly the f64 destination/);
  });

  it("refuses the wrong float width", () => {
    expectArgument(wFp64, { f32: new Float32Array(3) }, /needs exactly the f64 destination/);
    expectArgument(wFp32, { f64: new Float64Array(3) }, /needs exactly the f32 or bits/);
    expectArgument(wFp64, { bits: new Uint32Array(3) }, /needs exactly the f64 destination/);
    expectArgument(
      wFp64,
      { f32: new Float32Array(3), f64: new Float64Array(3) },
      /needs exactly the f64/,
    );
  });

  it("refuses an fp32 array given both a value and a bits destination", () => {
    // They are alternatives, not a pair: one array, one destination.
    expectArgument(
      wFp32,
      { f32: new Float32Array(3), bits: new Uint32Array(3) },
      /needs exactly the f32 or bits/,
    );
  });

  it("takes fp32 wire words, bit-exactly", () => {
    // The channel a value destination cannot be: a *signaling* NaN read through a
    // double comes back quiet, so §6.5's bit-exact round-trip needs the words.
    const raw = new Uint8Array(8);
    const dv = new DataView(raw.buffer);
    dv.setUint32(0, 0x7fa00001, true); // fp32 sNaN
    dv.setUint32(4, 0x3fc00000, true); // 1.5
    const os = growingOStream();
    os.writeFp32ArrayRaw(1, raw);
    const bits = new Uint32Array(2);
    decode(os.bytes().slice(), { arrayBulk: () => ({ bits }) });
    expect([...bits]).toEqual([0x7fa00001, 0x3fc00000]);

    // The same array through the value destination quiets it — which is why the
    // choice exists rather than one shape serving both.
    const f32 = new Float32Array(2);
    decode(os.bytes().slice(), { arrayBulk: () => ({ f32 }) });
    const back = new DataView(f32.buffer);
    expect(back.getUint32(0, true)).toBe(0x7fe00001);
  });

  it("refuses a typed destination shorter than the array", () => {
    expectArgument(wFp64, { f64: new Float64Array(2) }, /holds 2 of 3 elements/);
    expectArgument(w, { lo: new Uint32Array(3), hi: new Uint32Array(2), ...U16 }, /holds 2 of 3/);
  });

  it("refuses halves given only half", () => {
    expectArgument(w, { lo: new Uint32Array(3), ...U16 }, /needs both lo and hi/);
  });

  it("refuses a bound that is not four unsigned 32-bit halves", () => {
    expectArgument(w, { values: [] }, /four unsigned 32-bit halves/);
    expectArgument(w, { values: [], minLo: -1, minHi: 0, maxLo: 0xffff, maxHi: 0 }, /four unsigned/);
    expectArgument(w, { values: [], minLo: 0, minHi: 0, maxLo: 1.5, maxHi: 0 }, /four unsigned/);
    expectArgument(
      w,
      { values: [], minLo: 0, minHi: 0, maxLo: 0x1_0000_0000, maxHi: 0 },
      /four unsigned/,
    );
  });

  it("writes nothing before refusing", () => {
    const values: (number | bigint)[] = [];
    expect(() => decode(w, { arrayBulk: () => ({ values }) as unknown as ArrayTarget })).toThrow();
    expect(values).toEqual([]);
  });
});

describe("bulk hand-off: a refused target does not leave the stream decodable", () => {
  // The refusal happens *after* the count word is consumed and the element state
  // entered, so the read position dies with the throw. Unlatched, the next chunk
  // would resume mid-array at the wrong offset and hand the visitor fields that
  // were never on the wire — which is what every terminal refusal is latched to
  // prevent. `ARGUMENT` is terminal for that reason, and stays `ARGUMENT`.
  const bad: Visitor = { arrayBulk: () => ({ ...U16 }) as unknown as ArrayTarget };

  it("latches the Argument refusal: every later feed re-throws it, under its own code", () => {
    const w = wire((os) => {
      os.writeUnsignedArray(1, [1, 2, 3, 4, 5]);
      os.writeUnsigned(2, 42);
    });
    const is = new IStream(bad);
    expect(() => is.feed(w)).toThrow(/exactly one destination/);
    for (const again of [new Uint8Array(0), w]) {
      try {
        is.feed(again);
        expect.unreachable("a latched stream must not decode on");
      } catch (e) {
        expect((e as { code: string }).code).toBe(SofabErrorCode.Argument);
      }
    }
  });

  it("delivers nothing after the refusal, on any later chunk", () => {
    const w = wire((os) => {
      os.writeUnsignedArray(1, [1, 2, 3, 4, 5]);
      os.writeUnsigned(2, 42);
    });
    const seen: string[] = [];
    const is = new IStream({
      ...bad,
      arrayBegin: (id) => seen.push(`begin ${id}`),
      arrayEnd: (id) => seen.push(`end ${id}`),
      unsigned: (id) => seen.push(`u${id}`),
    });
    expect(() => is.feed(w.subarray(0, 4))).toThrow();
    expect(() => is.feed(w.subarray(4))).toThrow();
    expect(seen).toEqual(["begin 1"]); // no end, no fabricated field
  });

  it("refuses an empty bound rather than rejecting every element of a good message", () => {
    // The widest *unsigned* halves read as an empty interval once a signed array
    // compares them as two's complement — a caller mistake, not a verdict on the
    // bytes, so it must be ARGUMENT and not INVALID_MSG.
    const w = wire((os) => os.writeSignedArray(1, [1, -2, 3]));
    const values: (number | bigint)[] = [];
    try {
      decode(w, { arrayBulk: () => ({ values, ...U64 }) });
      expect.unreachable("an empty bound must be refused");
    } catch (e) {
      expect((e as { code: string }).code).toBe(SofabErrorCode.Argument);
      expect((e as Error).message).toMatch(/element bound is empty/);
    }
    expect(values).toEqual([]);
    // The same array decodes under the interval its own kind means.
    const ok: (number | bigint)[] = [];
    decode(w, { arrayBulk: () => ({ values: ok, ...I64 }) });
    expect(ok).toEqual([1, -2, 3]);
  });

  it("drops the destination when a refusal latches, so nothing of the caller's is held", () => {
    // Observable through the contract rather than through the heap: after the
    // latch the machine is dead, and a *new* stream with its own destination is
    // unaffected by the one the dead stream was filling.
    const w = wire((os) => os.writeUnsignedArray(1, [1, 70000, 3]));
    const stale: (number | bigint)[] = [];
    const is = new IStream({ arrayBulk: () => ({ values: stale, ...U16 }) });
    expect(() => is.feed(w)).toThrow(/outside the schema bound/);
    expect(stale).toEqual([1]);
    expect(() => is.feed(w)).toThrow(/outside the schema bound/);
    expect(stale).toEqual([1]); // not appended to by the re-thrown feed
  });
});

describe("bulk hand-off: it holds nothing it should not", () => {
  it("drops the destination at arrayEnd, so a later array cannot write into it", () => {
    const w = wire((os) => {
      os.writeUnsignedArray(1, [1, 2]);
      os.writeUnsignedArray(2, [3, 4]);
    });
    const first: (number | bigint)[] = [];
    decode(w, {
      // Only the first array is handed over. If the decoder kept the target, the
      // second array's elements would be written into `first` as well.
      arrayBulk: (id) => (id === 1 ? { values: first, ...U16 } : null),
    });
    expect(first).toEqual([1, 2]);
  });

  it("a decode aborted inside a bulk array does not leak into the next one", () => {
    const bad = wire((os) => os.writeUnsignedArray(1, [1, 70000]));
    const good = wire((os) => os.writeUnsignedArray(1, [5, 6]));
    const stale: (number | bigint)[] = [];
    expect(() => decode(bad, { arrayBulk: () => ({ values: stale, ...U16 }) })).toThrow();
    // The pooled machine is reused here; it must not still be holding `stale`.
    const fresh: (number | bigint)[] = [];
    decode(good, { arrayBulk: () => ({ values: fresh, ...U16 }) });
    expect(fresh).toEqual([5, 6]);
    expect(stale).toEqual([1]);
  });
});
