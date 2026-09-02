/**
 * The 64-bit `Long` path reached arrays only; scalars had no twin (corelib-ts#143).
 *
 * `writeUnsignedArrayLong` (+ signed) let a 64-bit *array* stay on 32-bit word
 * pairs, but a `u64`/`i64` **scalar** could only be written from `number |
 * bigint` — so a generated field under `int64: long` materialised a `bigint` per
 * scalar per encode, which is the one thing the mode exists to avoid.
 *
 * The decode half is no longer an opt-in channel: every integer callback carries
 * the exact 64-bit value as two unsigned 32-bit halves (`lo`/`hi`) *beside* the
 * number-first value, so a `Long` consumer rebuilds one with `Long.fromBits` and
 * a plain consumer ignores them. That removes the flag the old channel needed —
 * and with it the per-value `Long` the decoder used to allocate, which §6.6 does
 * not allow it to (a value is not storage; an object is).
 *
 * The bar this suite holds all of it to is that it is **representation-only**:
 * identical wire out of the encoder at every buffer size, identical values out of
 * the decoder however the halves are read, and identical `SofabError` codes
 * through `decode()` and `IStream` at every chunk size.
 */

import { describe, expect, it } from "vitest";
import {
  DecodeStatus,
  IStream,
  Long,
  OStream,
  SofabError,
  SofabErrorCode,
  decode,
  type Visitor, growingOStream } from "../src/index.js";

/** Unsigned corpus: every varint-width and number/bigint boundary that matters. */
const UNSIGNED: bigint[] = [
  0n,
  1n,
  127n,
  128n,
  300n,
  70_000n,
  2n ** 31n,
  2n ** 32n - 1n,
  2n ** 32n,
  2n ** 53n - 1n, // last value the number-first readers keep as a number
  2n ** 53n,
  2n ** 62n,
  2n ** 63n - 1n,
  2n ** 63n, // bit 63 set — the half that reads back negative if mishandled
  2n ** 64n - 1n,
];

/** Signed corpus: both signs across every zig-zag width, plus the i64 extremes. */
const SIGNED: bigint[] = [
  0n,
  -1n,
  1n,
  -300n,
  300n,
  -(2n ** 31n),
  2n ** 31n - 1n,
  -(2n ** 53n),
  2n ** 53n - 1n,
  -(2n ** 62n),
  2n ** 62n,
  -(2n ** 63n), // i64 min
  2n ** 63n - 1n, // i64 max
];

/** Encode through the growable in-memory path. */
function grown(write: (os: OStream) => void): number[] {
  const os = growingOStream();
  write(os);
  return Array.from(os.bytes());
}

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

// A buffer narrower than a worst-case varint takes the split-across-flushes
// route (§5.1); one wider takes the drain-and-retry route. Both must produce the
// bytes the growable encoder produces.
const SIZES = [1, 2, 3, 5, 8, 16, 64];

