# Changelog

All notable changes to `@sofa-buffers/corelib` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is below `1.0.0`, breaking changes bump the **minor** version.

## [Unreleased]

### Changed

- **The pull decoder's hot path: −35% Ir/op on a full-scale message** (arena
  `typescript` row). The encoder was already ahead of protobufjs on the same
  message while the decoder was 65% behind it, and every part of that gap was
  the same two mistakes in different places — a per-byte bounds test the caller
  had already settled, and a per-string payload view nothing needed.

  - **`readVarint` is split into an inlinable single-byte head plus
    `readVarintSlow`**, the decoder-side twin of the encoder's existing
    `putVarintNum` / `putVarintNumSlow`. The unrolled ten-step ladder is far past
    what V8 will inline, so before this every field header, fixlen word, array
    count and array element paid a real call and could not keep the cursor in
    registers across it.
  - **Array element loops drive a local cursor and a five-byte, bounds-free
    ladder (`ladder5`)**, with the buffer-end case hoisted out of the loop.
    `readVarint` tests `p >= n` before each of its ten byte reads, which is right
    when a varint may be the last bytes of the message and pure cost inside an
    array, where the extent is known once. Measured on a five-element array read:
    1155 Ir/op → 243. Truncation verdicts are unchanged — the guarded tail still
    goes through `readVarint`, so a short array is still `INCOMPLETE`, decided by
    the bytes.
  - **Strings are decoded in place, and a short all-ASCII payload is built with a
    single `String.fromCharCode` call** (new `decode/text.ts`, plus `takeRange`
    on the reader). `TextDecoder` needs a `Uint8Array` covering exactly the
    payload, and building that `subarray` cost about a third of a short string's
    whole read. Appending with `+=` instead — what protobufjs does — only moves
    the cost: it builds a rope that the next consumer flattens, which in a
    decode-then-encode round trip is the encoder's own UTF-8 pass. Measured on a
    13-byte ASCII field, decode plus one `charCodeAt` walk: `TextDecoder` 2006
    Ir/op, rope 2095, single flat call **858**. Strictness is unchanged: the fast
    path is gated on every byte being below 0x80, and everything else still goes
    to the fatal `TextDecoder` whole.
  - **`num()`, `upper()`, `unsignedValue()` and `signedValue()` take an integer
    path when the high half is zero**, which is every id, length, count and every
    value a u8..u32 / i8..i32 field or element can carry. Each of those used a
    float multiply by 2^32 on the most-executed arithmetic in the decoder.
  - **`readHeader` only peeks a fixlen subtype for a fixlen wire type**, keeping
    the scanning call off every other header, and the fp32/fp64 array readers
    hoist their `DataView` and cursor out of the element loop.

  No public API, no wire and no verdict changes: the shared vectors, the 1510
  unit tests and the generator's TypeScript conformance suite are byte-identical
  before and after.

### Added

