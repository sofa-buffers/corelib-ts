/**
 * The **exact-width** integer destination ({@link IntegerArrayTarget.typed}): a
 * typed array whose element width IS the schema's declared width, filled in place.
 *
 * Two things make this destination different from the three beside it, and both
 * are what these tests are about.
 *
 * **It masks, so the bound must still be compared.** `a[0] = 70000` in a
 * `Uint16Array` is 4464 — silently. MESSAGE_SPEC §7.1 makes an element outside
 * the declared width INVALID, *neither masked to the width nor kept*, so a fill
 * that simply stored would turn a malformed message into an accepted one. The
 * bound is therefore compared exactly as for `values`, and the width is matched
 * against that bound once, at the hand-off, so a destination that could not
 * represent every legal element is a caller mistake rather than a quiet
 * truncation.
 *
 * **It lets the ENCODER know the width too.** A `Uint16Array` element is an
 * integer in 0..65535 by construction, which settles every per-element guard the
 * general varint loop makes and caps the varint at three bytes. Both halves are
 * pinned here against the general path: same bytes out, same values back.
 */

import { describe, expect, it } from "vitest";
import {
  IStream,
  OStream,
  SofabErrorCode,
  decode,
  getKernel,
  growingOStream,
  jsKernel,
  setKernel,
  type ArrayTarget,
  type Kernel,
  type Visitor,
} from "../src/index.js";

const U8 = { minLo: 0, minHi: 0, maxLo: 0xff, maxHi: 0 };
const U16 = { minLo: 0, minHi: 0, maxLo: 0xffff, maxHi: 0 };
const U32 = { minLo: 0, minHi: 0, maxLo: 0xffffffff, maxHi: 0 };
const U64 = { minLo: 0, minHi: 0, maxLo: 0xffffffff, maxHi: 0xffffffff };
const I8 = { minLo: 0xffffff80, minHi: 0xffffffff, maxLo: 0x7f, maxHi: 0 };
const I16 = { minLo: 0xffff8000, minHi: 0xffffffff, maxLo: 0x7fff, maxHi: 0 };
const I32 = { minLo: 0x80000000, minHi: 0xffffffff, maxLo: 0x7fffffff, maxHi: 0 };

function wire(build: (os: ReturnType<typeof growingOStream>) => void): Uint8Array {
  const os = growingOStream();
  build(os);
  return os.bytes().slice();
}

function feedChunked(bytes: Uint8Array, visitor: Visitor, chunk: number): void {
  const is = new IStream(visitor);
  for (let off = 0; off < bytes.length; off += chunk) {
    is.feed(bytes.subarray(off, Math.min(off + chunk, bytes.length)));
  }
}

/** Every width, with the extremes of its own domain among the values. */
const WIDTHS = [
  { name: "u8", Ctor: Uint8Array, bound: U8, signed: false, vals: [0, 1, 127, 128, 255] },
  { name: "u16", Ctor: Uint16Array, bound: U16, signed: false, vals: [0, 1, 127, 128, 16383, 16384, 65535] },
  { name: "u32", Ctor: Uint32Array, bound: U32, signed: false, vals: [0, 1, 128, 2 ** 21, 2 ** 28, 0xffffffff] },
  { name: "i8", Ctor: Int8Array, bound: I8, signed: true, vals: [0, -1, 1, 63, -64, 127, -128] },
  { name: "i16", Ctor: Int16Array, bound: I16, signed: true, vals: [0, -1, 8191, -8192, 32767, -32768] },
  { name: "i32", Ctor: Int32Array, bound: I32, signed: true, vals: [0, -1, 2 ** 20, -(2 ** 20), 2147483647, -2147483648] },
] as const;

