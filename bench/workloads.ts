/**
 * The cross-language benchmark datasets, and the ten workloads BENCH_SPEC
 * builds out of them.
 *
 * Every literal below is fixed by BENCH_SPEC so that the encoded bytes — and
 * therefore the message sizes the MB/s and Ir/op figures are computed from —
 * are identical on every port. Three of the sizes are parity checks: a port
 * whose `perf` message is not 170 bytes, whose `blob 1MB` message is not
 * 1,000,005 and whose `composite` is not 956 is encoding something other than
 * the shared dataset, and its numbers are not comparable with anyone else's.
 * `test/bench-datasets.test.ts` holds them to that.
 *
 * The workloads are built here rather than in `bench.ts` because three tools
 * consume them: the throughput table, the per-op report, and — through
 * `bench.ts`'s command-line mode — the Callgrind harness, which must run
 * *exactly* the operation the table timed for its Ir/op to describe the same
 * thing.
 *
 * **What the encode rows drive.** Each of them writes into a caller-supplied
 * buffer that outlives the loop (`new OStream(scratch)`, rewound with
 * {@link OStream.reset} per op) — CORELIB_PLAN §5.1's model, and what generated
 * code does with a `MAX_SIZE`-sized buffer. Not {@link growingOStream}: that
 * would put a fresh buffer allocation in every op, which on a ~40-byte message
 * is most of the measurement (corelib-ts#138 measured that allocation at 45% of
 * the `typical message` profile) and would report V8's allocator rather than
 * this encoder.
 */

import {
  Cursor,
  DecodeStatus,
  IStream,
  OStream,
  decode,
  growingOStream,
  type FlushSink,
  type Visitor,
} from "../src/index.js";
import { sink } from "./common.js";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/**
 * The one magic number in BENCH_SPEC: `u64 array (1000)` and the `blob 1MB`
 * payload are both derived from it, so there is a single constant to keep in
 * step across the ports rather than two.
 */
const GOLDEN = 0x9e37_79b9_7f4a_7c15n;
const MASK64 = (1n << 64n) - 1n;

/** Elements in the `u64 array (1000)` workload. */
const N = 1000;

/** Payload bytes of the `blob 1MB` message — exactly 1e6, so MB/s reads directly. */
export const BLOB_LEN = 1_000_000;

/**
 * Encoded size of the `blob 1MB` message: a 1-byte header `(1 << 3) | 2`, a
 * 4-byte `fixlen_word` `(1000000 << 3) | 3`, and the payload. A parity check,
 * like the `perf` message's 170.
 */
export const BLOB_ENCODED_SIZE = BLOB_LEN + 5;

/**
 * Buffer size for the streaming `blob 1MB` rows, and the chunk size the decode
 * row is fed in. A fixed 4096 on every port rather than each port's own
 * preference, so the rows stay comparable. {@link MIN_OUTPUT_BUFFER} does not
 * enter into it — it is at most 20, so 4096 always clears it.
 */
export const BLOB_CHUNK = 4096;

/** Encoded size of the `perf` message — BENCH_SPEC states it outright. */
export const PERF_ENCODED_SIZE = 170;

/** Encoded size of the `composite` message, from the reference implementation. */
export const COMPOSITE_ENCODED_SIZE = 956;

/**
 * Scratch buffer for the encode rows other than `blob 1MB`. Comfortably larger
 * than the biggest of them *and* than the worst-case bulk reserve of the 1000-
 * element array (10 bytes per element), so no row ever falls off its bulk path
 * for want of room and starts measuring the element-at-a-time fallback instead.
 */
const SCRATCH_BYTES = 32 * 1024;

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

/** `u64 array (1000)`: `src[i] = i * 0x9E3779B97F4A7C15` (wrapping u64 multiply). */
export function buildU64Array(): bigint[] {
  const a = new Array<bigint>(N);
  for (let i = 0; i < N; i++) a[i] = (BigInt(i) * GOLDEN) & MASK64;
  return a;
}

