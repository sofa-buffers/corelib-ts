/**
 * The bigint-free 64-bit path: `Long` + the `*Long` encoder methods must produce
 * byte-identical wire to their `bigint` twins, and the value must come back
 * exactly — rebuilt from the `lo`/`hi` halves every integer callback carries, the
 * decode-side half of the same `bigint`-free route (§6.6.3: a value, not storage).
 */

import { describe, expect, it } from "vitest";
import { Long, OStream, decode, growingOStream } from "../src/index.js";

/** Every unsigned array element of `wire`, rebuilt from the visitor's lo/hi halves. */
function unsignedLongs(wire: Uint8Array): Long[] {
  const out: Long[] = [];
  decode(wire, { arrayUnsigned: (_id, _i, _v, lo, hi) => void out.push(Long.fromBits(lo, hi)) });
  return out;
}

/** Every signed array element of `wire`, rebuilt from the visitor's lo/hi halves. */
function signedLongs(wire: Uint8Array): Long[] {
  const out: Long[] = [];
  decode(wire, { arraySigned: (_id, _i, _v, lo, hi) => void out.push(Long.fromBits(lo, hi)) });
  return out;
}

const U64 = [0n, 1n, 4611686018427387904n, 9223372036854775808n, 18446744073709551615n];
const I64 = [-9223372036854775807n, -4611686018427387904n, 0n, 4611686018427387903n, 9223372036854775807n];

describe("Long", () => {
  it("round-trips bigint <-> lo/hi for the full 64-bit range", () => {
    for (const v of [...U64, ...I64]) {
      const signed = v < 0n;
      expect(Long.fromBigInt(v).toBigInt(signed)).toBe(v);
      expect(Long.fromValue(v).toBigInt(signed)).toBe(v);
    }
  });

  it("fromValue accepts Long, bigint and number", () => {
    const l = Long.fromBits(7, 0);
    expect(Long.fromValue(l)).toBe(l);
    expect(Long.fromValue(42n).toBigInt()).toBe(42n);
    expect(Long.fromValue(42).toBigInt()).toBe(42n);
  });

  it("fromNumber truncates toward zero rather than rounding", () => {
    expect(Long.fromNumber(3.9).toBigInt()).toBe(3n);
    expect(Long.fromNumber(-3.9).toBigInt(true)).toBe(-3n);
  });

  it("toString reads the high bit as two's complement only when asked", () => {
    // The one place a Long's *interpretation* shows: the same 64 bits are
    // 2^64-1 unsigned and -1 signed, and a Long carries no signedness of its own.
    const allOnes = Long.fromBigInt(0xffff_ffff_ffff_ffffn);
    expect(allOnes.toString()).toBe("18446744073709551615");
    expect(allOnes.toString(true)).toBe("-1");

    expect(Long.fromBigInt(I64[0]!).toString(true)).toBe("-9223372036854775807");
    expect(Long.fromBigInt(0n).toString()).toBe("0");
    expect(Long.fromBigInt(0x7fff_ffff_ffff_ffffn).toString(true)).toBe(
      "9223372036854775807",
    );
  });
});

describe("*ArrayLong wire compatibility", () => {
  it("writeUnsignedArrayLong is byte-identical to writeUnsignedArray", () => {
    const a = growingOStream(); a.writeUnsignedArray(6, U64);
    const b = growingOStream(); b.writeUnsignedArrayLong(6, U64.map(Long.fromBigInt));
    expect([...b.bytes()]).toEqual([...a.bytes()]);
  });

  it("writeSignedArrayLong is byte-identical to writeSignedArray", () => {
    const a = growingOStream(); a.writeSignedArray(7, I64);
    const b = growingOStream(); b.writeSignedArrayLong(7, I64.map(Long.fromBigInt));
    expect([...b.bytes()]).toEqual([...a.bytes()]);
  });

  it("an unsigned Long array round-trips through the visitor's halves", () => {
    const os = growingOStream(); os.writeUnsignedArrayLong(6, U64.map(Long.fromBigInt));
    expect(unsignedLongs(os.bytes()).map((l) => l.toBigInt(false))).toEqual(U64);
  });

  it("a signed Long array round-trips through the visitor's halves", () => {
    const os = growingOStream(); os.writeSignedArrayLong(7, I64.map(Long.fromBigInt));
    expect(signedLongs(os.bytes()).map((l) => l.toBigInt(true))).toEqual(I64);
  });
});
