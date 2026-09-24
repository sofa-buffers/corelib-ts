# Changelog

All notable changes to `@sofa-buffers/corelib` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is below `1.0.0`, breaking changes bump the **minor** version.

## [0.11.0] - 2026-09-24

> The breaking entries below make this a **minor** bump, per the pre-`1.0.0` rule
> above — never a patch. The release rebuilds the decode surface against
> CORELIB_PLAN@`c837108`: the visitor is the only way to decode, it is flat, it
> allocates nothing after construction, and an array's elements arrive through a
> hand-off instead of per-element callbacks.

### Changed

- **BREAKING (decode API) — one visitor surface, flat and heap-free, and no
  views (CORELIB_PLAN §5.3.1, §6.6, §6.7).** `Cursor` is gone, and with it
  `fast.ts` and the `reader.ts` they shared. A second decode surface is a second
  implementation of every rule, which this port had already paid for three times
  (chunk-boundary verdicts, fixlen-array word order, receiver caps). `decode()`
  is now `IStream` fed once, over one resumable machine with a fast lane that
  decodes a field inline whenever its words do not straddle the chunk.

  | before | after |
  |---|---|
  | `Cursor`, `decode()` as a second implementation | `new IStream(visitor)` and `feed(chunk)`; `decode()` is that machine fed once |
  | a visitor per nested message class | **one flat visitor per message**; nesting arrives as `sequenceBegin(id, depth)` / `sequenceEnd(id, depth)` |
  | `sequenceBegin` returns `null` to decline a subtree | returns **`false`** |
  | `Visitor.longs`, an opt-in `Long` channel | gone — `lo`/`hi` halves are passed beside every integer value |
  | `Visitor.fp32` takes a byte view | takes **`bits`**; re-encode with `OStream.writeFp32Bits` |
  | payloads reported as a view | `(id, total, offset, src, start, end)`, where `src` **is** the caller's fed chunk |
  | `FlushSink(view)` | `FlushSink(buffer, start, end)` — the sink only ever sees the installed buffer |

  A visitor per nested class made every dispatch site megamorphic on V8 and JSC
  and put a per-scope object on the decode path; flat removes both, and the
  visitor stack with them. No view is built and nothing is retained, and the
  one-shot path has no exemption (§6.7.1). Pass-through of a payload run is
  **forbidden** (§5.1.6), not merely off by default. After construction `write`,
  `feed` and `flush` allocate nothing: fixed-size state is sized from `MAX_DEPTH`
  at construction, and `decode()` pools one decoder so a one-shot caller pays no
  construction per message.

  One deviation is recorded rather than hidden: a payload split across flushes is
  copied with `set(data.subarray(...))`, one view per piece, because the
  allocation-free alternative measured 358 MB/s against 10,963 MB/s.

- **BREAKING (decode API) — an array's elements reach a visitor only through the
  hand-off (§6.7.2).** `Visitor.arrayUnsigned`, `arraySigned`, `arrayFp32` and
  `arrayFp64` are removed. `Visitor.arrayBulk` hands the decoder the destination
  to fill — a `number[]`, a `Long[]`, a `Uint32Array` pair of halves, a
  `Float32Array` / `Float64Array`, or the raw `fp32` words — together with the
  schema's element bound as 32-bit halves. Returning `null`, or declaring no
  hook, walks the elements over without decoding them: the `skip` half of
  §6.7.2's two intents.

  Two delivery routes for the same elements were two places for the element
  bound to be compared, two resume paths to keep in step, and a standing
  invitation for generated code to take the slower one (§5.3.1: a rule gets one
  implementation).

  **Migration.** Replace each `array*` callback with one `arrayBulk` that returns
  the destination; fold at `arrayEnd` instead of inside the delivery. Measured
  with `bench/run_callgrind.sh`, 1000-element arrays, Ir/op:

  | array | destination | before | after | |
  |---|---|---:|---:|---:|
  | `array<u16>` | `number[]` | 235,433 | 184,023 | −21.8% |
  | `array<u64>` | `Long[]` | 576,206 | 429,113 | −25.5% |
  | `array<u64>` | `lo`/`hi` halves | 498,618 | 299,180 | −40.0% |
  | `array<fp64>` | `Float64Array` | 93,520 | 36,893 | −60.5% |
  | `array<fp32>` | `Float32Array` | 94,497 | 35,259 | −62.7% |

  Declining is cheaper still, since nothing is decoded into existence:
  `array<fp64>` 36,893 → 9,383, `array<u16>` 184,023 → 152,082. A short array is
  not the exception — the ~600 Ir fixed cost is paid once per array, so four
  elements at the end of a 37-byte message cost 578 Ir against the 563 the
  callbacks cost. What did move is a *folding* consumer's side: the same four
  elements cost 1,063 Ir summed at `arrayEnd`.

