# Changelog

All notable changes to `@sofa-buffers/corelib` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is below `1.0.0`, breaking changes bump the **minor** version.

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

[0.2.0]: https://github.com/sofa-buffers/corelib-ts/releases/tag/v0.2.0
[0.1.0]: https://github.com/sofa-buffers/corelib-ts/releases/tag/v0.1.0
