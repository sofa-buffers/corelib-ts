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
with `serialize` / `decode` methods that call these primitives. Decoding has one
surface, the **visitor** (CORELIB_PLAN §5.3.1): a resumable push decoder that takes
chunks of any size and calls one method per field.

### Requirements

Node.js 20+ — CI runs 20 / 22 / 24 / 26 — or any modern browser / Electron /
Deno / Bun. Built with TypeScript 6.x; targets ES2020 (`bigint` required).

### Dependencies

None. Zero runtime dependencies; uses only standard JS / Web APIs
(`Uint8Array`, `DataView`, `TextEncoder` / `TextDecoder`).

### Feature flags

None — the build always ships every wire type.

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
| One decode surface | The visitor, and nothing beside it (§5.3.1). `decode()` is that decoder fed once, so a whole-buffer decode runs the same code and the same rules as a chunked one. |
| Full 64-bit fidelity | Scalars round-trip the entire `uint64` / `int64` range: `number` when exact, `bigint` beyond `2^53-1`, and every integer callback carries the exact `lo` / `hi` halves beside the value for a `bigint`-free consumer (`Long`). |
| Generated-code friendly | One flat `Visitor` per message, all methods optional; nesting arrives as `sequenceBegin` / `sequenceEnd` events carrying id and depth, which generated code routes on. |
| Reserve-offset | `new OStream(buf, offset)` leaves room at the front for a lower-layer header, saving a copy. The offset belongs to that installation and is consumed by the flush that hands the unit over; `setBuffer(buf, offset)` from inside the sink re-arms it, for header room in every packet. |
| Caller-owned buffers | The encoder allocates no output buffer, grows none, and has no hook that could grow one for it: it writes into yours, and when it fills it flushes to your sink, which may install the next buffer. `growingOStream()` is that caller ready-made — a scratch buffer with a sink that accumulates the result. |
| No payload storage in the codec | After construction the encoder and decoder allocate no storage a wire number sizes (§6.6) — no views, no scratch, no growable state — apart from the **language-forced handles** of §6.6.2, itemised under [Memory handling](#memory-handling). Verified two ways: no allocation primitive on a codec path, and a flat heap over a complete encode and decode. |
| No views | Nothing the decoder hands over aliases anything it owns (§6.7). A payload arrives as a range of the chunk **you** fed, so what you keep, you copied. |
| Explicit endianness | IEEE-754 values are read / written little-endian — bit-for-bit identical on every engine, big-endian hosts included. |
| Pluggable acceleration | The encoder's bulk array paths run through a swappable `Kernel`, and that interface is the entire seam: `setKernel(yourKernel)`. **No accelerated backend exists today** — the kernel is the pure-TypeScript one on every host unless you build and install your own (native addon or WASM); the library ships no loader for one. |

## Usage

The codec has four use cases — serialize a message that fits in one buffer,
serialize one too large for the buffer (streamed out in chunks), deserialize a
whole message, and deserialize one arriving in chunks — plus the generated-code
path that wraps them.

Problems are reported by throwing `SofabError`; the cause is on
`SofabError.code` (`ARGUMENT`, `BUFFER_FULL`, `INVALID_MSG`, `INCOMPLETE`,
`LIMIT_EXCEEDED`), and that is the whole set. A read whose declared type
contradicts the field on the wire is not an error at all: the field is *skipped*
like an unknown id, the destination is left untouched and the decode stays
`COMPLETE`. `INVALID_MSG` is a message malformed regardless of what follows;
`INCOMPLETE` means the bytes merely ended *inside* a field, and is reported by
what `feed()` returns rather than thrown — there is no finish/finalize step.
`LIMIT_EXCEEDED` is neither: it is a receiver-local *policy* rejection, a field
larger than a cap **you** configured (see [Decode limits](#decode-limits)).

### Serialize

`OStream` writes into the buffer **you** hand it: the library allocates no output
buffer and never grows one it was given. Where the schema bounds the message,
that is one buffer of `MAX_SIZE` bytes:

```ts
import { OStream } from "@sofa-buffers/corelib";

const os = new OStream(new Uint8Array(MAX_SIZE));  // your buffer, sized from the schema
os.writeUnsigned(1, 42);
os.writeSigned(2, -7);
os.writeString(3, "hi");
const bytes = os.bytes();          // Uint8Array view of the finished message
```

Where it does not — no `maxlen` / `count` to size from — `growingOStream()` owns
a buffer, hands it to the encoder like any other caller and replaces it with a
bigger one of its own as the message grows:

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
64-bit value domains: unsigned `0 .. 2^64 - 1`, signed `-2^63 .. 2^63 - 1`.
Anything outside them, and any `number` that is not an integer at all (a
fraction, `NaN`, `±Infinity`), throws `SofabError` with code `ARGUMENT` rather
than a bare `RangeError`; the encoder never reduces a value modulo 2^64 and never
puts a wrapped one on the wire. That answer does not depend on how the encoder
was constructed, nor on the installed `Kernel`, which carries the same
obligation.

The byte-level `writeFixlen(id, data, subtype)` is checked the same way against
the fixlen domain: subtypes `0x4`–`0x7` are **reserved**, and an `fp32` / `fp64`
payload is **exactly** 4 / 8 bytes. Either mistake throws `ARGUMENT` before a
byte is written. `String` and `Blob` still take any length up to `FIXLEN_MAX`
(`0x7fffffff`); the typed `writeFp32` / `writeFp64` / `writeString` are correct
by construction.

### Serialize stream

Constructed over a caller-owned buffer with a `FlushSink`, `OStream` drains that
small buffer whenever it fills, so the buffer never has to be message-sized:

```ts
import { OStream, type FlushSink } from "@sofa-buffers/corelib";

const out: number[] = [];
// The sink is handed the installed buffer and the region's bounds — never memory
// from anywhere else (§5.1.6), and never a view the encoder built (§6.6).
const sink: FlushSink = (buf, start, end) => {         // or socket / file / stream
  for (let i = start; i < end; i++) out.push(buf[i]!);
};
const os = new OStream(new Uint8Array(16), 0, sink);   // tiny 16-byte buffer
for (let i = 0; i < 1000; i++) os.writeUnsigned(i, BigInt(i));
os.flush();                                            // push the tail
```

### Nested sequences

A nested message is a *sequence*: a fresh id scope between a begin header and the
`0x07` end marker. A sequence-typed **field** whose value equals its declared
default is omitted from the wire, so the encoder holds the begin header back
until the sequence proves it has content — no buffering of the sub-message:

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
array's length (highest present id + 1): dropping an all-default element would
shorten the array. `writeSequenceEndKeep()` is the safe choice when in doubt — a
needless one costs only a non-canonical empty frame that a decoder normalizes
away — and raw transcoding, replaying bytes rather than encoding a schema value,
uses it throughout so the output reproduces the input frame for frame.

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
both sides, and the encoder holds headers back to that full depth. A held-back
header is encoder state, never buffer content, so streaming through a small
buffer produces the same bytes.

### Deserialize

`decode()` walks a whole buffer and calls one optional `Visitor` method per field; a
field whose callback you did not implement is skipped. The visitor is **flat**: one
object receives the whole message, nested scopes included.

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

There are exactly two things to do with a field — **read** it or **skip** it
(§6.7.2) — and not implementing a callback is how you say the second.

`fieldBegin(id, wire)` is announced first for every field — right after the header
varint, before the value and before the value's *own* header word (a fixlen length
word, an array count word, a nested sequence's fields). It gives a reader the field
stream in wire order without writing the eight value callbacks. The sequence-*end*
marker gets none: it closes a scope rather than opening a field, and its id is
discarded (§4.9).

**Do not apply a schema bound from it.** An element id past the declared `count`
looks decidable from the id alone, and is not: that bound applies only to a field
whose *subtype* has confirmed it is the declared one, so it belongs on
`fixlenBegin`. A message ending inside the fixlen word is `INCOMPLETE` even when
the id would violate the bound. Throwing from `fieldBegin` is still how you
reject a field the header alone settles — an id you will not accept in any shape.
Everything schema-shaped stays on the later, more informative hook: a fixlen
subtype and a declared length on `fixlenBegin`, a declared element count on
`arrayBegin`.

`sequenceBegin(id, depth)` opens a nested scope and `sequenceEnd(id, depth)` closes
it — the same visitor receives the scope's fields, with their own ids and
`depth + 1`. Route on the `(id, depth)` pair, which a schema fixes statically:

```ts
let inChild = false;
const v: Visitor = {
  sequenceBegin: (id, depth) => { if (id === 3 && depth === 1) inChild = true; },
  sequenceEnd:   (id, depth) => { if (id === 3 && depth === 1) inChild = false; },
  unsigned: (id, value) => { /* `inChild` says which scope this id belongs to */ },
};
```

Return **`false`** from `sequenceBegin` to decline the whole subtree: no callback of
any kind fires inside it, a scope opened within it is never offered either, and no
`sequenceEnd` arrives for what was declined.

A declined subtree is still parsed — a sequence is framed by markers rather than by
a length, so its end has to be found — but nothing is decoded into existence for
it, and the caps in `DecodeLimits` do not fire. Format ceilings (`ARRAY_MAX`,
`FIXLEN_MAX`, `MAX_DEPTH`, the varint bound) apply inside a declined subtree exactly
as outside it.

### Deserialize stream

`IStream` resumes across chunk boundaries: feed it whatever the transport hands
you and read the outcome from what `feed()` **returns**, the three-valued status
for the bytes consumed so far. There is no end / finalize step. The visitor is bound
at construction. String / blob payloads arrive in one or more pieces, each a range
`[start, end)` of the chunk **you** fed, tagged with the field's `total` length and
the piece's `offset` within it:

```ts
import { IStream, DecodeStatus, type Visitor } from "@sofa-buffers/corelib";

const visitor: Visitor = {
  blob(id, total, offset, src, start, end) {
    /* copy `src[start..end)` to `offset` of a `total`-byte destination of yours */
  },
};

const is = new IStream(visitor);
let status = DecodeStatus.Complete;               // zero bytes end on a boundary
for await (const chunk of source) {
  status = is.feed(chunk);                        // any async byte source
}
// feed() never throws for a merely incomplete decode and never promotes one to
// an error (MESSAGE_SPEC §7). The caller owns end-of-input.
if (status !== DecodeStatus.Complete) {
  // stream ended inside a field (INCOMPLETE) — wait for more bytes, or treat
  // the truncation as an error if this really was the end of input.
}
```

The chunk is borrowed **only for the duration of `feed`** (§6.0): once it returns
you may reuse, overwrite or free it, and what you decoded is unaffected — the
decoder retains nothing that points into it. Copy what you want to keep, during the
call; `PayloadAcc` and `decodeUtf8` are the ready-made way.

`status()` returns exactly what the last `feed()` returned; it is a pure accessor
and never changes the verdict.

`INVALID` is **terminal**, and is the one outcome `feed()` does not return: it
travels on the error channel, as a thrown `INVALID_MSG`. A stream that has thrown
it is poisoned for good — every further `feed` re-throws it without consuming a
byte or calling the visitor, and `status()` answers `INVALID` however many
well-formed chunks follow:

```ts
import { SofabError, SofabErrorCode } from "@sofa-buffers/corelib";

const is = new IStream(visitor);
try {
  for await (const chunk of source) is.feed(chunk);
} catch (e) {
  if ((e as SofabError).code !== SofabErrorCode.InvalidMsg) throw e;
}
is.status(); // INVALID — never COMPLETE, never INCOMPLETE
```

A receiver-side cap (`LIMIT_EXCEEDED`, see [Decode limits](#decode-limits)) is
terminal in the same way — every further `feed` re-throws it — but it is **not** the
`INVALID` outcome: the bytes are well-formed and decode under a looser cap, so
`status()` never answers `INVALID` for it. It is read off the error channel, not
from `status()`.

### 64-bit values without `bigint`

The default 64-bit surface is *number-first*: a value that fits exactly comes
back as a `number`, and only past `2^53-1` is a `bigint` materialised — so the
runtime type of a `u64` / `i64` depends on the value. `Long`, a value carried as two
unsigned 32-bit halves (`.low` / `.high`), is the fixed-type alternative on the
**encode** side. It is **representation-only**: the wire is identical to the
`number | bigint` path, byte for byte.

```ts
import { Long, growingOStream } from "@sofa-buffers/corelib";

const os = growingOStream();
os.writeUnsignedLong(1, Long.fromValue(2n ** 63n));         // scalar
os.writeSignedLong(2, Long.fromValue(-(2n ** 62n)));
os.writeUnsignedArrayLong(3, [1n, 2n].map(Long.fromValue)); // array
```

On the decode side there is no channel to switch on: **every** integer callback
carries the exact 64 bits as two unsigned 32-bit halves, beside the number-first
value. Read whichever you want — the halves cost nothing to pass and nothing to
ignore, and a `Long` built from them never goes through `bigint` arithmetic:

```ts
import { decode, Long, type Visitor } from "@sofa-buffers/corelib";

const v: Visitor = {
  unsigned(id, value, lo, hi) { const x = Long.fromBits(lo, hi); },
  signed(id, value, lo, hi)   { /* lo/hi are the decoded two's-complement halves */ },
  arrayUnsigned(id, i, value, lo, hi) { /* … per element */ },
  arraySigned(id, i, value, lo, hi)   { /* … */ },
};
decode(bytes, v);
```

Narrowing back is exact:
`value.low` for `u8`..`u32`, and `value.low | 0` for `i8`..`i32`.

### Code generator

`sofabgen` compiles a schema to one class per message with a `serialize` (chaining
`OStream` writes) and two decode entry points: a `static decode` for a message
already in one buffer, and a `static decoder()` bound to `IStream` for one arriving
in chunks — the same generated type driven whole-buffer or incrementally. Both
drive the same visitor, because there is only one decode surface (§5.3.1): what
changes is the drive, not the reader. A hand-written stand-in of both halves,
encoded and decoded each way:

```ts
import {
  OStream,
  growingOStream,
  IStream,
  DecodeStatus,
  decode,
  type FlushSink,
  type Visitor,
} from "@sofa-buffers/corelib";

// generated by: sofabgen --lang typescript
class Point {
  x = 0;
  y = 0;

  serialize(os: OStream): void {
    os.writeSigned(1, this.x);
    os.writeSigned(2, this.y);
  }

  static decode(bytes: Uint8Array): Point {
    return _decodeIntoPoint(bytes, new Point());
  }

  /** The streaming half: a reader bound to the corelib's resumable IStream. */
  static decoder(): PointDecoder {
    return new PointDecoder();
  }
}

// The decode-into step sits beside the class, not on it: CORELIB_PLAN §6.1.1
// closes the generated object's surface to encode / decode / try_decode /
// serialize / deserialize / decoder, and `decode_from` / `decode_into` are two of
// the spellings it names as forbidden. It stays module-private — reachable from
// the sibling classes that decode into one another, and from nowhere else.

// Decodes into `o`, so a re-opened sequence continues the scope an earlier
// opening populated (MESSAGE_SPEC §7.4).
function _decodeIntoPoint(bytes: Uint8Array, o: Point): Point {
  decode(bytes, new PointVisitor(o));
  return o;
}

// generated alongside it: the visitor that fills a Point — the library's only
// decode surface (§5.3.1), one callback per wire type instead of one `case` per id.
// A visitor *is* the decode-into step: it writes into the object it was handed.
class PointVisitor implements Visitor {
  private readonly out: Point;
  constructor(out: Point) { this.out = out; }

  signed(id: number, v: number | bigint): void {
    if (id === 1) this.out.x = Number(v);
    else if (id === 2) this.out.y = Number(v);
    // no branch for an unknown id — or for a field whose wire type is not
    // `signed` — so it is skipped and the decode stays COMPLETE (§7.3)
  }
}

// ...and the handle Point.decoder() returns: an IStream plus its destination
class PointDecoder {
  readonly message = new Point();
  private readonly is = new IStream(new PointVisitor(this.message));

  feed(chunk: Uint8Array): DecodeStatus { return this.is.feed(chunk); }
  status(): DecodeStatus { return this.is.status(); }
}

const p = new Point(); p.x = 3; p.y = 4;

// one-shot: encode into memory, decode a whole buffer
const os = growingOStream(); p.serialize(os);
const wire = os.bytes().slice();
const got = Point.decode(wire);            // got.x === 3, got.y === 4

// streaming out: the same serialize(), over a 4-byte buffer with a sink. The sink
// is handed the installed buffer and the region's bounds — never memory from
// anywhere else — so it copies out what it wants to keep.
const parts: Uint8Array[] = [];
const sink: FlushSink = (buf, start, end) => { parts.push(buf.slice(start, end)); };
const so = new OStream(new Uint8Array(4), 0, sink);
p.serialize(so); so.flush();               // the same bytes, in pieces

// streaming in: feed those pieces — or any other chunking — to the decoder
const dec = Point.decoder();
let st: DecodeStatus = DecodeStatus.Complete;   // zero bytes end on a boundary
for (const part of parts) st = dec.feed(part);

// COMPLETE says the bytes so far ended on a field boundary, not that the
// message is over — the caller's framing decides that, and a still-INCOMPLETE
// status once the input really has ended is truncation (§5.2.4).
const streamed = st === DecodeStatus.Complete ? dec.message : null;
```

A generated visitor takes the nested cases too: a nested message switches the
router into the child's fields on `sequenceBegin(id, depth)`, and a compact scalar
array arrives element by element through `arrayBegin` / `arraySigned`, so no part of
the message is ever buffered whole. Nothing from a fed chunk is retained either — a
string is decoded and a blob copied on the way into the destination — so a chunk is
reusable the moment `feed` returns.

This example is compiled and executed by the test suite
(`test/helpers/readme-generator-example.ts`), so it cannot drift from the API.

## Memory handling

Who owns the bytes:

- **Encode (`OStream`).** Every buffer the encoder writes into is
  **caller-supplied**: the library allocates none of its own and never grows or
  reallocates one it was handed — `new OStream(buf, offset?, flush?)` writes into
  `buf` and into nothing else. When it fills it calls the `flush` sink with **that
  buffer** and the region's bounds — `(buffer, start, end)`, never memory from
  anywhere else and never a view the encoder built, since pass-through is forbidden
  (§5.1.6) — and continues; the region is valid for the duration of that call. With
  no sink it throws `BUFFER_FULL`. `bytes()` returns a **view** of what is in the
  buffer — with a sink, only the not-yet-flushed tail — so `.slice()` it if it
  must outlive the next write.
- **The `offset` belongs to the installation, not to the buffer.** It reserves
  room at the front of the unit the buffer-set begins — the constructor or
  `setBuffer` — and handing that unit to the sink **consumes** it: a sink that
  returns without installing a buffer has *copied*, so the encoder keeps writing
  into the same buffer and resumes at `0`, with the whole buffer usable from
  there. A sink that wants header room in **every** flushed unit — one framing
  header per packet — re-arms it by calling `setBuffer(buf, offset)` from inside
  the callback; passing the buffer it already has counts. A sink that *takes* the
  buffer (hands it to a transport, queues it, gives it to DMA) must install a
  replacement before returning. Either way the bytes are the same — only the unit
  sizes differ. `reset()` and `bytes()` follow the current installation, so after
  a flush they are relative to `0`; on a sink-less stream, which can never flush,
  the reservation stands for the life of the encode.
- **Encode into memory (`growingOStream()`).** The allocating half is the
  caller's role. `growingOStream(initialCapacity?)` is that caller ready-made: a
  scratch buffer installed **with a sink** that accumulates the result (§5.1.2).
  It never throws `BUFFER_FULL`, its `bytes()` is the **whole** message (a view —
  `.slice()` it if it must outlive the next write or growth), and `reset()` keeps
  the buffer it grew to, so a pooled encoder stops allocating. It is an ordinary
  streaming stream otherwise, so `setBuffer` works and means what it always means:
  the not-yet-flushed bytes are dropped and encoding continues into your buffer.
  Pass an `initialCapacity` when you know roughly how large the message is: a
  message built from many small fields grows by doubling, so 100 KB of them costs
  nine enlargements from the 256-byte default. A single large field does not — a
  bulk write tells the accumulator how much contiguous room it wants, so the
  buffer reaches that size in one step and the write keeps its bulk route.

  It reaches the encoder through `setBuffer(buffer, offset, carried)`, the third
  argument being how many bytes of the message the replacement already holds
  before `offset`. That is what keeps `bytes()` meaning "the message" across an
  enlargement, and it is available to any caller that keeps a message in one
  growing store.

  Its storage is **carved from a shared slab** while it is small enough (up to
  4 KiB of an 8 KiB slab). A carve is handed out once and never recycled, so no
  two encoders ever share bytes and no message can read another's; what it
  changes is *lifetime* — a retained `bytes()` view keeps its slab alive, so
  `.slice()` (already the advice for a view that outlives the next write) is also
  what releases it.
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
  **without** a sink has no minimum: no flush can occur, so nothing can be split,
  and a two-byte message encodes into a two-byte buffer.
- **Decode (`decode()` / `IStream`).** You own the bytes being parsed, and they
  must stay valid only for the duration of the `feed` (or `decode`) call. After it
  returns, reuse, overwrite or free them freely: **nothing the decoder produced
  points into them**.
- **No views.** The decoder exposes no zero-copy view of a decoded value, no
  payload-position getter and no borrowed value (§6.7) — on the one-shot path
  exactly as on the streaming one, with no option that reinstates one. A `string` /
  `blob` payload is reported in pieces as `(src, start, end)`, where `src` **is**
  the chunk you fed: the decoder builds no view over it and keeps no storage of its
  own, so whatever you want to keep, you copy out of memory you already own, during
  the call. Scalars are delivered by value. If any of this README ever describes a
  borrowed decoded value, either the README or the port is wrong.
- **No wire value decides an allocation in the codec.** After construction the
  encoder and decoder allocate no payload storage (§6.6), and nothing at all except
  the itemised handles below: no per-message, per-field or per-chunk allocation,
  no growable state, and no
  accumulator for a payload that straddles a chunk — a decoder's whole memory is
  fixed-size state sized from this format's constants (a `MAX_DEPTH` scope stack, a
  partial varint, an 8-byte float landing zone). Constructing an `OStream` /
  `IStream` is the one allocating step, and `decode()` reuses one decoder across
  calls so a one-shot caller does not pay it per message. A `bigint` for an integer
  past `2^53` is not an exception: it is a *value*, not storage, and the `lo` / `hi`
  halves beside it are there for a consumer that would rather not have one.
- **The language-forced handles, itemised** (§6.6.2). JavaScript will not let a codec
  place or take an IEEE-754 value at a byte offset, or copy a *range* of bytes,
  without building an object first: `TypedArray.set` — the only `memcpy` there is —
  takes a typed array as its source, and a float needs a `DataView`. These are all
  of them:

  | handle | where | how many |
  |---|---|---|
  | `DataView` over the **output buffer** | `Kernel`, bulk `fp32` / `fp64` arrays | one per bulk call, and only from 64 `fp32` / 16 `fp64` elements up |
  | `DataView` over the **fed chunk** | `IStream`, bulk float array reads | one per chunk, on the first run in it that clears the same thresholds |
  | `subarray` of the caller's payload | `OStream.writeRaw`, as `set`'s source | one per copied piece, only when the payload does not fit the buffer |

  Each addresses storage **you** supplied, each is sized by that storage and never by
  a number from the wire, and none of them leaves the codec. A **scalar** float, a
  float array below the element threshold, and a float array fed in chunks too small
  to hold a long run all build no handle at all: they go through a shared 8-byte
  scratch word, which is fixed state. `heap-free-codec.test.ts` asserts these counts
  exactly, including the short runs that allocate nothing and the element one under
  the threshold. The thresholds and what they were derived from are on
  `FP32_HANDLE_MIN` / `FP64_HANDLE_MIN` in the API documentation.
- **The static helper layer allocates, on your behalf.** `PayloadAcc`,
  `ElementSeq`, `StringSeq`, `BlobSeq`, `decodeUtf8` and `elementsEqual` are the
  generated layer's code shipped here for reuse (ARCHITECTURE §8), not part of the
  codec: the codec never calls them, and they allocate the values they build.
- **String validity is checked where a string is materialized** (§6.4.5).
  JavaScript strings are a Unicode type, so this port is always strict — but a
  `string` payload piece is *raw wire bytes* and is not validated (it may end
  mid-code-point), so whoever materializes one owns the check.
  `decodeUtf8(bytes, start?, end?)` is that check, exported for exactly this: it
  rejects malformed bytes as `INVALID_MSG` rather than as a platform `TypeError`.
  Rolling your own instead
  means `new TextDecoder("utf-8", { fatal: true })` — the default `TextDecoder`
  silently substitutes `U+FFFD`, which the format forbids in either direction,
  and `TextEncoder` does the same to an unpaired surrogate where this encoder
  refuses it with `ARGUMENT`.
- **Reassembly is the caller's, with a helper.** The codec holds no payload across
  `feed` calls. `PayloadAcc.take(total, offset, src, start, end)` joins the pieces —
  one accumulator per decoder, since only one payload is ever in flight — and
  returns storage of its own that aliases nothing, on the whole-payload path exactly
  as on the split one. `StringSeq` / `BlobSeq` collect the elements of a `string` /
  `blob` wrapper array and `ElementSeq` holds the index rules for any element kind
  (index bound, gap fill, last-write-wins); `elementsEqual` is the array form of the
  omit-if-default test an encoder applies before writing a field.

### Decode limits

Every decoder carries receiver-side caps, and there is no unset state and no
unlimited mode (§6.2.1): a field the schema leaves unbounded is still bounded by the
receiver. An omitted option takes the format ceiling it bounds rather than switching
the cap off, and `Infinity`, a negative value, a fractional one and anything above
the ceiling are refused with `ARGUMENT`.

| cap | default | bounds |
|---|---|---|
| `maxArrayCount` | `ARRAY_MAX` = 2,147,483,647 | elements in a schema-unbounded array |
| `maxStringLen` | `FIXLEN_MAX` = 2,147,483,647 | bytes of a schema-unbounded `string` |
| `maxBlobLen` | `FIXLEN_MAX` = 2,147,483,647 | bytes of a schema-unbounded `blob` |

The numbers belong to generated code, which knows the schema and the deployment;
§6.2.1 says the codec "never invents a limit of its own". So the fallback is the
widest value that is still a limit — the ceiling above which the count or length is
already `INVALID` — and not a number chosen here. A decoder built without limits is
bounded exactly where the format bounds it; pass your own to bound it tighter.

```ts
const limits = { maxArrayCount: 65536, maxStringLen: 1 << 20, maxBlobLen: 1 << 20 };
decode(bytes, visitor, limits);       // one-shot
new IStream(visitor, limits);         // streaming
```

An over-limit array count or string / blob length is rejected at the field's count /
length header — **before** the array is announced or any payload piece reaches the
visitor — by throwing `SofabError` with code `SofabErrorCode.LimitExceeded`. The
decoder rejects, never clamps. A rejection at a count or length word is terminal:
the stream re-reports it from every later `feed` rather than resuming inside the
abandoned field. It is **not** the `INVALID` outcome — the same bytes decode under a
looser cap — so `status()` never reports `INVALID` for it; nor does it report
anything else about it, since the three-valued outcome has no value for "valid, but
more than I am configured to accept". Read a cap rejection where it is raised, off
the error channel, not by polling `status()`.

A cap applies **only to a field you read**. A limit bounds an allocation, and a
field the visitor steps over allocates nothing — so a decode that walks past an
over-cap field it was never going to read stays `COMPLETE` (§6.2.1). On this flat
visitor that intent is spelled by which callbacks you declare: a `string` field is
read if you declare `string` or `fixlenBegin`, an array if you declare `arrayBegin`
or the element callback for its kind, and a whole subtree is skipped by answering
`false` from `sequenceBegin`. Declare none of them and the bytes are consumed
uncapped, because nothing was ever handed to you. The **format ceilings** are not
yours to waive this way: a count above `ARRAY_MAX` or a length above `FIXLEN_MAX`
stays `INVALID` whether anyone reads the field.

A cap applies **only to a field the schema leaves unbounded**. Where the schema
declares a `count` / `maxlen`, that bound governs and an over-bound value is
`INVALID_MSG`, never `LimitExceeded`. This decoder is driven by wire type and never
learns a schema, so the split is made where the schema is known: generated code takes
the declared size from `fixlenBegin` / `arrayBegin` — which carry it before any
payload or element arrives — and configures caps that do not cut across its own
declarations. `StringSeq` / `BlobSeq` / `ElementSeq` take both, on both axes: the
schema `count` and a receiver index cap, and the element `maxlen` and a receiver
element-length cap (`receiverElemMax`) — a wrapper array's `string` / `blob` length
words go to the collector, never to the generated visitor, so that is where the
element's cap belongs. Each pair is exclusive: the schema half where the schema
declared one, the receiver half where it did not.

## Build & test

```bash
npm ci
npm run typecheck      # tsc --noEmit (strict)
npm test               # vitest run: vectors, chunked feeding, memory rules, round-trips
npm run coverage       # vitest run --coverage (v8)
npm run build          # tsup -> ESM + CJS + IIFE + .d.ts in dist/
npm run smoke          # cross-runtime smoke test of the built bundle
```

Tests live in `test/` as focused vitest suites, including `vectors.test.ts` (encode
+ decode every shared conformance vector), `istream.chunked.test.ts` (every vector
fed one byte at a time), `heap-free-codec.test.ts` (no allocation primitive on a
codec path, a flat heap over encode and decode, no view into a fed or one-shot
buffer) and `pooled-decoder-state.test.ts` (a decode aborted at every cut point
leaves nothing behind for the next one).

`assets/test_vectors.json` carries three blocks and this port runs all three:
`vectors`, `invalid_utf8`, and `sequence_growth` — the wrapper-array growth cases of
§7.2 item 8, replayed by `sequence-growth.test.ts` for both element kinds at three
chunkings. This port declares `dynamic_arrays`: its wrapper-array containers are JS
arrays that grow at decode time, so the block applies. The cases are cap-relative and
the run installs `max_dyn_array_count = 8`. Growth **geometry** splits in two: the
backing store's reallocation strategy is the engine's amortised doubling, which is not
this port's to pin, while the fill is, and is asserted as one write per slot in a
single pass.

CI type-checks, tests and builds on Node 20 / 22 / 24 / 26, smoke-tests the
bundle on Node, Deno and Bun, and publishes coverage badges; a separate
`docs.yml` deploys the TypeDoc API reference to GitHub Pages.

## Benchmarks

Three standalone tools, specified by `BENCH_SPEC.md` and mirrored in every other
port — same datasets, same timing rules, same output grammar — so the numbers
compare directly across languages:

```bash
npm run perf              # per-op cost on the 170-byte perf message
npm run bench             # throughput table (MB/s) over the four shared datasets
npm run bench:callgrind   # machine-independent instructions/op under Valgrind
```

`bench` prints ten rows over four datasets: a 1000-element `u64` array, the small
`typical` message, an **unbounded 1 MB blob**, and a `composite` message that
reaches what the flat ones miss — a 64-element wrapper array, 320 bytes of 1-,
2-, 3- and 4-byte UTF-8, nesting three deep, a default-valued field the encoder
must *not* write, and a two-byte field header. Three of the encoded sizes are
cross-port parity checks (`perf` = 170 bytes, `blob 1MB` = 1,000,005,
`composite` = 956); `test/bench-datasets.test.ts` holds the datasets to them, and
`test/bench-grammar.test.ts` holds the tools to the output grammar.

Every encode row writes into a **caller-supplied buffer** rather than the
accumulator. The `blob 1MB` rows are the ones that exercise streaming end to end:
`one-shot` is a single contiguous write into a 1,000,005-byte buffer, `streaming`
is the same bytes through a **4096-byte** buffer with a flush sink (~245
flushes), and `decode: blob 1MB` is fed back in 4096-byte chunks. The
**difference** between the two encode rows is what the divisible-run flush path
costs, and it is legible only under `Ir/op`. BENCH_SPEC's optional
`blob 1MB passthrough` row is absent: pass-through is forbidden (§5.1.6), so every
`string` / `blob` run is copied through the output buffer. Both copies are
`TypedArray.set` — the whole payload when it fits, a range per flush when it does
not, the latter through one of the itemised §6.6.2 handles under
[Memory handling](#memory-handling).

Since JS engines expose no portable cycle counter, `perf` uses CPU time/op as the
code-cost proxy; `bench:callgrind` counts instructions/op under Valgrind (two rep
counts per workload, subtracted, on a `--predictable` V8) for a fully
machine-independent figure. The same tools under Node (V8) and Bun
(JavaScriptCore) give directly comparable numbers. `tsx bench/bench.ts --smoke`
runs every row exactly once — a liveness check for the rows, never a
measurement.