- **BREAKING (decode API) — the codec holds no receiver limit (§6.2.1).** §6.2.1
  fixes the provenance of a `max_dyn_*` number and forbids the codec from
  supplying one: it must not hold a limit of its own, supply a default for one it
  was not given, read an omitted argument as unlimited, or clamp to one. A §6.2
  format ceiling reached because no cap was stated is the **format's** bound, not
  a receiver cap.

  This port failed both. `src/decode/state.ts` held `maxArrayCount` /
  `maxStringLen` / `maxBlobLen`, each defaulting to `ARRAY_MAX` / `FIXLEN_MAX`,
  so an unconfigured decode reported `LimitExceeded` against a ceiling nobody had
  configured; `src/decode/seq.ts` defaulted `receiverCap` and `receiverElemMax`
  at five collector sites.

  | before | after |
  |---|---|
  | `src/decode/limits.ts`, `DecodeLimits` | **deleted** |
  | `decode(bytes, visitor, limits?)`, `new IStream(visitor, limits?)` | the `limits` argument is gone |
  | `StringSeq` / `BlobSeq` / `ElementSeq` bounds optional | every bound is a **required** constructor argument |
  | — | `UNBOUNDED` (`-1`) is exported as the explicit "the schema declared none" |

  The comparison now lives in the layer that has the number: generated code
  compares its cap inside `arrayBegin` / `fixlenBegin`, and the collectors compare
  the two bounds they are handed for the one shape a visitor cannot see — a
  wrapper array's element index and element byte length.

- **BREAKING (decode API) — a refused decode is terminal, and `feed` is the only
  answer (§5.2.1, §6.3).** `IStream.status()` is **removed**. `feed` returns
  `FeedStatus`, a type alias admitting only `Complete` and `Incomplete`, so the
  compiler rejects a branch that can never be taken; refusals travel on the thrown
  `SofabError` with their code.

  Two terminal rejections are decided inside a visitor callback rather than by the
  state machine — §6.4.5 puts the strict UTF-8 check where a string is
  materialized, §6.2.1 puts the receiver caps in the layer holding the numbers —
  and both arrived as a throw out of the parse loop, passing the latch entirely.
  Reproduced before the fix: on wire `0a 12 ff fe`, `feed` threw `INVALID_MSG` and
  `status()` then answered `COMPLETE`; at a receiver cap with chunk size 3, the
  visitor was handed `unsigned(0, 42)` — a field that was never on the wire.
  `push()` now routes both through the existing `fail()` latch, which holds the
  raised `SofabError` so the two codes stay distinct.

### Added

- **An exact-width typed array is an array destination.**
  `IntegerArrayTarget.typed` takes a `Uint8Array`..`Uint32Array` /
  `Int8Array`..`Int32Array` whose element width **is** the schema's declared
  width, and the encoder's array writers read one without the guards a `number[]`
  element needs: a `Uint16Array` element is an integer in `0..65535` by
  construction. It stores unboxed and never changes element kind the way a
  `number[]` does when a value leaves the small-integer range. The element bound
  is still compared — a typed array masks on store (70000 into a `Uint16Array` is
  4464) and MESSAGE_SPEC §7.1 makes an out-of-width element INVALID, so a fill
  that merely stored would turn a malformed message into an accepted one.

- **64-bit and boolean destinations.** `IntegerArrayTarget.typed` also takes a
  `BigUint64Array` / `BigInt64Array`. It cannot be filled the way the 32-bit
  widths are — `b[i] = 5` throws, and a `bigint` store is one allocation per
  element, the cost a 64-bit array most wants to avoid — so the fill writes the
  two 32-bit halves it already holds into a `Uint32Array` over the array's own
  buffer and builds no `bigint` at all. The encoder reads them back the same way,
  so `writeUnsignedArray(id, someBigUint64Array)` is `bigint`-free in both
  directions and byte-identical to the `bigint[]` path. A boolean array gets its
  own destination for the same reason.