/**
 * The `blob 1MB` payload: `b[i] = (i * 0x9E3779B97F4A7C15) & 0xFF`.
 *
 * Computed as `(i * 0x15) & 0xFF`, which is the same byte: the low 8 bits of a
 * product depend only on the low 8 bits of its factors (arithmetic mod 2^8
 * divides mod 2^64), and `0x9E3779B97F4A7C15 & 0xFF` is `0x15`. That keeps the
 * whole megabyte in `number` arithmetic — a million `bigint` multiplies here
 * would be fixed setup cost the Callgrind subtraction cancels but the wall clock
 * does not, on a tool already run twice per workload under Valgrind.
 */
export function buildBlob(): Uint8Array {
  const b = new Uint8Array(BLOB_LEN);
  for (let i = 0; i < BLOB_LEN; i++) b[i] = (i * 0x15) & 0xff;
  return b;
}

/** The `typical` message: 7 fields, ids 1..7, ~37 bytes. */
export function encodeTypical(os: OStream): void {
  os.writeUnsigned(1, 0xdead_beefn);
  os.writeSigned(2, -12345);
  os.writeBoolean(3, true);
  os.writeFp32(4, 3.14159);
  os.writeString(5, "sofab");
  os.writeUnsignedArray(6, [10, 20, 30, 40]);
  os.writeSequenceBeginLazy(7);
  os.writeUnsigned(1, 99);
  os.writeSigned(2, -7);
  os.writeSequenceEnd();
}

const PERF_STRING = "perf-benchmark-message";
const PERF_SAMPLES = [1e6, 2e6, 3e6, 4e6, 5e6, 6e6, 7e6, 8e6];
const PERF_DELTAS = [-1e5, -2e5, -3e5, -4e5, -5e5, -6e5, -7e5, -8e5];
const PERF_FP64 = [3.14159265, 6.2831853, 9.42477795, 12.5663706];

/** The `perf` message: 12 fields, ids 1..12, exactly {@link PERF_ENCODED_SIZE} bytes. */
export function encodePerf(os: OStream): void {
  os.writeUnsigned(1, 0xdead_beefn);
  os.writeSigned(2, -12345);
  os.writeUnsigned(3, 0x0123_4567_89ab_cdefn);
  os.writeSigned(4, -5_000_000_000_000);
  os.writeBoolean(5, true);
  os.writeFp32(6, 3.14159);
  os.writeFp64(7, 2.718281828459045);
  os.writeString(8, PERF_STRING);
  os.writeUnsignedArray(9, PERF_SAMPLES);
  os.writeSignedArray(10, PERF_DELTAS);
  os.writeFp64Array(11, PERF_FP64);
  os.writeSequenceBeginLazy(12);
  os.writeUnsigned(1, 99);
  os.writeSigned(2, -7);
  os.writeSequenceEnd();
}

/**
 * The 64 wrapper-array elements and the 320-byte string of the `composite`
 * message, built **once**, outside anything measured: 64 fresh strings and a
 * 320-character concatenation per op would cost several times the encoding they
 * feed, and `encode: composite` would become a report on V8's string allocator.
 */
export const COMPOSITE_ITEMS: string[] = Array.from({ length: 64 }, (_, i) => `item-${i}`);
/** One cycle of 1-, 2-, 3- and 4-byte UTF-8; the 4-byte one is a surrogate pair in JS. */
export const COMPOSITE_TEXT = "aä€\u{1d11e}".repeat(32);

/**
 * The `composite` message — every encoder path the three flat datasets miss:
 *
 * * **id 1** — the suite's only **wrapper array** (MESSAGE_SPEC §5.1): one field
 *   header per element, element id = array index, so ids 0–15 take a one-byte
 *   header and 16–63 a two-byte one.
 * * **id 2** — 320 UTF-8 bytes across all four sequence widths, so the §6.4
 *   validator (here: this port's UTF-8 *writer*) runs on a non-ASCII payload and
 *   `writeString`'s ASCII fast path is left behind.
 * * **id 3** — nesting at depth 3, so the lazy hold-back run grows past the
 *   single level `typical` and `perf` reach.
 * * **id 4** — a struct equal to its declared default: opened lazily and closed
 *   with nothing written, so the encoder must emit no byte for it. This is the
 *   hold-back's discard path, which nothing else in the suite exercises.
 * * **id 130** — the suite's only two-byte field header, `(130 << 3) | 0`.
 */
