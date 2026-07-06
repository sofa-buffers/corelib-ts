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
classic `<script>` tag — with no native dependency. It is a single, standalone
codec: the same source runs on V8 (Node) and JavaScriptCore (Bun) unchanged.

Like protobuf's `CodedInputStream` / `CodedOutputStream`, this library is meant
to be driven by **generated code**: a schema-driven generator (`sofabgen`) emits
one class per message plus marshal / unmarshal methods that call the primitives
here. The library offers **two decode models**: a resumable **push / visitor**
decoder for streaming, and a monomorphic **pull cursor** (`Cursor`) that
generated per-message code drives with a single `switch` over the field id.

The wire format is specified, language-neutrally, in the
[SofaBuffers documentation](https://github.com/sofa-buffers/documentation). The
unit tests here use the exact byte vectors from the
[C corelib](https://github.com/sofa-buffers/corelib-c-cpp)'s reference suite
(`test_vectors.json`) to guarantee byte-for-byte interoperability with the C,
C++, Rust, C#, Java, Go and Python implementations.

**Requirements.** Node.js **18+** (`engines.node >= 18`, CI runs 18 / 20 / 24),
or any modern browser / Electron / Deno / Bun. Built with TypeScript 5.7;
targets ES2020 (`bigint` is required).

**Dependencies.** None. The published package has **zero runtime dependencies**
and uses only standard JS / Web APIs (`Uint8Array`, `DataView`, `TextEncoder` /
`TextDecoder`) — nothing from `node:` on the hot path.

The npm package name is `@sofa-buffers/corelib`. Install from npm:

```bash
npm install @sofa-buffers/corelib
```

Ships **ESM** (`.js`), **CommonJS** (`.cjs`), a **browser IIFE global**
(`SofaBuffers`, for `<script>` / unpkg / jsDelivr) and full type declarations.

## Why this design

| Goal | How |
|------|-----|
| Runs everywhere | Pure TypeScript over `Uint8Array` / `DataView` / `TextEncoder` — no Node built-ins on the hot path, so the same build works in browsers, Electron and servers, on V8 and JavaScriptCore alike. |
| Streaming **out** | `OStream` writes into a small caller buffer and invokes a `FlushSink` whenever it fills, so a message can exceed the buffer — and even RAM. |
| Streaming **in** | `IStream` is a resumable state machine fed arbitrary chunks; large string / blob payloads are delivered in pieces to your `Visitor`. |
| Fast whole-buffer decode | When the whole message is already in one buffer, `decode()` (push) and `Cursor` (pull) advance one cursor instead of the per-byte state machine. |
| Full 64-bit fidelity | Unsigned / signed scalars round-trip the entire `uint64` / `int64` range: values are `number` when exact and `bigint` beyond `2^53-1` (`Long` offers a `bigint`-free path for the array hot loops). |
| Generated-code friendly | The pull `Cursor` gives generated code a monomorphic `readHeader()` + typed `read*` loop; the push `Visitor` has all-optional methods, so a sink overrides only the fields it needs. |
| Reserve-offset | `new OStream(buf, offset)` leaves room at the front of the buffer for a lower-layer protocol header (saves a copy). |
| Explicit endianness | IEEE-754 values are written / read little-endian via `DataView`, so behaviour is identical on every engine. |
| Pluggable acceleration | The encoder's bulk array paths run through a swappable `Kernel`; the default is pure TypeScript, and an optional native (N-API) or WebAssembly kernel can be installed with no API change. |

## Usage

### Simple encode

```ts
import { OStream } from "@sofa-buffers/corelib";

const os = new OStream();          // in-memory, auto-growing buffer
os.writeUnsigned(1, 42);
os.writeSigned(2, -7);
os.writeString(3, "hi");
const bytes = os.bytes();          // Uint8Array view of the finished message
```

Encoder and decoder report problems by throwing `SofabError`; the cause is on
`SofabError.code` (`ARGUMENT`, `USAGE`, `BUFFER_FULL`, `INVALID_MSG`).

### Simple decode (push / visitor)

`decode()` walks a whole buffer and calls one `Visitor` method per field. Every
`Visitor` method is optional; unhandled fields are silently skipped.

```ts
import { decode, type Visitor } from "@sofa-buffers/corelib";

class My implements Visitor {
  a = 0;
  b = 0;
  unsigned(id: number, v: number | bigint) { if (id === 1) this.a = Number(v); }
  signed(id: number, v: number | bigint)   { if (id === 2) this.b = Number(v); }
  // fp32(), fp64(), string(), blob(), arrayBegin(), sequenceBegin(), ... as needed
}

const sink = new My();
decode(bytes, sink);
```

### OStream — streaming a message larger than the buffer

`OStream` in streaming mode writes into a small caller buffer and drains it to a
`FlushSink` whenever it fills, so the buffer never has to be message-sized:

```ts
import { OStream, type FlushSink } from "@sofa-buffers/corelib";

const out: number[] = [];
const sink: FlushSink = (chunk) => out.push(...chunk); // or socket / file / stream
const os = new OStream(new Uint8Array(16), 0, sink);   // tiny 16-byte buffer
for (let i = 0; i < 1000; i++) os.writeUnsigned(i, BigInt(i));
os.flush();                                            // push the tail
```

### IStream — reading a payload fed in chunks

`IStream` resumes across chunk boundaries, so you can feed it whatever the
transport hands you — a packet, or a single byte — and finish with `end()`:

```ts
import { IStream, type Visitor } from "@sofa-buffers/corelib";

const is = new IStream();
for await (const chunk of socket) is.feed(chunk, visitor);
is.end(); // asserts the message ended cleanly on a field boundary

// String / blob payloads arrive as one or more chunks, each tagged with the
// field's `total` length and the byte `offset`, so they need never be held whole:
const visitor: Visitor = {
  blob(id, total, offset, chunk) {
    /* append `chunk` at `offset`; the field is `total` bytes */
  },
};
```

### Cursor — pull decode (the generated-code path)

`Cursor` inverts control: your code drives the loop. This is the shape generated
message classes use — one `switch` over `cursor.id`, reading straight into typed
fields, with `skip()` keeping the cursor in sync on unknown ids:

```ts
import { Cursor } from "@sofa-buffers/corelib";

const c = new Cursor(bytes);
let x = 0, y = 0;
while (c.readHeader()) {
  switch (c.id) {
    case 1: x = Number(c.readUnsigned()); break;
    case 2: y = Number(c.readSigned());   break;
    default: c.skip(c.wire);              break; // forward-compatible
  }
}
```

### Generated object code

`sofabgen` compiles a schema to one class per message whose `encode` / `decodeFrom`
methods call the runtime primitives above. A nested message just recurses into the
child type's `decodeFrom`; `readHeader()` returns `false` at the sequence's close:

```ts
import { Cursor, OStream } from "@sofa-buffers/corelib";

// Hand-written stand-in for sofabgen output.
class Point {
  x = 0;
  y = 0;

  encode(os: OStream): void {
    os.writeSigned(1, this.x);
    os.writeSigned(2, this.y);
  }

  static decodeFrom(c: Cursor): Point {
    const p = new Point();
    while (c.readHeader()) {
      switch (c.id) {
        case 1: p.x = Number(c.readSigned()); break;
        case 2: p.y = Number(c.readSigned()); break;
        // case 3: p.child = Child.decodeFrom(c); break;  // nested sequence
        default: c.skip(c.wire); break;
      }
    }
    return p;
  }
}

const os = new OStream();
Object.assign(new Point(), { x: 3, y: -4 }).encode(os);
const back = Point.decodeFrom(new Cursor(os.bytes()));
```

## API summary

### Encoding — `OStream`

One `write*` method per wire type, each appending a single field:
`writeUnsigned` / `writeSigned` (accept `number` **or** `bigint`), `writeBoolean`,
`writeFp32` / `writeFp64`, `writeString`, `writeBlob`, and `writeFixlen(id, bytes,
subtype)` as the raw escape hatch. Typed arrays go through
`write{Unsigned,Signed,Fp32,Fp64}Array`; nested messages are bracketed by
`writeSequenceBegin(id)` / `writeSequenceEnd()`. For the 64-bit array hot path,
`writeUnsignedArrayLong` / `writeSignedArrayLong` take `Long[]` and never allocate
a `bigint`. There is **no sticky-error model**: an out-of-range id/value, a full
buffer with no sink, or an unbalanced sequence **throws** `SofabError` on the spot.

Two buffer modes: `new OStream()` is in-memory and auto-growing; `new
OStream(buffer, offset?, flush?)` streams into a caller buffer, draining to
`flush` when it fills. `bytesUsed`, `bytes()`, `flush()`, `setBuffer()` and
`reset()` round out the surface (see **Memory handling**).

### Decoding — two models

**Push / visitor** (`IStream` + `Visitor`, and the one-shot `decode()`). You feed
bytes and the decoder *calls back* one `Visitor` method per field: `unsigned` /
`signed` (**number-first** — a plain `number` when `|value| ≤ 2^53-1`, a `bigint`
only beyond that), `fp32` / `fp64` (always `number`), `string` / `blob` (a
`(id, total, offset, chunk)` slice of the payload), array elements delivered one
at a time between `arrayBegin` / `arrayEnd` (never materialised as a JS array),
and `sequenceBegin(id): Visitor | void` which may return a child visitor to route
a nested message. Every method is optional and an unhandled field is skipped.
Use `IStream.feed()` / `end()` for chunked input; `decode()` is the faster
whole-buffer path.

**Pull / cursor** (`Cursor`). Over a contiguous buffer, your code drives the loop:
`readHeader()` advances to the next field (setting `.id` / `.wire`, returning
`false` at end-of-buffer or the matching sequence close), then a typed reader
consumes the value — `readUnsigned` / `readSigned` (number-first),
`readFp32` / `readFp64`, `readString` (decoded to a JS `string`), `readBlob`
(zero-copy view), the `read*Array` family (materialised as JS arrays, or `Long[]`
via `readUnsignedArrayLong` / `readSignedArrayLong`), and `skip(wire)` for an
unknown field (skipping a `SequenceStart` skips the whole nested subtree). This is
the monomorphic path generated per-message decoders use.

Arrays carry exactly four element kinds — unsigned / signed varint, fp32, fp64
(the fixlen-array path is restricted to `Fp32` / `Fp64`), so **string, blob and
nested-sequence elements are not allowed inside an array**; model those as
repeated fields or nested sequences. Booleans are encoded as the unsigned values
`0` / `1` (the wire has no separate boolean type), so they decode back through the
`unsigned` callback / `readUnsigned`.

### Memory handling

**Input buffer — payload bytes are zero-copy.** Scalars are produced *for* you
(integers as `number`, or `bigint` past the safe range; floats as `number`), so
there is nothing to own there. String and blob **payloads are not copied**: the
`chunk` passed to the visitor `string` / `blob`, and the view returned by
`Cursor.readBlob`, is a `subarray` aliasing the input (for `decode` / `Cursor`) or
the chunk you fed (for `IStream`). A visitor chunk is valid **only during that
callback**; a `Cursor` view is valid as long as the source buffer lives. Copy
(`chunk.slice()`) or decode on the spot (`new TextDecoder().decode(chunk)`) to
retain it. (`Cursor.readString` decodes for you, so it owns its result.)

**Output buffer — allocate-and-grow or caller-owned.** In-memory
(`new OStream()`): the library allocates an internal buffer (256 bytes) and
auto-grows it (doubling, via a fresh `Uint8Array` + copy); it never throws
`BUFFER_FULL`. `bytes()` returns a `subarray` **view** of the finished message —
copy it (`.slice()`) if it must outlive the next write or a grow. Streaming
(`new OStream(buffer, offset?, flush?)`): writes into the **caller-provided**
buffer and never grows; when it fills it hands the produced bytes to your `flush`
sink (as a `subarray` view valid only for the callback) and resets — without a
sink, a full buffer throws `BUFFER_FULL`. `offset` reserves room at the front for
a lower-layer header. `setBuffer(buffer, offset?)` installs a fresh buffer
mid-stream (`flush()` first — any unflushed bytes are dropped); `reset()` rewinds
to empty for pooling one `OStream` across many messages.

**Message object.** The `Visitor` / generated object is entirely caller-owned; the
library only calls methods on it and never retains a reference past the decode.

### Acceleration seam (`Kernel`)

The encoder's four bulk array transforms (`encodeUnsignedVarints`,
`encodeSignedVarints`, `packFp32Array`, `packFp64Array`) run through a swappable
`Kernel`. The default `jsKernel` is pure TypeScript and always active — **no
native or WebAssembly build ships in this package**. The seam is the stable
extension point: `loadNativeKernel()` tries to `require` an optional
`@sofabuffers/corelib-native` N-API addon (returns `false`, keeping the JS kernel,
if it or Node is absent), `loadWasmKernel(source, factory)` instantiates a WASM
module you supply, and `setKernel()` installs any object implementing the
interface — all with **no change to the public API**. The boundary is deliberately
*bulk* (a whole array per call, into pre-sized capacity) so the cost of crossing
into native code is amortised, never paid per element.

### Constants & helpers

`API_VERSION` (= 1), `ID_MAX`, `FIXLEN_MAX`, `ARRAY_MAX`, `MAX_DEPTH`, `U64_MAX`,
`I64_MIN`, `I64_MAX`; the `WireType`, `FixlenSubtype` and `ArrayKind` enum-like
objects; the `Long` 64-bit helper; errors via `SofabError` (`.code:
SofabErrorCode` — `ARGUMENT`, `USAGE`, `BUFFER_FULL`, `INVALID_MSG`); and the
kernel seam (`getKernel` / `setKernel`, `jsKernel`, `loadNativeKernel`,
`loadWasmKernel`). Every symbol is available both as a flat named export and
under the aggregate `sofab` namespace (`import * as sofab from "..."`).

## Feature flags

**No build toggles — always the full format.** Unlike the C library's
compile-time `SOFAB_DISABLE_*` switches, the TypeScript build always ships every
wire type (unsigned / signed varints, `fp32` / `fp64`, string / blob, integer &
fixlen arrays, nested sequences) at full 64-bit width, because the browser / Node /
Electron targets are not code-size constrained. The wire image is byte-identical
to the C default.

## Build & test

```bash
npm ci
npm run typecheck      # tsc --noEmit (strict)
npm test               # vitest run: vectors, chunked feeding, cursor, errors, round-trips
npm run coverage       # vitest run --coverage (v8): text + html + lcov
npm run build          # tsup -> ESM + CJS + IIFE + .d.ts in dist/
npm run smoke          # run the built bundle's cross-runtime smoke test on Node
```

Requires Node.js 18+. The `.devcontainer/` here builds a ready-to-use image
(`./.devcontainer/start.sh`) with Node and tooling preinstalled.

Tests live in `test/` as focused suites — including `vectors.test.ts` (encode +
decode every shared `test_vectors.json` vector, byte-exact vs. the C reference),
`istream.chunked.test.ts` (every vector fed one byte at a time), `cursor.test.ts`
(the pull-decode path parity + error branches), `errors.test.ts`,
`ostream.test.ts`, `roundtrip.test.ts`, `skip*.test.ts`, `varint.test.ts`,
`long.test.ts`, `kernel.test.ts` and `visitor-defaults.test.ts`. `test/smoke.mjs`
is a framework-free smoke test of the built bundle.

The CI workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml))
type-checks, tests and builds on Node 18 / 20 / 24, smoke-tests the built bundle
on Node, Deno and Bun, measures coverage, and publishes the coverage / branches
badge JSON consumed above to the `badges` branch. A separate
[`docs.yml`](.github/workflows/docs.yml) builds the TypeDoc API reference and
deploys it to GitHub Pages (the **Docs** badge).

## Benchmarks

Two standalone tools mirror the C / C++ / Rust / C# / Java / Python benchmarks so
the implementations can be compared directly:

```bash
# perf -- per-op cost: encodes/decodes one mixed message, reporting a code-cost
#         figure plus throughput MB/s. MB = 1e6 bytes.
npm run perf

# bench -- a throughput table (MB/s) for encode/decode of a 1000-element u64
#          array and a small "typical" mixed message.
npm run bench

# bench:callgrind -- machine-independent instructions/op under Valgrind.
npm run bench:callgrind
```

`perf` and `bench` encode the identical message (same field ids, types and
values) as their counterparts in the other ports and print the same report
layout. JavaScript engines expose no portable hardware cycle counter, so — like
the .NET and JVM tools — `perf` reports `cycles/op` as unavailable and uses **CPU
time/op** (process CPU time, clock-independent) as the code-cost proxy. For a
fully machine-independent figure, `bench/run_callgrind.sh` counts
**instructions/op** under Valgrind, mirroring the Python tool. Because this is one
codec running on two engines, running the same tools under Node (V8) and Bun
(JavaScriptCore) gives directly comparable numbers for each.
