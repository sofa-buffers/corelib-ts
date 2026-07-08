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

A dependency-free, streaming TypeScript implementation of the SofaBuffers
(*Sofab*) serialization format — the runtime stream core that runs anywhere
JavaScript does (Node.js, browsers, Electron, Deno, Bun, a `<script>` tag).

Like protobuf's `CodedInputStream` / `CodedOutputStream`, it is meant to be
driven by generated code: the `sofabgen` generator emits one class per message
with marshal / unmarshal methods that call these primitives. Two decode models
are offered — a resumable push / visitor decoder for streaming, and a
monomorphic pull cursor (`Cursor`) driven by a single `switch` over the field id.

### Requirements

Node.js 20+ (CI runs 20 / 24), or any modern browser / Electron / Deno /
Bun. Built with TypeScript 5.7; targets ES2020 (`bigint` required).

### Dependencies

None. Zero runtime dependencies; uses only standard JS / Web APIs
(`Uint8Array`, `DataView`, `TextEncoder` / `TextDecoder`).

### Packaging

Published as `@sofa-buffers/corelib`:

```bash
npm install @sofa-buffers/corelib
```

Ships ESM (`.js`), CommonJS (`.cjs`), a browser IIFE global (`SofaBuffers`) and
full type declarations.

## Why this design

| Goal | How |
|------|-----|
| Runs everywhere | Pure TypeScript over `Uint8Array` / `DataView` / `TextEncoder`, no Node built-ins on the hot path. |
| Streaming **out** | `OStream` writes into a small caller buffer and calls a `FlushSink` when it fills, so a message can exceed the buffer. |
| Streaming **in** | `IStream` is a resumable state machine fed arbitrary chunks; large string / blob payloads arrive in pieces. |
| Fast whole-buffer decode | With the whole message in one buffer, `decode()` (push) and `Cursor` (pull) advance a single cursor. |
| Full 64-bit fidelity | Scalars round-trip the entire `uint64` / `int64` range: `number` when exact, `bigint` beyond `2^53-1` (`Long` offers a `bigint`-free array path). |
| Generated-code friendly | The pull `Cursor` gives a monomorphic `readHeader()` + typed `read*` loop; the push `Visitor` has all-optional methods. |
| Reserve-offset | `new OStream(buf, offset)` leaves room at the front for a lower-layer header, saving a copy. |
| Explicit endianness | IEEE-754 values are read / written little-endian via `DataView`, identical on every engine. |
| Pluggable acceleration | The encoder's bulk array paths run through a swappable `Kernel`; the default is pure TypeScript. |

## Usage

The codec has four use cases — serialize a message that fits in one buffer,
serialize one too large for the buffer (streamed out in chunks), deserialize a
whole message, and deserialize one arriving in chunks — plus the generated-code
path that wraps them. Problems are reported by throwing `SofabError`; the cause is
on `SofabError.code` (`ARGUMENT`, `USAGE`, `BUFFER_FULL`, `INVALID_MSG`).

### Serialize

Write fields into an in-memory `OStream` and take a view of the finished bytes:

```ts
import { OStream } from "@sofa-buffers/corelib";

const os = new OStream();          // in-memory, auto-growing buffer
os.writeUnsigned(1, 42);
os.writeSigned(2, -7);
os.writeString(3, "hi");
const bytes = os.bytes();          // Uint8Array view of the finished message
```

### Serialize stream

Constructed over a caller-owned buffer with a `FlushSink`, `OStream` drains that
small buffer whenever it fills, so the buffer never has to be message-sized:

```ts
import { OStream, type FlushSink } from "@sofa-buffers/corelib";

const out: number[] = [];
const sink: FlushSink = (chunk) => out.push(...chunk); // or socket / file / stream
const os = new OStream(new Uint8Array(16), 0, sink);   // tiny 16-byte buffer
for (let i = 0; i < 1000; i++) os.writeUnsigned(i, BigInt(i));
os.flush();                                            // push the tail
```

### Deserialize

`decode()` walks a whole buffer and calls one optional `Visitor` method per field;
unhandled fields are silently skipped:

```ts
import { decode, type Visitor } from "@sofa-buffers/corelib";

class My implements Visitor {
  a = 0;
  b = 0;
  unsigned(id: number, v: number | bigint) { if (id === 1) this.a = Number(v); }
  signed(id: number, v: number | bigint)   { if (id === 2) this.b = Number(v); }
  // fp32(), fp64(), string(), blob(), arrayBegin(), sequenceBegin(), ... as needed
}

decode(bytes, new My());
```

### Deserialize stream

