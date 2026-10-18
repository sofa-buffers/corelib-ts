/**
 * What a destination holds after a decode **stopped inside its array** — the
 * guarantee the exact-width reuse family used to buy up front by zeroing every
 * destination it handed over (#210, and `decode/reuse.ts` for why it moved).
 *
 * The promise is unchanged and it is the one a receive loop needs: a destination
 * reused across messages never shows the *previous* message's elements as this
 * one's. What changed is who pays. An array the decode completes has every slot of
 * it written, so there is nothing to zero; only an array it abandoned has a tail,
 * and the decoder is the one that knows where that tail starts. So the slots from
 * the stopped position to the wire count are zeroed
 *
 * - on the **terminal refusal** that stopped the fill, and
 * - when a pooled machine is **released**, which `decode` and `tryDecode` do in a
 *   `finally` — so a *truncated* message settles there, with no byte of the
 *   caller's destination left speaking for a message that is not this one.
 *
 * Each case is checked against a destination **seeded** with a value no decode
 * could produce, because a fresh typed array is zero already and would pass every
 * assertion below without the decoder doing anything at all.
 *
 * A plain-array destination (`values` / `longs`) is **cut** rather than zeroed, by
 * the same `trimPlain` that cuts it when an array ends; its case is here too, so
 * the two shapes of the promise sit side by side.
 */

import { describe, expect, it } from "vitest";
import {
  DecodeStatus,
  OStream,
  SofabErrorCode,
  decode,
  tryDecode,
  type ArrayTarget,
  type Visitor,
} from "../src/index.js";

const U16 = { minLo: 0, minHi: 0, maxLo: 0xffff, maxHi: 0 };
const U64 = { minLo: 0, minHi: 0, maxLo: 0xffffffff, maxHi: 0xffffffff };

/** The five elements every case below decodes, and the two-byte one that is not. */
const VALS = [11, 22, 33, 44, 55];

function wire(write: (os: OStream) => void): Uint8Array {
  const os = new OStream(new Uint8Array(256));
  write(os);
  return os.bytes().slice();
}

/** A visitor that hands over one fixed target and counts the arrays it saw. */
function handing(target: ArrayTarget): Visitor {
  return { arrayBulk: () => target };
}

/**
 * The wire of `VALS` cut so that exactly `kept` elements are complete. Every
 * element here is one byte, and the header and the count are one byte each.
 */
function truncatedTo(kept: number): Uint8Array {
  const full = wire((os) => os.writeUnsignedArray(1, VALS));
  return full.subarray(0, 2 + kept);
}

describe("a destination the decode stopped inside (§7.1, #210)", () => {
  it("zeroes the tail of an exact-width destination when an element is refused", () => {
    // 70000 does not fit the declared u16 bound: INVALID at element 1, so the
    // prefix stands and elements 1..4 are this array's unwritten tail.
    const bytes = wire((os) => os.writeUnsignedArray(1, [11, 70000, 33, 44, 55]));
    const out = new Uint16Array(5).fill(0xbeef);
    expect(() => decode(bytes, handing({ typed: out, ...U16 }))).toThrow(
      expect.objectContaining({ code: SofabErrorCode.InvalidMsg }),
    );
    expect([...out]).toStrictEqual([11, 0, 0, 0, 0]);
  });

  it("zeroes the tail of an exact-width destination when the message is truncated", () => {
    const out = new Uint16Array(5).fill(0xbeef);
    expect(tryDecode(truncatedTo(2), handing({ typed: out, ...U16 }))).toBe(
      DecodeStatus.Incomplete,
    );
    expect([...out]).toStrictEqual([11, 22, 0, 0, 0]);
  });

  it("leaves a completed array's destination alone — every slot of it was written", () => {
    const out = new Uint16Array(5).fill(0xbeef);
    decode(wire((os) => os.writeUnsignedArray(1, VALS)), handing({ typed: out, ...U16 }));
    expect([...out]).toStrictEqual(VALS);
  });

  it("zeroes a 64-bit destination with `0n`, not `0`", () => {
    // The one destination whose zero is not a `number`: a `0` store into a
    // BigUint64Array is a TypeError, so this case is the proof that the decoder
    // does not reach for the narrow zero.
    const out = new BigUint64Array(5).fill(0xdead_beefn);
    expect(tryDecode(truncatedTo(2), handing({ typed: out, ...U64 }))).toBe(
      DecodeStatus.Incomplete,
    );
    expect([...out]).toStrictEqual([11n, 22n, 0n, 0n, 0n]);
  });

  it("zeroes both halves of an `lo`/`hi` destination", () => {
    const lo = new Uint32Array(5).fill(0xbeef);
    const hi = new Uint32Array(5).fill(0xbeef);
    expect(tryDecode(truncatedTo(2), handing({ lo, hi, ...U64 }))).toBe(DecodeStatus.Incomplete);
    expect([...lo]).toStrictEqual([11, 22, 0, 0, 0]);
    expect([...hi]).toStrictEqual([0, 0, 0, 0, 0]);
  });

  it("zeroes a `bool` destination", () => {
    const bool = new Uint8Array(5).fill(7);
    const bytes = wire((os) => os.writeUnsignedArray(1, [1, 0, 1, 1, 0]));
    expect(tryDecode(bytes.subarray(0, 4), handing({ bool }))).toBe(DecodeStatus.Incomplete);
    expect([...bool]).toStrictEqual([1, 0, 0, 0, 0]);
  });

  it("zeroes an fp32 destination", () => {
    const f32 = new Float32Array(4).fill(-1.5);
    const bytes = wire((os) => os.writeFp32Array(1, [1.5, 2.5, 3.5, 4.5]));
    // Two whole elements: the header, the count, the element-length word and
    // eight payload bytes.
    expect(tryDecode(bytes.subarray(0, 11), handing({ f32 }))).toBe(DecodeStatus.Incomplete);
    expect([...f32]).toStrictEqual([1.5, 2.5, 0, 0]);
  });

  it("cuts a plain-array destination to the prefix instead of zeroing it", () => {
    const values: (number | bigint)[] = [0xbeef, 0xbeef, 0xbeef, 0xbeef, 0xbeef];
    expect(tryDecode(truncatedTo(2), handing({ values, ...U16 }))).toBe(DecodeStatus.Incomplete);
    expect(values).toStrictEqual([11, 22]);
  });

  it("does not touch a destination it was never handed", () => {
    // The boundary of the promise, and the reason the two cases above had to be a
    // refusal and a truncation: a visitor that throws does it from `arrayBegin`
    // or from `arrayBulk` itself — there is no callback per element — so the
    // hand-off has not happened and the destination is still entirely the
    // caller's. The codec zeroes what it was given and nothing else.
    const out = new Uint16Array(5).fill(0xbeef);
    const boom = new Error("the visitor's own");
    expect(() =>
      decode(wire((os) => os.writeUnsignedArray(1, VALS)), {
        arrayBulk: () => ({ typed: out, ...U16 }),
        arrayBegin: () => {
          throw boom;
        },
      }),
    ).toThrow(boom);
    expect([...out]).toStrictEqual([0xbeef, 0xbeef, 0xbeef, 0xbeef, 0xbeef]);
  });
});
