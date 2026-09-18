/**
 * The codec is heap-free and hands out no views (CORELIB_PLAN §6.6, §6.7).
 *
 * §6.6.4 asks for **both** halves of the proof, and they catch different defects:
 *
 * - **read** — no allocation primitive is reachable from a codec entry point, apart
 *   from the **language-forced handles** §6.6.2 allows. In JavaScript "no allocator
 *   call" is not a `malloc` grep: it is `new Uint8Array`, a `subarray`/`slice` view,
 *   a `DataView`, a `TextDecoder`, an array that grows. All of those are spied on
 *   here, and the handles are asserted **by exact count and kind** — which is the
 *   itemisation §6.6.2 asks for, in executable form. An allocation nobody listed
 *   fails the count instead of hiding behind the paragraph.
 * - **measure** — an allocation count or heap high-water mark over a complete
 *   encode and decode, *after* the codec's one-time construction, which must be
 *   zero. A spy can be evaded by an allocation the runtime performs on the codec's
 *   behalf; the heap cannot.
 *
 * §6.7 is the other half of the same rule: what the decoder reports is a range of
 * the caller's **own** fed chunk (§6.6.3), never a view the codec built, and
 * nothing it hands over outlives the call. The one-shot path has no exemption
 * (§6.7.1) — that is the test a port that borrows from the buffer it was handed
 * passes every other item of §7.2 without.
 */

import { describe, expect, it } from "vitest";
import v8 from "node:v8";
import vm from "node:vm";
import { FP32_HANDLE_MIN, FP64_HANDLE_MIN } from "../src/constants.js";
import {
  ArrayKind,
  DecodeStatus,
  IStream,
  OStream,
  PayloadAcc,
  decode,
  decodeUtf8,
  growingOStream,
  type Visitor,
} from "../src/index.js";

// Built once: what the *caller* allocates is not on trial, and hoisting it keeps
// the heap measurement below about the codec rather than about these literals.
const BLOB = Uint8Array.from({ length: 200 }, (_, i) => i & 0xff);
const U_ARRAY = [1, 2, 3, 1_000_000];
const S_ARRAY = [-1, -2, -3];
const F32_ARRAY = [1, 2, 3];
const F64_ARRAY = [1, 2];
// Long enough that a handle over the buffer pays for itself — the *only* shape that
// builds one on either side (FP32_HANDLE_MIN / FP64_HANDLE_MIN).
const F32_BULK = Array.from({ length: FP32_HANDLE_MIN }, (_, i) => i + 0.5);
const F64_BULK = Array.from({ length: FP64_HANDLE_MIN }, (_, i) => i + 0.25);
/** A 64-bit array whose elements do not fit a `number`, so nothing can cheat. */
const U64_ELEMS = [0n, 1n, 0x9e3779b97f4a7c15n, 2n ** 64n - 1n];

/** A message with every wire type, including payloads longer than a small buffer. */
function message(os: OStream): void {
  os.writeUnsigned(1, 42);
  os.writeUnsigned(2, 0xffff_ffff_ffff_ffffn);
  os.writeSigned(3, -70_000);
  os.writeBoolean(4, true);
  os.writeFp32(5, 1.5);
  os.writeFp64(6, -2.25);
  os.writeString(7, "a payload that outgrows a small buffer, and then some");
  os.writeBlob(8, BLOB);
  os.writeUnsignedArray(9, U_ARRAY);
  os.writeSignedArray(10, S_ARRAY);
  os.writeFp32Array(11, F32_ARRAY);
  os.writeFp64Array(12, F64_ARRAY);
  os.writeSequenceBeginLazy(13);
  os.writeUnsigned(1, 7);
  os.writeString(2, "nested");
  os.writeSequenceEndKeep();
}

const WIRE = (() => {
  const os = growingOStream();
  message(os);
  return os.bytes().slice();
})();

