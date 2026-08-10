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
Bun. Built with TypeScript 6.x; targets ES2020 (`bigint` required).

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
| Streaming **out** | `OStream` writes into a small caller buffer and calls a `FlushSink` when it fills, so a message can exceed the buffer — by any amount, down to a one-byte buffer: a value too large for the buffer is split across flushes. |
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
on `SofabError.code` (`ARGUMENT`, `USAGE`, `BUFFER_FULL`, `INVALID_MSG`,
`INCOMPLETE`). The decoder splits its two failure kinds (MESSAGE_SPEC §7):
`INVALID_MSG` is a message malformed regardless of what follows, while
`INCOMPLETE` means the bytes merely ended *inside* a field — a truncation more
bytes could complete, which is not an error the caller must treat as one. There
is no finish/finalize step: a streaming decode reports `INCOMPLETE` from `end()`
(see below), never by promoting it to a throw.

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

Every integer written — scalar **or array element** — is checked against the
64-bit value domains (CORELIB_PLAN §6.2): unsigned `0 .. 2^64 - 1`, signed
`-2^63 .. 2^63 - 1`. Anything outside them is a caller mistake and throws
`SofabError` with code `ARGUMENT`; the encoder never reduces a value modulo 2^64
and never puts a wrapped one on the wire. The answer does not depend on how the
encoder was constructed — the in-memory and streaming modes reject exactly the
same values — nor on the installed `Kernel`, which carries the same obligation.

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

### Nested sequences

A nested message is a *sequence*: a fresh id scope between a begin header and the
`0x07` end marker. MESSAGE_SPEC §2 omits a sequence-typed **field** whose value
equals its declared default, so the encoder holds the begin header back until the
sequence proves it has content — no buffering of the sub-message, and nothing to
compare byte images against:

```ts
const os = new OStream();
os.writeUnsigned(1, 42);
os.writeSequenceBeginLazy(2);   // a nested field...
os.writeSequenceEnd();          // ...that got no content: header and end both vanish
os.writeSequenceBeginLazy(3);
os.writeString(1, "hi");        // content — commits the held-back header first
os.writeSequenceEnd();
os.bytes();                     // 08 2a 1e 0a 12 68 69 07  (field 2 is not on the wire)
```

Which closer to use is decided **statically**, by the position in the schema, not
by the value:

| position | closer |
|---|---|
| `struct` / `union` field, array-field wrapper | `writeSequenceEnd()` — drops a contentless frame |
| wrapper-array **element**, or an array field differing from a non-empty declared default | `writeSequenceEndKeep()` — always emits `begin` + `end` |

An element keeps its frame because element presence is what carries a dynamic
array's length (highest present id + 1, §5.1); dropping an all-default element
would change the decoded length, not just the bytes. The failure directions are
not symmetric, so `writeSequenceEndKeep()` is the safe choice when in doubt: a
needless one costs a non-canonical empty frame that a decoder normalizes away,
while a wrong `writeSequenceEnd()` shortens an array. Raw transcoding — replaying
bytes rather than encoding a schema value — should use `writeSequenceEndKeep()`
throughout, so the output reproduces the input frame for frame.

```ts
const os = new OStream();
os.writeSequenceBeginLazy(4);   // the wrapper array
os.writeSequenceBeginLazy(0);   // element 0 — has content
os.writeUnsigned(0, 7);
os.writeSequenceEndKeep();
os.writeSequenceBeginLazy(1);   // element 1 — all-default, but still present
os.writeSequenceEndKeep();      // ...so its frame stays: the array has length 2
os.writeSequenceEnd();
os.bytes();                     // 26 06 00 07 07 0e 07 07
```

Decoding is unaffected by the distinction: an empty frame is valid input that the
message layer normalizes to the default, and an absent sequence field is
reconstructed from the schema default. Nesting is capped at `MAX_DEPTH` (255) on
both sides; the encoder holds headers back to that full depth, so its output is
canonical however deep a message nests. A held-back header is encoder state, never
buffer content, so streaming through a small buffer produces the same bytes.

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

`fieldBegin(id, wire)` is announced first for every field — right after the header
varint, before the value and before the value's *own* header word (a fixlen length
word, an array count word, a nested sequence's fields). It is the push twin of
`Cursor.readHeader()`, and it is where a check the header alone decides belongs: a
wrapper-array element whose id is past the schema `count` needs no length, no
count and no payload, and a message that ends inside the word behind that header
fires no later callback at all — so without it the same bytes were `INVALID`
through the cursor and `INCOMPLETE` through the visitor, which §5.2 forbids.
Throwing from it rejects the field, as from `fixlenBegin`. The sequence-*end*
marker gets no `fieldBegin`: it closes a scope rather than opening a field, the
same answer `readHeader()` gives by returning `false` for it. Checks that need
more than `id` and `wire` stay on the later, more informative hook — a fixlen
subtype on `fixlenBegin`, a declared length or element count on `fixlenBegin` /
`arrayBegin`.

### Deserialize stream

`IStream` resumes across chunk boundaries, so feed it whatever the transport hands
you — from any source — and read the outcome from `end()`. String / blob payloads
arrive as one or more chunks tagged with the field's `total` length and byte
`offset`:

```ts
import { IStream, DecodeStatus, type Visitor } from "@sofa-buffers/corelib";

const visitor: Visitor = {
  blob(id, total, offset, chunk) {
    /* append `chunk` at `offset`; the field is `total` bytes */
  },
};

const is = new IStream();
for await (const chunk of source) is.feed(chunk, visitor); // any async byte source
// end() is a pure accessor — it never throws and never promotes an incomplete
// decode to an error (MESSAGE_SPEC §7). The caller owns end-of-input.
if (is.end() !== DecodeStatus.Complete) {
  // stream ended inside a field (INCOMPLETE) — wait for more bytes, or treat
  // the truncation as an error if this really was the end of input.
}
```

`INVALID` is **terminal** (CORELIB_PLAN §5.2): no later bytes can make malformed
input valid. A stream that has thrown `INVALID_MSG` from `feed` is therefore
poisoned for good — every further `feed` re-throws it without consuming a byte or
calling the visitor, and `end()` answers `INVALID` however many well-formed
chunks follow. So a caller that catches the throw and keeps going still gets a
truthful verdict:

```ts
import { SofabError, SofabErrorCode } from "@sofa-buffers/corelib";

const is = new IStream();
try {
  for await (const chunk of source) is.feed(chunk, visitor);
} catch (e) {
  if ((e as SofabError).code !== SofabErrorCode.InvalidMsg) throw e;
}
is.end(); // INVALID — never COMPLETE, never INCOMPLETE
```

A receiver-side cap (`LIMIT_EXCEEDED`, see [Decode limits](#decode-limits)) does
*not* poison the stream: the bytes are well-formed and the same message decodes
under a looser limit (§6.2.1), so it is a policy rejection, not the `INVALID`
outcome.

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
- **`MIN_OUTPUT_BUFFER` = `1`.** The smallest buffer this port accepts *for
  streaming*, exported from the package so a caller can size from it. It is `1`
  because the encoder splits every atomic unit — field header, fixlen word,
  element count, a scalar or array element varint, an `fp32` / `fp64` element —
  across a flush, so a message of any size encodes through a one-byte buffer and
  the bytes produced are identical at every size. It binds a buffer installed
  **with** a sink, at construction and at every mid-stream `setBuffer`:
  `buf.length - offset` must be at least `MIN_OUTPUT_BUFFER`, and a smaller
  window is rejected right there with `ARGUMENT` — never partway through a
  message — leaving the encoder on the buffer it already had. A buffer installed
  **without** a sink has no minimum: no flush can occur, so nothing can be split.
  That is the one-shot `MAX_SIZE` case and it stays exact — a two-byte message
  encodes into a two-byte buffer.
- **Decode (`decode()` / `Cursor` / `IStream`).** Input payload bytes are
  zero-copy: string / blob chunks and `Cursor.readBlob` are `subarray` **views**
  aliasing the input (or, for `IStream`, the chunk you fed). A visitor chunk is
  valid **only during that callback**; a `Cursor` view lasts as long as the source
  buffer lives. Scalars are delivered by value. Copy (`.slice()`) or decode
  (`Cursor.readString` decodes for you) to retain a payload.

### Decode limits

For a schema whose `count` / `maxlen` bounds are omitted, the decoder otherwise
accepts whatever count / length the received message claims. Pass an optional
`DecodeLimits` object to cap that and protect a receiver from a hostile oversized
field:

```ts
const limits = { maxArrayCount: 65536, maxStringLen: 1 << 20, maxBlobLen: 1 << 20 };
decode(bytes, visitor, limits);       // one-shot push
new Cursor(bytes, limits);            // pull
new IStream(limits);                  // streaming
```

An over-limit array count or string / blob length is rejected at the field's
header — **before** the array is sized or any payload is decoded or streamed to
the visitor — by throwing `SofabError` with code
`SofabErrorCode.LimitExceeded`. The decoder never clamps or truncates. Each limit
is independent, and an omitted one means **no cap** (the default is today's
unlimited behavior — the corelib invents no default). `LimitExceeded` is distinct
from `INVALID_MSG`: exceeding a receiver-configured limit is policy, not a
malformed message — so, unlike `INVALID_MSG`, it does not poison an `IStream`
(see [Deserialize stream](#deserialize-stream)). Generated code supplies these
values from the sofabgen config.

A limit applies **only to a field the schema leaves unbounded** (§6.2.1). Where
the schema declares a `count` / `maxlen`, that bound governs and an over-bound
value is `INVALID_MSG`, never `LimitExceeded` — a schema bound states what is
*valid*, a receiver limit only what this deployment has the *capacity* for, and
two receivers with the same schema and different limits must not disagree about a
bounded field. On the pull `Cursor` this is automatic: passing the schema bound
(`readString(maxlen)`, `readUnsignedArray(count)`, …) both enables the `INVALID`
check and takes the field out of the cap's reach, so a bounded field decodes
normally even when its size exceeds the configured cap. The push surfaces
(`decode()`, `IStream`) are driven by wire type and never learn the schema, so
there the caps apply to every field; a caller that needs the distinction on a
bounded field decodes it through `Cursor`, or leaves the cap unset and enforces
the schema bound itself from `fixlenBegin` / `arrayBegin`, which carry the
declared size.

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

Three standalone tools mirror the other-language ports so implementations can be
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
