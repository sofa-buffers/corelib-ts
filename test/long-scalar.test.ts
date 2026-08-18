/**
 * Scalar 64-bit `Long` codecs (corelib-ts#143).
 *
 * The Long-backed 64-bit path existed for ARRAYS only
 * (`write/readUnsignedArrayLong` and the signed twins); a scalar u64/i64 had no
 * Long codec, so `sofabgen`'s `int64: long` mode could Long-back arrays but had
 * to keep scalars on `bigint` (sofa-buffers/generator#339). These four methods
 * close that: `write/readUnsignedLong`, `write/readSignedLong`.
 *
 * Two properties are asserted throughout, because they are what makes the mode
 * usable at all:
 *
 * 1. **Wire-identical.** The Long scalar writer must emit exactly the bytes the
 *    `bigint` writer emits, for every value in the 64-bit domain — the three
 *    generator int64 modes are representation-only.
 * 2. **Representation is the FIELD's, not the value's.** `readUnsigned` is
 *    number-first (a `number` below 2^53, a `bigint` above); `readUnsignedLong`
 *    returns a `Long` for every value, including small ones. That is the whole
 *    point: a generated field's runtime type must not depend on the magnitude
 *    that happened to arrive.
 */

import { describe, expect, it } from "vitest";
import { Cursor, I64_MAX, I64_MIN, Long, OStream, U64_MAX } from "../src/index.js";

/** Every interesting unsigned value: half boundaries, the number/bigint seam, the ends. */
const UNSIGNED: bigint[] = [
  0n,
  1n,
  127n,
  128n,
  300n,
  70_000n,
  0xffff_ffffn, // low half full
  0x1_0000_0000n, // first value with a high half
  (1n << 53n) - 1n, // last exact double
  1n << 53n, // first value readUnsigned hands back as a bigint
  (1n << 62n) + 12345n,
  I64_MAX,
  1n << 63n, // sign bit set: only an unsigned field can carry it
  U64_MAX,
];

const SIGNED: bigint[] = [
  0n,
  -1n,
  1n,
  -300n,
  300n,
  -(1n << 31n),
  1n << 31n,
  -((1n << 53n) - 1n),
  (1n << 53n) - 1n,
  -(1n << 62n),
  1n << 62n,
  I64_MIN,
  I64_MAX,
];

/** Encode through the growable path and return the bytes. */
function grown(write: (os: OStream) => void): number[] {
  const os = new OStream();
  write(os);
  return Array.from(os.bytes());
}

/** Encode through a fixed caller buffer of `size`, collecting everything flushed. */
function streamed(size: number, write: (os: OStream) => void): number[] {
  const out: number[] = [];
  const os = new OStream(new Uint8Array(size), 0, (b) => out.push(...b));
  write(os);
  os.flush();
  return out;
}

describe("scalar Long encode", () => {
  it("emits the same wire as writeUnsigned, across the whole u64 domain", () => {
    for (const v of UNSIGNED) {
      expect(
        grown((os) => os.writeUnsignedLong(7, Long.fromValue(v))),
        `u64 ${v}`,
      ).toEqual(grown((os) => os.writeUnsigned(7, v)));
    }
  });

  it("emits the same wire as writeSigned, across the whole i64 domain", () => {
    for (const v of SIGNED) {
      expect(
        grown((os) => os.writeSignedLong(7, Long.fromValue(v))),
        `i64 ${v}`,
      ).toEqual(grown((os) => os.writeSigned(7, v)));
    }
  });

  it("writes a small value at its exact varint size, not the 10-byte worst case", () => {
    // header (1) + payload (1). A fixed 2-byte buffer proves the writer never
    // demands room for the worst case — the fixed-buffer contract (§5.1).
    expect(streamed(2, (os) => os.writeUnsignedLong(1, Long.fromValue(1n)))).toEqual(
      grown((os) => os.writeUnsigned(1, 1n)),
    );
    expect(streamed(2, (os) => os.writeSignedLong(1, Long.fromValue(-1n)))).toEqual(
      grown((os) => os.writeSigned(1, -1n)),
    );
  });

  it("streams a full-range value through a buffer smaller than the field", () => {
    // 1-byte buffer: every byte of the 10-byte payload is drained individually.
    expect(streamed(1, (os) => os.writeUnsignedLong(1, Long.fromValue(U64_MAX)))).toEqual(
      grown((os) => os.writeUnsigned(1, U64_MAX)),
    );
    expect(streamed(1, (os) => os.writeSignedLong(1, Long.fromValue(I64_MIN)))).toEqual(
      grown((os) => os.writeSigned(1, I64_MIN)),
    );
  });
});