export function encodeComposite(os: OStream): void {
  os.writeSequenceBeginLazy(1);
  for (let i = 0; i < 64; i++) os.writeString(i, COMPOSITE_ITEMS[i]!);
  os.writeSequenceEnd();

  os.writeString(2, COMPOSITE_TEXT);

  os.writeSequenceBeginLazy(3);
  os.writeSequenceBeginLazy(1);
  os.writeSequenceBeginLazy(1);
  os.writeUnsigned(1, 7);
  os.writeSequenceEnd();
  os.writeSequenceEnd();
  os.writeSigned(2, -1);
  os.writeSequenceEnd();

  // Equal to its declared default: opened, closed, and gone from the wire.
  os.writeSequenceBeginLazy(4);
  os.writeSequenceEnd();

  os.writeUnsigned(130, 0xdead_beefn);
}

// ---------------------------------------------------------------------------
// Sinks and drivers
// ---------------------------------------------------------------------------

/**
 * The flush sink of the streaming `blob 1MB` row. BENCH_SPEC is explicit that it
 * **consumes and discards**: accumulating the bytes would charge the streaming
 * row a copy the one-shot row never pays, and I/O is not deterministic under
 * Callgrind. Folding one byte per call is the minimum that keeps the call from
 * being optimised away.
 */
export class DiscardSink {
  acc = 0;
  flushes = 0;
  bytes = 0;
  readonly add: FlushSink = (chunk) => {
    this.flushes++;
    this.bytes += chunk.length;
    if (chunk.length > 0) this.acc ^= chunk[0]!;
  };
}

/**
 * A decode sink that folds every delivered value into a running total, so no
 * decode can be optimised away and every visitor callback is really made.
 *
 * The fold is `number` arithmetic throughout — including for the `bigint`s the
 * 64-bit workloads deliver, which are converted rather than accumulated. The
 * accumulator used to be a `bigint`, which turned every callback into two or
 * three heap allocations: `decode: typical message` spent more time in the
 * checksum than in the decoder it was reporting on, and `decode: u64 array
 * (1000)` charged 1000 bigint adds per op to this port's decoder. What the row
 * should measure is the decode.
 */
export class Checksum implements Visitor {
  acc = 0;
  unsigned(id: number, v: number | bigint): void {
    this.acc += (typeof v === "number" ? v : Number(v)) + id;
  }
  signed(id: number, v: number | bigint): void {
    this.acc += (typeof v === "number" ? v : Number(v)) + id;
  }
  fp32(_id: number, v: number): void {
    this.acc += v;
  }
  fp64(_id: number, v: number): void {
    this.acc += v;
  }
  string(_id: number, _total: number, _offset: number, chunk: Uint8Array): void {
    this.acc += chunk.length;
  }
  blob(_id: number, _total: number, _offset: number, chunk: Uint8Array): void {
    this.acc += chunk.length;
  }
  arrayUnsigned(_id: number, _i: number, v: number | bigint): void {
    this.acc += typeof v === "number" ? v : Number(v);
  }
  arraySigned(_id: number, _i: number, v: number | bigint): void {
    this.acc += typeof v === "number" ? v : Number(v);
  }
  arrayFp32(_id: number, _i: number, v: number): void {
    this.acc += v;
  }
  arrayFp64(_id: number, _i: number, v: number): void {
    this.acc += v;
  }
}

/** Encode into a fresh accumulating stream and copy the bytes out (setup only). */
export function encodeToBytes(write: (os: OStream) => void): Uint8Array {
  const os = growingOStream();
  write(os);
  return os.bytes().slice();
}

/**
 * The `encode: blob 1MB one-shot` target: a caller buffer of exactly
 * {@link BLOB_ENCODED_SIZE} bytes and **no sink**. Sized by hand — the schema is
 * unbounded, so there is no `MAX_SIZE` to take it from — and this row is the
 * floor the streaming one is read against.
 */
