/**
 * The 64-bit `Long` path reached arrays only; scalars had no twin (corelib-ts#143).
 *
 * `writeUnsignedArrayLong` / `readUnsignedArrayLong` (+ signed) let a 64-bit
 * *array* stay on 32-bit word pairs, but a `u64`/`i64` **scalar** could only be
 * written from and decoded to `number | bigint` — so a generated field under
 * `int64: long` materialised a `bigint` per scalar per decode, which is the one
 * thing the mode exists to avoid. The four scalar codecs added here close that,
 * and the opt-in `Visitor.longs` channel carries the same representation through
 * the two push decoders so a field does not change runtime type per decode API.
 *
 * The bar this suite holds them to is that they are **representation-only**:
 * identical wire out of the encoder at every buffer size, identical values out
 * of every decoder, and — the streaming half of it — identical values *and*
 * identical `SofabError` codes through `decode()` and `IStream` at every chunk
 * size.
 */

import { describe, expect, it } from "vitest";
import {
  Cursor,
  DecodeStatus,
  IStream,
  Long,
  OStream,
  SofabError,
  SofabErrorCode,
  decode,
  type AnyVisitor,
  type LongVisitor,
  type Visitor,
} from "../src/index.js";

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
  const os = new OStream();
  write(os);
  return Array.from(os.bytes());
}

