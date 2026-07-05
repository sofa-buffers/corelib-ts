/**
 * The bigint-free 64-bit array path: `Long` + the `*ArrayLong` codec methods
 * must produce byte-identical wire to the bigint `write*Array` methods and
 * round-trip exactly through the cursor.
 */

import { describe, expect, it } from "vitest";
import { Cursor, Long, OStream } from "../src/index.js";

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
});

describe("*ArrayLong wire compatibility", () => {
  it("writeUnsignedArrayLong is byte-identical to writeUnsignedArray", () => {
    const a = new OStream(); a.writeUnsignedArray(6, U64);
    const b = new OStream(); b.writeUnsignedArrayLong(6, U64.map(Long.fromBigInt));
    expect([...b.bytes()]).toEqual([...a.bytes()]);
  });

  it("writeSignedArrayLong is byte-identical to writeSignedArray", () => {
    const a = new OStream(); a.writeSignedArray(7, I64);
    const b = new OStream(); b.writeSignedArrayLong(7, I64.map(Long.fromBigInt));
    expect([...b.bytes()]).toEqual([...a.bytes()]);
  });

  it("readUnsignedArrayLong round-trips", () => {
    const os = new OStream(); os.writeUnsignedArrayLong(6, U64.map(Long.fromBigInt));
    const c = new Cursor(os.bytes());
    expect(c.readHeader()).toBe(true);
    expect(c.readUnsignedArrayLong().map((l) => l.toBigInt(false))).toEqual(U64);
  });

  it("readSignedArrayLong round-trips", () => {
    const os = new OStream(); os.writeSignedArrayLong(7, I64.map(Long.fromBigInt));
    const c = new Cursor(os.bytes());
    expect(c.readHeader()).toBe(true);
    expect(c.readSignedArrayLong().map((l) => l.toBigInt(true))).toEqual(I64);
  });
});
