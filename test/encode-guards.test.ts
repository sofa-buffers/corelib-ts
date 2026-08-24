/**
 * Encoder guards on the *caller's* side of the contract — the argument and
 * buffer checks no conformance vector can reach, because a vector only ever
 * describes a well-formed message.
 *
 * Three obligations are asserted here:
 *
 *  - **Buffer handover (CORELIB_PLAN §5.1).** A buffer is validated where it is
 *    handed over — at construction and at every mid-stream `setBuffer` — so an
 *    offset outside the buffer is rejected right there with `ARGUMENT`, never
 *    partway through a message, and a rejected `setBuffer` is not an
 *    installation: the encoder keeps writing into the buffer it already had.
 *  - **Wire-domain limits (§4.6/§4.7).** An `element_count` above `ARRAY_MAX`,
 *    and an fp32 raw payload that is not a whole number of 4-byte elements,
 *    cannot be represented on the wire and are refused before a single byte of
 *    the field is written.
 *  - **The indivisible end marker (§4.9).** The one-byte sequence-end marker is
 *    the only write with nothing smaller to split into, so a sink-less buffer
 *    that cannot take it has nothing to report but `BUFFER_FULL` — and the depth
 *    counter it maintains stops at zero, so an unmatched end cannot underflow it
 *    and buy extra nesting past `MAX_DEPTH`.
 */

import { describe, expect, it } from "vitest";
import {
  ARRAY_MAX,
  MAX_DEPTH,
  OStream,
  SofabError,
  SofabErrorCode,
  decode,
  growingOStream,
  type Visitor,
} from "../src/index.js";

/** Run `fn` and return the `SofabError` code it throws (or fail). */
function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SofabError) return e.code;
    throw e;
  }
  throw new Error("expected a SofabError, but nothing was thrown");
}

describe("buffer handover is validated at the handover (§5.1)", () => {
  it("rejects a negative construction offset", () => {
    expect(codeOf(() => new OStream(new Uint8Array(8), -1))).toBe(
      SofabErrorCode.Argument,
    );
  });

  it("rejects a construction offset past the end of the buffer", () => {
    expect(codeOf(() => new OStream(new Uint8Array(8), 9))).toBe(
      SofabErrorCode.Argument,
    );
  });

  it("accepts an offset exactly at the end — a zero-byte window, sink-less", () => {
    // `offset === buffer.length` is inside the buffer: it reserves the whole of
    // it. With no sink there is no MIN_OUTPUT_BUFFER floor, so this is legal and
    // fails, if at all, as BUFFER_FULL on the first write — not as ARGUMENT here.
    const os = new OStream(new Uint8Array(4), 4);
    expect(os.bytesUsed).toBe(0);
    expect(codeOf(() => os.writeUnsigned(1, 1))).toBe(SofabErrorCode.BufferFull);
  });

  it("rejects an out-of-range offset at a mid-stream setBuffer, keeping the old buffer", () => {
    const first = new Uint8Array(16);
    const os = new OStream(first, 0, () => {});
    os.writeUnsigned(1, 1);
    const before = os.bytesUsed;

    expect(codeOf(() => os.setBuffer(new Uint8Array(16), -1))).toBe(
      SofabErrorCode.Argument,
    );
    expect(codeOf(() => os.setBuffer(new Uint8Array(16), 17))).toBe(
      SofabErrorCode.Argument,
    );

    // Still on the original installation: the bytes written before the rejected
    // call are still there, and the next write lands in the same buffer.
    expect(os.bytesUsed).toBe(before);
    os.writeUnsigned(2, 2);
    expect(os.bytes().buffer).toBe(first.buffer);
    expect([...os.bytes()]).toStrictEqual([0x08, 0x01, 0x10, 0x02]);
  });
});

describe("array element_count is bounded by ARRAY_MAX (§4.7)", () => {
  // `ArrayLike` is the writers' declared parameter type, so a caller can hand
  // over a length without materializing 2^31 elements — which is exactly how a
  // hostile or buggy caller would reach this guard for real.
  const oversized: ArrayLike<never> = { length: ARRAY_MAX + 1 };

  const writers: [string, (os: OStream) => void][] = [
    ["writeUnsignedArray", (os) => os.writeUnsignedArray(1, oversized)],
    ["writeSignedArray", (os) => os.writeSignedArray(1, oversized)],
    ["writeFp32Array", (os) => os.writeFp32Array(1, oversized)],
    ["writeFp64Array", (os) => os.writeFp64Array(1, oversized)],
  ];

  it.each(writers)("%s rejects a count above ARRAY_MAX, writing nothing", (_name, write) => {
    const os = growingOStream();
    expect(codeOf(() => write(os))).toBe(SofabErrorCode.Argument);
    expect(os.bytesUsed).toBe(0);
  });
});

