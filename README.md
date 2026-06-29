<p align="center"><img src="assets/sofabuffers_logo.png" alt="SofaBuffers" height="140"></p>

# SofaBuffers

<b>Structured Objects For Anyone</b><br>
<i>... so optimized, feels amazing.</i>

[Would you like to know more?](https://github.com/sofa-buffers)

## SofaBuffers TypeScript library

[![CI](https://github.com/sofa-buffers/corelib-ts/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sofa-buffers/corelib-ts/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsofa-buffers%2Fcorelib-ts%2Fbadges%2Fcoverage.json)](https://github.com/sofa-buffers/corelib-ts/actions/workflows/ci.yml)
[![Branches](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsofa-buffers%2Fcorelib-ts%2Fbadges%2Fbranches.json)](https://github.com/sofa-buffers/corelib-ts/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-API-blue)](https://sofa-buffers.github.io/corelib-ts/)

[GitHub repository](https://github.com/sofa-buffers/corelib-ts)

A **dependency-free**, **streaming** TypeScript implementation of the SofaBuffers
(*Sofab*) serialization format. It is the **runtime stream core** (equivalent to
the C `corelib`'s `istream` / `ostream`), written in portable TypeScript that
runs anywhere JavaScript does — **Node.js, browsers, Electron, Deno, Bun** and a
classic `<script>` tag — with no native dependency.

Like protobuf's `CodedInputStream` / `CodedOutputStream`, this library is meant
to be driven by **generated code**: a schema-driven generator emits one class per
message plus marshal / unmarshal methods that call the primitives here. The
decoder uses the **visitor pattern**, so a generated message is typically a
single `switch` over the field id, and a nested message simply returns its child
object from `sequenceBegin`.

The wire format is specified, language-neutrally, in the
[SofaBuffers documentation](https://github.com/sofa-buffers/documentation). The
unit tests here use the exact byte vectors from the
[C corelib](https://github.com/sofa-buffers/corelib-c-cpp)'s reference suite
(`test_vectors.json`) to guarantee byte-for-byte interoperability with the C,
C++, Rust, C#, Java, Go and Python implementations.

Requires **Node.js 18+** (or any modern browser / Electron / Deno / Bun).
Install from npm:

```bash
npm install @sofabuffers/corelib
```

Ships ESM, CommonJS, a browser global (`SofaBuffers`) and full type declarations.

## Why this design

| Goal | How |
|------|-----|
| Runs everywhere | Pure TypeScript over `Uint8Array` / `DataView` / `TextEncoder` — no Node built-ins on the hot path, so the same build works in browsers, Electron and servers. |
| Streaming **out** | `OStream` writes into a small caller buffer and invokes a `FlushSink` whenever it fills, so a message can exceed the buffer — and even RAM. |
| Streaming **in** | `IStream` is a byte-at-a-time state machine fed arbitrary chunks; large string / blob payloads are delivered in pieces to your `Visitor`. |
| Full 64-bit fidelity | Unsigned / signed scalars are `bigint`, so the entire `uint64` / `int64` range round-trips exactly (`writeUnsigned` also accepts `number`). |
| Generated-code friendly | Every `Visitor` method is optional, so generated (and hand-written) sinks override only the fields they need and ignore the rest. Nested messages compose: `sequenceBegin` returns the child visitor. |
| Reserve-offset | `new OStream(buf, offset)` leaves room at the front of the buffer for a lower-layer protocol header (saves a copy). |
| Explicit endianness | IEEE-754 values are written / read little-endian via `DataView`, so behaviour is identical on every engine. |
| Pluggable acceleration | Hot paths run through a swappable `Kernel`; an optional native (N-API) or WebAssembly build can replace it with no API change. |

## Usage

```ts
import { OStream, decode, type Visitor } from "@sofabuffers/corelib";

// ---- encode ----
const os = new OStream();
os.writeUnsigned(1, 42);
os.writeSigned(2, -7);
os.writeString(3, "hi");
const bytes = os.bytes(); // Uint8Array

// ---- decode (push to your visitor) ----
class My implements Visitor {
  a = 0n;
  b = 0n;
  unsigned(id: number, v: bigint) { if (id === 1) this.a = v; }
  signed(id: number, v: bigint)   { if (id === 2) this.b = v; }
  // fp32(), fp64(), string(), blob(), arrayBegin(), sequenceBegin(), ... as needed
}

const sink = new My();
decode(bytes, sink);
```

Encoder and decoder report problems through `SofabError`; the specific cause is
available via `SofabError.code` (`ARGUMENT`, `USAGE`, `BUFFER_FULL`,
`INVALID_MSG`).

### Streaming a message larger than the buffer

`OStream` writes into a small caller buffer and drains it to a `FlushSink`
whenever it fills, so the buffer never has to be message-sized:

```ts
import { OStream, type FlushSink } from "@sofabuffers/corelib";

const out: number[] = [];
const sink: FlushSink = (chunk) => out.push(...chunk); // or socket / file / stream
const os = new OStream(new Uint8Array(16), 0, sink);   // tiny 16-byte buffer
for (let i = 0; i < 1000; i++) os.writeUnsigned(i, BigInt(i));
os.flush();                                            // push the tail
```

### Reading a payload fed in chunks

`IStream` resumes across chunk boundaries, so you can feed it whatever the
transport hands you — a packet, or a single byte — and finish with `end()`:

```ts
import { IStream } from "@sofabuffers/corelib";

const is = new IStream();
for await (const chunk of socket) is.feed(chunk, visitor);
is.end(); // asserts the message ended cleanly

// String / blob payloads arrive as one or more chunks, each tagged with the
// field `total` length and the byte `offset`, so they need never be held whole:
const blobSink: Visitor = {
  blob(id, total, offset, chunk) {
    /* append chunk at offset; the field is `total` bytes */
  },
};
```

## API summary

### Write operations — `OStream`

- `new OStream()` — in-memory, auto-growing; `new OStream(buffer, offset?, flush?)` — stream into a caller buffer, draining to `flush` when full.
- `writeUnsigned(id, number|bigint)`, `writeSigned(id, number|bigint)`, `writeBoolean(id, boolean)`, `writeFp32(id, number)`, `writeFp64(id, number)`, `writeString(id, string)`, `writeBlob(id, Uint8Array)`, `writeFixlen(id, bytes, subtype)`.
- `writeUnsignedArray` / `writeSignedArray(id, ArrayLike<number|bigint>)`, `writeFp32Array` / `writeFp64Array(id, ArrayLike<number>)`.
- `writeSequenceBegin(id)` / `writeSequenceEnd()`.
- `flush()`, `setBuffer(buffer, offset?)` (install a fresh buffer mid-stream), `bytesUsed`, `bytes()`.

### Read operations — `IStream` + `Visitor`

The decoder is **push / visitor-based**, not a pull cursor: rather than calling a
`readUnsigned()` that returns a value, you feed bytes and the decoder *calls back*
one `Visitor` method per decoded field, handing you the value (or, for
string / blob, a view of the payload). This is what generated message classes
implement — typically a `switch` on `id`.

- `new IStream()`, `feed(chunk, visitor)` (dispatch a chunk's fields), `end()` (assert a clean field-boundary finish); `decode(bytes, visitor)` is the one-shot, whole-buffer fast path.
- `Visitor` — every method is **optional**, and an unhandled (or unimplemented) field is silently **skipped**:
  - `unsigned(id, value: number | bigint)` / `signed(id, value: number | bigint)` — a decoded integer. *Number-first*: `value` is a plain `number` when it fits exactly (`|value| ≤ 2^53-1`, covering all ids and u8..u32) and only a `bigint` beyond that, so the common case never allocates a bigint.
  - `fp32(id, value: number)` / `fp64(id, value: number)` — a decoded IEEE-754 float, always a JS `number`.
  - `string(id, total, offset, chunk: Uint8Array)` / `blob(id, total, offset, chunk: Uint8Array)` — a piece of a string/blob payload. `total` is the field's full byte length, `offset` the position of `chunk` within it. `decode()` delivers the whole payload in a single call (`offset 0`); `IStream` may split it across calls. Decode the string yourself (e.g. `TextDecoder`); see **Memory handling** for the lifetime of `chunk`.
  - `arrayBegin(id, kind: ArrayKind, count)` then one of `arrayUnsigned(id, index, value)` / `arraySigned(id, index, value)` (number-first like `unsigned`) / `arrayFp32(id, index, value: number)` / `arrayFp64(id, index, value: number)` **per element**, then `arrayEnd(id)`. The library hands you elements one at a time — it does not materialise a JS array.
  - `sequenceBegin(id): Visitor | void` — start of a nested message; return a child `Visitor` to route the nested fields to it (its `sequenceEnd()` fires at the matching close), or return nothing to keep using the current visitor.
  - `sequenceEnd(): void` — close of the nested sequence this visitor was handling.

### Supported types

| Field | Write | Read (Visitor) | TS type |
|-------|-------|----------------|---------|
| unsigned (u8..u64) | `writeUnsigned` | `unsigned` | `number \| bigint` — `bigint` only when `> 2^53-1`; full `uint64` range round-trips |
| signed (i8..i64) | `writeSigned` | `signed` | `number \| bigint` — `bigint` only when `\|v\| > 2^53-1`; full `int64` range |
| boolean | `writeBoolean` | `unsigned` (as `0`/`1`) | `boolean` in / `number` out — no separate wire type |
| fp32 | `writeFp32` | `fp32` | `number` (little-endian IEEE-754) |
| fp64 | `writeFp64` | `fp64` | `number` (little-endian IEEE-754) |
| string | `writeString` | `string` | `string` in / UTF-8 `Uint8Array` chunk(s) out |
| blob | `writeBlob` | `blob` | `Uint8Array` |
| array | `write{Unsigned,Signed,Fp32,Fp64}Array` | `array{Unsigned,Signed,Fp32,Fp64}` | element-typed as above |

There is **no `bigint` requirement** for 64-bit — pass a `number` and it is used
directly when exact; pass a `bigint` to reach the full 64-bit range. Arrays carry
exactly the four element kinds above (unsigned / signed varint, fp32, fp64): the
fixed-length array path is restricted to `Fp32` / `Fp64` subtypes, so **string,
blob and nested-sequence elements are not allowed inside an array** — model those
as repeated fields or nested sequences instead. `writeFixlen(id, bytes, subtype)`
is the escape hatch for emitting any `FixlenSubtype` from raw bytes.

### Memory handling

**Encoder — two buffer modes.**

- **In-memory (`new OStream()`)** — the library **allocates** an internal buffer
  (256 bytes) and **auto-grows** it (doubling, via a fresh `Uint8Array` + copy) as
  you write; it never throws `BUFFER_FULL`. `bytes()` returns a `subarray` *view*
  of the finished message — copy it (`.slice()`) if you need to outlive the next
  write or a grow.
- **Streaming (`new OStream(buffer, offset?, flush?)`)** — writes into the
  **caller-provided** `Uint8Array`; it never grows. When the buffer fills it hands
  the produced bytes to your `flush` `FlushSink` (as a `subarray` view, valid only
  for the duration of the callback) and resets, so a message can far exceed the
  buffer — without a `flush` sink, a full buffer throws `BUFFER_FULL`. `offset`
  reserves room at the front for a lower-layer header. **Buffer swap:** call
  `setBuffer(buffer, offset?)` (typically from inside the flush callback) to
  install a fresh output buffer mid-stream; `flush()` first, as any unflushed
  bytes in the old buffer are dropped.

**Decoder — values allocated, payload bytes are zero-copy.**

The decoder produces scalar values *for* you: integers arrive as `number`
(bigint only when out of safe range), floats as `number` — so generated code
gets ready-to-use values without managing destinations. Arrays are not
materialised: you receive one callback per element.

String and blob payloads, however, are **not copied**. The `chunk` handed to
`string` / `blob` is a **zero-copy `subarray` view** aliasing the input buffer
(for `decode`) or the chunk you fed (for `IStream`). It is valid **only during
the callback** — if you need to retain it, copy it (`chunk.slice()`) or decode it
on the spot (`new TextDecoder().decode(chunk)`). This avoids a copy on the hot
path; the trade-off is that the bytes are borrowed, not owned.

### Constants & helpers

`API_VERSION` (= 1), `ID_MAX`, `FIXLEN_MAX`, `ARRAY_MAX`, `U64_MAX`, `I64_MIN`,
`I64_MAX`, `WireType`, `FixlenSubtype`, `ArrayKind`; errors via `SofabError`
(`.code: SofabErrorCode` — `ARGUMENT`, `USAGE`, `BUFFER_FULL`, `INVALID_MSG`);
acceleration via `getKernel` / `setKernel`, `jsKernel`, `loadNativeKernel`,
`loadWasmKernel`.

## Feature flags

The TypeScript build always ships the **full format** — there are no compile-time
toggles like the C library's `SOFAB_DISABLE_*` switches, because the browser /
Node / Electron targets are not code-size constrained.

| Capability | Default |
|------------|---------|
| unsigned / signed varints | always on |
| `fp32` / `fp64` | always on |
| string / blob | always on |
| arrays (integer + fixlen) | always on |
| nested sequences | always on |
| scalar value width | 64-bit (`bigint`), matching the C default — identical wire image |

Booleans are encoded as the unsigned values `0` / `1` (the wire has no separate
boolean type), and IEEE-754 floats are always little-endian.

## Build & test

```bash
npm ci
npm run typecheck      # tsc --noEmit (strict)
npm test               # vitest: vectors, chunked feeding, errors, round-trips
npm run coverage       # vitest --coverage (v8): text + html + lcov
npm run build          # tsup -> ESM + CJS + IIFE + .d.ts in dist/
```

Requires Node.js 18+. The `.devcontainer/` here builds a ready-to-use image
(`./.devcontainer/start.sh`) with Node and tooling preinstalled.

Tests live in `test/` as focused suites:

- `vectors.test.ts` — encode + decode every shared `test_vectors.json` vector, byte-exact vs. the C reference
- `istream.chunked.test.ts` — every vector fed one byte (and seven bytes) at a time
- `errors.test.ts` — every malformed-input rejection branch + encoder argument validation
- `ostream.test.ts` — flush-sink streaming smaller than the buffer, reserve-offset, typed-array inputs
- `roundtrip.test.ts` — value preservation across the type system, 64-bit boundaries, nested sequences
- `varint.test.ts` — LEB128 / zig-zag boundaries
- `visitor-defaults.test.ts` — a no-op visitor silently drops every field kind
- `kernel.test.ts` — the acceleration seam: kernel swap parity + native fallback

The CI workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) builds,
type-checks and tests on Node 18/20/24, measures coverage, and publishes the
coverage / branches badge JSON consumed above to the `badges` branch.

## Benchmarks

Two standalone tools mirror the C / C++ / Rust / C# / Java / Python benchmarks so
the implementations can be compared directly:

```bash
# perf -- per-op cost: a CPU-speed-independent figure (cycles/op where the
#         runtime exposes a cycle counter) plus throughput MB/s.
npm run perf

# bench -- a throughput table in MB/s for encode/decode of a 1000-element u64
#          array and a small "typical" mixed message. MB = 1e6 bytes.
npm run bench
```

`perf` and `bench` encode the identical message (same field ids, types and
values) as their counterparts and print the same report layout. JavaScript
engines expose no portable hardware cycle counter, so — like the .NET and JVM
tools — `perf` reports `cycles/op` as unavailable and uses **CPU time/op**
(process CPU time, clock-independent) as the code-cost proxy. For a fully
machine-independent figure, `bench/run_callgrind.sh` counts **instructions/op**
under Valgrind, mirroring the Python tool.

## Native acceleration

The encoder's bulk array paths run through a swappable `Kernel` interface. The
default `jsKernel` is pure TypeScript and always active. An optional native
(N-API) or WebAssembly build can implement the same interface and be installed
with **no change to the public API**:

```ts
import { setKernel, loadNativeKernel, loadWasmKernel } from "@sofabuffers/corelib";

// Node / Electron: load the optional @sofabuffers/corelib-native addon if present
await loadNativeKernel();         // returns false (and keeps the JS kernel) if absent

// Anywhere (incl. browsers): instantiate a WASM kernel
await loadWasmKernel(wasmBytes, (exports) => makeKernel(exports));

// Or install your own:
setKernel(myKernel);
```

The boundary is deliberately *bulk* (a whole array per call, into guaranteed
capacity), so the cost of crossing into native code is amortised rather than paid
per element. The pure-JS kernel remains the fallback everywhere.

## Layering vs. the C library

| C file | TypeScript | Status |
|--------|------------|--------|
| `sofab.h` (types / constants) | `SofabError`, `WireType`, `FixlenSubtype`, `ArrayKind`, constants | ported |
| `ostream.c` | `OStream` (+ `FlushSink`) | ported |
| `istream.c` | `IStream` + `Visitor` | ported (push / visitor model, with a child-returning `sequenceBegin` for nesting) |
| `object.c` (descriptor transcoder) | — | not ported. The idiomatic TypeScript equivalent is generated message classes — a schema-driven generator emitting `Visitor` / encode glue; the streaming core above already covers serialize / deserialize. |

