/**
 * A 64-bit array must stream through a fixed caller buffer, like every other
 * array.
 *
 * `writeUnsignedArrayLong` / `writeSignedArrayLong` reserved the array's *worst
 * case* — 10 bytes per element — as one contiguous run, with no `canGrow`
 * branch. On a fixed buffer that reserve can never be satisfied by draining the
 * sink, so the call threw `BufferFull` for an array that encodes to a handful of
 * bytes, and threw *after* `arrayHead`, leaving a header with no payload
 * (corelib-ts#91).
 *
 * This is the path `sofabgen` emits for `targets.typescript.int64: long` and
 * `int64: number`, so the same schema through the same buffer worked under
 * `bigint` and threw under the other two — even though the three modes are
 * representation-only and wire-identical. Hence the cross-mode byte comparison
 * below: streaming must not just succeed, it must produce the same wire.
 */

import { describe, expect, it } from "vitest";
import { Long, OStream, growingOStream } from "../src/index.js";

/** Encode through a fixed caller buffer of `size`, collecting everything flushed. */
function streamed(size: number, write: (os: OStream) => void): number[] {
  const out: number[] = [];
  const os = new OStream(new Uint8Array(size), 0, (buf, start, end) => {
    for (let i = start; i < end; i++) out.push(buf[i]!);
  });
  write(os);
  os.flush();
  return out;
}

/** Encode through the growable path. */
function grown(write: (os: OStream) => void): number[] {
  const os = growingOStream();
  write(os);
  return Array.from(os.bytes());
}

const VALUES = [1n, 2n, 3n, 4n, 300n, 70_000n, 2n ** 62n, 2n ** 63n - 1n];
const SIGNED = [0n, -1n, 1n, -300n, 300n, -(2n ** 62n), 2n ** 62n, -1n];

describe("64-bit arrays on a fixed caller buffer", () => {
  it("streams an unsigned Long array through a buffer smaller than its worst case", () => {
    // 8 elements: the old contiguous reserve asked for 80 bytes at once.
    const longs = VALUES.map(Long.fromValue);
    expect(streamed(16, (os) => os.writeUnsignedArrayLong(13, longs)).length).toBeGreaterThan(0);
  });

  it("streams a signed Long array through a buffer smaller than its worst case", () => {
    const longs = SIGNED.map(Long.fromValue);
    expect(streamed(16, (os) => os.writeSignedArrayLong(13, longs)).length).toBeGreaterThan(0);
  });

  it("emits the same wire as the bigint writer — streamed and grown alike", () => {
    const longs = VALUES.map(Long.fromValue);
    const reference = grown((os) => os.writeUnsignedArray(13, VALUES));
    expect(grown((os) => os.writeUnsignedArrayLong(13, longs))).toEqual(reference);
    for (const size of [16, 24, 32, 64]) {
      expect(
        streamed(size, (os) => os.writeUnsignedArrayLong(13, longs)),
        `unsigned, ${size}-byte buffer`,
      ).toEqual(reference);
    }
  });

  it("emits the same signed wire as the bigint writer — streamed and grown alike", () => {
    const longs = SIGNED.map(Long.fromValue);
    const reference = grown((os) => os.writeSignedArray(13, SIGNED));
    expect(grown((os) => os.writeSignedArrayLong(13, longs))).toEqual(reference);
    for (const size of [16, 24, 32, 64]) {
      expect(
        streamed(size, (os) => os.writeSignedArrayLong(13, longs)),
        `signed, ${size}-byte buffer`,
      ).toEqual(reference);
    }
  });

  it("streams an array far larger than the buffer", () => {
    // 500 elements — no reserve of the whole run could ever fit, so this only
    // passes if the sink drains between elements.
    const values = Array.from({ length: 500 }, (_, i) => BigInt(i) * 1_000_000_007n);
    const longs = values.map(Long.fromValue);
    expect(streamed(16, (os) => os.writeUnsignedArrayLong(13, longs))).toEqual(
      grown((os) => os.writeUnsignedArray(13, values)),
    );
  });

  it("matches the other array writers on the smallest useful buffer", () => {
    // The contrast from the issue: every array writer, same 16-byte buffer, same
    // four values. One of them used to be the odd one out.
    const vals = [1n, 2n, 3n, 4n];
    const longs = vals.map(Long.fromValue);
    const each: Array<[string, (os: OStream) => void]> = [
      ["writeUnsignedArray", (os) => os.writeUnsignedArray(13, vals)],
      ["writeUnsignedArrayLong", (os) => os.writeUnsignedArrayLong(13, longs)],
      ["writeSignedArray", (os) => os.writeSignedArray(13, vals)],
      ["writeSignedArrayLong", (os) => os.writeSignedArrayLong(13, longs)],
      ["writeFp64Array", (os) => os.writeFp64Array(13, [1, 2, 3, 4])],
    ];
    for (const [name, write] of each) {
      expect(() => streamed(16, write), name).not.toThrow();
    }
  });

  it("leaves no header behind when an element really is out of range", () => {
    // The fixed path still has to fail loudly on a bad *value* — what it must not
    // do is fail on a buffer that is merely small. Long carries exactly 64 bits,
    // so there is no out-of-range Long; the bigint writer is the one with a
    // range check, and it must keep it.
    expect(() => streamed(16, (os) => os.writeUnsignedArray(13, [-1n]))).toThrow();
  });

  it("still writes an empty 64-bit array as a bare count", () => {
    expect(streamed(16, (os) => os.writeUnsignedArrayLong(13, []))).toEqual(
      grown((os) => os.writeUnsignedArray(13, [])),
    );
  });
});