describe("scalar Long decode", () => {
  it("reads back every unsigned value the bigint writer wrote", () => {
    for (const v of UNSIGNED) {
      const os = new OStream();
      os.writeUnsigned(3, v);
      const c = new Cursor(os.bytes());
      expect(c.readHeader()).toBe(true);
      const got = c.readUnsignedLong();
      expect(got, `u64 ${v}`).toBeInstanceOf(Long);
      expect(got.toBigInt(), `u64 ${v}`).toBe(v);
    }
  });

  it("reads back every signed value the bigint writer wrote", () => {
    for (const v of SIGNED) {
      const os = new OStream();
      os.writeSigned(3, v);
      const c = new Cursor(os.bytes());
      expect(c.readHeader()).toBe(true);
      const got = c.readSignedLong();
      expect(got, `i64 ${v}`).toBeInstanceOf(Long);
      expect(got.toBigInt(true), `i64 ${v}`).toBe(v);
    }
  });

  it("returns a Long for a small value too — the representation is the field's", () => {
    const os = new OStream();
    os.writeUnsignedLong(1, Long.fromValue(1n));
    os.writeSignedLong(2, Long.fromValue(-1n));
    const c = new Cursor(os.bytes());
    expect(c.readHeader()).toBe(true);
    // The number-first reader hands back a `number` here; the Long reader does not.
    expect(c.readUnsignedLong()).toEqual(Long.fromBits(1, 0));
    expect(c.readHeader()).toBe(true);
    expect(c.readSignedLong()).toEqual(Long.fromBits(0xffff_ffff, 0xffff_ffff));
  });

  it("round-trips Long -> wire -> Long with no bigint in between", () => {
    const os = new OStream();
    for (const [i, v] of UNSIGNED.entries()) os.writeUnsignedLong(i + 1, Long.fromValue(v));
    const c = new Cursor(os.bytes());
    const got: bigint[] = [];
    while (c.readHeader()) got.push(c.readUnsignedLong().toBigInt());
    expect(got).toEqual(UNSIGNED);

    const so = new OStream();
    for (const [i, v] of SIGNED.entries()) so.writeSignedLong(i + 1, Long.fromValue(v));
    const sc = new Cursor(so.bytes());
    const sgot: bigint[] = [];
    while (sc.readHeader()) sgot.push(sc.readSignedLong().toBigInt(true));
    expect(sgot).toEqual(SIGNED);
  });

  it("agrees with the number-first readers value for value", () => {
    const os = new OStream();
    os.writeUnsigned(1, U64_MAX);
    os.writeSigned(2, I64_MIN);
    os.writeUnsigned(3, 42n);
    const bytes = os.bytes();

    const a = new Cursor(bytes.slice());
    const b = new Cursor(bytes.slice());
    while (a.readHeader() && b.readHeader()) {
      const signed = a.id === 2;
      const viaNumberFirst = signed ? a.readSigned() : a.readUnsigned();
      const viaLong = signed ? b.readSignedLong() : b.readUnsignedLong();
      expect(viaLong.toBigInt(signed)).toBe(BigInt(viaNumberFirst));
    }
  });
});