describe("exact-width destination: it fills every width", () => {
  for (const { name, Ctor, bound, signed, vals } of WIDTHS) {
    it(`fills a ${name} destination`, () => {
      const bytes = wire((os) =>
        signed ? os.writeSignedArray(1, vals as readonly number[]) : os.writeUnsignedArray(1, vals as readonly number[]),
      );
      const out = new Ctor(vals.length);
      decode(bytes, { arrayBulk: () => ({ typed: out, ...bound }) });
      expect([...out]).toEqual([...vals]);
    });

    // The drain loop and the resumable tail are different code, and a chunking
    // of 1 puts EVERY element through the tail.
    it(`fills a ${name} destination identically at every chunking`, () => {
      const bytes = wire((os) =>
        signed ? os.writeSignedArray(1, vals as readonly number[]) : os.writeUnsignedArray(1, vals as readonly number[]),
      );
      for (const chunk of [1, 2, 3, 5, 13, Number.MAX_SAFE_INTEGER]) {
        const out = new Ctor(vals.length);
        feedChunked(bytes, { arrayBulk: () => ({ typed: out, ...bound }) }, chunk);
        expect([...out], `chunk ${chunk}`).toEqual([...vals]);
      }
    });
  }

  it("fills an array long enough to reach the drain, and an empty one", () => {
    for (const n of [0, 1, 999]) {
      const vals = Array.from({ length: n }, (_, i) => (i * 7919) & 0xffff);
      const bytes = wire((os) => os.writeUnsignedArray(1, vals));
      const out = new Uint16Array(Math.max(n, 1));
      decode(bytes, { arrayBulk: () => ({ typed: out, ...U16 }) });
      expect([...out.subarray(0, n)], `n=${n}`).toEqual(vals);
    }
  });
});

describe("exact-width destination: the bound is compared, never masked (§7.1)", () => {
  it("refuses an over-width element as INVALID rather than storing it truncated", () => {
    // 70000 & 0xffff is 4464. A destination that simply stored would report a
    // clean decode of a value the schema does not allow — the defect §7.1 names.
    const bytes = wire((os) => os.writeUnsignedArray(1, [1, 70000, 3]));
    const out = new Uint16Array(3);
    try {
      decode(bytes, { arrayBulk: () => ({ typed: out, ...U16 }) });
      expect.unreachable("an over-width element must be refused");
    } catch (e) {
      expect((e as { code: string }).code).toBe(SofabErrorCode.InvalidMsg);
    }
    expect(out[1], "the offending element must not be stored, masked or otherwise").toBe(0);
    expect(out[0], "the prefix before it stands").toBe(1);
  });

  it("refuses below the minimum too, signed", () => {
    const bytes = wire((os) => os.writeSignedArray(1, [0, -200]));
    const out = new Int8Array(2);
    expect(() => decode(bytes, { arrayBulk: () => ({ typed: out, ...I8 }) })).toThrow();
    expect(out[1]).toBe(0);
  });

  it("refuses at the same element whether or not it straddles a chunk", () => {
    const bytes = wire((os) => os.writeUnsignedArray(1, [1, 2, 300]));
    for (const chunk of [1, 2, 3, 5, Number.MAX_SAFE_INTEGER]) {
      const out = new Uint8Array(3);
      expect(() => feedChunked(bytes, { arrayBulk: () => ({ typed: out, ...U8 }) }, chunk), `chunk ${chunk}`).toThrow();
      expect([...out], `chunk ${chunk}`).toEqual([1, 2, 0]);
    }
  });

  it("accepts the bound's own endpoints", () => {
    const bytes = wire((os) => os.writeSignedArray(1, [-32768, 32767]));
    const out = new Int16Array(2);
    decode(bytes, { arrayBulk: () => ({ typed: out, ...I16 }) });
    expect([...out]).toEqual([-32768, 32767]);
  });
});

describe("exact-width destination: a target this decoder cannot fill", () => {
  const w3 = wire((os) => os.writeUnsignedArray(1, [1, 2, 3]));

  function expectArgument(bytes: Uint8Array, target: unknown, match: RegExp): void {
    try {
      decode(bytes, { arrayBulk: () => target as ArrayTarget });
      expect.unreachable("expected an Argument refusal");
    } catch (e) {
      expect((e as { code: string }).code).toBe(SofabErrorCode.Argument);
      expect((e as Error).message).toMatch(match);
    }
  }

  it("refuses a destination too short for the count", () => {
    expectArgument(w3, { typed: new Uint16Array(2), ...U16 }, /holds 2 of 3 elements/);
  });

  it("refuses a destination NARROWER than the stated bound", () => {
    // The whole point: a u8 array cannot hold every legal u16, and storing would
    // mask. So it is refused before an element is written, not truncated after.
    expectArgument(w3, { typed: new Uint8Array(3), ...U16 }, /does not fit the typed destination/);
  });

  it("refuses a 64-bit bound, which no typed destination here can hold", () => {
    expectArgument(w3, { typed: new Uint32Array(3), ...U64 }, /does not fit the typed destination/);
  });

  it("refuses it beside another destination", () => {
    expectArgument(w3, { typed: new Uint16Array(3), values: [], ...U16 }, /exactly one destination/);
  });

  it("refuses a float destination handed over as typed", () => {
    expectArgument(w3, { typed: new Float64Array(3) as never, ...U16 }, /unsupported typed destination/);
  });

  it("accepts a destination WIDER than the bound", () => {
    // Wider is safe — every legal element fits — and is what a receiver that
    // holds a u8 field in a u16 array does. Only narrower is the mistake.
    const out = new Uint32Array(3);
    decode(w3, { arrayBulk: () => ({ typed: out, ...U16 }) });
    expect([...out]).toEqual([1, 2, 3]);
  });
});

