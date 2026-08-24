/**
 * The output buffer may be arbitrarily smaller than the message — down to a
 * single byte (CORELIB_PLAN §5.1, normative).
 *
 * `ensure(n)` used to demand `n` *contiguous* bytes and flush at most once, so a
 * fixed caller buffer smaller than the largest single write could not encode at
 * all: an `fp64` set the floor at 8 bytes, a full-width varint at 10, which made
 * the minimum workable buffer size data-dependent (corelib-ts#94). An encoder
 * must instead be able to split a single write across a flush.
 *
 * §7.2 item 4 asks for a buffer of exactly `MIN_OUTPUT_BUFFER` bytes — `1` on
 * this port, which splits every atomic unit — and the sweep below goes wider on
 * purpose: 1, 2, 3, 5, 8 and 16 all failed the same way once, but a fix that
 * special-cased 1 would pass a 1-only test and still break at 3.
 *
 * The same item asks for the constant's two edges: a buffer one byte short of it
 * is rejected **where it is handed over** when a flush sink is installed, and the
 * very same buffer is accepted when there is none — the minimum is a streaming
 * constant and must not become a floor on the one-shot `MAX_SIZE` path (§5.1).
 */

import { describe, expect, it } from "vitest";
import { Long, MIN_OUTPUT_BUFFER, OStream, SofabError, SofabErrorCode, growingOStream } from "../src/index.js";

/** Encode through a fixed caller buffer of `size`, collecting everything flushed. */
function streamed(size: number, write: (os: OStream) => void, offset = 0): number[] {
  const out: number[] = [];
  const os = new OStream(new Uint8Array(size + offset), offset, (buf, start, end) => {
    for (let i = start; i < end; i++) out.push(buf[i]!);
  });
  write(os);
  os.flush();
  return out;
}

/** Encode the same fields one-shot, through the growable in-memory path. */
function grown(write: (os: OStream) => void): number[] {
  const os = growingOStream();
  write(os);
  return Array.from(os.bytes());
}

const SIZES = [MIN_OUTPUT_BUFFER, 2, 3, 5, 8, 16, 64];

/** The corpus: every writer that reserves a fixed-width run of bytes. */
const CASES: Array<[string, (os: OStream) => void]> = [
  ["the issue's three fields", (os) => {
    os.writeUnsigned(0, 42);
    os.writeFp64(1, 3.5);
    os.writeString(2, "hello, world");
  }],
  ["fp64", (os) => os.writeFp64(1, 1.7976931348623157e308)],
  ["fp32", (os) => os.writeFp32(1, 3.14159)],
  ["a full-width u64 (10-byte varint)", (os) => os.writeUnsigned(1, 2n ** 64n - 1n)],
  ["a full-width i64", (os) => os.writeSigned(1, -(2n ** 63n))],
  ["a large number-path unsigned", (os) => os.writeUnsigned(1, Number.MAX_SAFE_INTEGER)],
  ["a large number-path signed", (os) => os.writeSigned(1, -Number.MAX_SAFE_INTEGER)],
  ["a full-width u64 Long scalar", (os) => os.writeUnsignedLong(1, Long.fromValue(2n ** 64n - 1n))],
  ["a full-width i64 Long scalar", (os) => os.writeSignedLong(1, Long.fromValue(-(2n ** 63n)))],
  ["a multi-byte field header", (os) => os.writeBoolean(1_000_000, true)],
  ["a multi-byte fixlen word", (os) => os.writeString(1, "x".repeat(200))],
  ["a blob", (os) => os.writeBlob(3, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))],
  ["a non-ASCII string", (os) => os.writeString(4, "grüße, 世界 🌍")],
  ["an unsigned array", (os) => os.writeUnsignedArray(5, [1n, 300n, 2n ** 63n, 2n ** 64n - 1n])],
  ["a signed array", (os) => os.writeSignedArray(6, [0n, -1n, 300n, -(2n ** 63n)])],
  ["an unsigned Long array", (os) =>
    os.writeUnsignedArrayLong(7, [1n, 2n ** 62n, 2n ** 64n - 1n].map(Long.fromValue))],
  ["a signed Long array", (os) =>
    os.writeSignedArrayLong(8, [-1n, 2n ** 62n, -(2n ** 63n)].map(Long.fromValue))],
  ["an fp32 array", (os) => os.writeFp32Array(9, [1.5, -2.5, 3.5])],
  ["an fp64 array", (os) => os.writeFp64Array(10, [1.5, -2.5, 3.5])],
  ["a raw fp32 array", (os) => os.writeFp32ArrayRaw(11, new Uint8Array(12).fill(0xa5))],
  ["nested sequences", (os) => {
    os.writeSequenceBeginLazy(12);
    os.writeFp64(1, -0.125);
    os.writeSequenceBeginLazy(2);
    os.writeUnsigned(1, 2n ** 63n);
    os.writeSequenceEnd();
    os.writeSequenceEnd();
  }],
  ["an empty sequence kept", (os) => {
    os.writeSequenceBeginLazy(13);
    os.writeSequenceEndKeep();
  }],
  ["a message far larger than any buffer", (os) => {
    for (let i = 1; i <= 40; i++) {
      os.writeFp64(i, i * 1.5);
      os.writeUnsigned(i, (BigInt(i) * 0x1234_5678_9abc_def0n) & (2n ** 64n - 1n));
      os.writeString(i, `field ${i}`);
    }
  }],
];