export function blobOneShotStream(): OStream {
  return new OStream(new Uint8Array(BLOB_ENCODED_SIZE));
}

/** One `encode: blob 1MB one-shot` op: a single contiguous write, no flush. */
export function encodeBlobOneShot(os: OStream, blob: Uint8Array): Uint8Array {
  os.reset();
  os.writeBlob(1, blob);
  return os.bytes();
}

/**
 * The `encode: blob 1MB streaming` target: a caller buffer of exactly
 * {@link BLOB_CHUNK} bytes with a flush sink, so the megabyte goes out in ~245
 * flushes. Pass-through is **not** granted — this port implements none, so every
 * `blob` run is copied through the buffer, which is the path BENCH_SPEC requires
 * this row to measure.
 */
export function blobStreamingStream(sink: FlushSink): OStream {
  return new OStream(new Uint8Array(BLOB_CHUNK), 0, sink);
}

/**
 * One `encode: blob 1MB streaming` op. Its distance from the one-shot row is
 * what the divisible-run path of CORELIB_PLAN §5.1 costs — read it as Ir/op,
 * where memory bandwidth does not drown it out.
 */
export function encodeBlobStreaming(os: OStream, blob: Uint8Array): void {
  os.reset();
  os.writeBlob(1, blob);
  os.flush();
}

/** Feed a whole message to a fresh {@link IStream} in `chunk`-byte pieces. */
export function decodeChunked(wire: Uint8Array, visitor: Visitor, chunk: number): DecodeStatus {
  const is = new IStream();
  let status: DecodeStatus = DecodeStatus.Complete;
  for (let off = 0; off < wire.length; off += chunk) {
    status = is.feed(wire.subarray(off, Math.min(off + chunk, wire.length)), visitor);
  }
  return status;
}

/**
 * The `decode: composite skip-all` row: walk the message and materialize
 * nothing.
 *
 * This is the pull decoder's skip machinery, not a push visitor with no
 * callbacks — the two are different work. A {@link Visitor} that implements
 * nothing still has every value *parsed* for it (the decoder only elides the
 * call), while {@link Cursor.skip} jumps a fixlen payload by its length word and
 * discards a whole sub-sequence by walking headers, which is the path a router
 * or filter actually runs and the one MESSAGE_SPEC §7.2 item 7 requires be
 * exercised. Returns the number of top-level fields skipped, so the loop cannot
 * be optimised away.
 */
/**
 * A message whose one subtree the consumer declines, and the two ways to say so.
 *
 * `declineWire` is deliberately string-heavy: a declined subtree used to cost a
 * payload view and a callback lookup per field, and the row exists to keep that
 * saving honest rather than asserted.
 */
export function declinedWire(): Uint8Array {
  const os = new OStream();
  os.writeUnsigned(1, 7);
  os.writeSequenceBeginLazy(2);
  for (let i = 0; i < 200; i++) os.writeString(i % 64, "payload".repeat(8));
  os.writeSequenceEnd();
  os.writeUnsigned(9, 6);
  return os.bytes().slice();
}

/** Declines the subtree: sequenceBegin returns null (corelib-ts#154). */
export function decodeDeclining(wire: Uint8Array): void {
  decode(wire, { sequenceBegin: () => null });
}