describe("writeUnsignedLong / writeSignedLong", () => {
  it("emit the wire the bigint writers emit", () => {
    for (const v of UNSIGNED) {
      expect(grown((os) => os.writeUnsignedLong(13, Long.fromValue(v))), `u64 ${v}`).toEqual(
        grown((os) => os.writeUnsigned(13, v)),
      );
    }
    for (const v of SIGNED) {
      expect(grown((os) => os.writeSignedLong(13, Long.fromValue(v))), `i64 ${v}`).toEqual(
        grown((os) => os.writeSigned(13, v)),
      );
    }
  });

  it("emit that same wire through a fixed caller buffer of any size", () => {
    for (const v of UNSIGNED) {
      const reference = grown((os) => os.writeUnsigned(13, v));
      for (const size of SIZES) {
        expect(
          streamed(size, (os) => os.writeUnsignedLong(13, Long.fromValue(v))),
          `u64 ${v}, ${size}-byte buffer`,
        ).toEqual(reference);
      }
    }
    for (const v of SIGNED) {
      const reference = grown((os) => os.writeSigned(13, v));
      for (const size of SIZES) {
        expect(
          streamed(size, (os) => os.writeSignedLong(13, Long.fromValue(v))),
          `i64 ${v}, ${size}-byte buffer`,
        ).toEqual(reference);
      }
    }
  });

  it("commit a held-back sequence header, like every other field writer", () => {
    // The `Long` writers must reach the wire through `header()` — the single
    // choke point that flushes the lazy-framing run (MESSAGE_SPEC §2). A writer
    // that bypassed it would silently drop the enclosing sequence's header.
    expect(
      grown((os) => {
        os.writeSequenceBeginLazy(2);
        os.writeUnsignedLong(1, Long.fromValue(42n));
        os.writeSequenceEnd();
      }),
    ).toEqual(
      grown((os) => {
        os.writeSequenceBeginLazy(2);
        os.writeUnsigned(1, 42n);
        os.writeSequenceEnd();
      }),
    );
  });

  it("range-check the field id", () => {
    expect(() => grown((os) => os.writeUnsignedLong(-1, Long.ZERO))).toThrow(SofabError);
    expect(() => grown((os) => os.writeSignedLong(2 ** 31, Long.ZERO))).toThrow(SofabError);
  });

  it("still report BufferFull on a fixed buffer with no sink", () => {
    // Nowhere to drain to, so a split cannot help: the failure must be reported
    // rather than silently truncated, exactly as for the bigint writers.
    const os = new OStream(new Uint8Array(2));
    expect(() => os.writeUnsignedLong(1, Long.fromValue(2n ** 64n - 1n))).toThrow(SofabError);
    try {
      new OStream(new Uint8Array(2)).writeSignedLong(1, Long.fromValue(-(2n ** 63n)));
    } catch (e) {
      expect((e as SofabError).code).toBe(SofabErrorCode.BufferFull);
    }
  });
});

describe("the decoder's lo/hi halves", () => {
  /** Rebuild every scalar of `wire` as a Long, from the halves the visitor gets. */
  function scalars(wire: Uint8Array): { u: bigint[]; s: bigint[] } {
    const u: bigint[] = [];
    const sv: bigint[] = [];
    decode(wire, {
      unsigned: (_id, _v, lo, hi) => void u.push(Long.fromBits(lo, hi).toBigInt()),
      signed: (_id, _v, lo, hi) => void sv.push(Long.fromBits(lo, hi).toBigInt(true)),
    });
    return { u, s: sv };
  }

  it("carry what the number-first value carries, for every 64-bit boundary", () => {
    for (const v of UNSIGNED) {
      const os = growingOStream();
      os.writeUnsigned(13, v);
      expect(scalars(os.bytes().slice()).u, `u64 ${v}`).toEqual([v]);
    }
    for (const v of SIGNED) {
      const os = growingOStream();
      os.writeSigned(13, v);
      expect(scalars(os.bytes().slice()).s, `i64 ${v}`).toEqual([v]);
    }
  });

  it("round-trip the Long writers", () => {
    const os = growingOStream();
    UNSIGNED.forEach((v, i) => os.writeUnsignedLong(i, Long.fromValue(v)));
    SIGNED.forEach((v, i) => os.writeSignedLong(100 + i, Long.fromValue(v)));
    const got = scalars(os.bytes().slice());
    expect(got.u).toEqual(UNSIGNED);
    expect(got.s).toEqual(SIGNED);
  });

  it("agree with the array halves element for element", () => {
    // Scalar and array are the same varint; the two paths must not drift.
    const os = growingOStream();
    os.writeUnsignedArray(1, UNSIGNED);
    os.writeSignedArray(2, SIGNED);
    const uArray: number[][] = [];
    const sArray: number[][] = [];
    decode(os.bytes().slice(), {
      arrayUnsigned: (_id, _i, _v, lo, hi) => void uArray.push([lo, hi]),
      arraySigned: (_id, _i, _v, lo, hi) => void sArray.push([lo, hi]),
    });

    const each = growingOStream();
    UNSIGNED.forEach((v, i) => each.writeUnsigned(i, v));
    const eachS = growingOStream();
    SIGNED.forEach((v, i) => eachS.writeSigned(i, v));
    const uScalar: number[][] = [];
    const sScalar: number[][] = [];
    decode(each.bytes().slice(), { unsigned: (_id, _v, lo, hi) => void uScalar.push([lo, hi]) });
    decode(eachS.bytes().slice(), { signed: (_id, _v, lo, hi) => void sScalar.push([lo, hi]) });

    expect(uScalar).toEqual(uArray);
    expect(sScalar).toEqual(sArray);
  });

  it("are the two's-complement halves for a signed value, not the zig-zag ones", () => {
    // The decoded value's bits, so Long.fromBits(...).toBigInt(true) is the value
    // — not the raw zig-zag image the wire carries.
    const os = growingOStream();
    os.writeSigned(1, -2n);
    let half: [number, number] = [0, 0];
    decode(os.bytes(), { signed: (_id, _v, lo, hi) => void (half = [lo, hi]) });
    expect(half).toEqual([0xffff_fffe, 0xffff_ffff]);
  });
});

