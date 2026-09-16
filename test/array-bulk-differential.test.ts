/**
 * The destination shapes must not disagree — on random messages, at random
 * lengths, at every chunking.
 *
 * There is one delivery route for array elements ({@link Visitor.arrayBulk}), but
 * five fill loops behind it: number-first values, `Long`s, raw halves, floats, and
 * `fp32` wire words. Each is a separate implementation of "read this element and
 * put it there", which is exactly the shape §5.3.1 warns about — so they are held
 * to each other here, on input no hand-written case would think to write.
 *
 * *Length* is what this reaches and the other tests do not: the shared corpus's
 * arrays are short, so nothing there crosses `FP32_HANDLE_MIN` /
 * `FP64_HANDLE_MIN`, fills a drain more than a few times, or lands a straddling
 * element in the middle of a long run. That last case is not hypothetical — the
 * float arm once returned out of its fill and never closed the array, and only an
 * array past the handle threshold showed it.
 *
 * So: random messages of random arrays, read through every destination legal for
 * their kind, compared on values, on the `arrayEnd` sequence and on the final
 * status, at six chunkings each. The generator is seeded, so a failure here
 * reproduces exactly.
 */

import { describe, expect, it } from "vitest";
import {
  ArrayKind,
  IStream,
  Long,
  decode,
  growingOStream,
  type ArrayTarget,
  type Visitor,
} from "../src/index.js";

/** The whole `u64` / `i64` domains: this asserts what the *decoder* does, not a schema. */
const U64 = { minLo: 0, minHi: 0, maxLo: 0xffffffff, maxHi: 0xffffffff };
const I64 = { minLo: 0, minHi: 0x80000000, maxLo: 0xffffffff, maxHi: 0x7fffffff };

const MESSAGES = 200;
const CHUNKS = [1, 5, 13, 64, 1 << 20];

/** A seeded LCG, so a failing case is reproducible from the seed alone. */
function rng(seed: number): { f: () => number; i: (n: number) => number } {
  let s = seed;
  const f = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  return { f, i: (n: number) => Math.floor(f() * n) };
}

type Field = { id: number; kind: ArrayKind; data: (number | bigint)[] };

function randomFields(r: ReturnType<typeof rng>): Field[] {
  const kinds = [ArrayKind.Unsigned, ArrayKind.Signed, ArrayKind.Fp32, ArrayKind.Fp64];
  const fields: Field[] = [];
  const count = 1 + r.i(4);
  for (let k = 0; k < count; k++) {
    const kind = kinds[r.i(kinds.length)]!;
    // 0 to 79 elements: empty arrays (never offered the hand-off), short ones
    // (byte loads), and runs past both float handle thresholds.
    const len = r.i(80);
    const id = k + 1;
    if (kind === ArrayKind.Unsigned) {
      const data = Array.from({ length: len }, () => {
        const low = BigInt(Math.floor(r.f() * 2 ** 32));
        return (low * (r.i(2) === 1 ? 0x1_0000_0001n : 1n)) & 0xffffffffffffffffn;
      });
      fields.push({ id, kind, data });
    } else if (kind === ArrayKind.Signed) {
      const data = Array.from({ length: len }, () => {
        const v = BigInt(Math.floor(r.f() * 2 ** 32) - 2 ** 31);
        return v * (r.i(2) === 1 ? 0x1_0001n : 1n);
      });
      fields.push({ id, kind, data });
    } else if (kind === ArrayKind.Fp32) {
      const data = [...Float32Array.from(Array.from({ length: len }, () => (r.f() - 0.5) * 1e6))];
      fields.push({ id, kind, data });
    } else {
      const data = Array.from({ length: len }, () => (r.f() - 0.5) * 1e30);
      fields.push({ id, kind, data });
    }
  }
  return fields;
}

function encode(fields: Field[]): Uint8Array {
  const os = growingOStream();
  for (const f of fields) {
    if (f.kind === ArrayKind.Unsigned) os.writeUnsignedArray(f.id, f.data);
    else if (f.kind === ArrayKind.Signed) os.writeSignedArray(f.id, f.data);
    else if (f.kind === ArrayKind.Fp32) os.writeFp32Array(f.id, f.data as number[]);
    else os.writeFp64Array(f.id, f.data as number[]);
  }
  return os.bytes().slice();
}

/** Every element as a comparable value, whichever destination produced it. */
type Decoded = { values: Record<number, unknown[]>; ends: number[]; status: string };

/** The destinations a kind can legally be read into. */
type Shape = "values" | "longs" | "halves" | "floats" | "bits";