describe("encoding through a buffer smaller than a single write (§5.1)", () => {
  for (const [name, write] of CASES) {
    it(`streams ${name} byte-identically at every buffer size`, () => {
      const reference = grown(write);
      for (const size of SIZES) {
        expect(streamed(size, write), `${size}-byte buffer`).toEqual(reference);
      }
    });
  }

  it("encodes into a one-byte buffer behind a reserved offset", () => {
    // `offset` reserves room at the front for a lower-layer header, so the
    // usable window is what is left — one byte here, not the buffer's length.
    const write = CASES[0]![1];
    expect(streamed(1, write, 7)).toEqual(grown(write));
  });

  it("drives the flush sink once per byte at size 1", () => {
    // Byte-identity alone would also pass if the encoder quietly grew its own
    // buffer; this pins that the caller's buffer is the one being filled.
    let chunks = 0;
    const os = new OStream(new Uint8Array(1), 0, (_buf, start, end) => {
      expect(end - start).toBe(1);
      chunks++;
    });
    os.writeFp64(1, 3.5);
    os.flush();
    expect(chunks).toBe(10); // header + fixlen word + 8 payload bytes
  });

  it("survives a taking sink that scrubs the buffer it was handed (§7.2 item 4)", () => {
    // The half of §5.1.5 the copying sink cannot see. A sink that *takes* the
    // buffer installs a replacement and then destroys the one it took — a
    // transport that reuses its scratch, a test that proves it was handed
    // ownership. An encoder that kept writing into the buffer it gave away
    // would read the fill pattern back out on the next flush, and the
    // byte-identity assertions elsewhere in this file would not notice, because
    // their sinks copy and return.
    for (const [name, write] of CASES) {
      const reference = grown(write);
      for (const size of SIZES) {
        const out: number[] = [];
        let taken = 0;
        const first = new Uint8Array(size);
        let current = first;
        const os = new OStream(current, 0, (buf, start, end) => {
          expect(buf).toBe(current); // still only ever the installed buffer
          for (let i = start; i < end; i++) out.push(buf[i]!);
          taken++;
          const next = new Uint8Array(size);
          current = next;
          os.setBuffer(next);
          // Only now, with the replacement installed, is the taken buffer ours
          // to destroy (§5.1.5: install before returning).
          buf.fill(0xee);
        });
        write(os);
        os.flush();
        expect(out, `${name} @ ${size}`).toEqual(reference);
        expect(taken).toBeGreaterThan(0);
        // The first buffer was taken and scrubbed; nothing may have been written
        // into it afterwards.
        expect(first.every((b) => b === 0xee)).toBe(true);
      }
    }
  });

  it("agrees with the copying sink on the same message — both halves of §5.1.5", () => {
    // The pairing §7.2 item 4 asks for: a sink that returns without installing
    // anything (it copied) and one that takes and replaces must produce the same
    // bytes, so the handover rule is exercised in both directions.
    const write = CASES[CASES.length - 1]![1];
    const reference = grown(write);

    const copied: number[] = [];
    const shared = new Uint8Array(7);
    const copying = new OStream(shared, 0, (buf, start, end) => {
      for (let i = start; i < end; i++) copied.push(buf[i]!);
    });
    write(copying);
    copying.flush();

    expect(copied).toEqual(reference);
  });

  it("lets the sink swap in a fresh buffer mid-value", () => {
    // A sink is allowed to hand the encoder a new buffer (`setBuffer`) instead
    // of copying — including from inside a value that is being split.
    const out: number[] = [];
    const os = new OStream(new Uint8Array(1), 0, (buf, start, end) => {
      for (let i = start; i < end; i++) out.push(buf[i]!);
      os.setBuffer(new Uint8Array(1));
    });
    const write = CASES[0]![1];
    write(os);
    os.flush();
    expect(out).toEqual(grown(write));
  });

  it("reports a full buffer for a zero-length one rather than spinning", () => {
    // The degenerate case below the §5.1 floor, on the path where it is legal:
    // with no sink there is no minimum, so a zero-byte buffer is accepted and
    // the byte-at-a-time path must terminate with BufferFull rather than loop.
    // The sequence-end marker is the same case for the one write that is
    // indivisible — a single byte has nothing to split.
    const os = new OStream(new Uint8Array(0));
    expect(() => os.writeUnsigned(1, 1)).toThrow(/output buffer full/);
    expect(() => os.writeSequenceEnd()).toThrow(/output buffer full/);
  });

  it("still reports a full buffer when there is no sink to drain to", () => {
    // Without a sink there is nowhere for the bytes to go, so a buffer too small
    // for the value is still an error — and it must be the same BufferFull one.
    const os = new OStream(new Uint8Array(2));
    expect(() => os.writeFp64(1, 3.5)).toThrow(/output buffer full/);
  });
});