// --- the streaming (Visitor) channel ---------------------------------------

/** One decoded integer event, normalised so both readings compare directly. */
type IntEvent = { kind: "u" | "s" | "au" | "as"; id: number; value: bigint };

/** Collects the integer events from the number-first `value`. */
class PlainRecorder implements Visitor {
  readonly events: IntEvent[] = [];
  unsigned(id: number, v: number | bigint): void {
    this.events.push({ kind: "u", id, value: BigInt(v) });
  }
  signed(id: number, v: number | bigint): void {
    this.events.push({ kind: "s", id, value: BigInt(v) });
  }
  arrayUnsigned(id: number, _i: number, v: number | bigint): void {
    this.events.push({ kind: "au", id, value: BigInt(v) });
  }
  arraySigned(id: number, _i: number, v: number | bigint): void {
    this.events.push({ kind: "as", id, value: BigInt(v) });
  }
}

/** The same events, read from the `lo`/`hi` halves instead. */
class LongRecorder implements Visitor {
  readonly events: IntEvent[] = [];

  unsigned(id: number, _v: number | bigint, lo: number, hi: number): void {
    this.events.push({ kind: "u", id, value: Long.fromBits(lo, hi).toBigInt() });
  }
  signed(id: number, _v: number | bigint, lo: number, hi: number): void {
    this.events.push({ kind: "s", id, value: Long.fromBits(lo, hi).toBigInt(true) });
  }
  arrayUnsigned(id: number, _i: number, _v: number | bigint, lo: number, hi: number): void {
    this.events.push({ kind: "au", id, value: Long.fromBits(lo, hi).toBigInt() });
  }
  arraySigned(id: number, _i: number, _v: number | bigint, lo: number, hi: number): void {
    this.events.push({ kind: "as", id, value: Long.fromBits(lo, hi).toBigInt(true) });
  }
}

/** A message exercising every integer surface the flag touches. */
function corpusMessage(): Uint8Array {
  const os = growingOStream();
  UNSIGNED.forEach((v, i) => os.writeUnsigned(i + 1, v));
  SIGNED.forEach((v, i) => os.writeSigned(i + 40, v));
  os.writeUnsignedArray(80, UNSIGNED);
  os.writeSignedArray(81, SIGNED);
  os.writeSequenceBeginLazy(90); // nested scope — the flag must survive it
  os.writeUnsigned(1, 2n ** 63n);
  os.writeSigned(2, -(2n ** 63n));
  os.writeSequenceEnd();
  os.writeUnsigned(99, 7n); // ...and be restored after it
  return os.bytes().slice();
}