- **An fp32 array written from a `Float32Array` keeps its bits.** `packFp32Array`
  read `values[i]`, widening each element to a double — and widening a
  **signaling** NaN quiets it (`0x7f800001` came back `0x7fc00001`). A
  `Float32Array` source already holds the 32-bit wire words, so they are copied
  through a `Uint32Array` view instead. Bit-exact for every value, not only NaNs.
  With a `Float32Array` member and the `bits` destination on the way in, the array
  **is** the payload in both directions, and there is nothing left to capture,
  compare or re-attach. The words go out through `DataView.setUint32(..., true)`,
  so the wire stays little-endian whatever the platform's order is.

- **The static helpers a generated package still carries.** ARCHITECTURE §8 puts
  a helper here when its code has the same shape for every schema and its schema
  dependence is carried entirely by arguments and type parameters. Three helpers
  in the TypeScript backend's output failed that test only because this library
  had nowhere to put them, so they were re-emitted, textually identical, into
  every generated package. `FramedSeq<T>` is the one that is not a straight move:
  `ElementSeq<T>` holds the index rules of MESSAGE_SPEC §5.1 and the two exclusive
  bounds of §6.2.1 for any element type, but writes a single shared `def` into
  every gap — right for `""` and a zero-length `Uint8Array`, wrong for a `struct`,
  a `union`, a nested row or a `Long[]` row, whose defaults are fresh mutable
  objects.

### Fixed

- **A source's claimed element width is not a fact the encoder can check.** The
  bulk kernel decided how much room to reserve by reading the source's own
  `constructor` — an ordinary property. An `ArrayLike` claiming to be a
  `Uint16Array` while holding `0xffffffff` got three bytes an element reserved and
  needed five; the kernel then wrote past the buffer, where the writes are no-ops,
  and the message came back short while `bytesUsed` reported a length that was
  never written — CORELIB_PLAN §5.1's "partial output handed back as complete",
  the one failure an encoder must never produce. The estimate is gone and nothing
  replaces it: `out.length` is the kernel's bound.

- **A streamed `Float32Array` keeps its signaling NaNs.** `writeFp32Array` copied
  the wire words only on the bulk path; when the array did not fit the buffer it
  fell back to `putFp32(values[i])`, quieting signaling NaNs, so a streamed encode
  differed from the one-shot one (§6.5, §5.1.4). A `Float32Array` now takes its own
  route at the entry, streamed through one `Uint32Array` over the source with the
  words stored by shifts (byte-order independent). Split points are unchanged.

- **"Exactly one destination" now means one out of all of them.** `resolveTarget`
  refused a target naming two destinations, but the float branch counted only
  `f32`/`bits`/`f64` and the `bool` branch only the integer fields, so a
  combination straddling the two branches was accepted and the other destination
  left untouched — `{ bool, f64 }` on an fp64 array filled `f64` and left `bool`
  at `[0,0]`, which reads as data. Worse, the extra field *silenced* an error:
  `{ bool }` alone on an fp64 array is an `Argument` refusal, `{ bool, f64 }` was
  not.

- **One fp32 NaN word view per array, not per NaN**, and the typed-destination
  check is kept polymorphic, so an `instanceof` slow path no longer forces the
  streaming loop to re-check every element.

- **The `node_modules` symlink committed by mistake is untracked.**

### Performance

Measured with `bench/run_callgrind.sh` (Callgrind Ir/op, Node 24). Wall-clock
numbers from a shared runner are not usable at this resolution.

- **Encode and decode instruction cost cut by up to 4.7×:** `encode: u64 array
  (1000)` 1,229,088 → 259,659 (−78.9%), `decode: u64 array (1000)` 1,458,937 →
  721,953 (−50.5%), `encode: typical message` 13,360 → 10,408 (−22.1%).
- **The §6.6.2 float handle, taken where it pays and only there:** `encode fp32`
  (1000) 195,320 → 27,970 (−85.7%), while `decode: typical message` moved 5324 →
  6415 Ir/op, and every other decode path paid ~0.4% for code it never runs.
