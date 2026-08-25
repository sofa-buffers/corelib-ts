/**
 * `growingOStream` — the caller that lets the buffer follow the message.
 *
 * **This is the static helper layer, not the codec** (CORELIB_PLAN §6.6.1). The
 * codec is {@link OStream}: it writes into the buffer it was handed and has no
 * way to enlarge one. Where the schema bounds the message, generated code sizes
 * one buffer from `MAX_SIZE` and a plain `new OStream(buf)` is the whole story.
 * Where it does not, §5.1.2 names exactly one shape for the unbounded case:
 *
 * > Install a scratch buffer **with a sink** that appends into the growing
 * > result; the scratch is subject to `MIN_OUTPUT_BUFFER` like any
 * > sink-installed buffer.
 *
 * That is what this file builds, so neither generated code nor a hand-written
 * one-shot encode has to write it again. The scratch and the result are the same
 * storage: the encoder is installed over the free tail of a buffer this module
 * owns, and when it fills, the flush callback fires, this module enlarges its
 * storage and installs the next tail with {@link OStream.setBuffer} — §5.1.5's
 * taking sink, and §6.6.1's second row, a helper reached from inside a callback
 * the codec made. Because the encoder was writing *into the result all along*,
 * absorbing a flush is one assignment: there is no per-flush copy.
 *
 * The predecessor was a `BufferOwner` hook: the encoder called it from
 * `ensureSome`, i.e. from every `write*`, and kept the buffer it returned. That
 * is §6.6's second violation row — "the codec allocates nothing itself but
 * requires a growable destination and grows it … it moved the allocator call one
 * type away, where a source-level audit no longer sees it" — and the hook is gone
 * with it (A2-0159).
 *
 * **No subclass, deliberately.** An `OStream` subclass overriding `bytes()` was
 * the obvious shape and cost 2.3x on `encode: composite`: a program that uses
 * both `growingOStream()` and `new OStream(buf)` would then have two receiver
 * maps at every `os.write*` call site, and V8 stops inlining a polymorphic one.
 * `setBuffer`'s `carried` argument buys the same behaviour with one map and one
 * extra number in the encoder, and a stateless module-level sink keeps the
 * per-stream cost at exactly what it was: one buffer.
 */

import { argumentError } from "../errors.js";
import { OStream } from "./ostream.js";
import type { FlushSink } from "./sink.js";

/**
 * Capacity {@link growingOStream} starts from when the caller names none. Only a
 * starting point: the accumulator enlarges itself as the message grows, so this
 * trades an initial allocation against the number of enlargements, and decides
 * nothing about the bytes. A caller that knows roughly how big its message is
 * passes that instead and pays for one allocation.
 */
const DEFAULT_CAPACITY = 256;

/**
 * Smallest free tail the accumulator will install. Any value at or above
 * `MIN_OUTPUT_BUFFER` is correct — the encoder splits every atomic unit — so
 * this only keeps `growingOStream(1)` from flushing once per byte until the
 * geometric growth takes over.
 */
const MIN_WINDOW = 16;

/**
 * Bytes per slab the accumulator carves its buffers out of (see
 * {@link accumulatorBuffer}). Node's own `Buffer.allocUnsafe` pool is 8 KiB for
 * the same reason and the same trade-off.
 */
const SLAB_BYTES = 8192;

/**
 * The largest buffer taken from a slab. Half a slab, so a carve can never leave
 * most of a fresh slab unusable, and a request bigger than this gets storage of
 * its own — where one allocation per message is amortised by the message anyway.
 */
const SLAB_MAX_TAKE = SLAB_BYTES >>> 1;

let slab: Uint8Array | null = null;
/** How much of {@link slab} has been handed out; never given back. */
let slabUsed = 0;