/** Feed `bytes` to an `IStream` in fixed-size chunks and return the visitor. */
function feed<V extends PlainRecorder | LongRecorder>(
  bytes: Uint8Array,
  chunkSize: number,
  visitor: V,
): V {
  const is = new IStream(visitor);
  let status: DecodeStatus = DecodeStatus.Complete;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    status = is.feed(bytes.subarray(i, i + chunkSize));
  }
  expect(status).toBe(DecodeStatus.Complete);
  return visitor;
}

describe("the lo/hi halves alongside every integer value", () => {
  const bytes = corpusMessage();

  it("carry the same values the number-first channel carries", () => {
    const plain = new PlainRecorder();
    decode(bytes, plain);
    const longs = new LongRecorder();
    decode(bytes, longs);

    expect(longs.events).toEqual(plain.events);
    // Sanity: the corpus really did reach every hook.
    expect(new Set(plain.events.map((e) => e.kind))).toEqual(new Set(["u", "s", "au", "as"]));
  });

  it("carry those same values through IStream at every chunk size", () => {
    const reference = new PlainRecorder();
    decode(bytes, reference);

    for (let chunkSize = 1; chunkSize <= bytes.length; chunkSize++) {
      const longs = feed(bytes, chunkSize, new LongRecorder());
      expect(longs.events, `chunk size ${chunkSize}`).toEqual(reference.events);
      // The plain channel is fed alongside, so a chunk size that broke *both*
      // identically could not pass by comparing the two against each other.
      expect(feed(bytes, chunkSize, new PlainRecorder()).events, `chunk size ${chunkSize}`).toEqual(
        reference.events,
      );
    }
  });

  it("reach a nested scope unchanged — there is no channel to lose", () => {
    // What the old opt-in flag had to promise per scope, the halves get for free:
    // they are arguments, so a nested scope cannot be on a different channel from
    // its parent, and a flat visitor has only one channel to begin with.
    const os = growingOStream();
    os.writeUnsigned(1, 2n ** 63n);
    os.writeSequenceBeginLazy(2);
    os.writeUnsigned(3, 2n ** 63n);
    os.writeSequenceEnd();
    os.writeUnsigned(4, 2n ** 63n);
    const wire = os.bytes().slice();

    const want = [2n ** 63n, 2n ** 63n, 2n ** 63n];
    const halves = (b: Uint8Array): bigint[] => {
      const seen: bigint[] = [];
      decode(b, { unsigned: (_id, _v, lo, hi) => void seen.push(Long.fromBits(lo, hi).toBigInt()) });
      return seen;
    };
    expect(halves(wire)).toEqual(want);

    for (let chunkSize = 1; chunkSize <= wire.length; chunkSize++) {
      const seen: bigint[] = [];
      const is = new IStream({
        unsigned: (_id, _v, lo, hi) => void seen.push(Long.fromBits(lo, hi).toBigInt()),
      });
      for (let i = 0; i < wire.length; i += chunkSize) is.feed(wire.subarray(i, i + chunkSize));
      expect(seen, `chunk size ${chunkSize}`).toEqual(want);
    }
  });

  it("changes no SofabError code, on any path, at any chunk size", () => {
    // How a *valid* value is read decides nothing about validity, so every
    // malformed / truncated input must produce the identical verdict whichever
    // callbacks a visitor implements — and the streaming verdict must match the
    // whole-buffer one, which is the parity bar #143 sets.
    const malformed: Record<string, Uint8Array> = {
      // A scalar varint of ten continuation bytes needs an 11th: >64 bits.
      "an overlong unsigned scalar": Uint8Array.from([0x01, ...Array(10).fill(0x80)]),
      "an overlong signed scalar": Uint8Array.from([0x0a, ...Array(10).fill(0x80)]),
      // id 8 / ArrayUnsigned, count 11, then the same ten bytes.
      "an overlong unsigned element": Uint8Array.from([0x43, 0x0b, ...Array(10).fill(0x80)]),
      "an overlong signed element": Uint8Array.from([0x44, 0x0b, ...Array(10).fill(0x80)]),
      "a field id past ID_MAX": Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x40, 0x01]),
      // id 1 / Fixlen, then a fixlen word naming reserved subtype 4 (§4.6).
      "a reserved fixlen subtype": Uint8Array.from([0x0a, 0x04]),
      "a dangling sequence end": Uint8Array.from([0x07]),
    };
    const truncated: Record<string, Uint8Array> = {
      "a scalar cut mid-varint": Uint8Array.from([0x01, 0x80]),
      "an array cut mid-element": Uint8Array.from([0x43, 0x03, 0x01]),
      "an unclosed sequence": Uint8Array.from([0x16, 0x01, 0x2a]),
    };

    /** The verdict `decode()` reaches, as a code or "ok". */
    const whole = (b: Uint8Array, v: Visitor): string => {
      try {
        decode(b, v);
        return "ok";
      } catch (e) {
        return e instanceof SofabError ? e.code : String(e);
      }
    };
    /** The verdict `IStream` reaches at `chunkSize`, from what `feed` returns or throws. */
    const chunked = (b: Uint8Array, v: Visitor, chunkSize: number): string => {
      const is = new IStream(v);
      let status: DecodeStatus = DecodeStatus.Complete;
      try {
        for (let i = 0; i < b.length; i += chunkSize) {
          status = is.feed(b.subarray(i, i + chunkSize));
        }
      } catch (e) {
        return e instanceof SofabError ? e.code : String(e);
      }
      return status === DecodeStatus.Complete ? "ok" : SofabErrorCode.Incomplete;
    };

    const plain: Visitor = {};
    // A visitor that reads the halves — the same decode, a different reading.
    const longs: Visitor = { unsigned: () => {}, signed: () => {} };

    for (const [what, b] of Object.entries(malformed)) {
      expect(whole(b, plain), what).toBe(SofabErrorCode.InvalidMsg);
      expect(whole(b, longs), `${what} (longs)`).toBe(SofabErrorCode.InvalidMsg);
      for (let k = 1; k <= b.length; k++) {
        expect(chunked(b, plain, k), `${what}, chunk ${k}`).toBe(SofabErrorCode.InvalidMsg);
        expect(chunked(b, longs, k), `${what}, chunk ${k} (longs)`).toBe(SofabErrorCode.InvalidMsg);
      }
    }

    for (const [what, b] of Object.entries(truncated)) {
      // The one-shot entry point throws INCOMPLETE where the resumable one merely
      // suspends and returns it from `feed` — the documented difference between
      // the two *entry points* (§7), not between two decoders.
      expect(whole(b, longs), `${what} (longs)`).toBe(whole(b, plain));
      expect(whole(b, plain), what).toBe(SofabErrorCode.Incomplete);
      for (let k = 1; k <= b.length; k++) {
        expect(chunked(b, longs, k), `${what}, chunk ${k} (longs)`).toBe(chunked(b, plain, k));
        expect(chunked(b, plain, k), `${what}, chunk ${k}`).toBe(SofabErrorCode.Incomplete);
      }
    }
  });

  it("leave the number-first value exactly as it was", () => {
    // The regression guard: `value` is still `number` below 2^53 and `bigint`
    // above, whatever a visitor does with the halves beside it.
    const os = growingOStream();
    os.writeUnsigned(1, 42n);
    os.writeUnsigned(2, 2n ** 63n);
    os.writeSigned(3, -42n);
    os.writeSigned(4, -(2n ** 63n));
    const seen: string[] = [];
    const v: Visitor = {
      unsigned: (_id, x) => void seen.push(typeof x),
      signed: (_id, x) => void seen.push(typeof x),
    };
    decode(os.bytes(), v);
    expect(seen).toEqual(["number", "bigint", "number", "bigint"]);
  });
});
