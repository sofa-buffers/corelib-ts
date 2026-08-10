/**
 * Output-buffer ownership (CORELIB_PLAN §5.1, normative).
 *
 * > A corelib **MUST NOT**: allocate an output buffer. Every buffer the encoder
 * > writes into is caller-supplied. … **MUST NOT** grow or reallocate a buffer
 * > the caller supplied; what was handed over is what gets written.
 *
 * > **The generated-object layer allocates; the corelib does not.** … the
 * > corelib allocates no output buffer at all; the generated layer does, and
 * > hands one in like any other caller (§13).
 *
 * `OStream` used to carry a second, corelib-owned buffer mode: constructed with
 * no arguments it allocated 256 bytes and reallocated them as the message grew
 * (corelib-ts#108). Worse, that mode survived a hand-over: a caller could
 * `setBuffer` its **own** buffer into such a stream and the encoder would
 * silently reallocate away from it — leaving the caller's buffer half-written
 * and the message somewhere else entirely, which is exactly the second
 * prohibition.
 *
 * Now there is one ownership model. Every buffer comes from the caller: either
 * the one it hands over, or the next one its {@link BufferOwner} supplies when
 * that fills. {@link growingOStream} is that owner ready-made — the accumulator
 * §5.1 puts in the generated-object layer — and `OStream` itself allocates
 * nothing and enlarges nothing.
 */

import { describe, expect, it } from "vitest";
import {
  type BufferOwner,
  type FlushSink,
  OStream,
  SofabError,
  SofabErrorCode,
  growingOStream,
} from "../src/index.js";

/** The §6.3 code of whatever `fn` throws, or `undefined` if it returns. */
function codeOf(fn: () => void): SofabErrorCode | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    if (e instanceof SofabError) return e.code;
    throw e;
  }
}

/** Every distinct backing store the encoder flushed from, in order. */
function collect(): { sink: FlushSink; bytes: () => Uint8Array; stores: ArrayBufferLike[] } {
  const acc: number[] = [];
  const stores: ArrayBufferLike[] = [];
  return {
    sink: (c) => {
      if (stores[stores.length - 1] !== c.buffer) stores.push(c.buffer);
      for (let i = 0; i < c.length; i++) acc.push(c[i]!);
    },
    bytes: () => Uint8Array.from(acc),
    stores,
  };
}

/** A message with every atomic unit and a divisible run, plus nested framing. */
function write(os: OStream): void {
  os.writeUnsigned(1, 0xdead_beefn);
  os.writeSigned(2, -70_000);
  os.writeString(3, "a caller-supplied buffer is the only buffer there is");
  os.writeString(4, "üü-nicode ✓ payload");
  os.writeBlob(5, Uint8Array.from({ length: 300 }, (_, i) => i & 0xff));
  os.writeUnsignedArray(6, Array.from({ length: 64 }, (_, i) => i * 1_000_000));
  os.writeSignedArray(7, Array.from({ length: 64 }, (_, i) => -i * 1_000_000));
  os.writeFp32Array(8, [1.5, -2.25, 3.125]);
  os.writeFp64Array(9, [1.5, -2.25, 3.125]);
  os.writeSequenceBeginLazy(10);
  os.writeUnsigned(1, 7);
  os.writeSequenceEnd();
}

/** The reference bytes: a fixed caller buffer with a sink, no growth anywhere. */
function reference(): Uint8Array {
  const { sink, bytes } = collect();
  const os = new OStream(new Uint8Array(16), 0, sink);
  write(os);
  os.flush();
  return bytes();
}

describe("output-buffer ownership (§5.1)", () => {
  it("never reallocates a buffer the caller handed over at construction", () => {
    const { sink, bytes, stores } = collect();
    const mine = new Uint8Array(32);
    const os = new OStream(mine, 0, sink);
    write(os);
    os.flush();

    expect(bytes()).toEqual(reference());
    // Every flushed byte came out of the caller's buffer: the encoder never
    // swapped in one of its own.
    expect(stores).toEqual([mine.buffer]);
  });

  it("never reallocates a buffer the caller handed over mid-stream", () => {
    const os = growingOStream(8);
    const mine = new Uint8Array(8);

    // Handing the encoder a buffer makes the caller its owner, whatever the
    // stream did before. This one already has an owner supplying its buffer, so
    // it cannot honour a foreign one and says so where the buffer is handed
    // over — rather than reallocating away from it, which is what the old
    // growable mode did (corelib-ts#108).
    expect(codeOf(() => os.setBuffer(mine, 0))).toBe(SofabErrorCode.Argument);

    // Rejected at the handover means the stream is untouched and still usable.
    write(os);
    expect(os.bytes()).toEqual(reference());
  });

  it("reports a full caller buffer instead of growing it", () => {
    const mine = new Uint8Array(8);
    const os = new OStream(mine);
    expect(codeOf(() => os.writeBlob(1, new Uint8Array(64)))).toBe(SofabErrorCode.BufferFull);
    expect(os.bytes().buffer).toBe(mine.buffer);
  });

  it("has no allocating encoder mode: the no-argument form is the accumulator", () => {
    // Kept as a deprecated alias for one release (corelib-ts#108). It is the
    // caller-role accumulator — an owned buffer, hence no BUFFER_FULL and no
    // foreign hand-over — not a second ownership model inside OStream.
    const os = new OStream();
    write(os);
    expect(os.bytes()).toEqual(reference());
    expect(codeOf(() => os.setBuffer(new Uint8Array(64)))).toBe(SofabErrorCode.Argument);
  });
});