/** A visitor that allocates nothing itself, so only the codec is on trial. */
function foldingVisitor(): Visitor & { acc: number } {
  // Destinations for the array hand-off, allocated **here** — before any measured
  // region — and long enough for every array in these messages, so the fold costs
  // the decode nothing. `length >= count` is all the hand-off asks of them.
  const lo = new Uint32Array(256);
  const hi = new Uint32Array(256);
  const f32 = new Float32Array(256);
  const f64 = new Float64Array(256);
  return {
    acc: 0,
    unsigned(_id, v, lo) { this.acc += lo + (typeof v === "number" ? 1 : 2); },
    signed(_id, _v, lo) { this.acc += lo; },
    fp32(_id, _v, bits) { this.acc += bits; },
    fp64(_id, v) { this.acc += v; },
    fixlenBegin(_id, _sub, total) { this.acc += total; },
    string(_id, _t, _o, src, start, end) { this.acc += src[start]! + end; },
    blob(_id, _t, _o, src, start, end) { this.acc += src[start]! + end; },
    arrayBegin(_id, _kind, count) { this.acc += count; },
    arrayBulk(_id, kind) {
      if (kind === ArrayKind.Fp32) return { f32 };
      if (kind === ArrayKind.Fp64) return { f64 };
      // The widest interval of the element's own signedness: this visitor is
      // about allocation, not about validity, and must refuse nothing.
      return kind === ArrayKind.Unsigned
        ? { lo, hi, minLo: 0, minHi: 0, maxLo: 0xffffffff, maxHi: 0xffffffff }
        : { lo, hi, minLo: 0, minHi: 0x80000000, maxLo: 0xffffffff, maxHi: 0x7fffffff };
    },
    arrayEnd(_id) { this.acc += 1 + lo[0]! + f32[0]! + f64[0]!; },
    sequenceBegin(_id, depth) { this.acc += depth; },
    sequenceEnd(_id, depth) { this.acc += depth; },
  };
}

/** What a run allocated, by kind. An absent kind never happened. */
type Tally = Partial<
  Record<
    "DataView" | "subarray" | "slice" | "Uint8Array" | "Uint32Array" | "Array" | "text",
    number
  >
>;

/**
 * Tally every allocation primitive a codec path could reach, while `body` runs.
 *
 * The `subarray` / `slice` / `DataView` counters are the JavaScript-specific half: a
 * view is an object, so building one is an allocation even though no bytes are
 * copied. That is why the decoder reports `(src, start, end)` instead of handing one
 * out — and, where the language leaves no alternative, why the ones it does build are
 * itemised (§6.6.2) rather than waved through.
 */
function allocationsDuring(body: () => void): Tally {
  const tally: Tally = {};
  const bump = (k: keyof Tally): void => {
    tally[k] = (tally[k] ?? 0) + 1;
  };
  const savedU8 = globalThis.Uint8Array;
  const savedArray = globalThis.Array;
  const savedDataView = globalThis.DataView;
  // Watched because the 64-bit and `fp32`-word paths build one over storage the
  // CALLER supplied — §6.6.2's language-forced handle, and so itemised like the rest.
  const savedU32 = globalThis.Uint32Array;
  const subarray = Uint8Array.prototype.subarray;
  const slice = Uint8Array.prototype.slice;
  const decodeText = TextDecoder.prototype.decode;
  const encodeText = TextEncoder.prototype.encode;

  const count = <T extends (...args: never[]) => unknown>(fn: T, k: keyof Tally): T =>
    function (this: unknown, ...args: never[]) {
      bump(k);
      return (fn as (...a: never[]) => unknown).apply(this, args);
    } as unknown as T;
  const ctor = <T extends abstract new (...args: never[]) => unknown>(c: T, k: keyof Tally): T =>
    new Proxy(c, {
      construct(t, a: unknown[]) {
        bump(k);
        return Reflect.construct(t as never, a as never) as object;
      },
    });

  Uint8Array.prototype.subarray = count(subarray, "subarray");
  Uint8Array.prototype.slice = count(slice, "slice");
  TextDecoder.prototype.decode = count(decodeText, "text");
  TextEncoder.prototype.encode = count(encodeText, "text");
  (globalThis as { Uint8Array: unknown }).Uint8Array = ctor(savedU8, "Uint8Array");
  (globalThis as { Array: unknown }).Array = ctor(savedArray, "Array");
  (globalThis as { DataView: unknown }).DataView = ctor(savedDataView, "DataView");
  (globalThis as { Uint32Array: unknown }).Uint32Array = ctor(savedU32, "Uint32Array");
  try {
    body();
  } finally {
    Uint8Array.prototype.subarray = subarray;
    Uint8Array.prototype.slice = slice;
    TextDecoder.prototype.decode = decodeText;
    TextEncoder.prototype.encode = encodeText;
    (globalThis as { Uint8Array: unknown }).Uint8Array = savedU8;
    (globalThis as { Array: unknown }).Array = savedArray;
    (globalThis as { DataView: unknown }).DataView = savedDataView;
    (globalThis as { Uint32Array: unknown }).Uint32Array = savedU32;
  }
  return tally;
}

