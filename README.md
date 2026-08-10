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
| Reserve-offset | `new OStream(buf, offset)` leaves room at the front for a lower-layer header, saving a copy. The offset belongs to that installation and is consumed by the flush that hands the unit over; `setBuffer(buf, offset)` from inside the sink re-arms it, for header room in every packet. |
| Caller-owned buffers | The encoder allocates no output buffer and grows none: it writes into yours, and asks the `BufferOwner` you named for the next one when it fills. `growingOStream()` is that owner ready-made. |
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
is no finish/finalize step: every streaming `feed()` *returns* the decode outcome
for the bytes so far (see below), so `INCOMPLETE` is reported to the caller,
never promoted to a throw.

### Serialize

`OStream` writes into the buffer **you** hand it — the library allocates no
output buffer and never grows one it was given (CORELIB_PLAN §5.1). Where the
schema bounds the message, that is one buffer of `MAX_SIZE` bytes:

```ts
import { OStream } from "@sofa-buffers/corelib";

const os = new OStream(new Uint8Array(MAX_SIZE));  // your buffer, sized from the schema
os.writeUnsigned(1, 42);
os.writeSigned(2, -7);
os.writeString(3, "hi");
const bytes = os.bytes();          // Uint8Array view of the finished message
```

Where it does not — no `maxlen` / `count` to size from — the buffer has to follow
the message, and that is the caller's job too. `growingOStream()` builds that caller,
ready-made: it owns a buffer, hands it to the encoder like any other caller and
replaces it with a bigger one of its own as the message grows. It is the
one-liner for the 90% case:

```ts
import { growingOStream } from "@sofa-buffers/corelib";

const os = growingOStream();   // the accumulator owns the buffer
os.writeUnsigned(1, 42);
os.writeSigned(2, -7);
os.writeString(3, "hi");
const bytes = os.bytes();          // the whole message; never throws BUFFER_FULL
```

Everything below is written against `OStream`, and every one of its `write*`
methods works the same on the stream `growingOStream()` returns.

Every integer written — scalar **or array element** — is checked against the
64-bit value domains (CORELIB_PLAN §6.2): unsigned `0 .. 2^64 - 1`, signed
`-2^63 .. 2^63 - 1`. Anything outside them is a caller mistake and throws
`SofabError` with code `ARGUMENT`; the encoder never reduces a value modulo 2^64
and never puts a wrapped one on the wire. The answer does not depend on how the
encoder was constructed — a buffer that grows and a fixed streaming one reject
exactly the same values — nor on the installed `Kernel`, which carries the same obligation.
A `number` that is not an integer at all (a fraction, `NaN`, `±Infinity`) is the
same kind of caller mistake and is reported the same way: `SofabError` with code
`ARGUMENT`, never a bare `RangeError` — so the `instanceof SofabError` pattern
above catches every encoder rejection without exception.

The byte-level `writeFixlen(id, data, subtype)` is checked the same way, against
the fixlen domain of CORELIB_PLAN §4.6: subtypes `0x4`–`0x7` are **reserved**, and
an `fp32` / `fp64` payload is **exactly** 4 / 8 bytes. Either mistake throws
`ARGUMENT` before a byte is written, because a decoder must reject the resulting
`fixlen_word` as malformed (`INVALID_MSG`) — the encoder does not emit bytes it
would refuse to read. `String` and `Blob` still take any length up to
`FIXLEN_MAX` (`0x7fffffff`), and the typed `writeFp32` / `writeFp64` /
`writeString` are correct by construction and pay nothing for this.

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
const os = growingOStream();
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
const os = growingOStream();
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
you — from any source — and read the outcome from what `feed()` **returns**: the
three-valued status for the bytes consumed so far (CORELIB_PLAN §5.2/§6). There is
no end / finalize step; `status()` re-reads that same value whenever you want it
later. String / blob payloads arrive as one or more chunks tagged with the field's
`total` length and byte `offset`:

```ts
import { IStream, DecodeStatus, type Visitor } from "@sofa-buffers/corelib";

const visitor: Visitor = {
  blob(id, total, offset, chunk) {
    /* append `chunk` at `offset`; the field is `total` bytes */
  },
};

const is = new IStream();
let status = DecodeStatus.Complete;               // zero bytes end on a boundary
for await (const chunk of source) {
  status = is.feed(chunk, visitor);               // any async byte source
}
// feed() never throws for a merely incomplete decode and never promotes one to
// an error (MESSAGE_SPEC §7). The caller owns end-of-input.
if (status !== DecodeStatus.Complete) {
  // stream ended inside a field (INCOMPLETE) — wait for more bytes, or treat
  // the truncation as an error if this really was the end of input.
}
```

`status()` returns exactly what the last `feed()` returned, for a caller that
would rather ask later than thread the value through — it is a pure accessor and
never changes the verdict. (`end()` is a deprecated alias of `status()`, kept so
existing code compiles; the spec's decoder has no "end" step.)

`INVALID` is **terminal** (CORELIB_PLAN §5.2): no later bytes can make malformed
input valid. `INVALID` is the one outcome `feed()` does not return: it travels on
the error channel, as a thrown `INVALID_MSG`. A stream that has thrown it is
poisoned for good — every further `feed` re-throws it without consuming a byte or
calling the visitor, and `status()` answers `INVALID` however many well-formed
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
is.status(); // INVALID — never COMPLETE, never INCOMPLETE
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
import { OStream, growingOStream, Cursor } from "@sofa-buffers/corelib";

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
const os = growingOStream(); p.marshal(os);
const wire = os.bytes();
const got = Point.decode(wire);   // got.x === 3, got.y === 4
```

## Memory handling

Who owns the bytes:

- **Encode (`OStream`).** Every buffer the encoder writes into is
  **caller-supplied**: the library allocates none of its own and never grows or
  reallocates one it was handed (CORELIB_PLAN §5.1) — `new OStream(buf, offset?,
  flush?)` writes into `buf` and into nothing else. When it fills it drains a
  view to the `flush` sink (valid only during that callback) and continues; with
  no sink it throws `BUFFER_FULL`. `bytes()` returns a **view** of what is in the
  buffer — with a sink, only the not-yet-flushed tail — so `.slice()` it if it
  must outlive the next write.
- **The `offset` belongs to the installation, not to the buffer** (§5.1). It
  reserves room at the front of the unit the buffer-set begins — the constructor
  or `setBuffer` — and handing that unit to the sink **consumes** it: a sink that
  returns without installing a buffer has *copied*, so the encoder keeps writing
  into the same buffer and resumes at `0`, with the whole buffer usable from
  there. A sink that wants header room in **every** flushed unit — one framing
  header per packet — re-arms it by calling `setBuffer(buf, offset)` from inside
  the callback; passing the buffer it already has counts, a buffer-set is a new
  installation like any other. A sink that *takes* the buffer (hands it to a
  transport, queues it, gives it to DMA) must install a replacement before
  returning, for the same reason: returning bare says "reuse the storage".
  Either way the bytes are the same — only the unit sizes differ. `reset()` and
  `bytes()` follow the current installation, so after a flush they are relative
  to `0`; on a sink-less stream, which can never flush, the reservation stands
  for the life of the encode.
- **Encode into memory (`growingOStream()`, `BufferOwner`).** The allocating
  half is the caller's role (§5.1: "the generated-object layer allocates; the
  corelib does not"), and a caller that owns its storage names a `BufferOwner`:
  when the buffer fills, the encoder asks it for the next one — at least
  `used + needed` bytes, holding the first `used` of the old — instead of
  enlarging what it was handed. `growingOStream(initialCapacity?)` is that owner
  ready-made, a doubling accumulator: it never throws `BUFFER_FULL`, its
  `bytes()` is the **whole** message (a view — `.slice()` it if it must outlive
  the next write or growth), and `reset()` keeps the buffer it grew to, so a
  pooled encoder stops allocating. The buffer belongs to the owner, so
  `setBuffer` on such a stream throws `ARGUMENT`: hand a buffer of your own to a
  plain `OStream` instead. `new OStream()` with no arguments is a **deprecated**
  alias for `growingOStream()` and will be removed.
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