`IStream` resumes across chunk boundaries, so feed it whatever the transport hands
you — from any source — and finish with `end()`. String / blob payloads arrive as
one or more chunks tagged with the field's `total` length and byte `offset`:

```ts
import { IStream, type Visitor } from "@sofa-buffers/corelib";

const visitor: Visitor = {
  blob(id, total, offset, chunk) {
    /* append `chunk` at `offset`; the field is `total` bytes */
  },
};

const is = new IStream();
for await (const chunk of source) is.feed(chunk, visitor); // any async byte source
is.end(); // asserts the message ended cleanly on a field boundary
```

### Code generator

`sofabgen` compiles a schema to one class per message with a `marshal` (chaining
`OStream` writes) and a `static decode` driven by a monomorphic pull `Cursor` —
one `switch` over `c.id`. A hand-written stand-in, encoded then decoded:

```ts
import { OStream, Cursor } from "@sofa-buffers/corelib";

// generated by: sofabgen --lang typescript
class Point {
  x = 0;
  y = 0;

  marshal(os: OStream): void {
    os.writeSigned(1, this.x);
    os.writeSigned(2, this.y);
  }

  static decode(bytes: Uint8Array): Point {
    return Point.decodeFrom(new Cursor(bytes));
  }

  static decodeFrom(c: Cursor): Point {
    const p = new Point();
    while (c.readHeader()) {
      switch (c.id) {
        case 1: p.x = Number(c.readSigned()); break;
        case 2: p.y = Number(c.readSigned()); break;
        // case 3: p.child = Child.decodeFrom(c); break;  // nested sequence
        default: c.skip(c.wire); break;                   // forward-compatible
      }
    }
    return p;
  }
}

const p = new Point(); p.x = 3; p.y = 4;
const os = new OStream(); p.marshal(os);
const wire = os.bytes();
const got = Point.decode(wire);   // got.x === 3, got.y === 4
```

## Memory handling

Who owns the bytes:

- **Encode (`OStream`).** In-memory `new OStream()` — the library allocates and
  auto-grows an internal buffer (never throws `BUFFER_FULL`); `bytes()` returns a
  **view** of the finished message, so `.slice()` it if it must outlive the next
  write or grow. Streaming `new OStream(buf, offset?, flush?)` — writes into the
  caller-owned buffer and never grows; when it fills it drains a view to the
  `flush` sink (valid only during that callback) and, with no sink, throws
  `BUFFER_FULL`.
- **Decode (`decode()` / `Cursor` / `IStream`).** Input payload bytes are
  zero-copy: string / blob chunks and `Cursor.readBlob` are `subarray` **views**
  aliasing the input (or, for `IStream`, the chunk you fed). A visitor chunk is
  valid **only during that callback**; a `Cursor` view lasts as long as the source
  buffer lives. Scalars are delivered by value. Copy (`.slice()`) or decode
  (`Cursor.readString` decodes for you) to retain a payload.

## Feature flags

None — the build always ships every wire type.

## Build & test

```bash
npm ci
npm run typecheck      # tsc --noEmit (strict)
npm test               # vitest run: vectors, chunked feeding, cursor, errors, round-trips
npm run coverage       # vitest run --coverage (v8)
npm run build          # tsup -> ESM + CJS + IIFE + .d.ts in dist/
npm run smoke          # cross-runtime smoke test of the built bundle
```

Tests live in `test/` as focused suites, including `vectors.test.ts` (encode +
decode every shared conformance vector), `istream.chunked.test.ts` (every vector
fed one byte at a time), `cursor.test.ts`, `errors.test.ts`, `ostream.test.ts`,
`roundtrip.test.ts` and more. CI type-checks, tests and builds on Node 20 /
24, smoke-tests the bundle on Node, Deno and Bun, and publishes coverage badges;
a separate `docs.yml` deploys the TypeDoc API reference to GitHub Pages.

## Benchmarks

Two standalone tools mirror the other-language ports so implementations can be
compared directly:

```bash
npm run perf              # per-op cost: code-cost figure plus throughput MB/s
npm run bench             # throughput table (MB/s) for a u64 array and a mixed message
npm run bench:callgrind   # machine-independent instructions/op under Valgrind
```

`perf` and `bench` encode the identical message as their counterparts in the
other ports and print the same report layout. Since JS engines expose no portable
cycle counter, `perf` uses CPU time/op as the code-cost proxy; `bench:callgrind`
counts instructions/op under Valgrind for a fully machine-independent figure.
Running the same tools under Node (V8) and Bun (JavaScriptCore) gives directly
comparable numbers.
