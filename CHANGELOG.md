# Changelog

All notable changes to `@sofa-buffers/corelib` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is below `1.0.0`, breaking changes bump the **minor** version.

## [Unreleased]

### Performance

Encoder and decoder throughput work. No wire-format, API or behavioural change —
the shared vectors, the round-trip and chunked suites, and the byte-exactness
guarantees are all unchanged; only the instruction cost of getting there moved.
Measured with `bench/run_callgrind.sh` (Callgrind `Ir/op`, Node 24):

| Workload | before | after | |
|---|---|---|---|
| `encode: u64 array (1000)` | 1,229,088 | 259,650 | **−78.9%** |
| `encode: typical message` | 13,360 | 10,408 | **−22.1%** |
| `decode: u64 array (1000)` | 1,458,937 | 721,954 | **−50.5%** |
| `decode: typical message` | 14,204 | 12,511 | **−11.9%** |

- **`bigint` ⇄ 32-bit halves now goes through bit punning, not arithmetic**
  (`src/varint/bits64.ts`). One `ArrayBuffer` aliased by a `BigUint64Array` and a
  `Uint32Array` converts in both directions with no intermediate allocation,
  where `Number(v & 0xffff_ffffn)` and `(BigInt(hi) << 32n) | BigInt(lo)`
  allocated a `bigint` per intermediate. Profiling put the split alone at ~74% of
  the `u64 array` encode. Truncation is identical — a `BigUint64Array` store
  *is* reduction modulo 2^64 — so out-of-range inputs wrap exactly as before.
- **64-bit range checks fused into the split.** `writeUnsigned` / `writeSigned`
  and the streaming array writers get their `inU64` / `inI64` verdict from the
  same scratch round-trip that produces the halves, instead of two `bigint`
  comparisons followed by three `bigint` allocations.
- **The varint writer no longer re-derives a shifted 64-bit value per byte.**
  Above 2^32 the first four bytes come straight off the low half and the tail is
  an ordinary 32-bit varint loop; `varintSizeLoHi` answers from a range ladder
  rather than a loop. Zig-zag likewise runs on the halves.
- **Decoder: fewer `bigint`s and less per-byte state.** A 64-bit value costs one
  `bigint` instead of four; a varint whose bytes are all present in the chunk is
  read by an unrolled reader with no resume bookkeeping; array elements drain in
  a loop that does not re-enter the state switch; the current visitor is held in
  a field rather than re-derived from a stack top.
- **Fewer per-object allocations.** The decoder's resumable float scratch is two
  number fields rather than a per-`IStream` `Uint8Array(8)`; the visitor stack
  and the encoder's held-back-sequence array are created only if a nested
  sequence actually occurs.
- **Pure-ASCII strings skip the general UTF-8 walk** on both the length and the
  write pass — the byte length is the character count, so the payload is a
  straight character-to-byte copy. Non-ASCII is untouched, including every
  surrogate rule.

### Fixed