describe("growingOStream (the caller that owns the buffer)", () => {
  it("produces the same bytes as a caller buffer with a sink, at any capacity", () => {
    const want = reference();
    for (const initial of [1, 2, 3, 7, 16, 256, 4096]) {
      const os = growingOStream(initial);
      write(os);
      expect(Array.from(os.bytes())).toEqual(Array.from(want));
      expect(os.bytesUsed).toBe(want.length);
    }
  });

  it("rejects a capacity that could not hold a single byte", () => {
    expect(codeOf(() => void growingOStream(0))).toBe(SofabErrorCode.Argument);
    expect(codeOf(() => void growingOStream(-1))).toBe(SofabErrorCode.Argument);
    expect(codeOf(() => void growingOStream(1.5))).toBe(SofabErrorCode.Argument);
  });

  it("rewinds to empty on reset, whatever it grew to", () => {
    const os = growingOStream(2);
    write(os);
    expect(os.bytesUsed).toBeGreaterThan(2);
    os.reset();
    expect(os.bytesUsed).toBe(0);
    expect(os.bytes()).toEqual(new Uint8Array(0));

    write(os);
    expect(os.bytes()).toEqual(reference());
  });

  it("keeps a message written across many growths byte-identical to a one-shot one", () => {
    const oneShot = growingOStream(1 << 16);
    write(oneShot);
    const grown = growingOStream(1);
    write(grown);
    expect(Array.from(grown.bytes())).toEqual(Array.from(oneShot.bytes()));
  });
});

describe("BufferOwner (the caller's own storage)", () => {
  /** A doubling owner that records what it was asked for. */
  function recording(): { owner: BufferOwner; calls: Array<[number, number]> } {
    const calls: Array<[number, number]> = [];
    return {
      calls,
      owner: (current, used, needed) => {
        calls.push([used, needed]);
        const next = new Uint8Array(Math.max(current.length * 2, used + needed));
        next.set(current.subarray(0, used));
        return next;
      },
    };
  }

  it("is asked for room only once the buffer it supplied is full", () => {
    const { owner, calls } = recording();
    const os = new OStream(new Uint8Array(64), 0, undefined, owner);
    os.writeUnsigned(1, 42);
    expect(calls).toEqual([]);
    write(os);
    expect(calls.length).toBeGreaterThan(0);
    // Every request asks to keep exactly what has been written so far.
    for (const [used] of calls) expect(used).toBeGreaterThan(0);
  });

  it("carries the message across each replacement, byte for byte", () => {
    const { owner } = recording();
    const os = new OStream(new Uint8Array(1), 0, undefined, owner);
    write(os);
    expect(Array.from(os.bytes())).toEqual(Array.from(reference()));
  });

  it("reports BUFFER_FULL when the owner declines", () => {
    const os = new OStream(new Uint8Array(8), 0, undefined, () => undefined);
    expect(codeOf(() => write(os))).toBe(SofabErrorCode.BufferFull);
  });

  it("treats a replacement that is too small as a refusal, rather than overrunning it", () => {
    // A buffer shorter than `used + needed` cannot take the write: an
    // out-of-range store on a Uint8Array is silently dropped, so accepting one
    // would lose bytes without any error at all.
    const stingy: BufferOwner = (current, used) => {
      const next = new Uint8Array(current.length + 1);
      next.set(current.subarray(0, used));
      return next;
    };
    const os = new OStream(new Uint8Array(8), 0, undefined, stingy);
    expect(codeOf(() => os.writeBlob(1, new Uint8Array(64)))).toBe(SofabErrorCode.BufferFull);

    // …and with a sink to drain to, the same refusal splits the payload across
    // flushes instead of failing (§5.1): the owner is an addition to that path,
    // never a replacement for it. Every bulk route — the two string fast paths
    // and all four array kernels — has to fall back this way, so the whole
    // message goes through and comes out byte-identical.
    const { sink, bytes } = collect();
    const streamed = new OStream(new Uint8Array(8), 0, sink, stingy);
    write(streamed);
    streamed.flush();
    expect(Array.from(bytes())).toEqual(Array.from(reference()));
  });
});
