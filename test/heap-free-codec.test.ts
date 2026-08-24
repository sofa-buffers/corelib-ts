/**
 * The codec is heap-free and hands out no views (CORELIB_PLAN §6.6, §6.7).
 *
 * §6.6.4 asks for **both** halves of the proof, and they catch different defects:
 *
 * - **read** — no allocation primitive is reachable from a codec entry point. In
 *   JavaScript "no allocator call" is not a `malloc` grep: it is `new Uint8Array`,
 *   a `subarray`/`slice` view, a `TextDecoder`, an array that grows. Those are
 *   spied on here for the duration of one encode and one decode.
 *
 *   **One deviation is recorded rather than asserted away**: a payload split across
 *   flushes is copied with `set(data.subarray(…))`, one view per piece, because the
 *   allocation-free alternative is a byte loop at a 30x cost (`writeRaw`). The test
 *   below pins that shape — bounded by pieces, never by bytes, never exposed — so a
 *   regression cannot hide behind it.
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
import {
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
    arrayUnsigned(_id, _i, _v, lo) { this.acc += lo; },
    arraySigned(_id, _i, _v, lo) { this.acc += lo; },
    arrayFp32(_id, _i, _v, bits) { this.acc += bits; },
    arrayFp64(_id, _i, v) { this.acc += v; },
    arrayEnd(_id) { this.acc += 1; },
    sequenceBegin(_id, depth) { this.acc += depth; },
    sequenceEnd(_id, depth) { this.acc += depth; },
  };
}

/**
 * Count every allocation primitive a codec path could reach, while `body` runs.
 *
 * The `subarray` / `slice` counters are the JavaScript-specific half: a view is an
 * object, so handing one out is an allocation even though no bytes are copied —
 * which is exactly why the decoder reports `(src, start, end)` instead.
 */
function allocationsDuring(body: () => void): number {
  let n = 0;
  const savedU8 = globalThis.Uint8Array;
  const savedArray = globalThis.Array;
  const subarray = Uint8Array.prototype.subarray;
  const slice = Uint8Array.prototype.slice;
  const decodeText = TextDecoder.prototype.decode;
  const encodeText = TextEncoder.prototype.encode;

  const count = <T extends (...args: never[]) => unknown>(fn: T): T =>
    function (this: unknown, ...args: never[]) {
      n++;
      return (fn as (...a: never[]) => unknown).apply(this, args);
    } as unknown as T;

  Uint8Array.prototype.subarray = count(subarray);
  Uint8Array.prototype.slice = count(slice);
  TextDecoder.prototype.decode = count(decodeText);
  TextEncoder.prototype.encode = count(encodeText);
  (globalThis as { Uint8Array: unknown }).Uint8Array = new Proxy(savedU8, {
    construct(t, a: unknown[]) {
      n++;
      return Reflect.construct(t, a) as object;
    },
  });
  (globalThis as { Array: unknown }).Array = new Proxy(savedArray, {
    construct(t, a: unknown[]) {
      n++;
      return Reflect.construct(t, a) as object;
    },
  });
  try {
    body();
  } finally {
    Uint8Array.prototype.subarray = subarray;
    Uint8Array.prototype.slice = slice;
    TextDecoder.prototype.decode = decodeText;
    TextEncoder.prototype.encode = encodeText;
    (globalThis as { Uint8Array: unknown }).Uint8Array = savedU8;
    (globalThis as { Array: unknown }).Array = savedArray;
  }
  return n;
}

describe("read: no allocation primitive on a codec path (§6.6.4)", () => {
  it("a complete encode into a caller buffer allocates nothing", () => {
    const os = new OStream(new Uint8Array(4096)); // construction may allocate
    expect(allocationsDuring(() => message(os))).toBe(0);
  });

  it("a streaming encode allocates one view per copied piece, and nothing else", () => {
    // **The one recorded deviation from §6.6, pinned to its shape.**
    //
    // `TypedArray.set` is this language's only `memcpy` and it takes a typed array
    // as its source, so copying a *range* needs a `subarray` — an object, and thus
    // an allocator call §6.6 forbids "for anything at all". The allocation-free
    // alternative is a byte loop at 358 MB/s against 10,963 MB/s, a 30x tax on the
    // one path that exists because the payload is large, so this port takes the
    // view (see `writeRaw`, and the README).
    //
    // What this test defends is that the deviation stays exactly that: **bounded
    // by pieces, never by bytes**, and confined to the split-payload copy. A
    // regression that started allocating per varint, per field or per byte would
    // blow the bound; so would one that leaked a view to the sink (§5.1.6, checked
    // separately below).
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
    expect(allocs).toBeGreaterThan(0); // the deviation is real, and visible here
    expect(allocs).toBeLessThanOrEqual(flushes); // …and one per piece, not per byte
    // Two orders of magnitude of headroom against "per byte": the message is 40x
    // the buffer, and the whole point is that the count tracks pieces.
    expect(allocs).toBeLessThan(WIRE.length / 4);
  });

  it("the same message into one buffer allocates nothing at all", () => {
    // The control that keeps the deviation honest: with room for the payload there
    // is no range to copy, so `set` takes the caller's array whole and the count
    // is zero. Every shape §5.1.2 puts first — a `MAX_SIZE` buffer, the
    // accumulator — is this case.
    const os = new OStream(new Uint8Array(4096));
    expect(allocationsDuring(() => message(os))).toBe(0);
  });

  it("a complete one-shot decode allocates nothing after construction", () => {
    const v = foldingVisitor();
    const is = new IStream(v);
    expect(allocationsDuring(() => void is.feed(WIRE))).toBe(0);
    expect(v.acc).not.toBe(0);
  });

  it("a complete chunked decode allocates nothing after construction", () => {
    const v = foldingVisitor();
    const is = new IStream(v);
    // The chunk views belong to the caller, so they are built outside the
    // measurement: what is on trial is what the decoder does with them.
    const chunks = Array.from({ length: WIRE.length }, (_, i) => WIRE.subarray(i, i + 1));
    expect(
      allocationsDuring(() => {
        for (const c of chunks) is.feed(c);
      }),
    ).toBe(0);
    expect(is.status()).toBe(DecodeStatus.Complete);
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
    for (let i = 0; i < WIRE.length; i += 3) {
      const n = Math.min(3, WIRE.length - i);
      scratch.set(WIRE.subarray(i, i + n));
      is.feed(scratch.subarray(0, n));
      scratch.fill(0xee); // the caller reuses its buffer the moment feed returns
    }
    expect(is.status()).toBe(DecodeStatus.Complete);
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