describe("exact-width destination: it is neither cut nor emptied", () => {
  it("leaves the tail of a reused destination alone — its length is not the count", () => {
    // A plain destination is cut to the elements written; a typed one cannot be,
    // so the caller owns the length and reads `count` from arrayBegin. Pinning
    // this stops a later change from "helpfully" zeroing the tail.
    const out = new Uint16Array(5).fill(9);
    decode(wire((os) => os.writeUnsignedArray(1, [1, 2])), {
      arrayBulk: () => ({ typed: out, ...U16 }),
    });
    expect([...out]).toEqual([1, 2, 9, 9, 9]);
  });
});

describe("exact-width source: the encoder emits the same bytes as the general path", () => {
  for (const { name, Ctor, signed, vals } of WIDTHS) {
    it(`${name}: a typed source and a number[] produce identical wire`, () => {
      const plain = wire((os) =>
        signed ? os.writeSignedArray(1, vals as readonly number[]) : os.writeUnsignedArray(1, vals as readonly number[]),
      );
      const typed = wire((os) =>
        signed ? os.writeSignedArray(1, new Ctor(vals)) : os.writeUnsignedArray(1, new Ctor(vals)),
      );
      expect([...typed]).toEqual([...plain]);
    });
  }

  it("reaches the bulk kernel through a buffer sized to the TRUE element width", () => {
    // The reservation decides whether the bulk kernel runs AT ALL, and a
    // caller-owned buffer is sized from the real maximum (3 bytes for a `u16`),
    // never from the 10 a general 64-bit source needs. Asking for 10 per element
    // there asks for a buffer that by construction does not exist, so the array
    // falls to the element-at-a-time route — which costs a `bigint` per element.
    //
    // Identical bytes prove nothing here (both routes emit them), so the kernel
    // is swapped for one that counts: the claim is about WHICH path ran.
    const vals = Array.from({ length: 256 }, (_, i) => (i * 257) & 0xffff);
    // The buffer a generated `encode()` allocates: MAX_SIZE, the schema's WORST
    // case — `count * 3` for a `u16` array, plus its header. Not the size this
    // particular payload happens to take; a caller cannot know that in advance.
    const maxSize = 8 + vals.length * 3;

    let bulkCalls = 0;
    const counting: Kernel = {
      ...jsKernel,
      name: "counting",
      encodeUnsignedVarints(v, out, pos) {
        bulkCalls++;
        return jsKernel.encodeUnsignedVarints(v, out, pos);
      },
    };
    const previous = getKernel();
    setKernel(counting);
    try {
      const typedOut = new Uint8Array(maxSize);
      const osTyped = new OStream(typedOut);
      osTyped.writeUnsignedArray(1, new Uint16Array(vals));
      expect(bulkCalls, "an exact-width source reaches the bulk kernel").toBe(1);
      expect([...osTyped.bytes()]).toEqual([...wire((o) => o.writeUnsignedArray(1, vals))]);

      bulkCalls = 0;
      const plainOut = new Uint8Array(maxSize);
      new OStream(plainOut).writeUnsignedArray(1, vals);
      expect(
        bulkCalls,
        "a number[] cannot state its width, so the same buffer keeps it off the bulk path",
      ).toBe(0);
    } finally {
      setKernel(previous);
    }
  });

  it("round-trips a typed source through a typed destination", () => {
    const vals = Array.from({ length: 300 }, (_, i) => (i * 7919) & 0xffff);
    const bytes = wire((os) => os.writeUnsignedArray(1, new Uint16Array(vals)));
    const out = new Uint16Array(vals.length);
    decode(bytes, { arrayBulk: () => ({ typed: out, ...U16 }) });
    expect([...out]).toEqual(vals);
  });
});