describe("read: the itemised handles, and nothing else (§6.6.2 / §6.6.4)", () => {
  // §6.6.2 lets a codec allocate a **language-forced handle** — a view, a slice
  // object, a span — where the language's only bulk primitive takes one instead of a
  // pointer and a length, provided the object carries no message bytes and no wire
  // number sizes it. It asks the port to *itemise* them. This port has four, and
  // they are asserted by exact count and kind below, so an allocation nobody listed
  // fails the count instead of hiding behind the paragraph:
  //
  //   1. a `DataView` over the **output** buffer, in the kernel's bulk float
  //      packers — the only way to place an IEEE-754 value at a byte offset. One per
  //      call, not per element, and only for an array of at least
  //      {@link FP32_HANDLE_MIN} / {@link FP64_HANDLE_MIN} elements.
  //   2. a `DataView` over the **fed chunk** — the mirror of 1 on the read side. One
  //      per chunk, built on the first float **array** run long enough to pay for it.
  //   3. a `subarray` of the caller's payload, as the source of `TypedArray.set` —
  //      the only `memcpy` this language exposes takes a typed array. One per copied
  //      piece, and only when the payload does not fit the buffer.
  //   4. a `Uint32Array` word view over a caller's **typed array**, where a word has
  //      to cross as bits rather than as a number (a 64-bit element, an fp32 NaN).
  //      One per call on the write side and one per array on the read side — an
  //      `f32` destination builds it on its first NaN, and never without one.
  //
  // Everything else on both sides counts **zero**, which is what the absence of any
  // other key in these tallies says. Note what handles 1 and 2 are *not*: a scalar
  // float and a short array build none, because a handle costs ~129 ns and saves
  // ~2 ns per fp32 — the permission is §6.6.2's, the threshold is arithmetic's.

  it("an encode into one buffer allocates nothing: every float run is short", () => {
    // A message with both scalar floats and both float arrays — but the arrays are 3
    // and 2 elements, far under the thresholds, so the packers stay on the shared
    // scratch word and no handle is built. The payload fits too, so `set` takes the
    // caller's array whole: no range, no `subarray` either.
    const os = new OStream(new Uint8Array(4096)); // construction may allocate
    expect(allocationsDuring(() => message(os))).toStrictEqual({});
  });

  it("an encode with bulk float arrays: exactly one handle per packer call", () => {
    // Handle 1, pinned. Two calls above the threshold, two handles — per *call*,
    // never per element, which is what makes it a handle rather than a violation
    // (`no wire number sizes it`): 64 floats and 6400 both cost one.
    const os = new OStream(new Uint8Array(1 << 16));
    expect(
      allocationsDuring(() => {
        os.writeFp32Array(1, F32_BULK);
        os.writeFp64Array(2, F64_BULK);
      }),
    ).toStrictEqual({ DataView: 2 });

    const big = new OStream(new Uint8Array(1 << 16));
    const wide = Array.from({ length: 100 * FP32_HANDLE_MIN }, (_, i) => i);
    expect(allocationsDuring(() => big.writeFp32Array(1, wide))).toStrictEqual({
      DataView: 1,
    });
  });

  it("one element under the threshold, and the handle is not built", () => {
    // The boundary itself, both ways round — the arithmetic in FP32_HANDLE_MIN is
    // load-bearing, so a change to it has to be a deliberate one.
    const os = new OStream(new Uint8Array(1 << 16));
    expect(
      allocationsDuring(() => os.writeFp32Array(1, F32_BULK.slice(0, FP32_HANDLE_MIN - 1))),
    ).toStrictEqual({});
    expect(
      allocationsDuring(() => os.writeFp64Array(2, F64_BULK.slice(0, FP64_HANDLE_MIN - 1))),
    ).toStrictEqual({});
    expect(allocationsDuring(() => os.writeFp32Array(3, F32_BULK))).toStrictEqual({
      DataView: 1,
    });
  });

  it("a streaming encode: one copy source per piece, and nothing else", () => {
    // Through a 4-byte buffer every payload is split, so handle 3 appears — bounded
    // by **pieces, never by bytes**, which is what the flush count below pins. No
    // float handle: a 4-byte buffer takes one element per drain, which is nowhere
    // near the threshold. A regression that started allocating per varint, per field
    // or per byte would blow these numbers; so would one that leaked a view to the
    // sink (§5.1.6, checked separately below).
    let sunk = 0;
    let flushes = 0;
    const os = new OStream(new Uint8Array(4), 0, (_b, start, end) => {
      flushes++;
      sunk += end - start;
    });
    const allocs = allocationsDuring(() => {
      message(os);
      os.flush();
    });
    expect(sunk).toBe(WIRE.length);
    expect(Object.keys(allocs).sort()).toStrictEqual(["subarray"]);
    expect(allocs.subarray).toBeLessThanOrEqual(flushes);
    // Two orders of magnitude of headroom against "per byte": the message is 40x the
    // buffer, and the whole point is that the count tracks pieces.
    expect(allocs.subarray).toBeLessThan(WIRE.length / 4);
  });

  it("an encode from a 64-bit typed source: one view, and no bigint", () => {
    // The mirror of the decode case: the halves are read back through a
    // `Uint32Array` over the source's own buffer rather than indexed out of it,
    // which would materialise a `bigint` per element.
    const src = BigUint64Array.from(U64_ELEMS);
    // Built outside the measurement: constructing a stream is the one allocating
    // step there is (§6.6), and this is about what a *write* costs.
    const os = new OStream(new Uint8Array(256));
    expect(allocationsDuring(() => void os.writeUnsignedArray(1, src))).toStrictEqual({
      Uint32Array: 1,
    });
  });

  it("an encode of an fp32 array from a Float32Array: a word view only for a NaN", () => {
    // Below FP32_HANDLE_MIN a short run takes no handle. Only a NaN can lose bits
    // when read as a number (a signaling one is quieted, §4.6/§6.5), so a word view
    // over the source is built when — and only when — the run holds one. The
    // `number[]` source below is the contrast: no handle at all.
    const short = new Float32Array([1.5, 2.5]);
    const withNaN = new Float32Array(2);
    new Uint32Array(withNaN.buffer)[0] = 0x7f800001;
    const typedStream = new OStream(new Uint8Array(256));
    const plainStream = new OStream(new Uint8Array(256));
    expect(allocationsDuring(() => void typedStream.writeFp32Array(1, short))).toStrictEqual({});
    expect(allocationsDuring(() => void typedStream.writeFp32Array(2, withNaN))).toStrictEqual({
      Uint32Array: 1,
    });
    expect(allocationsDuring(() => void plainStream.writeFp32Array(1, [1.5, 2.5]))).toStrictEqual(
      {},
    );
  });

  it("a streamed fp32 array from a Float32Array: one word view per call, never per piece", () => {
    // The element-at-a-time route copies words too (corelib-ts#185), so it takes
    // the same `Uint32Array` as the bulk kernel — once, however many drains the
    // array needs. A 4-byte buffer forces one drain per element here, and no
    // `DataView` appears: the words are stored with shifts, not through a handle.
    let flushes = 0;
    const os = new OStream(new Uint8Array(4), 0, () => void flushes++);
    const f = new Float32Array(3 * FP32_HANDLE_MIN);
    expect(allocationsDuring(() => void os.writeFp32Array(1, f))).toStrictEqual({
      Uint32Array: 1,
    });
    expect(flushes).toBeGreaterThanOrEqual(f.length);
  });

  it("an encode with no float at all allocates nothing", () => {
    // The control that keeps the itemisation honest: the handles are forced by
    // *operations*, not held as a matter of course, so a message without floats and
    // without a split payload allocates on no path at all.
    const os = new OStream(new Uint8Array(4096));
    expect(
      allocationsDuring(() => {
        os.writeUnsigned(1, 42);
        os.writeSigned(2, -70_000);
        os.writeString(3, "no floats here");
        os.writeBlob(4, BLOB);
        os.writeUnsignedArray(5, U_ARRAY);
        os.writeSequenceBeginLazy(6);
        os.writeUnsigned(1, 7);
        os.writeSequenceEndKeep();
      }),
    ).toStrictEqual({});
  });

  it("a one-shot decode of short float runs allocates nothing", () => {
    const v = foldingVisitor();
    const is = new IStream(v);
    expect(allocationsDuring(() => void is.feed(WIRE))).toStrictEqual({});
    expect(v.acc).not.toBe(0);
  });

  it("a one-shot decode of a bulk float array: one handle for the whole chunk", () => {
    // Handle 2, pinned. Both arrays clear their threshold, but the view is cached
    // per chunk, so the second run reuses the first one's — one handle for the
    // message, not one per array and certainly not one per element.
    const bulk = (() => {
      const os = growingOStream();
      os.writeFp32Array(1, F32_BULK);
      os.writeFp64Array(2, F64_BULK);
      return os.bytes().slice();
    })();
    const v = foldingVisitor();
    const is = new IStream(v);
    expect(allocationsDuring(() => void is.feed(bulk))).toStrictEqual({ DataView: 1 });
    expect(v.acc).not.toBe(0);
  });

  it("the same bulk array fed in short chunks builds no handle at all", () => {
    // The run that decides is the one **left in this chunk**, not the array's count:
    // 8 bytes at a time delivers one or two elements per drain, so every step takes
    // the byte-load route and the message decodes identically with zero allocations.
    const bulk = (() => {
      const os = growingOStream();
      os.writeFp32Array(1, F32_BULK);
      return os.bytes().slice();
    })();
    const whole = foldingVisitor();
    new IStream(whole).feed(bulk);

    const piecemeal = foldingVisitor();
    const is = new IStream(piecemeal);
    const chunks = Array.from({ length: Math.ceil(bulk.length / 8) }, (_, i) =>
      bulk.subarray(i * 8, i * 8 + 8),
    );
    let st: DecodeStatus = DecodeStatus.Complete;
    expect(
      allocationsDuring(() => {
        for (const c of chunks) st = is.feed(c);
      }),
    ).toStrictEqual({});
    expect(st).toBe(DecodeStatus.Complete);
    expect(piecemeal.acc).toBe(whole.acc); // same values, other route
  });

  it("a decode of fp32 NaNs into an f32 destination: one word view per array, not per NaN", () => {
    // A NaN is stored by its wire word (§4.6), through a view over the visitor's
    // Float32Array — built on the array's first NaN and reused for the rest, so the
    // count is the same for one NaN and for an array of nothing else. Both routes
    // are covered: the short byte-load run and the long run over the chunk handle.
    const nans = (n: number): Uint8Array => {
      const src = new Float32Array(n);
      new Uint32Array(src.buffer).fill(0x7f800001); // signaling, so a value would lose it
      const os = growingOStream();
      os.writeFp32Array(1, src);
      return os.bytes().slice();
    };
    const short = nans(FP32_HANDLE_MIN - 1);
    const long = nans(4 * FP32_HANDLE_MIN);
    const shortStream = new IStream(foldingVisitor());
    const longStream = new IStream(foldingVisitor());
    expect(allocationsDuring(() => void shortStream.feed(short))).toStrictEqual({ Uint32Array: 1 });
    expect(allocationsDuring(() => void longStream.feed(long))).toStrictEqual({
      DataView: 1,
      Uint32Array: 1,
    });
  });

  it("the NaN word view lives per array: a stream of chunks builds it once", () => {
    // 8 bytes at a time puts most elements on the byte-load route and some across a
    // chunk boundary (bulkStoreFp) — three call sites, one view, because the view
    // belongs to the array and not to the chunk. A second array builds its own.
    const src = new Float32Array(3 * FP32_HANDLE_MIN);
    new Uint32Array(src.buffer).fill(0x7fa00001);
    const bulk = (() => {
      const os = growingOStream();
      os.writeFp32Array(1, src);
      os.writeFp32Array(2, src);
      return os.bytes().slice();
    })();
    const f32 = new Float32Array(src.length);
    const words = new Uint32Array(f32.buffer);
    const is = new IStream({ arrayBulk: () => ({ f32 }) });
    const chunks = Array.from({ length: Math.ceil(bulk.length / 7) }, (_, i) =>
      bulk.subarray(i * 7, i * 7 + 7),
    );
    let st: DecodeStatus = DecodeStatus.Complete;
    expect(
      allocationsDuring(() => {
        for (const c of chunks) st = is.feed(c);
      }),
    ).toStrictEqual({ Uint32Array: 2 });
    expect(st).toBe(DecodeStatus.Complete);
    expect(words.every((w) => w === 0x7fa00001)).toBe(true); // bit-exact, every element
  });

  it("a bulk hand-off into typed destinations allocates nothing beyond the one handle", () => {
    // The hand-off writes into storage the *visitor* supplied, so it adds no
    // allocation of its own: an integer array into `lo`/`hi` builds nothing at all,
    // and a float array into a `Float64Array` builds the one chunk handle its
    // per-element twin builds — §6.6.2's itemisation is unchanged by it existing.
    const bulk = (() => {
      const os = growingOStream();
      os.writeUnsignedArray(1, U_ARRAY);
      os.writeFp64Array(2, F64_BULK);
      return os.bytes().slice();
    })();
    const lo = new Uint32Array(U_ARRAY.length);
    const hi = new Uint32Array(U_ARRAY.length);
    const f64 = new Float64Array(F64_BULK.length);
    const is = new IStream({
      arrayBulk: (id) =>
        id === 1
          ? { lo, hi, minLo: 0, minHi: 0, maxLo: 0xffffffff, maxHi: 0xffffffff }
          : { f64 },
    });
    expect(allocationsDuring(() => void is.feed(bulk))).toStrictEqual({ DataView: 1 });
    expect([...lo]).toEqual(U_ARRAY);
    expect([...f64]).toEqual(F64_BULK);
  });

  it("a bulk float run under the threshold builds no handle either", () => {
    // One element under FP64_HANDLE_MIN: the hand-off takes the byte-load route for
    // exactly the same reason the per-element drain does.
    const short = F64_BULK.slice(0, FP64_HANDLE_MIN - 1);
    const bulk = (() => {
      const os = growingOStream();
      os.writeFp64Array(1, short);
      return os.bytes().slice();
    })();
    const f64 = new Float64Array(short.length);
    const is = new IStream({ arrayBulk: () => ({ f64 }) });
    expect(allocationsDuring(() => void is.feed(bulk))).toStrictEqual({});
    expect([...f64]).toEqual(short);
  });

  it("a 64-bit typed destination: one view over the caller's own array", () => {
    // A `BigUint64Array` element cannot be stored without a `bigint` — `b[i] = 5`
    // throws — so the fill writes the halves it already holds through a
    // `Uint32Array` over that array's own buffer. One per array, over storage the
    // caller supplied, sized by it and never by the wire: §6.6.2's shape exactly.
    const wire = (() => {
      const os = growingOStream();
      os.writeUnsignedArray(1, U64_ELEMS);
      return os.bytes().slice();
    })();
    const dest = new BigUint64Array(U64_ELEMS.length);
    const is = new IStream({
      arrayBulk: () => ({
        typed: dest,
        minLo: 0,
        minHi: 0,
        maxLo: 0xffffffff,
        maxHi: 0xffffffff,
      }),
    });
    expect(allocationsDuring(() => void is.feed(wire))).toStrictEqual({ Uint32Array: 1 });
    expect([...dest]).toEqual(U64_ELEMS);
  });

  it("the other typed destinations build nothing at all", () => {
    // Every width below 64 bits is stored directly, so no view is needed for it —
    // and the `bool` destination is a plain byte store.
    const wire = (() => {
      const os = growingOStream();
      os.writeUnsignedArray(1, [1, 2, 3, 4]);
      os.writeUnsignedArray(2, [0, 1, 255]);
      return os.bytes().slice();
    })();
    const u16 = new Uint16Array(4);
    const bools = new Uint8Array(3);
    const is = new IStream({
      arrayBulk: (id) =>
        id === 1
          ? { typed: u16, minLo: 0, minHi: 0, maxLo: 0xffff, maxHi: 0 }
          : { bool: bools },
    });
    expect(allocationsDuring(() => void is.feed(wire))).toStrictEqual({});
    expect([...u16]).toEqual([1, 2, 3, 4]);
    expect([...bools]).toEqual([0, 1, 1]);
  });

  it("a chunked decode allocates nothing at all", () => {
    // One byte per feed: no float ever fits a chunk, so the handle is never built
    // and the resumable float accumulator — fixed-size state, not a handle — carries
    // the value instead. The same message, the same values, zero allocations.
    const v = foldingVisitor();
    const is = new IStream(v);
    // The chunk views belong to the caller, so they are built outside the
    // measurement: what is on trial is what the decoder does with them.
    const chunks = Array.from({ length: WIRE.length }, (_, i) => WIRE.subarray(i, i + 1));
    let st: DecodeStatus = DecodeStatus.Complete;
    expect(
      allocationsDuring(() => {
        for (const c of chunks) st = is.feed(c);
      }),
    ).toStrictEqual({});
    expect(st).toBe(DecodeStatus.Complete);
  });

  it("a decode with no float in the message allocates nothing", () => {
    const noFloats = (() => {
      const os = growingOStream();
      os.writeUnsigned(1, 42);
      os.writeString(2, "no floats here");
      os.writeUnsignedArray(3, U_ARRAY);
      return os.bytes().slice();
    })();
    const is = new IStream(foldingVisitor());
    expect(allocationsDuring(() => void is.feed(noFloats))).toStrictEqual({});
  });

  it("reuses the chunk handle across feeds of the same buffer", () => {
    // "Whether it allocates one per call or keeps one and reuses it is an
    // optimization" (§6.6.2) — this port keeps one, so re-feeding the same buffer
    // costs nothing after the first bulk float run.
    const bulk = (() => {
      const os = growingOStream();
      os.writeFp64Array(1, F64_BULK);
      return os.bytes().slice();
    })();
    const is = new IStream(foldingVisitor());
    expect(allocationsDuring(() => void is.feed(bulk))).toStrictEqual({ DataView: 1 });
    const again = new IStream(foldingVisitor());
    again.feed(bulk);
    expect(allocationsDuring(() => void again.feed(bulk))).toStrictEqual({});
  });
});