export function skipAll(wire: Uint8Array): number {
  const c = new Cursor(wire);
  let n = 0;
  while (c.readHeader()) {
    c.skip(c.wire);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// The workload table
// ---------------------------------------------------------------------------

/** One benchmark row: what to run, how it is labelled, and its message size. */
export interface Workload {
  /** Command-line key, also the Callgrind harness's name for the row. */
  key: string;
  /** BENCH_SPEC row label. */
  label: string;
  /** Encoded message size in bytes — the numerator of the MB/s figure. */
  bytes: number;
  run: () => void;
}

/**
 * Build every workload, sharing the one-time setup (datasets, pre-encoded wires
 * and the reusable output buffers). Rows are in BENCH_SPEC's table order.
 *
 * The `blob 1MB passthrough` row is BENCH_SPEC's one optional line and is
 * absent: this port grants no pass-through permission — every `string`/`blob`
 * run goes through the output buffer — so the row is omitted entirely rather
 * than printed as a placeholder.
 */
export function buildWorkloads(): Workload[] {
  const src = buildU64Array();
  const blob = buildBlob();

  const u64Wire = encodeToBytes((os) => os.writeUnsignedArray(1, src));
  const typWire = encodeToBytes(encodeTypical);
  const compWire = encodeToBytes(encodeComposite);
  const declWire = declinedWire();

  // Output targets, allocated once: the encode rows measure the encoder, not
  // the allocator (see the file header).
  const scratch = new OStream(new Uint8Array(SCRATCH_BYTES));
  const blobOneShot = blobOneShotStream();
  const discard = new DiscardSink();
  const blobStream = blobStreamingStream(discard.add);

  const blobWire = encodeBlobOneShot(blobOneShot, blob).slice();

  if (blobWire.length !== BLOB_ENCODED_SIZE || compWire.length !== COMPOSITE_ENCODED_SIZE) {
    throw new Error(
      `dataset parity check failed: blob=${blobWire.length} (want ${BLOB_ENCODED_SIZE}), ` +
        `composite=${compWire.length} (want ${COMPOSITE_ENCODED_SIZE})`,
    );
  }

  const encodeInto = (write: (os: OStream) => void) => () => {
    scratch.reset();
    write(scratch);
    sink(scratch.bytesUsed);
  };
  // The whole-message rows go through `decode()` — the contiguous path a caller
  // with the message already in hand uses, and the one the other ports' decode
  // rows drive. `decode: blob 1MB` below is its chunk-fed counterpart and the
  // only row here that runs the resumable state machine; `perf` reports that
  // machine for both directions, so between the two tools both decode surfaces
  // are covered.
  const decodeWhole = (wire: Uint8Array) => () => {
    const c = new Checksum();
    decode(wire, c);
    sink(c.acc);
  };

  return [
    { key: "encode_u64_array", label: "encode: u64 array (1000)", bytes: u64Wire.length,
      run: encodeInto((os) => os.writeUnsignedArray(1, src)) },
    { key: "encode_typical", label: "encode: typical message", bytes: typWire.length,
      run: encodeInto(encodeTypical) },
    { key: "encode_blob_oneshot", label: "encode: blob 1MB one-shot", bytes: BLOB_ENCODED_SIZE,
      run: () => sink(encodeBlobOneShot(blobOneShot, blob).length) },
    { key: "encode_blob_streaming", label: "encode: blob 1MB streaming", bytes: BLOB_ENCODED_SIZE,
      run: () => {
        encodeBlobStreaming(blobStream, blob);
        sink(discard.acc);
      } },
    { key: "encode_composite", label: "encode: composite", bytes: compWire.length,
      run: encodeInto(encodeComposite) },
    { key: "decode_u64_array", label: "decode: u64 array (1000)", bytes: u64Wire.length,
      run: decodeWhole(u64Wire) },
    { key: "decode_typical", label: "decode: typical message", bytes: typWire.length,
      run: decodeWhole(typWire) },
    { key: "decode_blob", label: "decode: blob 1MB", bytes: BLOB_ENCODED_SIZE,
      run: () => {
        const c = new Checksum();
        decodeChunked(blobWire, c, BLOB_CHUNK);
        sink(c.acc);
      } },
    { key: "decode_composite", label: "decode: composite", bytes: compWire.length,
      run: decodeWhole(compWire) },
    { key: "decode_composite_skip", label: "decode: composite skip-all", bytes: compWire.length,
      run: () => sink(skipAll(compWire)) },
    // The PUSH twin of the row above: skip-all there is the pull cursor jumping
    // fields, this is a visitor declining a whole subtree (sequenceBegin -> null).
    { key: "decode_declined", label: "decode: declined subtree", bytes: declWire.length,
      run: () => decodeDeclining(declWire) },
  ];
}
