/**
 * Every array writer, at every buffer size, produces the same bytes.
 *
 * That is not a nice-to-have: `MIN_OUTPUT_BUFFER` is 1 and the constant's own
 * documentation states the promise — "a message of any size encodes through a
 * one-byte buffer and the bytes produced are identical at every size". The
 * encoder keeps it by splitting every atomic unit across a flush, down to the
 * middle of a single varint.
 *
 * It was broken, and not by the splitting path. The **bulk kernel** writes a whole
 * array in one pass and cannot flush, so it may only run where everything fits —
 * which used to be decided by asking the source how wide its elements were:
 *
 *     switch (values.constructor) { case Uint16Array: return 3; ... }
 *
 * `constructor` is an ordinary property. An `ArrayLike` that claims to be a
 * `Uint16Array` while holding `0xffffffff` got three bytes an element reserved and
 * needed five; the kernel then wrote past the buffer, where the writes are no-ops,
 * and the message came back short while `bytesUsed` reported the length that was
 * never written — CORELIB_PLAN §5.1's "partial output handed back as complete".
 *
 * The lying source is what makes it *reachable*, but the property it breaks is the
 * one above, so this pins the property rather than the trigger: for each writer and
 * each buffer size from 1 upwards, the bytes must equal the one-shot encoding.
 */

import { describe, expect, it } from "vitest";
import { Long, OStream, SofabErrorCode, growingOStream } from "../src/index.js";

/** An `ArrayLike` that claims a width its values do not obey. */
const liar = {
  length: 3,
  0: 0xffffffff,
  1: 0xffffffff,
  2: 0xffffffff,
  constructor: Uint16Array,
} as unknown as ArrayLike<number>;

const writers: { name: string; write: (os: OStream) => void }[] = [
  { name: "unsigned, number[]", write: (os) => os.writeUnsignedArray(1, [1, 300, 70000, 0xffffffff]) },
  { name: "unsigned, bigint[]", write: (os) => os.writeUnsignedArray(1, [0n, 0xffffffffn, 2n ** 64n - 1n]) },
  { name: "unsigned, Uint16Array", write: (os) => os.writeUnsignedArray(1, Uint16Array.from([1, 300, 65535])) },
  { name: "unsigned, BigUint64Array", write: (os) => os.writeUnsignedArray(1, BigUint64Array.from([1n, 2n ** 64n - 1n])) },
  { name: "unsigned, a source that lies about its width", write: (os) => os.writeUnsignedArray(1, liar) },
  { name: "signed, number[]", write: (os) => os.writeSignedArray(2, [-1, 0, 70000, -2147483648]) },
  { name: "signed, Int16Array", write: (os) => os.writeSignedArray(2, Int16Array.from([-32768, 0, 32767])) },
  { name: "signed, BigInt64Array", write: (os) => os.writeSignedArray(2, BigInt64Array.from([-(2n ** 63n), 2n ** 63n - 1n])) },
  { name: "signed, a source that lies about its width", write: (os) => os.writeSignedArray(2, liar) },
  { name: "unsigned Long[]", write: (os) => os.writeUnsignedArrayLong(3, [Long.fromBigInt(0n), Long.fromBigInt(2n ** 64n - 1n)]) },
  { name: "signed Long[]", write: (os) => os.writeSignedArrayLong(4, [Long.fromBigInt(-(2n ** 63n)), Long.fromBigInt(7n)]) },
  { name: "fp32, number[]", write: (os) => os.writeFp32Array(5, [1.5, -2.5, 3e38]) },
  { name: "fp32, Float32Array", write: (os) => os.writeFp32Array(5, Float32Array.from([1.5, -2.5])) },
  { name: "fp32, raw payload", write: (os) => os.writeFp32ArrayRaw(5, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) },
  { name: "fp64, number[]", write: (os) => os.writeFp64Array(6, [1.5, -2.5, 1e300]) },
  { name: "fp64, Float64Array", write: (os) => os.writeFp64Array(6, Float64Array.from([1.5, -2.5])) },
];

/** What the writer produces with room to spare — the answer every size must match. */
function reference(write: (os: OStream) => void): Uint8Array {
  const os = growingOStream();
  write(os);
  return os.bytes().slice();
}

/**
 * The bytes that actually left the encoder: what the sink took, plus what is still
 * in the buffer — bounded by the buffer, because `bytesUsed` is the very number a
 * broken run reports wrongly and must not be trusted to measure the break.
 */
function streamed(write: (os: OStream) => void, size: number): Uint8Array {
  const buf = new Uint8Array(size);
  const out: number[] = [];
  const os = new OStream(buf, 0, (b, start, end) => {
    for (let i = start; i < end; i++) out.push(b[i]!);
  });
  write(os);
  return Uint8Array.from([...out, ...buf.subarray(0, Math.min(os.bytesUsed, buf.length))]);
}

describe("every array writer keeps the bytes independent of the buffer (§5.1)", () => {
  for (const w of writers) {
    it(`${w.name}: identical at every streaming buffer size`, () => {
      const want = reference(w.write);
      for (let size = 1; size <= want.length + 6; size++) {
        expect([...streamed(w.write, size)], `buffer ${size}`).toEqual([...want]);
      }
    });

    it(`${w.name}: the block mode takes an exact buffer and refuses one byte less`, () => {
      const want = reference(w.write);
      // Sink-less: all or nothing, and `BUFFER_FULL` is the mode's answer.
      const buf = new Uint8Array(want.length);
      const exact = new OStream(buf);
      w.write(exact);
      expect(exact.bytesUsed).toBe(want.length);
      expect([...buf]).toEqual([...want]);

      try {
        const tight = new OStream(new Uint8Array(want.length - 1));
        w.write(tight);
        expect.unreachable("a buffer one byte short must be refused");
      } catch (e) {
        expect((e as { code: string }).code).toBe(SofabErrorCode.BufferFull);
      }
    });
  }
});