/** Run `fn` and return the SofabError code it throws (or fail). */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SofabError) return e.code;
    throw e;
  }
  throw new Error("expected a SofabError, but nothing was thrown");
}

/** One byte short of the declared minimum — zero usable bytes on this port. */
const UNDERSIZED = MIN_OUTPUT_BUFFER - 1;

describe("MIN_OUTPUT_BUFFER (§5.1)", () => {
  it("is declared, at most 20, and is this port's true value", () => {
    // A port that splits every atomic unit declares 1, and the sweep above
    // proves that at `SIZES[0]` across the whole writer corpus.
    expect(MIN_OUTPUT_BUFFER).toBeGreaterThanOrEqual(1);
    expect(MIN_OUTPUT_BUFFER).toBeLessThanOrEqual(20);
    expect(MIN_OUTPUT_BUFFER).toBe(1);
  });

  it("rejects an undersized buffer installed with a sink, at the constructor", () => {
    // Rejected where it is handed over, by the same mechanism as an
    // out-of-range offset — not partway through a message via BufferFull.
    expect(codeOf(() => new OStream(new Uint8Array(UNDERSIZED), 0, () => {})))
      .toBe(SofabErrorCode.Argument);
  });

  it("measures the window from the offset, not the buffer length", () => {
    // `offset` reserves room at the front, so what binds is `buflen - offset`:
    // a roomy buffer handed over with an offset that leaves too little is just
    // as undersized as a short one.
    const buf = new Uint8Array(64);
    expect(codeOf(() => new OStream(buf, buf.length - UNDERSIZED, () => {})))
      .toBe(SofabErrorCode.Argument);
    // One byte more of window is at the minimum and must work.
    expect(() => new OStream(buf, buf.length - MIN_OUTPUT_BUFFER, () => {})).not.toThrow();
  });

  it("rejects an undersized buffer at a mid-stream setBuffer", () => {
    const os = new OStream(new Uint8Array(8), 0, () => {});
    expect(codeOf(() => os.setBuffer(new Uint8Array(UNDERSIZED))))
      .toBe(SofabErrorCode.Argument);
    const buf = new Uint8Array(8);
    expect(codeOf(() => os.setBuffer(buf, buf.length - UNDERSIZED)))
      .toBe(SofabErrorCode.Argument);
  });

  it("leaves the encoder on its old buffer when a setBuffer is rejected", () => {
    // "never partway through a message": the rejected hand-over must not have
    // swapped anything, so the stream keeps encoding into what it already had.
    const out: number[] = [];
    const os = new OStream(new Uint8Array(64), 0, (buf, start, end) => {
      for (let i = start; i < end; i++) out.push(buf[i]!);
    });
    os.writeUnsigned(1, 42);
    expect(codeOf(() => os.setBuffer(new Uint8Array(UNDERSIZED))))
      .toBe(SofabErrorCode.Argument);
    os.writeString(2, "hello, world");
    os.flush();
    expect(out).toEqual(grown((o) => {
      o.writeUnsigned(1, 42);
      o.writeString(2, "hello, world");
    }));
  });

  it("imposes no floor on a buffer installed without a sink", () => {
    // The converse half of §7.2 item 4: the same undersized buffer is accepted
    // when no sink is installed — no flush can occur, so nothing can be split
    // and the constant has nothing to say. This is the `MAX_SIZE` case and it
    // stays exact.
    const os = new OStream(new Uint8Array(UNDERSIZED));
    expect(os.bytes().length).toBe(0); // the empty message fits, and encodes

    const buf = new Uint8Array(64);
    expect(() => new OStream(buf, buf.length - UNDERSIZED)).not.toThrow();
    expect(() => new OStream(buf, buf.length)).not.toThrow();

    // A sink-less stream may also be handed an undersized buffer mid-stream.
    const os2 = new OStream(new Uint8Array(8));
    expect(() => os2.setBuffer(new Uint8Array(UNDERSIZED))).not.toThrow();
  });

  it("encodes a message into a sink-less buffer sized exactly to it", () => {
    // Exactness on the one-shot path: two bytes of message into two bytes of
    // buffer, whatever the streaming minimum happens to be.
    const buf = new Uint8Array(2);
    const os = new OStream(buf);
    os.writeUnsigned(1, 1);
    expect(Array.from(os.bytes())).toEqual([0x08, 0x01]);
  });
});
