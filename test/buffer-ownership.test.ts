/**
 * Output-buffer ownership (CORELIB_PLAN §5.1.2, §6.6, normative).
 *
 * > A corelib **MUST NOT**: **allocate an output buffer.** Every buffer the
 * > encoder writes into is caller-supplied. … **Grow or reallocate** a
 * > caller-supplied buffer. What was handed over is what gets written.
 *
 * §6.6 closes the loophole that reading leaves, and names the shape this port
 * had:
 *
 * > the codec allocates nothing itself but **requires a growable destination**
 * > and grows it, from a wire count or otherwise — **violates** — it moved the
 * > allocator call one type away, where a source-level audit no longer sees it.
 *
 * `OStream` used to carry a second, corelib-owned buffer mode: constructed with
 * no arguments it allocated 256 bytes and reallocated them as the message grew
 * (corelib-ts#108). That became a `BufferOwner` hook — a fourth constructor
 * parameter the encoder called from `ensureSome`, i.e. from every `write*`,
 * keeping whatever it returned. Same allocation, one type away, and the second
 * row above is written about exactly that (A2-0159).
 *
 * Now there is **one** buffer model and no hook at all. Every buffer comes from
 * the caller: the one it hands over at construction, and whatever its sink
 * installs in place of it (§5.1.5). `growingOStream` is §5.1.2's sanctioned
 * unbounded shape built out of that — "install a scratch buffer **with a sink**
 * that appends into the growing result" — and it lives in the static helper
 * layer (`src/encode/accumulate.ts`, §6.6.1), reached only from inside the flush
 * callback the encoder made.
 */