describe("exact-width destination: the 64-bit pair fills through halves", () => {
  const U64 = { minLo: 0, minHi: 0, maxLo: 0xffffffff, maxHi: 0xffffffff };
  const I64 = { minLo: 0, minHi: 0x80000000, maxLo: 0xffffffff, maxHi: 0x7fffffff };
  const uVals = [0n, 1n, 255n, 4294967296n, 9223372036854775808n, 18446744073709551615n];
  const iVals = [0n, -1n, 1n, -4294967296n, -9223372036854775808n, 9223372036854775807n];

  // The reason this destination exists: `b[i] = 5` on a BigUint64Array throws,
  // so an element store would have to build a `bigint` per element — the very
  // cost a 64-bit array is meant to avoid. Writing the two 32-bit halves through
  // a view over the same buffer builds none.
  it("fills a BigUint64Array exactly", () => {
    const bytes = wire((os) => os.writeUnsignedArray(1, uVals));
    const out = new BigUint64Array(uVals.length);
    decode(bytes, { arrayBulk: () => ({ typed: out, ...U64 }) });
    expect([...out]).toEqual(uVals);
  });

  it("fills a BigInt64Array exactly, zig-zag undone and sign preserved", () => {
    const bytes = wire((os) => os.writeSignedArray(1, iVals));
    const out = new BigInt64Array(iVals.length);
    decode(bytes, { arrayBulk: () => ({ typed: out, ...I64 }) });
    expect([...out]).toEqual(iVals);
  });

  it("fills identically at every chunking, both signs", () => {
    for (const [vals, Ctor, bound, signed] of [
      [uVals, BigUint64Array, U64, false],
      [iVals, BigInt64Array, I64, true],
    ] as const) {
      const bytes = wire((os) =>
        signed ? os.writeSignedArray(1, vals) : os.writeUnsignedArray(1, vals),
      );
      for (const chunk of [1, 2, 3, 7, 13, Number.MAX_SAFE_INTEGER]) {
        const out = new Ctor(vals.length);
        feedChunked(bytes, { arrayBulk: () => ({ typed: out, ...bound }) }, chunk);
        expect([...out], `chunk ${chunk}`).toEqual([...vals]);
      }
    }
  });

  it("fills a long array, past the drain and through the resumable tail", () => {
    const vals = Array.from({ length: 777 }, (_, i) => BigInt(i) * 0x1_0000_0001n);
    const bytes = wire((os) => os.writeUnsignedArray(1, vals));
    for (const chunk of [1, 64, Number.MAX_SAFE_INTEGER]) {
      const out = new BigUint64Array(vals.length);
      feedChunked(bytes, { arrayBulk: () => ({ typed: out, ...U64 }) }, chunk);
      expect([...out], `chunk ${chunk}`).toEqual(vals);
    }
  });

  it("refuses a destination whose signedness contradicts the array", () => {
    const u = wire((os) => os.writeUnsignedArray(1, [1n, 2n]));
    const s = wire((os) => os.writeSignedArray(1, [1n, 2n]));
    for (const [bytes, target] of [
      [u, { typed: new BigInt64Array(2), ...U64 }],
      [s, { typed: new BigUint64Array(2), ...I64 }],
    ] as const) {
      try {
        decode(bytes, { arrayBulk: () => target as ArrayTarget });
        expect.unreachable("a mismatched 64-bit destination must be refused");
      } catch (e) {
        expect((e as { code: string }).code).toBe(SofabErrorCode.Argument);
        expect((e as Error).message).toMatch(/must match the array's signedness/);
      }
    }
  });

  it("refuses one too short for the count", () => {
    const bytes = wire((os) => os.writeUnsignedArray(1, [1n, 2n, 3n]));
    try {
      decode(bytes, { arrayBulk: () => ({ typed: new BigUint64Array(2), ...U64 }) });
      expect.unreachable("a short destination must be refused");
    } catch (e) {
      expect((e as { code: string }).code).toBe(SofabErrorCode.Argument);
    }
  });

  it("encodes from a typed 64-bit source with the same bytes as a bigint[]", () => {
    for (const [vals, Ctor, signed] of [
      [uVals, BigUint64Array, false],
      [iVals, BigInt64Array, true],
    ] as const) {
      const plain = wire((os) => (signed ? os.writeSignedArray(1, vals) : os.writeUnsignedArray(1, vals)));
      const typed = wire((os) =>
        signed ? os.writeSignedArray(1, new Ctor(vals)) : os.writeUnsignedArray(1, new Ctor(vals)),
      );
      expect([...typed]).toEqual([...plain]);
    }
  });
});

describe("bool destination: §4.4 normalizes rather than masks", () => {
  it("writes 1 for every non-zero, whatever its width", () => {
    // The trap a plain Uint8Array `typed` destination would fall into: 256 masks
    // to 0, turning `true` into `false`. A boolean carries NO width bound (§4.4),
    // so the store normalizes instead.
    const bytes = wire((os) => os.writeUnsignedArray(1, [0, 1, 2, 255, 256, 4294967296, 0]));
    const out = new Uint8Array(7);
    decode(bytes, { arrayBulk: () => ({ bool: out }) });
    expect([...out]).toEqual([0, 1, 1, 1, 1, 1, 0]);
  });

  it("normalizes identically at every chunking", () => {
    const bytes = wire((os) => os.writeUnsignedArray(1, [0, 256, 1, 4294967296]));
    for (const chunk of [1, 2, 3, Number.MAX_SAFE_INTEGER]) {
      const out = new Uint8Array(4);
      feedChunked(bytes, { arrayBulk: () => ({ bool: out }) }, chunk);
      expect([...out], `chunk ${chunk}`).toEqual([0, 1, 1, 1]);
    }
  });

  it("takes an empty array, and leaves a reused destination's tail alone", () => {
    const out = new Uint8Array(4).fill(9);
    decode(wire((os) => os.writeUnsignedArray(1, [1, 0])), { arrayBulk: () => ({ bool: out }) });
    expect([...out]).toEqual([1, 0, 9, 9]);
  });

  it("refuses a signed array, a short destination, and a second destination", () => {
    const u = wire((os) => os.writeUnsignedArray(1, [1, 0, 1]));
    const s = wire((os) => os.writeSignedArray(1, [1, 0, 1]));
    const cases: [Uint8Array, unknown, RegExp][] = [
      [s as never, { bool: new Uint8Array(3) }, /needs an unsigned array/],
      [u, { bool: new Uint8Array(2) }, /holds 2 of 3 elements/],
      [u, { bool: new Uint8Array(3), values: [], minLo: 0, minHi: 0, maxLo: 1, maxHi: 0 }, /exactly one destination/],
    ];
    for (const [bytes, target, match] of cases) {
      try {
        decode(bytes, { arrayBulk: () => target as ArrayTarget });
        expect.unreachable(`expected a refusal for ${JSON.stringify(Object.keys(target as object))}`);
      } catch (e) {
        expect((e as { code: string }).code).toBe(SofabErrorCode.Argument);
        expect((e as Error).message).toMatch(match);
      }
    }
  });

  it("round-trips: a normalized destination re-encodes as the canonical 0/1", () => {
    const bytes = wire((os) => os.writeUnsignedArray(1, [0, 256, 4294967296]));
    const out = new Uint8Array(3);
    decode(bytes, { arrayBulk: () => ({ bool: out }) });
    const back = wire((os) => os.writeUnsignedArray(1, out));
    expect([...back]).toEqual([...wire((os) => os.writeUnsignedArray(1, [0, 1, 1]))]);
  });
});

describe("an fp32 array written from a Float32Array is bit-exact", () => {
  // §4.6/§6.5: a JS number is a double, and widening an fp32 SIGNALING NaN into
  // one quiets it. A `Float32Array` already holds the wire words, so the encoder
  // copies them instead of reading the values — which is what lets a caller drop
  // the raw-bytes companion it would otherwise have to carry beside the numbers.
  const words = [0x7f800001, 0x3f800000, 0xffa00001, 0x7fc00001, 0x00000000];

  it("preserves every bit pattern, signaling NaNs included", () => {
    const f = new Float32Array(words.length);
    new Uint32Array(f.buffer).set(words);
    const bytes = wire((os) => os.writeFp32Array(1, f));
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // 1 header byte + 1 count byte + 1 fixlen word, then the payload.
    const off = bytes.length - words.length * 4;
    expect(words.map((_, i) => dv.getUint32(off + i * 4, true))).toEqual(words);
  });

  it("emits the same bytes as a number[] for ordinary values", () => {
    const vals = [0, 1.5, -0.25, 3.25, 1e30];
    const plain = wire((os) => os.writeFp32Array(1, vals));
    const typed = wire((os) => os.writeFp32Array(1, new Float32Array(vals)));
    expect([...typed]).toEqual([...plain]);
  });

  it("round-trips bit-exactly through `bits` over a Float32Array's own buffer", () => {
    // The decode side has the same asymmetry, and it decides which destination a
    // Float32Array member must take. `f32` writes VALUES: an fp32 signaling NaN
    // is widened to a double to be stored, which quiets it, and narrowing it back
    // into the array cannot recover the payload. `bits` writes the wire WORDS, and
    // a `Uint32Array` over the float array's own buffer is both — the words land
    // exactly and reading the array gives the values.
    const f = new Float32Array(words.length);
    new Uint32Array(f.buffer).set(words);
    const bytes = wire((os) => os.writeFp32Array(1, f));

    const out = new Float32Array(words.length);
    const view = new Uint32Array(out.buffer);
    decode(bytes, { arrayBulk: () => ({ bits: view }) });
    expect([...view]).toEqual(words);
    expect([...wire((os) => os.writeFp32Array(1, out))]).toEqual([...bytes]);
  });

  it("...where the value destination would quiet it — the reason for the choice", () => {
    const f = new Float32Array(1);
    new Uint32Array(f.buffer)[0] = 0x7f800001; // signaling
    const bytes = wire((os) => os.writeFp32Array(1, f));
    const viaValues = new Float32Array(1);
    decode(bytes, { arrayBulk: () => ({ f32: viaValues }) });
    expect(new Uint32Array(viaValues.buffer)[0], "f32 quiets it").toBe(0x7fc00001);
  });
});

describe("two destinations are refused whichever pair they name", () => {
  // "Exactly one destination" is the rule every other combination already
  // enforces. The float and bool branches used to count only their own fields,
  // so an integer destination beside a float one slipped through — and the
  // realistic way in is the documented one: a target object reused across fields
  // with a leftover from the previous array still set on it.
  //
  // What makes it worth a refusal rather than a shrug is that the leftover field
  // SILENCES an error: `{ bool }` alone on an fp64 array is an `Argument`
  // refusal, and `{ bool, f64 }` on the same array was not — the reader got an
  // all-false array back with nothing to say it had never been filled.
  const intWire = wire((os) => os.writeUnsignedArray(1, [1, 0, 1]));
  const fpWire = wire((os) => os.writeFp64Array(1, [1.5, 2.5]));

  function refuses(bytes: Uint8Array, target: unknown): void {
    try {
      decode(bytes, { arrayBulk: () => target as ArrayTarget } as Visitor);
      expect.unreachable("a target with two destinations must be refused");
    } catch (e) {
      expect((e as { code: string }).code).toBe(SofabErrorCode.Argument);
      // Each branch keeps its own wording — the float one names the destination
      // that kind wants, which is more use than a generic sentence would be.
      expect((e as Error).message).toMatch(/destination/);
    }
  }

  it("refuses a bool destination beside a float one, on a float array", () => {
    refuses(fpWire, { bool: new Uint8Array(2), f64: new Float64Array(2) });
  });

  it("refuses a bool destination beside a float one, on an integer array", () => {
    refuses(intWire, { bool: new Uint8Array(3), f64: new Float64Array(3) });
    refuses(intWire, { bool: new Uint8Array(3), f32: new Float32Array(3) });
    refuses(intWire, { bool: new Uint8Array(3), bits: new Uint32Array(3) });
  });

  it("still refuses the pairs it always refused", () => {
    refuses(intWire, { values: [], longs: [], ...U64 });
    refuses(intWire, { bool: new Uint8Array(3), values: [], ...U64 });
  });

  it("still accepts each destination on its own", () => {
    const bools = new Uint8Array(3);
    decode(intWire, { arrayBulk: () => ({ bool: bools }) } as Visitor);
    expect([...bools]).toEqual([1, 0, 1]);

    const floats = new Float64Array(2);
    decode(fpWire, { arrayBulk: () => ({ f64: floats }) } as Visitor);
    expect([...floats]).toEqual([1.5, 2.5]);
  });
});
