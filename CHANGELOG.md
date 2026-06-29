# Changelog

All notable changes to `@sofabuffers/corelib` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is below `1.0.0`, breaking changes bump the **minor** version.

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