describe("array elements are range-checked on the streaming path too", () => {
  /**
   * A buffer too small for the bulk reserve and with a sink to drain to, so the
   * array writers take their element-at-a-time route. That route re-derives the
   * 64-bit halves per element through the shared scratch, and its range check is
   * a second implementation of the one the bulk kernel applies — a value outside
   * the 64-bit domain must be refused identically on both.
   */
  function streaming(): OStream {
    return new OStream(new Uint8Array(4), 0, () => {});
  }

  it.each([
    ["2^64", 1n << 64n],
    ["-1", -1n],
  ])("writeUnsignedArray rejects %s", (_name, v) => {
    expect(codeOf(() => streaming().writeUnsignedArray(1, [1n, v]))).toBe(
      SofabErrorCode.Argument,
    );
  });

  it.each([
    ["2^63", 1n << 63n],
    ["-2^63 - 1", -(1n << 63n) - 1n],
  ])("writeSignedArray rejects %s", (_name, v) => {
    expect(codeOf(() => streaming().writeSignedArray(1, [1n, v]))).toBe(
      SofabErrorCode.Argument,
    );
  });

  it("accepts the domain boundaries on that same path", () => {
    const flushed: number[] = [];
    const os = new OStream(new Uint8Array(4), 0, (buf, start, end) => {
      for (let i = start; i < end; i++) flushed.push(buf[i]!);
    });
    os.writeUnsignedArray(1, [0n, 0xffff_ffff_ffff_ffffn]);
    os.writeSignedArray(2, [-(1n << 63n), (1n << 63n) - 1n]);
    os.flush();

    const whole = growingOStream();
    whole.writeUnsignedArray(1, [0n, 0xffff_ffff_ffff_ffffn]);
    whole.writeSignedArray(2, [-(1n << 63n), (1n << 63n) - 1n]);
    expect(flushed).toStrictEqual([...whole.bytes()]);
  });
});

describe("writeFp32ArrayRaw takes whole 4-byte elements only (§4.8)", () => {
  it.each([1, 2, 3, 5, 6, 7, 9])("rejects a %i-byte payload", (n) => {
    const os = growingOStream();
    expect(codeOf(() => os.writeFp32ArrayRaw(1, new Uint8Array(n)))).toBe(
      SofabErrorCode.Argument,
    );
    expect(os.bytesUsed).toBe(0);
  });

  it.each([0, 4, 8, 12])("accepts a %i-byte payload as %i/4 elements", (n) => {
    const os = growingOStream();
    os.writeFp32ArrayRaw(1, new Uint8Array(n));
    let count = -1;
    const sink: Visitor = { arrayBegin: (_id, _kind, c) => void (count = c) };
    decode(os.bytes(), sink);
    expect(count).toBe(n / 4);
  });
});

describe("the one-byte sequence-end marker (§4.9)", () => {
  /** A stream on an `n`-byte buffer with no sink and no owner: it cannot grow. */
  function fixed(n: number): OStream {
    return new OStream(new Uint8Array(n));
  }

  it("reports BUFFER_FULL when the last byte is already spoken for", () => {
    const os = fixed(3);
    os.writeSequenceBeginLazy(1);
    os.writeUnsigned(1, 0); // commits the held-back header: 0x0e 0x08 0x00
    expect(os.bytesUsed).toBe(3);
    expect(codeOf(() => os.writeSequenceEnd())).toBe(SofabErrorCode.BufferFull);
  });

  it("reports BUFFER_FULL from the frame-keeping closer too", () => {
    const os = fixed(3);
    os.writeSequenceBeginLazy(1);
    os.writeUnsigned(1, 0);
    expect(codeOf(() => os.writeSequenceEndKeep())).toBe(SofabErrorCode.BufferFull);
  });

  it("fits when the buffer has the one byte left", () => {
    const os = fixed(4);
    os.writeSequenceBeginLazy(1);
    os.writeUnsigned(1, 0);
    os.writeSequenceEnd();
    expect([...os.bytes()]).toStrictEqual([0x0e, 0x08, 0x00, 0x07]);
  });
});

describe("an unmatched sequence end is written, and cannot underflow the depth", () => {
  it("emits the marker from both closers with no begin in scope", () => {
    // The encoder writes what it is told; the resulting bytes are malformed and
    // that is the decoder's verdict to make (it rejects them as INVALID_MSG).
    const os = growingOStream();
    os.writeSequenceEnd();
    os.writeSequenceEndKeep();
    expect([...os.bytes()]).toStrictEqual([0x07, 0x07]);
    expect(codeOf(() => decode(os.bytes(), {}))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("still enforces MAX_DEPTH after unmatched ends (the counter stops at zero)", () => {
    const os = growingOStream();
    for (let i = 0; i < 4; i++) os.writeSequenceEnd();
    os.writeSequenceEndKeep();

    // Had those ends driven `depth` negative, more than MAX_DEPTH sequences
    // could be opened before the guard fired.
    for (let i = 0; i < MAX_DEPTH; i++) os.writeSequenceBeginLazy(1);
    expect(codeOf(() => os.writeSequenceBeginLazy(1))).toBe(SofabErrorCode.Argument);
  });
});