function shapesFor(kind: ArrayKind): Shape[] {
  if (kind === ArrayKind.Fp32) return ["floats", "bits"];
  if (kind === ArrayKind.Fp64) return ["floats"];
  return ["values", "longs", "halves"];
}

/** Read `bytes` with every array taken into `shape`, fed in `chunk`-sized pieces. */
function readAs(bytes: Uint8Array, shape: Shape, chunk: number): Decoded {
  const values: Record<number, unknown[]> = {};
  const ends: number[] = [];
  let held: {
    kind: ArrayKind;
    values?: (number | bigint)[];
    longs?: Long[];
    lo?: Uint32Array;
    hi?: Uint32Array;
    f32?: Float32Array;
    f64?: Float64Array;
    bits?: Uint32Array;
  } | null = null;

  const visitor: Visitor = {
    arrayBulk: (_id, kind, count): ArrayTarget | null => {
      // An empty array is offered too — its destination has to end up empty.
      expect(count).toBeGreaterThanOrEqual(0);
      const use = shapesFor(kind).includes(shape) ? shape : shapesFor(kind)[0]!;
      const range = kind === ArrayKind.Unsigned ? U64 : I64;
      held = { kind };
      if (use === "floats") {
        if (kind === ArrayKind.Fp32) {
          held.f32 = new Float32Array(count);
          return { f32: held.f32 };
        }
        held.f64 = new Float64Array(count);
        return { f64: held.f64 };
      }
      if (use === "bits") {
        held.bits = new Uint32Array(count);
        return { bits: held.bits };
      }
      if (use === "longs") {
        held.longs = [];
        return { longs: held.longs, ...range };
      }
      if (use === "halves") {
        held.lo = new Uint32Array(count);
        held.hi = new Uint32Array(count);
        return { lo: held.lo, hi: held.hi, ...range };
      }
      held.values = [];
      return { values: held.values, ...range };
    },
    arrayEnd: (id) => {
      ends.push(id);
      const h = held;
      held = null;
      if (h === null) {
        values[id] = [];
        return;
      }
      values[id] = normalise(h);
    },
  };

  const is = new IStream(visitor);
  let status = "";
  for (let off = 0; off < bytes.length; off += chunk) {
    status = is.feed(bytes.subarray(off, Math.min(off + chunk, bytes.length)));
  }
  return { values, ends, status };
}

/** One comparable form per kind, whichever destination the elements landed in. */
function normalise(h: {
  kind: ArrayKind;
  values?: (number | bigint)[];
  longs?: Long[];
  lo?: Uint32Array;
  hi?: Uint32Array;
  f32?: Float32Array;
  f64?: Float64Array;
  bits?: Uint32Array;
}): unknown[] {
  const signed = h.kind === ArrayKind.Signed;
  if (h.f64 !== undefined) return [...h.f64];
  // fp32 compares as bits either way, so the value and word destinations meet.
  if (h.f32 !== undefined) {
    const dv = new DataView(h.f32.buffer);
    return [...h.f32].map((_, k) => dv.getUint32(k * 4, true));
  }
  if (h.bits !== undefined) return [...h.bits];
  if (h.longs !== undefined) return h.longs.map((l) => l.toBigInt(signed));
  if (h.lo !== undefined && h.hi !== undefined) {
    return [...h.lo].map((lo, k) => {
      const raw = (BigInt(h.hi![k]!) << 32n) | BigInt(lo);
      return signed ? BigInt.asIntN(64, raw) : raw;
    });
  }
  return (h.values ?? []).map((v) => BigInt(v));
}

describe("bulk hand-off: every destination shape agrees with every other", () => {
  it(`agrees on values, arrayEnd order and status over ${MESSAGES} random messages`, () => {
    const r = rng(12345);
    for (let m = 0; m < MESSAGES; m++) {
      const fields = randomFields(r);
      const bytes = encode(fields);
      // The whole-buffer read through the first legal shape is the reference.
      const reference = readAs(bytes, "values", bytes.length || 1);
      expect(reference.status, `message ${m}`).toBe("COMPLETE");

      for (const shape of ["values", "longs", "halves", "floats", "bits"] as const) {
        for (const chunk of CHUNKS) {
          const got = readAs(bytes, shape, chunk);
          const where = `message ${m}, shape ${shape}, chunk ${chunk}`;
          expect(got.status, where).toBe("COMPLETE");
          expect(got.ends, where).toEqual(reference.ends);
          for (const f of fields) {
            expect(got.values[f.id], `${where}, field ${f.id} kind ${f.kind}`).toEqual(
              reference.values[f.id],
            );
          }
        }
      }
    }
  });
});