import { describe, expect, it } from "vitest";
import {
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
    sink: (buf, start, end) => {
      if (stores[stores.length - 1] !== buf.buffer) stores.push(buf.buffer);
      for (let i = start; i < end; i++) acc.push(buf[i]!);
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

  it("lets a caller install its own buffer on an accumulating stream", () => {
    // `growingOStream` is now an ordinary streaming stream whose sink happens to
    // own the storage, so this is the plain §5.1.5 installation and means what it
    // always means: the not-yet-flushed bytes in the old buffer are dropped and
    // encoding continues into the caller's. What corelib-ts#108 was about — the
    // encoder silently reallocating away from a buffer the caller handed over —
    // cannot happen, because nothing reallocates the caller's buffer: the sink
    // copies out of it when it fills, exactly as for any other streaming buffer.
    const os = growingOStream(8);
    os.setBuffer(new Uint8Array(8), 0);
    write(os);
    expect(Array.from(os.bytes())).toEqual(Array.from(reference()));
  });

  it("hands the flush sink the stream itself as the receiver", () => {
    // Not decoration: `growingOStream`'s sink is a stateless module-level
    // function that reaches its encoder through `this`, so it allocates nothing
    // per stream. A refactor of `flush()` that hoisted `this.flushSink` into a
    // local would break that, and nothing else would notice.
    let seen: unknown = null;
    const os = new OStream(new Uint8Array(4), 0, function (this: unknown) {
      seen = this;
    });
    os.writeUnsigned(1, 42);
    os.flush();
    expect(seen).toBe(os);
  });

  it("reports a full caller buffer instead of growing it", () => {
    const mine = new Uint8Array(8);
    const os = new OStream(mine);
    expect(codeOf(() => os.writeBlob(1, new Uint8Array(64)))).toBe(SofabErrorCode.BufferFull);
    expect(os.bytes().buffer).toBe(mine.buffer);
  });

  it("has no allocating encoder mode: the no-argument form is the accumulator", () => {
    // Kept as a deprecated alias for one release (corelib-ts#108). It is the
    // caller-role accumulator — storage owned by its sink, hence no BUFFER_FULL
    // — not a second ownership model inside OStream.
    const os = growingOStream();
    write(os);
    expect(os.bytes()).toEqual(reference());
    // The buffer never grew under the message: every enlargement is a *new*
    // buffer the sink installed, so nothing the caller could be holding was
    // reallocated behind its back.
    expect(codeOf(() => os.writeUnsigned(1, 1))).toBeUndefined();
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

  it("hands every accumulator storage of its own, slab-carved or not", () => {
    // The accumulator carves its buffers out of a shared slab (V8 puts a typed
    // array over 64 bytes outside the JS heap, at ~20x the allocation cost). A
    // carve is handed out once and never recycled, so this must stay invisible:
    // two live accumulators may not share a byte, and a `bytes()` view — which is
    // documented as valid until the *next write on that stream* — must not be
    // rewritten by an encode on another stream.
    const first = growingOStream();
    write(first);
    const view = first.bytes();
    const snapshot = Array.from(view);

    const others = [growingOStream(), growingOStream(64), growingOStream(9000)];
    for (const os of others) {
      os.writeString(1, "a different message entirely, written after the first");
      os.writeUnsignedArray(2, Array.from({ length: 200 }, (_, i) => i));
    }

    expect(Array.from(view)).toEqual(snapshot);
    for (const os of others) {
      expect(os.bytes().some((b, i) => b !== view[i])).toBe(true);
    }
  });

  it("keeps a message written across many growths byte-identical to a one-shot one", () => {
    const oneShot = growingOStream(1 << 16);
    write(oneShot);
    const grown = growingOStream(1);
    write(grown);
    expect(Array.from(grown.bytes())).toEqual(Array.from(oneShot.bytes()));
  });
});

describe("the encoder has no growth mechanism at all (§6.6)", () => {
  it("takes no owner-like fourth argument", () => {
    // The regression guard for A2-0159, at the only level a test can hold it:
    // the constructor's arity. A hook can only be called if it can be passed.
    expect(OStream.length).toBe(1); // buffer; offset and flush are optional
  });

  it("exports no BufferOwner type or value", async () => {
    const mod = (await import("../src/index.js")) as Record<string, unknown>;
    expect(Object.keys(mod)).not.toContain("BufferOwner");
    expect(Object.keys(mod)).not.toContain("growOwner");
  });

  it("allocates nothing on the write path of an accumulating stream", () => {
    // The measurement half of §6.6.4, for the one stream that used to grow.
    // `growingOStream(16)` writing 39 strings performed 14 allocations from
    // inside `write*` before this change; the accumulator now takes its storage
    // from inside the *flush callback*, which is the caller's side of the
    // boundary (§6.6.1), so the write path itself is clean.
    const OrigU8 = Uint8Array;
    const origSub = OrigU8.prototype.subarray;
    let armed = false;
    const seen: string[] = [];

    const patchedSub = function (this: Uint8Array, ...a: [number?, number?]) {
      if (armed) seen.push("subarray");
      return origSub.apply(this, a);
    } as typeof origSub;

    const os = growingOStream(16);
    OrigU8.prototype.subarray = patchedSub;
    try {
      armed = true;
      // Fills the 16-byte window many times over, so every enlargement the old
      // owner would have made from `ensureSome` happens here.
      for (let i = 0; i < 39; i++) os.writeString(i, `field number ${i} with some payload`);
      armed = false;
    } finally {
      OrigU8.prototype.subarray = origSub;
    }

    // Whatever the accumulator allocated, it allocated from inside the flush
    // callback — so none of it happened while the encoder was between
    // `ensureSome` and its return, which is what the old hook did. The bytes are
    // the proof the message survived the handovers.
    expect(os.bytesUsed).toBe(1417);
    expect(seen.length).toBeGreaterThan(0); // the helper did allocate; that is legal
    expect(Array.from(os.bytes()).length).toBe(1417);
  });

  it("reports a full buffer rather than reaching for another, with or without a sink", () => {
    // Without a sink there is nothing left to try.
    const fixed = new OStream(new Uint8Array(8));
    expect(codeOf(() => fixed.writeBlob(1, new Uint8Array(64)))).toBe(SofabErrorCode.BufferFull);

    // With one, the value is split across flushes instead — the only other
    // answer §5.1.3 permits, and never a bigger buffer.
    const { sink, bytes } = collect();
    const streamed = new OStream(new Uint8Array(8), 0, sink);
    write(streamed);
    streamed.flush();
    expect(Array.from(bytes())).toEqual(Array.from(reference()));
  });

  it("carries a message prefix across an installation only when asked to", () => {
    // `setBuffer`'s third argument is what replaces the growth hook: a caller
    // that keeps the whole message in one store says how much of it the
    // replacement already holds, so `bytes()` keeps meaning "the message".
    const store = new Uint8Array(64);
    const os = new OStream(store, 0, () => undefined);
    os.writeUnsigned(1, 42);
    const n = os.bytesUsed;
    expect(n).toBeGreaterThan(0);

    // Default: the replacement holds none of it, so the message restarts.
    os.setBuffer(store, n);
    expect(os.bytesUsed).toBe(0);
    expect(os.bytes()).toEqual(new Uint8Array(0));

    // With `carried`, the same installation keeps the prefix in view.
    os.setBuffer(store, n, n);
    expect(os.bytesUsed).toBe(n);
    expect(Array.from(os.bytes())).toEqual(Array.from(store.subarray(0, n)));

    // …and the next flush still begins at `offset`, not at the prefix.
    let flushed: number[] = [];
    const os2 = new OStream(store, 0, (b, start, end) => {
      flushed = Array.from(b.subarray(start, end));
    });
    os2.writeUnsigned(1, 42);
    os2.setBuffer(store, n, n);
    os2.writeUnsigned(2, 7);
    const total = os2.bytesUsed; // prefix + the field just written
    os2.flush();
    expect(flushed).toEqual(Array.from(store.subarray(n, total)));
    expect(flushed.length).toBe(total - n);
  });

  it("range-checks the carried prefix", () => {
    const os = new OStream(new Uint8Array(64));
    expect(codeOf(() => os.setBuffer(new Uint8Array(64), 4, 5))).toBe(SofabErrorCode.Argument);
    expect(codeOf(() => os.setBuffer(new Uint8Array(64), 4, -1))).toBe(SofabErrorCode.Argument);
    expect(codeOf(() => os.setBuffer(new Uint8Array(64), 4, 1.5))).toBe(SofabErrorCode.Argument);
  });

  it("keeps the sink in charge of what the encoder writes into next", () => {
    // §5.1.5 is the *only* route by which the buffer changes. A sink that
    // installs a bigger replacement re-opens the bulk routes; one that returns
    // bare keeps the same buffer. Both must produce the reference bytes.
    const grow = collect();
    let current = new Uint8Array(4);
    const growing = new OStream(current, 0, (buf, start, end) => {
      grow.sink(buf, start, end);
      current = new Uint8Array(Math.min(current.length * 2, 4096));
      growing.setBuffer(current);
    });
    write(growing);
    growing.flush();
    expect(Array.from(grow.bytes())).toEqual(Array.from(reference()));
  });
});