/**
 * Storage for the accumulator {@link growingOStream} builds: `n` bytes, carved
 * from a shared slab.
 *
 * V8 keeps a typed array's bytes inside the JS heap only up to **64 bytes**; one
 * byte more and the backing store is an external allocation, which on Node 24
 * measures ~1.4 µs — against ~60 ns for a slab carve, and against the ~300 ns it
 * takes to *encode* a small message. That single allocation was 45% of the
 * profile of `encode: typical message` and the reason the workload ran at 15 MB/s
 * while decode ran at 28. Carving amortises it over a whole slab.
 *
 * A carved region is handed out **once** and never recycled, so this changes
 * nothing an encoder or its caller can observe: two accumulators never share
 * bytes, and a slab is fresh (zero-filled) storage, so no previous message's
 * bytes can be read out of one. What it does change is lifetime — a retained
 * `bytes()` view keeps its whole slab alive, exactly as a retained
 * `Buffer.allocUnsafe` slice does — which is why {@link OStream.bytes} already
 * documents `.slice()` for a view that must outlive the encode.
 */
function accumulatorBuffer(n: number): Uint8Array {
  if (n > SLAB_MAX_TAKE) return new Uint8Array(n);
  let s = slab;
  if (s === null || s.length - slabUsed < n) {
    s = slab = new Uint8Array(SLAB_BYTES);
    slabUsed = 0;
  }
  const from = slabUsed;
  slabUsed = from + n;
  return s.subarray(from, slabUsed);
}

/**
 * The accumulating flush sink (§5.1.5), shared by every accumulating stream and
 * holding no state of its own.
 *
 * `OStream.flush` invokes the sink as `this.flushSink(this.buf, this.start,
 * this.pos)` — a method call — so `this` here is the encoder that flushed, and
 * `buffer` is the storage it was writing into. Those are the only two things
 * this needs, which is why `growingOStream` allocates **nothing** per stream
 * beyond the storage itself: no closure, no context, no accumulator object.
 * `test/buffer-ownership.test.ts` pins the receiver, since a refactor of `flush`
 * that hoisted the sink into a local would break it.
 *
 * The encoder writes into the result all along, so the flushed bytes are already
 * where they belong and `end` is their absolute offset: absorbing a flush is
 * nothing at all. What is left is to make room and re-open the encoder over the
 * free tail, telling it that the first `end` bytes of the replacement are the
 * message it has already written (`carried`), so {@link OStream.bytes} keeps
 * reporting the message.
 */
const ACCUMULATE = function (
  this: OStream,
  buffer: Uint8Array,
  _start: number,
  end: number,
): void {
  let acc = buffer;
  if (acc.length - end < MIN_WINDOW) {
    let cap = acc.length * 2;
    if (cap < end + MIN_WINDOW) cap = end + MIN_WINDOW;
    const next = accumulatorBuffer(cap);
    next.set(acc.subarray(0, end));
    acc = next;
  }
  this.setBuffer(acc, end, end);
} as FlushSink;

/**
 * An {@link OStream} whose **buffer follows the message** — the ready-made form
 * of the caller CORELIB_PLAN §5.1.2 puts the allocation in.
 *
 * It is the one-liner for the 90% case, where the message comfortably fits in
 * memory:
 *
 * ```ts
 * const os = growingOStream();
 * os.writeUnsigned(1, 42);
 * const wire = os.bytes();   // the whole message, as a view valid until the next write
 * ```
 *
 * {@link OStream.bytes} is therefore the **whole** message here rather than a
 * not-yet-flushed tail, and no write reports `BUFFER_FULL`. It is an ordinary
 * streaming stream in every other respect: {@link OStream.setBuffer} works and
 * means what it always means — the not-yet-flushed bytes in the old buffer are
 * dropped and encoding continues into yours, which the accumulator then grows in
 * turn.
 *
 * @param initialCapacity bytes to start from; the accumulator enlarges itself
 * whenever the message outgrows it, so this only trades an initial allocation
 * against the number of enlargements and never limits the message. A caller with
 * a rough size in hand should pass it: a 100 KB payload written into the default
 * 256 bytes costs nine enlargements and about 2.5x the CPU of one that started
 * big enough.
 */
export function growingOStream(initialCapacity = DEFAULT_CAPACITY): OStream {
  if (!Number.isInteger(initialCapacity) || initialCapacity < 1) {
    throw argumentError(`initial capacity ${initialCapacity} must be a positive integer`);
  }
  return new OStream(accumulatorBuffer(initialCapacity), 0, ACCUMULATE);
}