- **`IStream` never latched `INVALID`, so `end()` could answer `COMPLETE` after
  a malformed feed** (#103). CORELIB_PLAN §5.2 makes `INVALID` *terminal* — "the
  bytes are malformed regardless of what follows … no — terminal" — and forbids
  reporting `INCOMPLETE` (let alone `COMPLETE`) for input already determined to
  be malformed. `DecoderState` kept no error state: `feed` threw `INVALID_MSG`
  and left the machine fully usable, and `end()` decided purely from the
  resumable parser's position, so a caller that caught the throw and kept
  feeding was told `COMPLETE` for a message the decoder had already rejected
  (`00 2a 07 08 01` — a valid field, a sequence end with no open sequence, a
  valid field). The verdict now outlives the throw: every malformed-input
  rejection in the state machine goes through one `fail()` helper that latches
  the reason, `push()` re-throws it and consumes nothing (no visitor callback
  fires for the bytes after the defect), and `finish()` returns `INVALID`
  permanently — including where the input is *both* malformed and truncated,
  which `INVALID` outranks. `LIMIT_EXCEEDED` deliberately does **not** latch: a
  receiver-side cap is a policy rejection of well-formed bytes (§6.2.1), not the
  `INVALID` outcome. The cost is one perfectly-predicted branch per `feed`, not
  per byte, so decode throughput is unchanged; the one-shot `decode()` /
  `Cursor` paths, which build a fresh state per call and cannot be resumed after
  a throw, are untouched.
- **A varint array's allocation guard decided the verdict from the count word,
  before any element was examined** (#99). `Cursor.arrayCount` rejected a count
  larger than the bytes remaining as `INCOMPLETE`. The observation behind it is
  right — a varint element needs at least one wire byte, so such a count cannot
  be real and `new Array(count)` must never be sized from it (#38) — but
  rejecting there decides the outcome before a single element byte is read.
  CORELIB_PLAN §5.2 gives `INVALID` precedence over `INCOMPLETE`, so an element
  that already breaches its declared width (`readUnsignedArray`'s `elemMax`,
  `readSignedArray`'s `elemMin`/`elemMax`, added in #90 for exactly this) and is
  fully on the wire must stay `INVALID` when the array behind it is cut short.
  It did not: the read stopped at the count. `skipArrayCount` had already
  reached this conclusion one path over (#82/#49) and says so in its doc
  comment; this is the read-path half. The guard is now a cap on the
  *allocation* rather than a rejection — `arrayAlloc` sizes the destination to
  `min(count, bytes remaining)`, keeping all of #38's protection, while the
  elements decide the verdict. A short array still ends `INCOMPLETE`, decided by
  `readVarint` running out of buffer rather than by the count word, and on valid
  input (`count <= remaining`) the allocation is exactly what it was. The
  tighter fixlen bound in `arrayFixlenHeader` (`count * elemSize`) is unchanged:
  an fp element carries no declared-width bound, so there is nothing there for
  it to preempt. Found by Crucible F-0043 / F-0061 against the generated
  TypeScript driver, where it accounted for 92 of the 100 chunk-invariance
  mismatches over 10 442 truncations × 6 chunk sizes (the whole `INCOMPLETE` /
  chunked `INVALID` direction, now zero) — the contiguous path was the wrong one.

- **The encoder could not write through an output buffer smaller than its
  largest single write** (#94). CORELIB_PLAN §5.1 now puts a normative floor on
  the output buffer at **one byte**: it may be arbitrarily smaller than the
  message, so an encoder must be able to split a single write across a flush and
  may not require any write to land contiguously. `ensure(n)` demanded `n`
  *contiguous* bytes and flushed at most once, so on a fixed caller buffer the
  second check failed for the same reason as the first and every fixed-width
  writer threw `BufferFull` — an `fp64` put the practical floor at 8 bytes, a
  full-width varint at 10, making the minimum workable buffer size depend on the
  data. The scalar, float and streaming array writers now fall back to emitting
  the value a byte at a time across flushes when the buffer cannot hold it whole
  (`putVarintLoHi` / `putFp32` / `putFp64`); the bytes ride in local words rather
  than a shared scratch, so a sink that re-enters the encoder mid-value cannot
  overwrite the tail. A fixed buffer with **no** sink still reports `BufferFull`
  before writing anything, and the wire is byte-identical to the one-shot output
  at every buffer size. The hot path is untouched: a write with room still
  resolves in a single bounds check, and the growable in-memory encoder measured
  unchanged (`bench/run_callgrind.sh`, Node 24: `encode: typical message` 10,409
  → 10,369 `Ir/op`, −0.4%; `encode: u64 array (1000)` 259,665 → 259,888, +0.1% —
  either side of the ±0.05% the untouched decode workloads moved in the same
  pair of runs). A buffer wide enough to hold a worst-case varint also keeps the
  old drain-and-retry path byte for byte, so its flush pattern is unchanged
  (identical sink-call counts at every buffer size measured); only a buffer
  narrower than the value pays for sizing it exactly. Streaming a 1000-element
  `u64` array through a fixed buffer moved by, per buffer size: 10 B +0.2%,
  32 B +6.1%, 64 B +2.4%, 128 B −0.2%, 512 B −2.3%, 4096 B −4.8%; the typical
  message through 64 B −1.3%, an `fp64` array through 64 B −10.5%. The two
  mid-size figures are the cost of the extra branch on a buffer only three to
  six elements wide, and they are what is left after three rounds of measuring:
  routing the drain case through the exact-size path costs +125 instructions on
  *every* element of a one-element-wide buffer, and spelling that case out in
  the per-element entry point instead — making it too big for the JIT to inline —
  costs 16-19% at 32/64 B. The shape kept here is the best of the three at every
  size measured.
- **A sequence-end header's field id escaped the `ID_MAX` ceiling** (#85, Crucible
  F-0054). §4.9 has a decoder *discard* a sequence end's id — the marker closes the
  innermost open sequence whatever the id says — but discarded is not unvalidated:
  the header is an ordinary field header, so §6.2's ceiling binds it like every
  other, and an id above it is `INVALID` (§5.2). All three decode surfaces tested
  the wire type before computing or checking the id, so `76 87 80 80 80 40` — an
  undeclared sequence closed by an end marker with id 2³¹ — was accepted and
  re-encoded as the empty message. Each surface (`decode`, `IStream`, and both
  `Cursor.readHeader` and its sequence-skip path) now splits and bounds the id
  where it reads the header, before dispatching on the wire type, so one
  unconditional guard covers all eight wire types with no per-type exception.
  The bound is on the id's **value**, not its spelling: a non-minimal `0x87 0x00`
  and any id up to `ID_MAX` still decode as an ordinary sequence end and re-encode
  as `0x07` (§4.1 is untouched), and the encoder still emits exactly `0x07`.
- **An array count larger than the bytes remaining reported `INCOMPLETE` for an
  already-malformed element varint** (#82, Crucible F-0053). On the pull
  decoder's skip path, `Cursor.skip` read the count through `arrayCount`, whose
  `count ≤ remaining-bytes` guard decided the outcome before a single element
  byte was examined — so ten all-continuation bytes under a declared count of 11
  came back as truncation, where §5.2 gives `INVALID` precedence over
  `INCOMPLETE` for input that is both malformed and truncated. That guard exists
  to bound `new Array(count)` on the *read* paths; a skip materializes nothing,
  so it is now omitted there (the same reasoning already applied to fixlen arrays
  in #49) and the element varints are validated as they are walked. The push
  (`decode`) path never had the pre-check and is unchanged; genuine truncation
  still reports `INCOMPLETE`, and the opt-in `maxArrayCount` cap still fires at
  the count word.
- **A varint that overflows 64 bits was reported as `INCOMPLETE` when the chunk
  boundary fell on its tenth byte** (found while fixing #82). Ten bytes all
  carrying the continuation flag require an eleventh, which is past the 10-byte
  maximum (§4.1) — decidable from the bytes in hand. `IStream`'s resumable varint
  reader only tested the byte count on the *next* byte, so a chunk ending exactly
  at ten bytes suspended instead, and `end()` reported `Incomplete`; the same
  bytes fed as one chunk threw `INVALID_MSG`. It now rejects at the tenth byte,
  so the verdict no longer depends on where the chunks were split. A varint
  suspended at nine bytes or fewer still resumes normally.
- **`bench/run_callgrind.sh` produced an empty table.** It launched the workload
  through `npx tsx`, which puts it in a *child* process that Callgrind does not
  trace, so no per-op counts were collected at all. It now bundles the benchmark
  to plain JS and runs bare `node`, and adds `--predictable` so V8's background
  compile and GC threads cannot move the total between the two rep counts being
  subtracted (repeat runs now agree to ~0.01%, against tens of millions of
  instructions of drift before). Its default rep counts for the two
  small-message workloads were also raised past V8's tier-up: at 1000 ops the
  subtraction was reporting the JIT warming up rather than steady-state per-op
  cost, which is not comparable with the compiled ports' `Ir/op`.
- **Chunked decode of an array element split across a chunk boundary.** Found by
  the new whole-buffer and 16-byte chunk scenarios; the bulk element loop could
  start a fresh varint while a half-read one was still in the accumulator.

### Tests

- `small-buffer-encode.test.ts` is CORELIB_PLAN §7.2 item 4: it drives a corpus
  covering every fixed-width writer through caller buffers of 1, 2, 3, 5, 8, 16
  and 64 bytes and asserts the concatenated flushes are byte-identical to the
  one-shot output. The sweep is deliberately wider than the one byte §7.2 names —
  all of those sizes failed the same way, and a fix that special-cased 1 would
  pass a 1-only test and still break at 3. It also pins the sink seeing exactly
  one byte per call at size 1 (so byte-identity cannot be met by the encoder
  quietly growing a buffer of its own), a sink swapping in a fresh buffer
  mid-value, and the two cases that must still report `BufferFull`.
- The chunked-decode suite now also feeds every vector as a single whole-buffer
  chunk, in 16-byte chunks, and at deterministic pseudo-random split points. The
  previous sizes (1 and 7 bytes) are both narrower than a maximum varint, so the
  decoder's bulk route was never exercised while the resumable one was covered
  twice.
- `kernel.test.ts` pins the JS kernel's inlined bulk varint writer against the
  shared helper over a corpus covering every varint-length boundary, so the one
  deliberate duplication on the hot path cannot drift.
- `float-bits.test.ts` covers re-encoding *during* an `fp32` raw-channel
  callback, which is what the raw view's dedicated scratch exists to make safe.
- `istream.invalid-latch.test.ts` pins §5.2's terminal `INVALID` on the
  streaming decoder: four malformed constructs (dangling sequence end, an id
  above `ID_MAX`, a wrong-width `fp32` fixlen, a reserved fixlen subtype) each
  fed one byte at a time *and* as one whole buffer — so the verdict cannot
  depend on where the chunk boundaries fell — plus the overlong-varint case, the
  no-callbacks-after-poisoning guarantee, and the two controls that must stay
  unaffected: a well-formed stream still reaching `COMPLETE` / `INCOMPLETE`, and
  a `LIMIT_EXCEEDED` rejection not poisoning the stream.

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