- **A skipped scope is carried as a sentinel, not a null slot**, recovering the
  `decode: typical message` regression the nullable slot had cost (5366 → 5210
  Ir/op, +0.93% over baseline, was +3.95%).
- **A collector compares against one bound, picked at construction**, since the
  two-bound compare could not be inlined and a CALL is about 200 Ir.

## [0.10.0] - 2026-08-01

> The breaking entries below make the next release a **minor** bump (the first
> since `0.2.0`), per the pre-`1.0.0` rule above — never a patch. The published
> package is `@sofa-buffers/corelib`; the git tag is the source of truth for the
> version number, and `package.json` stays at `0.0.0-dev`.

### Changed

- **BREAKING (encode API) — an all-default sequence is now *omitted*, not framed
  empty (MESSAGE_SPEC §2, CORELIB_PLAN §6).** A sequence-typed **field** whose
  value equals its declared default carries no information, so it no longer
  reaches the wire at all, where it previously appeared as the two-byte empty
  frame `0E 07`. An all-default message is now the **empty byte string**. A
  wrapper-array **element** is the exception and keeps its frame: element
  presence is what carries a dynamic array's length (§5.1), so dropping one
  would change the decoded value, not just the bytes.

  Deciding this without buffering the sub-message means the sequence header has
  to be held back until the sequence proves it has content, which changes the
  encoder's public sequence API:

  | before | after |
  |---|---|
  | `writeSequenceBegin(id)` — **removed** | `writeSequenceBeginLazy(id)` — opens the scope and holds the header back; writes no byte |
  | `writeSequenceEnd()` | `writeSequenceEnd()` — drops the frame (header *and* end marker) if the sequence got no content |
  | — | `writeSequenceEndKeep()` — new; emits the held-back headers plus the end marker, so a contentless sequence still reaches the wire as `begin` + `end` |

  **Migration.** Replace every `writeSequenceBegin` with
  `writeSequenceBeginLazy`. Then pick the closer *statically*, by the position in
  the schema — it is a property of the position, not of the value:
  `writeSequenceEnd` for a `struct`/`union` field and for an array-field wrapper;
  `writeSequenceEndKeep` for a wrapper-array element, and for an array field
  already known to differ from a **non-empty** declared default. When in doubt
  `writeSequenceEndKeep` is the safe choice: the failure directions are not
  symmetric — a needless `endKeep` costs one non-canonical empty frame that a
  decoder normalizes away, while a wrong `end` silently changes an array's
  length. Code that transcodes or replays raw bytes (rather than encoding a
  schema value) wants `writeSequenceEndKeep` throughout, so its output reproduces
  its input frame for frame.

  **Decoding is unaffected**, in both directions: an empty frame remains valid
  input that the message layer normalizes to the default, and an omitted
  sequence field was already reconstructed from the schema default. Old and new
  encoders therefore interoperate; they disagree only about which encoding is
  canonical. Every non-sequence byte is unchanged — the shared
  `assets/test_vectors.json` is re-synced and every `serialized` hex is
  byte-identical; the vectors' separate `serialized_sparse` column is the new
  canonical form, and is exercised by the generator's conformance drivers (a
  corelib has no message layer and cannot produce it).

  The hold-back run is bounded only by `MAX_DEPTH`: this port can allocate, so
  it holds back to the full nesting depth and is canonical at every depth
  (CORELIB_PLAN §6, "How deep the hold-back reaches"). Held-back ids are encoder
  state and never buffer content, so a flush cannot split a run and a buffer
  smaller than the message still produces the one-shot bytes.