/** The same message without the one value that forces a `bigint` (§6.6.3). */
function smallMessage(os: OStream): void {
  os.writeUnsigned(1, 42);
  os.writeSigned(3, -70_000);
  os.writeFp32(5, 1.5);
  os.writeFp64(6, -2.25);
  os.writeString(7, "a payload that outgrows a small buffer, and then some");
  os.writeBlob(8, BLOB);
  os.writeUnsignedArray(9, U_ARRAY);
  os.writeFp32Array(11, F32_ARRAY);
  os.writeSequenceBeginLazy(13);
  os.writeUnsigned(1, 7);
  os.writeSequenceEndKeep();
}

const SMALL_WIRE = (() => {
  const os = growingOStream();
  smallMessage(os);
  return os.bytes().slice();
})();

/**
 * Bytes of heap the loop leaves behind, per iteration, after a settling GC.
 *
 * The **best** of several batches, because `heapUsed` after a collection is not a
 * quiet number: the runtime's own bookkeeping (code objects from a tier-up, a
 * profiler sample) lands in the same figure and only ever pushes it up. A codec
 * that allocated per field could not produce a clean batch at all, so taking the
 * minimum removes the noise without weakening what is being asserted.
 */
function heapPerOp(rounds: number, body: () => void): number {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  v8.setFlagsFromString("--no-expose-gc");
  // Warm up, so JIT tiering and inline-cache growth are not counted as heap.
  for (let i = 0; i < 1_000; i++) body();
  let best = Infinity;
  for (let batch = 0; batch < 5; batch++) {
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < rounds; i++) body();
    gc();
    best = Math.min(best, (process.memoryUsage().heapUsed - before) / rounds);
  }
  return best;
}

