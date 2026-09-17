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

describe("the stated element width is load-bearing, so understating it is refused", () => {
  it("refuses an element wider than the caller said, rather than truncating silently", () => {
    // A write past a `Uint8Array`'s end is a no-op, so an understated width used
    // to leave a SHORT message whose `bytesUsed` reported the length that was
    // never written — partial output handed back as complete, which §5.1 forbids.
    // The buffer here is exactly what the (wrong) claim promises: 2 header bytes
    // plus 3 elements at 1 byte. Each element actually needs 3.
    const os = new OStream(new Uint8Array(5));
    try {
      os.writeUnsignedArray(0, [999999, 999999, 999999], 1);
      expect.unreachable("an understated width must be refused");
    } catch (e) {
      expect((e as { code: string }).code).toBe(SofabErrorCode.BufferFull);
    }
  });

  it("an honest width in the same buffer encodes, and identically to the default", () => {
    const vals = [999999, 999999, 999999];
    const stated = new OStream(new Uint8Array(64));
    stated.writeUnsignedArray(0, vals, 5);
    const guessed = new OStream(new Uint8Array(64));
    guessed.writeUnsignedArray(0, vals);
    expect([...stated.bytes()]).toEqual([...guessed.bytes()]);
  });

  it("a width WIDER than the elements need is merely slack, never a refusal", () => {
    const os = new OStream(new Uint8Array(64));
    os.writeUnsignedArray(0, [1, 2, 3], 10);
    expect([...os.bytes()]).toEqual([0x03, 0x03, 1, 2, 3]);
  });

  it("the signed writer guards the same way", () => {
    const os = new OStream(new Uint8Array(5));
    expect(() => os.writeSignedArray(0, [-999999, -999999, -999999], 1)).toThrow();
  });
});