- **Strict UTF-8 for `string` fields (corelib-ts#85, MESSAGE_SPEC §8,
  CORELIB_PLAN §6.4).** JavaScript strings are a Unicode string type, so the
  corelib transcodes `string` payloads at the boundary and is now **always
  strict** — there is no lossy mode and the `SOFAB_STRICT_UTF8` option is a no-op
  that is omitted. Silent `U+FFFD` substitution, previously produced by both the
  decoder and the encoder, is removed in **both** directions:
  - *Decode:* the corelib builds the string with a **fatal** `TextDecoder`
    (`new TextDecoder("utf-8", { fatal: true })`). An invalid-UTF-8 payload that
    is materialized (`Cursor.readString`) is now the `INVALID` outcome —
    `SofabError` with `SofabErrorCode.InvalidMsg` (`"INVALID_MSG"`) — instead of
    decoding to a string full of replacement characters. Skipped fields are never
    validated; embedded `U+0000` round-trips.
  - *Encode:* `writeString` (both the in-memory fast path and the streaming
    `TextEncoder` path) now **rejects** an **unpaired surrogate** with
    `SofabError` / `SofabErrorCode.Argument` (`"ARGUMENT"`) rather than emitting
    `EF BF BD`. Every valid string — ASCII, multibyte BMP, correctly paired
    astral code points, embedded `U+0000` — still encodes byte-for-byte as
    before.

  The shared `assets/test_vectors.json` gains the top-level `invalid_utf8`
  negative-vector array (tracked by corelib-c-cpp#97); the conformance suite
  exercises it under the strict decode and encode paths.

### Added

- **`Cursor.fixSub` — the delivered fixlen subtype (corelib-ts#58).** A new
  public accessor on `Cursor`, the companion to `wire`, that reports the fixlen
  subtype of the header `readHeader` just accepted — one of `FixlenSubtype`
  (`Fp32`/`Fp64`/`String`/`Blob`) when `wire` is `Fixlen` or `ArrayFixlen`, and
  `-1` otherwise. The four fixlen subtypes all share one wire type, so `wire`
  alone cannot separate them; `fixSub` lets a generated guard skip a fixlen
  field whose subtype contradicts the schema (MESSAGE_SPEC §7.3) — exactly as it
  already does on `wire` for the other kinds — instead of passing the wire-type
  guard and then throwing from the wrong-typed reader. It is *peeked* (the
  subtype word is not consumed), so the matching typed reader / `skip()` still
  reads and validates the word and a malformed or truncated one still surfaces
  `INVALID` / `INCOMPLETE`. Completes §7.3 for the TypeScript target, matching
  corelib-py's `Field.subtype` and corelib-cpp's `fixType()`.

- **Opt-in decode limits (corelib-ts#38).** A new optional `DecodeLimits`
  options object — `{ maxArrayCount?, maxStringLen?, maxBlobLen? }` — is accepted
  by every decode entry point: `decode(bytes, visitor, limits?)`, the `IStream`
  constructor, and the `Cursor` constructor. When set, an array count or string /
  blob byte length that exceeds the cap is rejected at the field's header —
  before the array is sized or any payload is decoded / streamed to the visitor —
  with the new `SofabErrorCode.LimitExceeded` (`"LIMIT_EXCEEDED"`). The decoder
  never clamps or truncates. `LimitExceeded` is deliberately distinct from
  `InvalidMsg`: exceeding a receiver-configured limit is *policy*, not wire
  malformation — the identical bytes decode fine under a looser limit. **Default:
  no limits (today's behavior); the corelib invents no default cap** — the values
  come from the sofabgen config, baked into generated code (generator#102). Also
  hardens `Cursor` so a wire array `count` larger than the bytes remaining is
  rejected as `Incomplete` before `new Array(count)` is sized, so a hostile count
  can never drive an allocation larger than the input.
- **Finish-less three-valued decode outcome (MESSAGE_SPEC §7).** Truncation — a
  decode that ends *inside* a field — is now a distinct outcome from a malformed
  message. New `SofabErrorCode.Incomplete` (`"INCOMPLETE"`) and a `DecodeStatus`
  enum (`Complete` / `Incomplete` / `Invalid`) are exported. Every one-shot
  truncation site (`decode()`, `Cursor`) that used to throw `INVALID_MSG` — an
  unterminated varint, a payload / array shorter than its declared length, or a
  nested sequence left open at end-of-buffer — now throws `INCOMPLETE` instead;
  genuinely malformed input (varint over 64 bits, bad subtype/length/count, id
  over max, dangling sequence-end, over-`MAX_DEPTH` nesting) still throws
  `INVALID_MSG`. Mirrors corelib-go#42.

### Changed

- **BREAKING (decode API):** there is no finish/finalize step. `IStream.end()`
  no longer throws to promote an incomplete stream to an error; it is now a pure
  accessor returning `DecodeStatus.Complete` when the stream ended on a field
  boundary or `DecodeStatus.Incomplete` when it ended inside one. A malformed
  message still throws from `IStream.feed()`. Callers that relied on `end()`
  throwing on truncation must check its return value instead.
- **BREAKING (wire format):** a fixlen array (`fp32`/`fp64`) now always carries
  its `fixlen_word` — even when empty (`element_count == 0`). Previously an empty
  fixlen array was `[header][count=0]` with no `fixlen_word`, making an empty
  `fp32` array byte-identical to an empty `fp64` one (`05 00`); a decoder could
  not tell them apart. An empty fixlen array is now
  `[header][count=0][fixlen_word]` with no payload (`05 00 20` for `fp32`,
  `05 00 41` for `fp64`), so the element subtype stays recoverable. Integer
  arrays (`u8`…`u64`, `i8`…`i64`) are unchanged — they never carry a
  `fixlen_word` — so an empty integer array stays `[header][count=0]`. Mirrors
  CORELIB_PLAN §4.8 / MESSAGE_SPEC §3 and corelib-c-cpp#45.

## [0.2.0] - 2026-06-29

A performance release: the encode and decode hot paths no longer churn
short-lived `BigInt` objects, which V8 profiling identified as the dominant
cost. The wire format is unchanged and all shared conformance vectors still
pass. One source-level breaking change to the decode `Visitor` enables the
decode-side win.

### Changed

- **BREAKING:** `Visitor.unsigned`, `Visitor.signed`, `Visitor.arrayUnsigned`,
  and `Visitor.arraySigned` now receive `value: number | bigint` instead of
  `bigint`. Integer values are delivered **number-first** — a `number` when the
  value fits exactly (`≤ 2^53 − 1`, covering field ids, `u8`…`u32` and small
  `u64`/`i64` values) and a `bigint` only beyond that. This avoids a per-value
  `bigint` allocation on the common path.

  **Migration:** a handler that did `bigint`-only arithmetic on a decoded value
  must coerce the argument, e.g. `const n = typeof v === "bigint" ? v : BigInt(v)`
  (to keep working in `bigint`) or `Number(v)` (to work in `number`, safe for
  values `≤ 2^53`). The encoder is unaffected — it already accepted
  `number | bigint` — so re-encoding a decoded value is byte-identical.

### Added

- `decode()` now runs a dedicated **contiguous fast-path decoder** that advances
  a single cursor over the whole buffer (the technique Protocol Buffers uses),
  instead of driving the resumable per-byte state machine. Same API and
  validation; markedly faster when the whole message is in hand. The streaming
  `IStream` remains for chunked input.
- Expanded the shared conformance suite to the 67-vector `test_vectors.json`,
  including the new `skip-ids` decode scenario (auto-skipping fields by id at any
  nesting depth, including whole nested sequences) and `requires`/`skip_ids`
  metadata.

### Performance

- **Decode:** number-first values + the contiguous fast path cut BigInt-builtin
  time from ~35% to ~4% and GC from ~10% to ~1% on small-value workloads. A
  `u32` array decodes ~2.2× faster streaming and ~2.6× faster contiguous
  (≈165 / ≈270 MB/s) for a number-consuming visitor. (#6)
- **Decode (streaming):** the resumable varint reader accumulates into two 32-bit
  number halves instead of doing a per-byte `bigint` shift, with no loss of
  64-bit fidelity.
- **Encode:** `encodeVarint` / `varintSize` split the 64-bit value into two
  32-bit number halves once and emit LEB128 with number-only arithmetic,
  dropping per-value `bigint` allocations from ~20 to 2. A full-range `u64`
  array encodes ~4.4× faster (≈14.5 → ≈64 MB/s, isolated); ids, lengths, counts
  and small scalars/arrays take a number fast path. (#5)

## [0.1.0]

- Initial release: streaming, dependency-free TypeScript implementation of the
  SofaBuffers binary serialization format — `OStream` to encode and `IStream`
  (driving a `Visitor`) to decode, both chunkable, with a swappable acceleration
  `Kernel` seam.

[0.11.0]: https://github.com/sofa-buffers/corelib-ts/releases/tag/v0.11.0
[0.10.0]: https://github.com/sofa-buffers/corelib-ts/releases/tag/v0.10.0
[0.2.0]: https://github.com/sofa-buffers/corelib-ts/releases/tag/v0.2.0
[0.1.0]: https://github.com/sofa-buffers/corelib-ts/releases/tag/v0.1.0