describe("measure: the heap does not move over a decode (§6.6.4)", () => {
  it("stays flat across many encode/decode cycles", () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    v8.setFlagsFromString("--no-expose-gc");

    const os = new OStream(new Uint8Array(4096));
    const is = new IStream(foldingVisitor());
    const perOp = heapPerOp(5_000, () => {
      os.reset();
      smallMessage(os);
      is.feed(SMALL_WIRE);
    });
    // Zero, to within measurement noise: a codec that allocated per field would
    // leave hundreds of bytes per op behind.
    expect(perOp).toBeLessThan(4);
  });

  it("keeps a bigint-carrying message flat too — the value does not accumulate", () => {
    // §6.6.3: "a value is not storage". JavaScript has no exact 64-bit integer
    // *value* below a `bigint`, so a u64 above 2^53 materialises one — and the
    // decoder hands over the raw `lo`/`hi` halves beside it for a consumer that
    // would rather not have one. What matters for §6.6 is that it is transient:
    // the decoder retains nothing, so a message full of them leaves the heap where
    // it found it.
    const is = new IStream(foldingVisitor());
    const perOp = heapPerOp(5_000, () => void is.feed(WIRE));
    expect(perOp).toBeLessThan(8);
  });
});

describe("no views: the caller's own chunk, and nothing that outlives the call (§6.6.3/§6.7)", () => {
  it("reports payload pieces as a range of the fed chunk itself", () => {
    // Identity, not equality: `src` must BE the array the caller passed to feed.
    // A port that handed out `chunk.subarray(...)` would pass every value
    // assertion in the suite and fail this one.
    let seen = 0;
    const v: Visitor = {
      string: (_id, _t, _o, src) => {
        seen++;
        expect(src).toBe(WIRE);
      },
      blob: (_id, _t, _o, src) => {
        seen++;
        expect(src).toBe(WIRE);
      },
    };
    decode(WIRE, v);
    expect(seen).toBeGreaterThan(0);
  });

  it("keeps a materialized value after the one-shot buffer is scrubbed (§6.7.1)", () => {
    // The one-shot path has no view exemption: `decode(buffer)` copies exactly as
    // `feed` does. Scrubbing the buffer afterwards must not touch what the caller
    // kept — a port that borrowed from it reads back the fill pattern here.
    const scratch = WIRE.slice();
    const acc = new PayloadAcc();
    const strings: string[] = [];
    const blobs: Uint8Array[] = [];
    decode(scratch, {
      string(_id, total, offset, src, start, end) {
        const payload = acc.take(total, offset, src, start, end);
        if (payload !== null) strings.push(decodeUtf8(payload));
      },
      blob(_id, total, offset, src, start, end) {
        const payload = acc.take(total, offset, src, start, end);
        if (payload !== null) blobs.push(payload);
      },
    });
    const stringsBefore = [...strings];
    const blobsBefore = blobs.map((b) => [...b]);

    scratch.fill(0xee);

    expect(strings).toStrictEqual(stringsBefore);
    expect(blobs.map((b) => [...b])).toStrictEqual(blobsBefore);
    expect(blobsBefore[0]).toHaveLength(200);
  });

  it("keeps a materialized value after every fed chunk is scrubbed", () => {
    const acc = new PayloadAcc();
    const strings: string[] = [];
    const is = new IStream({
      string(_id, total, offset, src, start, end) {
        const payload = acc.take(total, offset, src, start, end);
        if (payload !== null) strings.push(decodeUtf8(payload));
      },
    });
    const scratch = new Uint8Array(3);
    let st: DecodeStatus = DecodeStatus.Complete;
    for (let i = 0; i < WIRE.length; i += 3) {
      const n = Math.min(3, WIRE.length - i);
      scratch.set(WIRE.subarray(i, i + n));
      st = is.feed(scratch.subarray(0, n));
      scratch.fill(0xee); // the caller reuses its buffer the moment feed returns
    }
    expect(st).toBe(DecodeStatus.Complete);
    expect(strings).toStrictEqual([
      "a payload that outgrows a small buffer, and then some",
      "nested",
    ]);
  });
});