- **Scalar 64-bit `Long` codecs: `OStream.write{Unsigned,Signed}Long` and
  `Cursor.read{Unsigned,Signed}Long`** (#143). The `bigint`-free 64-bit path
  existed for arrays only (`write/readUnsignedArrayLong` and the signed twins),
  so a u64/i64 **scalar** had no `Long` codec at all. Downstream that capped
  `sofabgen`'s `int64: long` mode at Long-backed *arrays* — its scalars had to
  stay `bigint` for want of these four methods (sofa-buffers/generator#339).

  Wire-identical to the `bigint` writers for every value in the 64-bit domain,
  and cheaper on both sides: the writer reads the `Long`'s `.low`/`.high`
  straight into `putVarintLoHi`, with no range check and no scratch round-trip
  (a `Long` is 64 bits of raw storage, so it is in range by construction — the
  check `writeUnsigned` performs exists only because a `number`/`bigint`
  argument can be negative or ≥ 2^64), and the reader hands back the two halves
  `readVarint` already produced instead of deciding a representation per value.

  That last point is the reason the methods exist rather than a convenience
  wrapper: `readUnsigned` is number-first — a `number` below 2^53, a `bigint`
  above — so the representation follows the *value*. `readUnsignedLong` returns
  a `Long` for every value, small ones included, which is what lets a generated
  field's runtime type be a property of the **field**. Nothing else changes:
  no wire, no verdicts, and the number-first readers are untouched.

- **`IStream.feed()` returns the three-valued decode outcome, and `IStream.status()`
  re-reads it** (#112). CORELIB_PLAN §6 requires `feed(bytes)` to *return* the
  `COMPLETE` / `INCOMPLETE` / `INVALID` outcome of §5.2 with **no** separate
  `finish` / `finalize` / `end` step — "the status `feed`/`decode` returns *is*
  the answer", computable at any byte boundary from the decoder's own state.
  This port returned `void` and offered the outcome only through a method
  literally named `end()`, so a finish-less decoder looked like it had a
  mandatory finish step, and the port was the odd one out for a caller porting
  code between languages. `feed` now returns `DecodeStatus` (`void` →
  `DecodeStatus` is source-compatible, so existing callers and generated code
  keep working unchanged), and `status()` is the pure accessor that re-reads the
  same value later. `end()` remains as a **deprecated alias** of `status()`,
  behaviourally unchanged. `INVALID` keeps travelling on the error channel — a
  thrown `INVALID_MSG`, this port's idiomatic surfacing — and stays latched, so
  it is the one outcome `feed` does not return and `status()` answers `Invalid`
  for good after the throw.

- **`Visitor.fieldBegin(id, wire)` — a field-header callback on the push paths**
  (#97). The visitor had no hook between a field's **header varint** and the
  value's own header word, so for a fixlen field the earliest signal was
  `fixlenBegin`, which needs the *complete* fixlen word: a message ending inside
  that word delivered no event at all and a visitor could not latch a bound the
  header alone had already decided. The pull path has no such gap —
  `Cursor.readHeader()` publishes `id` / `wire` and peeks `fixSub` one byte into
  the word — which is exactly why the two disagreed. Crucible F-0061
  `r3_wrapper_reopen_overindex_trunc.bin` (11 bytes, `probe.string_array` at id
  200 with `count: 5`) re-opens the wrapper (MESSAGE_SPEC §7.4), announces
  element id 161 and then ends one byte into its fixlen word: whole-buffer
  `INVALID` through the cursor, chunked `INCOMPLETE` through the visitor at every
  chunk size. CORELIB_PLAN §5.2 gives `INVALID` precedence over `INCOMPLETE` for
  input already known to be malformed, and §6.4 / MESSAGE_SPEC §7.2 forbid a
  chunk boundary changing the outcome — and the violation here is fully
  established by bytes that arrived, since `8a 0a` is a complete varint. The hook
  fires on both push paths (contiguous and chunked), exactly once per field, in
  every scope and for every wire type, before the value and before the value's
  own header word; throwing from it rejects the field, as from `fixlenBegin`.
  The sequence-*end* marker is not announced — it closes a scope rather than
  opening a field and its id is discarded, the same answer `readHeader()` gives
  by returning `false` for it. Optional like every other visitor method, so no
  existing visitor changes behaviour, and it costs one predicted property test
  per field header: measured with `bench/run_callgrind.sh`, `decode: typical
  message` 12,619 → 12,652 Ir/op (+0.3%) and `decode: u64 array (1000)` 723,050
  → 720,764 (unchanged within noise — one header for a thousand elements).

- **`MIN_OUTPUT_BUFFER` — the declared, documented and enforced streaming buffer
  minimum** (#107). CORELIB_PLAN §5.1 requires every port to expose a constant
  naming the smallest output buffer it accepts for streaming, so a caller can
  *size* a buffer from the API instead of discovering the floor at runtime. This
  port declares **`1`**: it splits every atomic unit — field header, fixlen word,
  element count, a scalar or array element varint, an `fp32` / `fp64` element —
  across a flush, which `test/small-buffer-encode.test.ts` proves at size 1 over
  the whole writer corpus. The constant is exported from the package root (and
  from the `sofab` namespace) and stated in the README's *Memory handling*
  section. It is now also **enforced where a buffer is handed over**: a buffer
  installed **with** a flush sink must satisfy `buffer.length - offset >=
  MIN_OUTPUT_BUFFER`, at construction and at every mid-stream `setBuffer`, and a
  smaller window throws `SofabError` with code `ARGUMENT` there — previously a
  zero-usable-byte streaming buffer was accepted and failed partway through the
  message with `BUFFER_FULL` instead, which §5.1 forbids. A rejected `setBuffer`
  changes nothing: the encoder keeps writing into the buffer it already had. A
  buffer installed **without** a sink is deliberately left unrestricted — no
  flush can occur, so nothing can be split, and the one-shot `MAX_SIZE` path
  stays exact down to a zero-length buffer.

### Performance

A pass on **what a message costs before a byte is coded** — the allocations each
encode and decode makes on the way in. No wire-format, API or behavioural change:
the shared vectors (now also encoded through a plain caller buffer, see *Tests*),
the round-trip and chunked suites and the byte-exactness guarantees are unchanged.

| Tool | Workload | before | after | |
|---|---|---|---|---|
| `run_callgrind.sh` | `encode: typical message` | 10,627 Ir/op | 8,037 Ir/op | **−24.4%** |
| `npm run bench` | `encode: typical message` | 15.19 MB/s | 58.61 MB/s | **+286%** |
| `npm run bench` | `encode: u64 array (1000)` | 300.94 MB/s | 316.38 MB/s | **+5.1%** |
| `npm run perf` | serialize (170-byte message) | 3,184 ns/op | 1,312 ns/op | **−58.8%** |

The decode rows of those tools all run through `IStream`, whose code is
untouched, and Callgrind — which is deterministic — reports them unchanged to the
instruction (`decode: typical message` 12,719 → 12,719, `decode: u64 array`
720,804 → 720,869). The whole-buffer decode wins below are invisible to
`bench` / `perf`, which have no `decode()` / `Cursor` row, and are measured one
row per process, best of four:

| Workload | before | after | |
|---|---|---|---|
| `growingOStream()` + 5 fields | 2,200 ns | 314 ns | **−85.7%** |
| `new OStream(buf)` + 5 fields | 1,945 ns | 158 ns | **−91.9%** |
| `Cursor` over a float-free message | 393 ns | 280 ns | **−28.9%** |
| `decode()` over a float-free message | 482 ns | 403 ns | **−16.5%** |
| `Long.fromBigInt` ×256 | 25.2 µs | 4.0 µs | **−84.0%** |
| `Long.toBigInt` ×256 | 21.7 µs | 12.6 µs | **−41.8%** |
| `IStream` over the same message (untouched path) | 455 ns | 464 ns | +1.9% |

- **The accumulator's buffers are carved from a shared slab.** V8 keeps a typed
  array's bytes inside the JS heap only up to **64 bytes**; one byte more and the
  backing store is an external allocation — measured on Node 24 at ~1.4 µs
  against ~60 ns, several times the cost of encoding a short message.
  `growingOStream()`'s 256-byte default was therefore 45% of the profile of
  `encode: typical message`, and the reason that workload ran at a sixth of the
  decode throughput. Requests up to 4 KiB now come out of an 8 KiB slab, exactly
  as Node's own `Buffer.allocUnsafe` pools; larger ones still get storage of
  their own, where one allocation is amortised by the message anyway. A carve is
  handed out **once** and never recycled, so nothing observable changes: two
  encoders never share bytes, and a slab is fresh, zero-filled storage. What does
  change is lifetime — a retained `bytes()` view keeps its slab alive, so
  `.slice()`, already the documented way to outlive the next write, is also what
  releases it.
- **A caller-supplied buffer now takes the bulk writers too.** The one-shot
  `new OStream(buf)` shape §5.1 puts first — a buffer sized from the schema's
  `MAX_SIZE`, no owner, no sink — was excluded from every bulk route by a
  `canGrow` gate, so it ran `TextEncoder.encode` (plus its throwaway array and
  second copy) for every string and the element-at-a-time loop for every array —
  1.9 µs against 0.16 µs for the same five-field message once the bulk routes are
  open to it, a 12x difference that nothing about the buffer required. The gate now
  asks the question that actually decides it — *is the payload's room already
  there?* — which can be true on any buffer, and only reaches for an owner beyond
  that. It has to: a bulk array reserve asks for the **worst case** (10 bytes per
  element), and demanding that of a fixed buffer would turn a message that fits
  into a spurious `BUFFER_FULL`, so a `false` here stays what it always was — a
  fallback to the element-at-a-time route, not an error.
- **The whole-buffer decoders build their `DataView` on first use.**
  `new DataView(buffer, offset, length)` costs ~115 ns on Node 24, and it was
  built in the `BufferReader` constructor — once per `decode()` and per `Cursor`,
  i.e. once per message — for a member only the `fp32` / `fp64` readers touch. A
  message with no float field never allocates it now, and one that has floats
  pays a single already-loaded field test per float read.
- **`Long` converts through the shared bit-punning scratch.** `Long.fromBigInt`
  ran `Number(v & 0xffff_ffffn)` plus a shift (four intermediate `bigint`s) and
  `toBigInt` a shift-and-or (two), on the very boundary the class exists to make
  cheap — while `src/varint/bits64.ts` has done both with one typed-array store
  and two number loads since the pass below. Truncation is identical: a
  `BigInt64Array` store *is* `ToBigInt64`, reduction modulo 2^64, which is what
  the masks computed.

Earlier in this release, and unchanged by the above:

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

- **`growingOStream()` and `BufferOwner` — the caller that owns the buffer**
  (#108). CORELIB_PLAN §5.1 gives the encoder one buffer-ownership model: every
  buffer it writes into is caller-supplied. A message without a schema-derived
  bound still has to end up somewhere, and §5.1 puts that on the caller — "the
  generated-object layer allocates; the corelib does not" — so the encoder now
  takes an optional fourth constructor argument, a `BufferOwner`, and asks it for
  the **next** buffer when the one it was handed fills:
  `owner(current, used, needed)` returns a buffer of at least `used + needed`
  bytes holding the first `used` of the old one, or `undefined` to decline (which
  reports `BUFFER_FULL`, or splits the value across flushes where a sink is
  installed). A replacement too short for `used + needed` counts as declining —
  an out-of-range store on a `Uint8Array` is silently dropped, so accepting one
  would lose bytes without an error. `growingOStream(initialCapacity?)` is that
  owner ready-made, a doubling accumulator: `bytes()` is the whole message, no
  write reports `BUFFER_FULL`, and `reset()` keeps the buffer it grew to. Because
  the buffer is the owner's, `setBuffer` on such a stream reports `ARGUMENT` —
  installing a foreign one would strand the bytes already written.

### Changed

- **The bench tools run BENCH_SPEC's full workload set** (`bench/`). `bench` had
  four rows over two datasets; the spec defines **ten** over four, and the two
  that were missing are the two that exercise anything hard. `blob 1MB` — one
  unbounded `blob` field, 1,000,005 bytes on the wire — is now driven three ways:
  `one-shot` into a caller buffer sized by hand to exactly the message,
  `streaming` through a **4096-byte** buffer with a flush sink (~245 flushes,
  pass-through not granted), and `decode: blob 1MB` fed back in 4096-byte chunks.
  Nothing in this suite reached the divisible-run flush path of CORELIB_PLAN §5.1
  before — the other workloads are all schema-bounded and small enough that no
  flush occurs mid-encode — and the gap between the first two rows is what that
  path costs (**+75%** `Ir/op`: 1.03M one-shot against 1.80M streaming).
  `composite` (956 bytes) is the second new dataset and reaches the encoder paths
  the flat ones miss: a 64-element **wrapper array** (MESSAGE_SPEC §5.1, ids 0–15
  one header byte and 16–63 two), 320 bytes of 1-, 2-, 3- and 4-byte UTF-8,
  nesting three deep, a default-valued field the encoder must **not** write (the
  lazy hold-back's discard path), and the suite's only two-byte field header. Its
  `decode: composite skip-all` row walks the same bytes through `Cursor.skip`,
  materializing nothing — the path a router runs, required to be *tested* by
  MESSAGE_SPEC §7.2 item 7 and until now never measured — and comes out ~5%
  cheaper in `Ir/op` than the full decode (53,985 against 56,852), the difference
  being the payload views the full decode materializes and the skip does not. The optional
  `encode: blob 1MB passthrough` row is omitted rather than stubbed: this port
  grants no pass-through permission.

  Two changes to how the existing rows are driven came with it. The encode rows
  now write into a **caller-supplied buffer** rewound per op (CORELIB_PLAN §5.1,
  and what generated code does) instead of a fresh `growingOStream()` per op, so
  they measure this encoder rather than V8's allocator —
  `encode: typical message` reads 119 MB/s where the allocating loop read 65. And
  the decode rows' checksum visitor folds into a `number` instead of a `bigint`:
  every callback used to allocate, which on `decode: typical message` cost more
  than the decode it was reporting on. Both are visible in the numbers, so the
  four pre-existing rows are not comparable with the ones in earlier releases.
  Datasets, tools and output grammar are now pinned by tests
  (`test/bench-datasets.test.ts`, `test/bench-grammar.test.ts`), and
  `--smoke` runs every row exactly once for a liveness check that costs a second
  instead of twelve.

- **`bench/run_callgrind.sh` measures all ten rows, with rep counts per workload
  shape.** The two-rep subtraction only reports steady-state cost if *both* rep
  counts sit past V8's tier-up, and the classes are now measured rather than
  assumed: the megabyte-copying blob encodes take BENCH_SPEC's own `R1=1, R2=3`;
  the 1000-element arrays and the 245-chunk blob decode are steady by a few
  hundred (the blob decode moves 0.8% between 200/1200 and 2000/12000); and
  `composite` — 70-odd small field calls per op — is not, reading 90.5k `Ir/op`
  for `encode: composite` at 200/1200, 75.9k at 2000/12000 and 67.2k at
  10000/60000, where it finally holds. It gets its own rep pair rather than
  riding on the array one.

- **The bench tools time through one loop** (`bench/common.ts`). `bench.ts`,
  `perf.ts` and `bound.ts` each carried a copy, and `bound.ts`'s had drifted into
  reading the clock once per *operation* — at ~1 µs a read, several times the cost
  of the sub-microsecond decodes it reports, so its rows measured mostly
  `process.cpuUsage`. Its `decode: string (43 bytes)` row went from 0.32 to 0.92
  Mops/s on the same code the moment the shared, batch-calibrating `measure()`
  replaced it. No workload, value or report layout changed in any of the three.

- **The two whole-buffer decoders share one byte-reading core** (#114). The pull
  `Cursor` (`src/decode/cursor.ts`) and the contiguous push decoder
  (`src/decode/fast.ts`) each carried a verbatim copy of the same unrolled,
  `bigint`-free LEB128 reader plus the helpers around it — a 72-line identical
  run, of which 55 lines were the reader itself, and two shorter runs covering
  the zero-copy `take` and the fp32/fp64 readers. Every varint-level decode fix
  (#82, #88, #99/#100, #113) had to be applied to both copies by hand, and one
  applied to a single copy is invisible to review: the shared vectors feed both
  surfaces the same well-formed bytes, so only a hostile varint tells them apart.
  Both decoders now extend `BufferReader` (`src/decode/reader.ts`), which owns
  the buffer, the cursor, the varint reader and the half-combining helpers.
  Internal only — no public API, wire behaviour or memory behaviour changes. The
  resumable streaming decoder keeps its own reader: by contract it suspends
  mid-varint at a chunk boundary, so it is a different algorithm rather than a
  third copy.

  Inheritance rather than free functions over shared registers, because this
  repo's profile is maxspeed and that is measured: routing the reader through a
  module-level function (buffer, length and position in, position out, halves
  published module-side) cost **+8%** `Ir/op` on `decode: u64 array (1000)` and
  **+15%** on `decode: typical message` under Callgrind — the reader is the
  innermost loop of every decode and its callers consume the halves in the same
  breath. Keeping every access a plain field access on `this` holds the numbers
  flat: over the pull and push paths, `-0.2%` / `+0.02%` on the array workloads
  and `+0.3%` / `+0.8%` on the small-message ones.

### Deprecated

- **`new OStream()` with no arguments** (#108) — a one-release alias for
  `growingOStream()`, kept so downstream code (the sofabgen TypeScript backend
  among it) keeps building, and removed after that. It is the accumulator, not a
  second ownership model inside `OStream`: the object it returns owns its buffer,
  so it never reports `BUFFER_FULL` and refuses `setBuffer`, exactly as
  `growingOStream()` does.

### Removed

- **The `bigint` varint and zig-zag helpers — a fourth varint reader with no
  caller.** `encodeVarint`, `varintSize`, `decodeVarint` / `VarintResult`,
  `zigzagEncode` and `zigzagDecode` were internal (never part of the public
  surface) and had no production caller left: every shipped path holds a 64-bit
  value as two 32-bit halves and goes through the `…LoHi` / `…Num` writers, while
  every decode surface reads varints in the shape its own control flow needs.
  What survived was a *general* reader that shipped in every bundle, ran nowhere,
  and had to be kept in lockstep with the three that do — corelib-ts#82, #88,
  #99/#100, #113 and #131 each had to be applied to it as well, and a rule
  applied to it alone would have been invisible. The §4.1 rules it carried are
  now asserted where they matter, on the encoder and the three decode surfaces
  (see *Tests*), against a reference LEB128 the test owns.
- **`validateKernel` is no longer exported** from `src/backend/kernel.ts`: it is
  what `setKernel` calls, and nothing else ever called it.

- **`loadNativeKernel()`, `loadWasmKernel()` and `WasmKernelFactory` — loaders
  for acceleration backends that do not exist** (#115). `loadNativeKernel()`
  tried to `require("@sofa-buffers/corelib-native")`, a package this
  `package.json` never declared (there is no `optionalDependencies` block) and
  the org never published, so on every host it took its `catch { return false }`
  path — its one test asserted exactly that. `loadWasmKernel()` was three lines
  of `WebAssembly.instantiate` sugar in front of `setKernel(factory(exports))`
  for a WASM build that its own doc comment claimed "is shipped separately", and
  that likewise does not exist; nothing in the library was "wired through" it.
  Both shipped in the ESM, CJS and IIFE bundles as public API and were the two
  least-covered files in the repo.

  The acceleration seam is unchanged and is now stated plainly in the README and
  in `src/backend/kernel.ts`: it is the `Kernel` interface plus `setKernel()` /
  `getKernel()` / `jsKernel`. A caller with a native addon or a WASM module
  loads it their own way and installs the kernel they build from it — one line,
  no loader needed — and CORELIB_PLAN §5's "the upgrade must be invisible to
  callers" still holds, because the swap happens behind the same public API.
  `test/kernel.test.ts` now walks that path end to end (instantiate a module,
  build a kernel over its exports, install it, encode byte-identical output),
  and `test/public-surface.test.ts` pins both halves of the finding: no exported
  `load*Kernel`, and no module id anywhere in `src/` that is not relative, a
  `node:` builtin, or a declared dependency.

### Fixed

- **The README stated a stale CI Node matrix** (#119). CORELIB_PLAN §9 requires
  every version number the README states to match the repo as it stands today.
  Both mentions of the tested Node lines read "20 / 24" while
  `.github/workflows/ci.yml` runs `build-test` on `[20, 22, 24, 26]` — every
  Node line still supported plus the current release — so a reader sizing their
  runtime support against the README under-read the tested range by half and
  could conclude 22 and 26 were untested. Both sentences now name the full
  matrix and say what decides it, and the numbers are no longer prose somebody
  has to remember to update: `test/readme-ci-matrix.test.ts` parses the
  `build-test` job's `node-version` list out of `ci.yml` (sliced to that job, so
  the deliberately narrower `smoke-node` boundary matrix cannot be mistaken for
  it) and fails if any README mention disagrees. It also pins the README's
  "Node.js 20+" floor to `package.json`'s `engines.node` and requires that floor
  to be a line CI really tests. Documentation and tests only; no library code
  changed.

- **The README's generated-code example showed only the whole-buffer half**
  (#118). CORELIB_PLAN §9.5 requires the `## Usage` "Generator" example to show
  the generated object driven **both** ways — the one-shot `encode()` /
  `decode()` helpers *and* the streaming `serialize` / `decoder()` path of
  §6.1.1 — because the generated layer is the only surface most callers touch
  and a chunked transport is exactly what the one-shot helpers cannot serve.
  "### Code generator" was whole-buffer throughout (`marshal`, `static decode`,
  `decodeFrom(cursor)`); `IStream` never appeared in it, and the streaming
  section above it drives a hand-written visitor rather than a generated type,
  so the combination a reader with a chunked transport needs was shown nowhere
  — inviting the conclusion that generated code does not stream. The example
  now carries both halves over one `Point`: the pull-`Cursor` one-shot as
  before, plus a generated-style `Visitor` and the `Point.decoder()` handle
  that owns an `IStream`, encoded through a 4-byte buffer with a `FlushSink`
  and decoded back from those pieces to a `DecodeStatus.Complete` check. The
  encode method is renamed `marshal` → `serialize`, the §6.1.1 name the
  generator actually emits and the other ports' READMEs use (the opening
  summary said "marshal / unmarshal" and now agrees). The snippet is no longer
  prose: it lives in `test/helpers/readme-generator-example.ts`, which
  `tsc --noEmit` type-checks and `test/readme-generator-example.test.ts`
  executes, asserting the README block is character-for-character that module
  and that it really does round-trip through a sink and through chunks — down
  to one byte at a time. Documentation and tests only; no library code changed.

- **The module-level doc example decoded a string chunk with a lossy
  `TextDecoder`** (#117). CORELIB_PLAN §6.4 forbids silent replacement in every
  mode — an implementation must never substitute `U+FFFD` for invalid UTF-8 —
  and names JavaScript's default `TextDecoder` as exactly the lossy platform
  primitive to avoid. The `@example` on `src/index.ts`, the first snippet a
  TypeDoc reader sees, materialized a visitor `string` chunk with
  `new TextDecoder()`, so the pattern it taught turns `ff fe` into two
  replacement characters while reporting the message `COMPLETE`, where the same
  bytes through `Cursor.readString` are `INVALID_MSG`. The example now builds a
  fatal decoder (`new TextDecoder("utf-8", { fatal: true })`), and the contract
  behind that choice is stated where it belongs: on `Visitor.string` itself and
  in the README's decode-ownership list — visitor chunks are raw, unvalidated
  wire bytes that may end mid-code-point, validation happens where a string is
  *materialized*, and on the push path the caller doing the materializing owns
  it. `test/doc-utf8-decoder.test.ts` lints every `new TextDecoder(...)` in the
  shipped docs (`src/**` TSDoc and the README) for `fatal: true` and pins the
  behaviour that makes it matter. Documentation and tests only; no library code
  changed.

- **The README's error-code list named a code that does not exist and omitted
  one that does** (#116). The "Usage" paragraph is the one place a caller learns
  which values `SofabError.code` can take, and it listed `USAGE` — a name
  `src/errors.ts` has never defined, so `e.code === "USAGE"` compiles into a
  branch that can never fire — while leaving out `LIMIT_EXCEEDED`, the §6.2.1
  code a caller most needs to tell apart from `INVALID_MSG` and which the same
  README documents further down under "Decode limits". The list is now the
  library's actual closed set (`ARGUMENT`, `BUFFER_FULL`, `INVALID_MSG`,
  `INCOMPLETE`, `LIMIT_EXCEEDED`), and says what the phantom code had implied
  was reportable: a read whose declared type contradicts the wire is **not** an
  error — the field is skipped like an unknown id and the decode stays
  `COMPLETE` (MESSAGE_SPEC §7.3, CORELIB_PLAN §6.3) — and `LIMIT_EXCEEDED` is a
  receiver-local policy rejection, not a verdict on the message. Documentation
  only; no code changed.

- **`leb128.decodeVarint` reported `INCOMPLETE` where the three real decode
  surfaces report `INVALID`** (#113). CORELIB_PLAN §4.1 bounds the varint
  *encoding*, not the decoded value: ten bytes that all carry the continuation
  flag already require an eleventh, which is past the 10-byte / 64-bit maximum,
  so they are malformed on the bytes already in hand — and §5.2 gives that
  `INVALID` precedence over the `INCOMPLETE` of input that merely stops there.
  The whole-buffer helper tested its truncation guard *before* its length guard,
  so ten continuation bytes followed by end of input suspended as `INCOMPLETE`,
  while the same bytes as a field value through `decode()`, `Cursor` and a
  byte-at-a-time `IStream` all reported `INVALID_MSG` — two varint precedence
  rules living in one repo, the divergent one reachable only from its own unit
  test (`decodeVarint` has no caller in `src/` and is not part of the public
  surface, so no decode of real input changed verdict). The two guards are now
  ordered overflow-first, matching `decode/state.ts`, `decode/fast.ts` and
  `decode/cursor.ts`; a varint that ends short of the bound is still
  `INCOMPLETE`, and no valid varint changes cost or result.
  `test/varint.test.ts` pins the ten-continuation-bytes-then-EOF case as
  `INVALID_MSG` with nine-then-EOF as the `INCOMPLETE` control, and asserts all
  four readers — the helper plus the three decode surfaces — agree on both.

- **A non-integer `number` at an integer surface escaped as a bare
  `RangeError`** (#111). CORELIB_PLAN §6.3 fixes the closed set of result codes
  every fallible operation reports, and a caller mistake — an id out of range, a
  bad scalar width, a value outside the 64-bit domain — is `InvalidArgument`.
  This port maps that set onto `SofabError.code`, and the README tells callers to
  catch problems with `e instanceof SofabError`. The `number → bigint` converter
  behind the 64-bit writers threw a plain `RangeError` instead, so
  `writeUnsigned(0, 1.5)`, `writeSigned(0, 1.5)` and both integer-array writers
  (`NaN` and `±Infinity` too, which are non-integers as well) produced a
  code-less error that pattern never caught — the one encoder rejection in the
  library that was not a `SofabError`. It now throws `argumentError(...)` like
  every neighbouring check, so it carries `SofabErrorCode.Argument`; the message
  text is unchanged. The throw sits on a path that has already left the fast lane
  (a valid small integer never reaches the converter), so no valid encode changes
  its bytes or its cost. `test/errors.test.ts` pins `ARGUMENT` for both scalar
  writers and both array writers, in both the growable (bulk `Kernel`) and the
  fixed-buffer element-at-a-time construction, plus `instanceof SofabError` on
  the thrown value. Breaking only for a caller that matched `RangeError`
  specifically; `instanceof Error` and the message are unchanged.

- **`writeFixlen` emitted reserved subtypes and wrong-width `fp32`/`fp64`
  fixlen words** (#110). CORELIB_PLAN §4.6 closes the domain of the
  `fixlen_word`'s low three bits — `0x4`–`0x7` are **reserved** and a decoder
  **must** reject a field carrying one — and fixes an `fp32`/`fp64` payload at
  **exactly** 4 / 8 bytes, any other declared length being malformed the moment
  the word is read. `writeFixlen` validated only the length ceiling, so
  `writeFixlen(0, Uint8Array.of(1), 6 as never)` produced `02 0e 01` and
  `writeFixlen(0, Uint8Array.of(1,2,3), Fp32)` produced a 3-byte `fp32` — bytes
  this library's *own* decoder answers `INVALID_MSG` for. The wrong-width case
  is reachable from the documented bit-exact transcode path
  (`Cursor.readFp32Raw()` → `writeFixlen(id, raw, Fp32)`): a caller handing over
  a wrongly sized slice got silently malformed output instead of an error. Both
  are now refused with `ARGUMENT` (§6.3, symmetric with the decoder's verdict as
  the strict-UTF-8 pair is) before any byte reaches the buffer, matching
  `corelib-rs`'s `write_fixlen`. `String`/`Blob` of any length up to
  `FIXLEN_MAX` are unaffected, and the typed `writeFp32` / `writeFp64` /
  `writeString` writers are correct by construction and do not go through the
  check, so no valid encode changes its bytes or its cost.
  `test/fixlen-encode-domain.test.ts` pins the rejected and accepted domains and
  the property behind them: whatever `writeFixlen` accepts, a decoder accepts.

- **A flush re-armed the start offset instead of consuming it** (#109).
  CORELIB_PLAN §5.1: "the start offset belongs to the installation, not to the
  buffer" — a buffer-set begins an installation whose cursor starts at *that
  call's* offset, and once the unit it began has been handed to the sink the
  offset is consumed, so a sink that returns **without** installing a buffer (the
  copied case) resumes at offset `0`. `flush()` rewound to `this.start`, which
  only the constructor and `setBuffer` ever set, so the reservation was
  re-established on every flush and the leading `offset` bytes were never usable
  again: a copying sink permanently lost `offset` bytes of capacity, and the two
  handover shapes §5.1 distinguishes — copy-and-continue versus take-and-replace
  — became indistinguishable, leaving no way to express "header room in the first
  unit only". With an 8-byte buffer handed over at offset 4, 16 bytes of message
  now flush as `4, 8, 4` where they used to flush as `4, 4, 4, 4`. The
  per-packet header-room pattern is unchanged and still the explicit one: a sink
  that calls `setBuffer(buf, 4)` from inside the callback — the same buffer
  counts, a buffer-set is a new installation like any other — keeps getting
  `4, 4, 4, 4`, and `flush()` no longer overwrites the cursor that call placed.
  No wire bytes change: the concatenation of the flushed units is byte-identical
  either way, and to the one-shot path, which the new
  `test/flush-installation-offset.test.ts` pins for both shapes, including a
  value split across the consumed offset. `bytes()`, `bytesUsed` and `reset()`
  follow the consumed offset — after a flush the stream is empty at `0` and
  `reset()` rewinds there — while a sink-less stream, which can never flush,
  keeps its reservation across `reset()` exactly as before.

- **`OStream` allocated its own output buffer and reallocated it as the message
  grew** (#108). CORELIB_PLAN §5.1 forbids both: a corelib "MUST NOT allocate an
  output buffer … MUST NOT grow or reallocate a buffer the caller supplied", and
  §13 asks for "no output buffer at all; the generated layer does, and hands one
  in like any other caller". `new OStream()` allocated 256 bytes and doubled them
  on demand, which is one buffer-ownership model too many — and the two mixed:
  handing such a stream a buffer of your own with `setBuffer` left the growable
  flag set, so the very next oversized write **reallocated away from the caller's
  buffer**, leaving it part-written while the message ended up somewhere else,
  with no error anywhere. The growth path now belongs to the caller
  (`BufferOwner`, above); `OStream` itself allocates nothing, enlarges nothing,
  and every buffer it writes into came from the caller. Encoded bytes are
  unchanged — the accumulator produces byte-identical output to a fixed caller
  buffer with a sink at every capacity, which is what the new
  `test/buffer-ownership.test.ts` pins, together with the mid-stream hand-over
  that used to reallocate. Throughput is unchanged (`npm run bench`, encode:
  typical message and u64 array within run-to-run noise of `main`): the
  accumulator is an ordinary `OStream`, not a subclass, so nothing on the write
  path changed shape.

- **An array element outside the 64-bit value domain was silently reduced modulo
  2^64 by the in-memory encoder, while the streaming one rejected it** (#106).
  CORELIB_PLAN §6.2 fixes the domains at `0 .. 2^64 - 1` (unsigned) and
  `-2^63 .. 2^63 - 1` (signed) and §6.3 makes anything outside them an
  out-of-range argument — `InvalidArgument`, not a wrapped value. `OStream`'s
  array writers have two implementations: the growable `new OStream()` branch
  hands the whole array to the bulk `Kernel`, and the fixed-caller-buffer branch
  writes element by element. Only the second range-checked, so
  `writeUnsignedArray(0, [-1n, 2n ** 64n])` put `18446744073709551615` and `0`
  on the wire in-memory and threw `ARGUMENT` when streaming — the identical
  call, two answers, decided by which constructor the caller used, and the
  unchecked one is the default the generated `marshal()` path builds. `number`
  elements were affected the same way: the kernel's number fast path is gated on
  `v >= 0`, so a negative number fell into the wrapping branch. The JS kernel now
  performs the very check the streaming path does — the `splitU64` / `splitI64`
  scratch round-trip, whose reload-and-compare *is* the range test — and throws
  `argumentError` when it fails, so both modes reject exactly the same values and
  no wrapped element ever reaches the wire. The obligation is written into the
  `Kernel` contract, since a kernel is the only code that ever sees the elements;
  the `number` fast paths are already gated on the domain and pay nothing.
  Signed arrays also stop materialising `bigint`s for the zig-zag: with the
  halves already in the scratch, `encodeZigzagVarintLoHi` computes the same
  mapping on them and allocates nothing, which more than pays for the check.
  Measured with `bench/run_callgrind.sh`, `encode: u64 array (1000)` 259,888 →
  342,606 Ir/op (+32% — V8's `bigint` comparison is instruction-heavy out of
  proportion to its time: the same array costs ~4% more CPU time, and the scalar
  writers have always paid this check), `encode: typical message` 10,368 →
  10,462 (+0.9%), both decode rows unchanged. A 1000-element signed `bigint`
  array encodes ~3.8× faster (best-of-9 CPU time, 90.2 → 23.7 µs).
- **Receiver-side limits (`maxArrayCount` / `maxStringLen` / `maxBlobLen`) were
  applied to schema-bounded fields, which §6.2.1 forbids** (#105). A `max_dyn_*`
  limit exists because a schema-*unbounded* field lets the sender dictate the
  receiver's allocation; a schema bound removes that freedom, so CORELIB_PLAN
  §6.2.1 states the limits "**MUST NOT** be applied to a field the schema already
  bounds. There the schema bound governs and its violation is `INVALID`", and
  §6.3 that `LimitExceeded` is "never raised for a field the schema bounds".
  `Cursor` took the schema bound and then applied the cap unconditionally, so a
  deployment with a global cap rejected well-formed messages whose fields the
  schema bounds *above* it — `readString(100)` on a 10-byte string under
  `{ maxStringLen: 4 }` threw `LIMIT_EXCEEDED`, and two receivers with the same
  schema and different limits disagreed about a bounded field, which §6.2.1 rules
  out. Each cap in `fixlenLen`, `arrayCount` and `arrayFixlenHeader` is now gated
  on the absence of the schema bound, so a bounded string, blob, varint array or
  fixlen array decodes normally however tight the cap. The schema check keeps its
  position and its `INVALID` verdict, and the fixlen-array path gains the second
  half of that: its cap sat at the count word, *before* the element word the §4.8
  order puts the schema check after (#104), so an over-`count` fp array under a
  tighter cap reported `LIMIT_EXCEEDED` where `INVALID` is required — precedence
  `INVALID > LIMIT_EXCEEDED > INCOMPLETE` now holds there too. Unbounded fields
  are unchanged, on every path, including a field skipped past on an unknown id
  (no schema bound by construction). The push surfaces (`decode()`, `IStream`)
  are driven by wire type and are never told a schema bound, so they still apply
  the caps to every field; that limitation is now recorded in the code and the
  README. Cost is one `undefined` test on an already-loaded argument.
- **A fixlen array's schema `count` was applied before its `fixlen_word`, so a
  message cut between the two words was `INVALID` where `INCOMPLETE` is
  required** (#104). CORELIB_PLAN §4.8 fixes the decode order — `element_count`
  under the *format* ceiling `ARRAY_MAX`, then the `fixlen_word`, then the
  subtype, and only then the *schema* `count` (MESSAGE_SPEC §7.1) — because the
  two words answer to different authorities: until the element word has shown the
  subtype, a decoder does not know the field is this array at all, and a
  contradicting subtype means its element count was never this field's count.
  §4.8 calls the consequence intended: "a message that ends **between** the two
  words is `INCOMPLETE`, not `INVALID`, even when the `element_count` already
  exceeds the schema `count`". `Cursor.arrayFixlenHeader` ran the schema check at
  the count word, so `05 05 80` (count 5 against a schema `count` of 2, element
  word truncated after its first byte), `05 05 a0` and `05 05` all threw
  `INVALID_MSG` — disagreeing with `decode()` / `IStream`, which report
  `INCOMPLETE` for the same bytes. The check now sits after the element word and
  its subtype/size validation, for `readFp32Array`, `readFp32ArrayRaw` and
  `readFp64Array`. Everything the count word does decide is unmoved: `ARRAY_MAX`
  still fires there "whatever the subtype turns out to be" (§4.8), and the
  `maxArrayCount` receiver cap still fires there, before the allocation §6.2.1
  requires it to prevent. A complete, agreeing element word still yields
  `INVALID` for an over-count array — including when the payload behind it is
  truncated (#69) — and integer arrays (§4.7) are untouched: they carry no second
  word, so their count word is the deciding word.
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

- **The benchmark datasets and the tools' output grammar are under test**
  (`test/bench-datasets.test.ts`, `test/bench-grammar.test.ts`). The datasets are
  a cross-language contract — BENCH_SPEC fixes the ids, types and literal values
  so the encoded sizes match on every port, and three of those sizes (`perf` =
  170 bytes, `blob 1MB` = 1,000,005, `composite` = 956) are stated as parity
  checks — but nothing here checked them, and a bench that quietly encodes
  something else prints numbers nobody can compare. The suite now pins the three
  sizes, the wrapper array's 64 elements and their id widths, the omitted
  default, the two-byte header, the depth-3 nesting, and that the streaming
  `blob 1MB` encode through a 4096-byte buffer produces byte-identical output to
  the one-shot one. The grammar test runs `bench` and `perf` for real (in
  `--smoke` mode) and matches their output with BENCH_SPEC's own regexes: a row
  one space out of column, a relabelled workload or a row that stopped printing
  fails nothing locally — it silently drops out of the cross-language tables.

- **Every shared vector is now encoded through a plain caller buffer as well**,
  at two sizes: exactly the reference length — the `MAX_SIZE` shape, which cannot
  take a worst-case array reserve, so the element-at-a-time fallback runs — and
  with 4 KiB of slack, where the bulk string / array writers run throughout. The
  vector suite only ever drove the accumulator, so the buffer shape CORELIB_PLAN
  §5.1 puts first had no byte-exact coverage at all; both routes through the
  encoder are now pinned to the same reference bytes (163 further assertions).
- **`test/varint.test.ts` drives the shipped surfaces.** It exercised the deleted
  `encodeVarint` / `decodeVarint` pair — the only thing keeping them alive — and
  now asserts the same §4.1 rules (the length ladder, the 10-byte / 64-bit bound,
  truncation vs. overflow, the zig-zag mapping) through `OStream`, `decode()`,
  `Cursor` and `IStream`, against a reference LEB128 written out in the test. The
  overlong-varint cases are now checked on *all three* decode surfaces rather
  than on the helper alone.
- **The accumulator's slab is pinned in `buffer-ownership.test.ts`**: a retained
  `bytes()` view is not disturbed by later encodes on other streams, and no two
  accumulators share bytes.

- `readme-error-codes.test.ts` checks the README's error-code prose against
  `src/errors.ts` instead of against itself (#116): the documented list must name
  every value `SofabErrorCode` defines, no value it does not, and each exactly
  once, and every `SofabErrorCode.<member>` the README spells in an example must
  resolve on the exported object. Both halves of the finding fail on the old
  text, and the drift they catch — a code added to the enum, or renamed out from
  under the prose — is invisible to every behavioural test in the suite.
- `varint-reader-shared.test.ts` guards the single varint reader (#114) at both
  levels the duplication could fail at. Structurally: the bounds-checked unrolled
  reader has exactly one definition across `src/decode/`, and no verbatim block
  of code survives between `cursor.ts` and `fast.ts` — both assertions fail
  immediately on a re-pasted copy, which the previous suite could not see at all.
  Behaviourally: the pull and push surfaces are fed the same adversarial varints
  — the 64-bit boundary, `u64` max, bit 64 set, an eleventh byte, and truncation
  at every prefix length from one to nine bytes — and must return the same value
  or the same error code. That is the drift a one-sided fix produces, and the
  shared vectors cannot catch it because both surfaces see the same well-formed
  bytes there.
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
- `utf8-late-offset.test.ts` closes the coverage gap the shared `invalid_utf8`
  vectors leave open: every one of them puts its string at buffer offset 2 with a
  1–4 byte payload, so a validator given a *length* where an exclusive *end
  index* was wanted still rejects them and a full conformance run stays green
  while the check is broken (that is how a `.length`-for-`end` bug survived
  conformance in a sibling port). The whole negative suite is replayed behind a
  96-byte pad, so each payload starts at an offset **at or beyond its own
  length**, and again through a `Uint8Array` at a non-zero `byteOffset` into a
  larger `ArrayBuffer`. The controls are what make it a validation test rather
  than a blanket-rejection test: a *valid* string at the same late offset decodes
  to the exact text, a skipped invalid one is not validated at all (§6.4) and
  stays `COMPLETE`, streaming chunks still report field-relative offsets, and a
  late invalid payload cut short is `INCOMPLETE`, not `INVALID`.
- `istream.malformed.test.ts` gives the resumable decoder the malformed-input
  coverage the vectors cannot: an `array<fixlen>` element word that is neither
  `fp32`/4 nor `fp64`/8 (including on an empty array, where that word is the only
  carrier of the element kind), a fixlen length word above `FIXLEN_MAX` — which
  must be `INVALID` even though its payload is missing, with the `FIXLEN_MAX`
  control one count lower staying `INCOMPLETE` — and a varint past the 10-byte /
  64-bit bound fed at *every* split point, which is what forces the resumable
  ladder and the ten-bytes-in-hand fast path to agree (§5.2 / §6.4: a chunk
  boundary must not change the verdict). Also the varint length ladder 1..10 read
  identically whole, one byte at a time and by `decode()`, and an unclosed
  sequence reported as `INCOMPLETE` on all three surfaces.
- `encode-guards.test.ts` covers the encoder's caller-side contract, which no
  vector can reach: buffer handover validated where it happens (§5.1 — an offset
  outside the buffer rejected at the constructor and at `setBuffer`, with the
  rejected call leaving the encoder on its old buffer), `element_count` above
  `ARRAY_MAX` and an fp32 raw payload that is not a whole number of elements
  refused before a byte is written, the indivisible one-byte sequence-end marker
  reporting `BUFFER_FULL`, an unmatched end unable to underflow the depth counter
  past `MAX_DEPTH`, and the per-element 64-bit range check on the *streaming*
  array route — a second implementation of the bulk kernel's, previously
  untested.
- `utf8-writer.test.ts` drives `utf8Length` / `utf8Write` directly. `writeString`
  sizes before it writes, so the writer's own unpaired-surrogate rejections are
  unreachable through the public API — and that is the point: they are the second
  half of a two-pass invariant, and dropping the pre-pass would start emitting
  `U+FFFD` (which §8 forbids) with the public suite still green.

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