/** Encode through a fixed caller buffer of `size`, collecting everything flushed. */
function streamed(size: number, write: (os: OStream) => void): number[] {
  const out: number[] = [];
  const os = new OStream(new Uint8Array(size), 0, (b) => {
    for (const byte of b) out.push(byte);
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

describe("Cursor.readUnsignedLong / readSignedLong", () => {
  it("decode what the bigint readers decode", () => {
    for (const v of UNSIGNED) {
      const os = new OStream();
      os.writeUnsigned(13, v);
      const bytes = os.bytes().slice();
      const c = new Cursor(bytes);
      expect(c.readHeader()).toBe(true);
      expect(c.readUnsignedLong().toBigInt(), `u64 ${v}`).toBe(v);
      // ...and the cursor is left exactly where the bigint reader leaves it.
      expect(c.readHeader()).toBe(false);
    }
    for (const v of SIGNED) {
      const os = new OStream();
      os.writeSigned(13, v);
      const bytes = os.bytes().slice();
      const c = new Cursor(bytes);
      expect(c.readHeader()).toBe(true);
      expect(c.readSignedLong().toBigInt(true), `i64 ${v}`).toBe(v);
      expect(c.readHeader()).toBe(false);
    }
  });

  it("round-trip the Long writers", () => {
    const os = new OStream();
    UNSIGNED.forEach((v, i) => os.writeUnsignedLong(i, Long.fromValue(v)));
    SIGNED.forEach((v, i) => os.writeSignedLong(100 + i, Long.fromValue(v)));

    const c = new Cursor(os.bytes().slice());
    const u: bigint[] = [];
    const s: bigint[] = [];
    while (c.readHeader()) {
      if (c.id < 100) u.push(c.readUnsignedLong().toBigInt());
      else s.push(c.readSignedLong().toBigInt(true));
    }
    expect(u).toEqual(UNSIGNED);
    expect(s).toEqual(SIGNED);
  });

  it("agree with the array readers element for element", () => {
    // Scalar and array are the same varint; the two Long readers must not drift.
    const os = new OStream();
    os.writeUnsignedArray(1, UNSIGNED);
    os.writeSignedArray(2, SIGNED);
    const c = new Cursor(os.bytes().slice());

    c.readHeader();
    const uArray = c.readUnsignedArrayLong();
    c.readHeader();
    const sArray = c.readSignedArrayLong();

    const each = new OStream();
    UNSIGNED.forEach((v, i) => each.writeUnsigned(i, v));
    const cu = new Cursor(each.bytes().slice());
    const uScalar: Long[] = [];
    while (cu.readHeader()) uScalar.push(cu.readUnsignedLong());

    const eachS = new OStream();
    SIGNED.forEach((v, i) => eachS.writeSigned(i, v));
    const cs = new Cursor(eachS.bytes().slice());
    const sScalar: Long[] = [];
    while (cs.readHeader()) sScalar.push(cs.readSignedLong());

    expect(uScalar.map((l) => [l.low, l.high])).toEqual(uArray.map((l) => [l.low, l.high]));
    expect(sScalar.map((l) => [l.low, l.high])).toEqual(sArray.map((l) => [l.low, l.high]));
  });
});

// --- the streaming (Visitor) channel ---------------------------------------

/** One decoded integer event, normalised so both channels compare directly. */
type IntEvent = { kind: "u" | "s" | "au" | "as"; id: number; value: bigint };

/** Collects the integer events a plain (number-first) visitor sees. */
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
  sequenceBegin(): Visitor {
    return this;
  }
}

/** The same, on the opt-in `Long` channel. */
class LongRecorder implements LongVisitor {
  readonly longs = true;
  readonly events: IntEvent[] = [];
  /**
   * Every value really arrived as a `Long`. The hooks are *declared* `Long`, so
   * only a runtime check can tell an honest channel from one that quietly kept
   * handing back numbers — which is exactly the regression to guard against.
   */
  allLong = true;

  unsigned(id: number, v: Long): void {
    this.events.push({ kind: "u", id, value: this.check(v).toBigInt() });
  }
  signed(id: number, v: Long): void {
    this.events.push({ kind: "s", id, value: this.check(v).toBigInt(true) });
  }
  arrayUnsigned(id: number, _i: number, v: Long): void {
    this.events.push({ kind: "au", id, value: this.check(v).toBigInt() });
  }
  arraySigned(id: number, _i: number, v: Long): void {
    this.events.push({ kind: "as", id, value: this.check(v).toBigInt(true) });
  }
  sequenceBegin(): LongVisitor {
    return this;
  }

  private check(v: Long): Long {
    if (v instanceof Long) return v;
    this.allLong = false;
    return Long.fromValue(v);
  }
}

/** A message exercising every integer surface the flag touches. */
function corpusMessage(): Uint8Array {
  const os = new OStream();
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
  const is = new IStream();
  // Both recorder shapes are assignable to `AnyVisitor`, which is the point of
  // that alias: a helper generic over the two needs no cast and no narrowing.
  const v: AnyVisitor = visitor;
  let status: DecodeStatus = DecodeStatus.Complete;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    status = is.feed(bytes.subarray(i, i + chunkSize), v);
  }
  expect(status).toBe(DecodeStatus.Complete);
  return visitor;
}

describe("Visitor.longs", () => {
  const bytes = corpusMessage();

  it("delivers the same values decode() delivers without it", () => {
    const plain = new PlainRecorder();
    decode(bytes, plain);
    const longs = new LongRecorder();
    decode(bytes, longs);

    expect(longs.allLong).toBe(true);
    expect(longs.events).toEqual(plain.events);
    // Sanity: the corpus really did reach every hook.
    expect(new Set(plain.events.map((e) => e.kind))).toEqual(new Set(["u", "s", "au", "as"]));
  });

  it("delivers those same values through IStream at every chunk size", () => {
    const reference = new PlainRecorder();
    decode(bytes, reference);

    for (let chunkSize = 1; chunkSize <= bytes.length; chunkSize++) {
      const longs = feed(bytes, chunkSize, new LongRecorder());
      expect(longs.allLong, `chunk size ${chunkSize}`).toBe(true);
      expect(longs.events, `chunk size ${chunkSize}`).toEqual(reference.events);
      // The plain channel is fed alongside, so a chunk size that broke *both*
      // identically could not pass by comparing the two against each other.
      expect(feed(bytes, chunkSize, new PlainRecorder()).events, `chunk size ${chunkSize}`).toEqual(
        reference.events,
      );
    }
  });

  it("is decided by the ROOT visitor, and a child's own flag is ignored", () => {
    // Both decoders read `longs` once, at the root, and drive the whole tree on
    // that channel — refreshing it per scope is a megamorphic property load at
    // every sequence transition, and it measured (see Visitor.longs). So a child
    // inherits the root's channel in *both* directions, which is what this pins:
    // a plain child under a Long root still gets Longs, and an opted-in child
    // under a plain root still gets number-first values.
    const os = new OStream();
    os.writeUnsigned(1, 2n ** 63n);
    os.writeSequenceBeginLazy(2);
    os.writeUnsigned(3, 2n ** 63n);
    os.writeSequenceEnd();
    os.writeUnsigned(4, 2n ** 63n);
    const wire = os.bytes().slice();

    const seen: string[] = [];
    const note = (v: unknown): void => {
      seen.push(v instanceof Long ? "Long" : typeof v);
    };
    // The casts are the point: the types model the root-decides contract, so a
    // mixed tree is not expressible — only a cast can build one, and the runtime
    // must still resolve it the same way. `sequenceBegin` returning a child on
    // the other channel is exactly what TypeScript refuses here.
    const longRoot = {
      longs: true as const,
      unsigned: (_id: number, v: Long) => note(v),
      sequenceBegin: () => ({ unsigned: (_id: number, v: unknown) => note(v) }) as never,
    };
    const plainRoot = {
      unsigned: (_id: number, v: number | bigint) => note(v),
      sequenceBegin: () => ({ longs: true, unsigned: (_id: number, v: unknown) => note(v) }) as never,
    };

    for (const [what, root, want] of [
      ["a Long root", longRoot, ["Long", "Long", "Long"]],
      ["a plain root", plainRoot, ["bigint", "bigint", "bigint"]],
    ] as const) {
      seen.length = 0;
      decode(wire, root as Visitor);
      expect(seen, `${what}, decode()`).toEqual(want);

      // The resumable decoder must agree, at every chunk size.
      for (let chunkSize = 1; chunkSize <= wire.length; chunkSize++) {
        seen.length = 0;
        const is = new IStream();
        for (let i = 0; i < wire.length; i += chunkSize) {
          is.feed(wire.subarray(i, i + chunkSize), root as Visitor);
        }
        expect(seen, `${what}, chunk size ${chunkSize}`).toEqual(want);
      }
    }
  });

  it("changes no SofabError code, on any path, at any chunk size", () => {
    // The channel decides how a *valid* value is materialised and nothing else,
    // so every malformed / truncated input must produce the identical verdict
    // with the flag set and unset — and the streaming verdict must match the
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
    const whole = (b: Uint8Array, v: AnyVisitor): string => {
      try {
        decode(b, v);
        return "ok";
      } catch (e) {
        return e instanceof SofabError ? e.code : String(e);
      }
    };
    /** The verdict `IStream` reaches at `chunkSize`, incl. its `end()` status. */
    const chunked = (b: Uint8Array, v: AnyVisitor, chunkSize: number): string => {
      const is = new IStream();
      let status: DecodeStatus = DecodeStatus.Complete;
      try {
        for (let i = 0; i < b.length; i += chunkSize) {
          status = is.feed(b.subarray(i, i + chunkSize), v);
        }
      } catch (e) {
        return e instanceof SofabError ? e.code : String(e);
      }
      return status === DecodeStatus.Complete ? "ok" : SofabErrorCode.Incomplete;
    };

    const plain: Visitor = {};
    const longs: LongVisitor = { longs: true };

    for (const [what, b] of Object.entries(malformed)) {
      expect(whole(b, plain), what).toBe(SofabErrorCode.InvalidMsg);
      expect(whole(b, longs), `${what} (longs)`).toBe(SofabErrorCode.InvalidMsg);
      for (let k = 1; k <= b.length; k++) {
        expect(chunked(b, plain, k), `${what}, chunk ${k}`).toBe(SofabErrorCode.InvalidMsg);
        expect(chunked(b, longs, k), `${what}, chunk ${k} (longs)`).toBe(SofabErrorCode.InvalidMsg);
      }
    }

    for (const [what, b] of Object.entries(truncated)) {
      // Whole-buffer decode throws INCOMPLETE where the resumable one merely
      // suspends and reports it from end() — the documented difference between
      // the two surfaces (§7). Both must be unaffected by the flag.
      expect(whole(b, longs), `${what} (longs)`).toBe(whole(b, plain));
      expect(whole(b, plain), what).toBe(SofabErrorCode.Incomplete);
      for (let k = 1; k <= b.length; k++) {
        expect(chunked(b, longs, k), `${what}, chunk ${k} (longs)`).toBe(chunked(b, plain, k));
        expect(chunked(b, plain, k), `${what}, chunk ${k}`).toBe(SofabErrorCode.Incomplete);
      }
    }
  });

  it("costs a non-opting visitor nothing — values are unchanged", () => {
    // The regression guard for the opt-in itself: a visitor that says nothing
    // must still get number-first values, `number` below 2^53 and `bigint` above.
    const os = new OStream();
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