describe("no foreign memory, ever (§5.1.6)", () => {
  it("hands the sink only the installed buffer, on every flush of every message", () => {
    // Pass-through is forbidden, so this holds unconditionally: there is no
    // permission to grant and no exemption to claim. A blob many times the buffer
    // size is the case an encoder was once allowed to hand over directly.
    const buf = new Uint8Array(64);
    let flushes = 0;
    let total = 0;
    const os = new OStream(buf, 0, (b, start, end) => {
      flushes++;
      total += end - start;
      expect(b).toBe(buf); // identity: the installed buffer, not a view of it
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(b.length);
    });
    os.writeBlob(1, Uint8Array.from({ length: 8192 }, (_, i) => i & 0xff));
    os.writeString(2, "x".repeat(4096));
    os.flush();
    expect(flushes).toBeGreaterThan(100);
    expect(total).toBeGreaterThan(12_000);
  });

  it("holds when the sink installs a replacement buffer each time", () => {
    // The take-and-replace shape (§5.1.5): whatever the sink installs is what the
    // next flush must arrive in — still never anything else.
    let current = new Uint8Array(32);
    const installed: Uint8Array[] = [current];
    const os = new OStream(current, 0, (b) => {
      expect(b).toBe(current);
      current = new Uint8Array(32);
      installed.push(current);
      os.setBuffer(current);
    });
    os.writeBlob(1, new Uint8Array(500));
    os.flush();
    expect(installed.length).toBeGreaterThan(10);
  });
});
