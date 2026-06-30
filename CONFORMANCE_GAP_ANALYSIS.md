# SofaBuffers `corelib-ts` — Conformance Gap Analysis & Remediation Plan

Audit of the TypeScript core-library port (`@sofabuffers/corelib`, repo `corelib-ts`)
against the language-independent specification `CORELIB_PLAN.md`, with primary focus on
the **§13 Conformance Checklist**. Every item below was verified by reading the source,
not inferred from names. Line references are to files in this repository.

> Scope note: this document is the only file added/changed by this audit. No
> implementation, test, or config file was modified. The test suite **was executed** in
> this environment (`npm test` → **337 tests pass across 10 files**); behaviour assessed
> by reading the wire logic and confirming with the suite.

## Spec revision

Audit re-run against the **updated `CORELIB_PLAN.md` (commit `dcb85d6`, 2026-06-30)**.
The substantive change since the previous revision is that **explicitly empty
collections are now first-class on the wire**:

- **§4.7** — integer-array `element_count` range is now `0 .. 2,147,483,647` (was `1..`).
  A zero-count unsigned/signed array is a valid, fully-specified empty array: exactly
  `[ header_varint ] [ element_count_varint = 0 ]`, nothing after. Whether an explicit
  empty array differs from an absent field is now a **code-generator** concern, not a
  wire-level one.
- **§4.8** — a zero-count **fixlen** array (fp32/fp64) carries **no `fixlen_word` and no
  payload**: exactly `[ header_varint ] [ element_count_varint = 0 ]`.
- **§4.9** — an **empty sequence** (`sequence start` immediately followed by `0x07`) is
  legal and a decoder **must** accept it.

Consequence for conformance: a port that **rejects** a zero-count array or an empty
sequence (on encode or decode) is now **non-conformant**; permitting count-0 is required.

### What changed vs the previous revision of this analysis

- **Item 6 (arrays): PASS → GAP.** The previous audit accepted the encoder/decoder's
  hard `count >= 1` guards because "arrays are never empty". Under §4.7–4.8 those guards
  are now spec violations. The encoder rejects zero-count arrays
  (`src/encode/ostream.ts:305`); both decoders reject zero-count arrays
  (`src/decode/state.ts:174`, `src/decode/fast.ts:186`). Additionally the fp32/fp64 array
  writers always emit a `fixlen_word` (`ostream.ts:234,249`), which §4.8 forbids for
  count-0, and both decoders unconditionally expect that element-length word for fixlen
  arrays (`state.ts:177-180`, `fast.ts:140`) — so even with the guard removed the fixlen
  path would mis-structure a zero-count array.
- **Item 12 (test suite): PASS → PARTIAL.** Two existing tests now assert the
  *opposite* of the spec: `test/errors.test.ts:43-46` treats a valid zero-count array
  (`03 00`) as `InvalidMsg`, and `test/errors.test.ts:102-104` treats `writeUnsignedArray(1, [])`
  as `Argument`. The bundled `assets/test_vectors.json` (67 vectors) predates the change
  and has **no** zero-count integer/fixlen array vector.
- **Item 7 (sequences): still GAP, but the new §4.9 empty-sequence rule is satisfied.**
  Empty sequences encode and decode correctly and are covered by vectors
  (`empty_sequence`, `nested_empty_sequences`, `empty_sequence_between_fields`,
  `assets/test_vectors.json:658-697`, all passing). The GAP on this item is unchanged and
  is solely the missing **`MAX_DEPTH = 255`** enforcement.
- **Carried forward unchanged:** the `MAX_DEPTH` gap (item 7), the devcontainer
  deviations (item 16: `--env-file` in `runArgs`, container name `ts-devcontainer`,
  `GH_TOKEN` in `.env.example`, named `claude-config` volume), CI missing
  `fail-fast: false` (item 17), and the `sofab` namespace / `SofaBuffers` package-name
  deviation (item 1).

---

## Summary

| Status | Count |
|--------|-------|
| PASS    | 12 |
| PARTIAL | 4  |
| GAP     | 2  |
| **Total** | **18** |

Headline findings:

- **GAP — zero-count arrays are rejected on both sides (new §4.7–4.8 violation).** The
  encoder throws for any array with `count < 1`, both decoders throw on a zero `element_count`,
  and the fixlen-array path is structurally built around an always-present `fixlen_word`.
  A valid empty array (`03 00`, `04 00`, `05 00`) can neither be produced nor consumed.
- **GAP — `MAX_DEPTH` (255) is not implemented anywhere.** No constant; neither the
  encoder nor either decoder rejects nesting beyond 255 (§4.9, §6.2) — an unbounded-recursion
  exposure on decode.
- **PARTIAL — test suite encodes the pre-revision rule.** Tests assert that zero-count
  arrays are errors, and the shared vectors lack any zero-count array case (§7).
- **PARTIAL — devcontainer** (§11): `devcontainer.json` omits the mandatory
  `--env-file` `runArgs`; container named `sofa-ts-dev` not `ts-devcontainer`;
  `.env.example` omits `GH_TOKEN`; Claude config bind-mounted instead of a named volume.
- **PARTIAL — CI matrix** is missing `fail-fast: false` (§12.1).
- **PARTIAL — namespace / package name** (§6): no `sofab` namespace surfaced; npm package
  is `@sofabuffers/corelib`, not `SofaBuffers`.

---

## Per-checklist-item results

| # | Checklist item (§13) | Status | Evidence | Notes |
|---|----------------------|--------|----------|-------|
| 1 | All public symbols under the `sofab` namespace (§6) | PARTIAL | `src/index.ts:27-54` flat named exports; package name `@sofabuffers/corelib` in `package.json:2`; README install `@sofabuffers/corelib` | TS flat module exports are an allowed "module" equivalent, but no `sofab` namespace alias is exported and the registry name is not `SofaBuffers` as §6 fixes it. |
| 2 | API version constant/getter returns `1` (§6) | PASS | `src/constants.ts:14` `API_VERSION = 1`; re-exported `src/index.ts:28` | Exposed and documented. |
| 3 | Varint & zig-zag match §4.1–4.2 | PASS | `src/varint/leb128.ts` (encode/decode, overflow guard); `src/varint/zigzag.ts` 64-bit transform; streaming `src/decode/state.ts:324-351`; fast `src/decode/fast.ts:258-320` | Overlong/overflow varints rejected with `INVALID_MSG`. |
| 4 | Field header `(id<<3)\|type` + all 8 wire types (§4.3) | PASS | `src/encode/ostream.ts:291-297` `header()`; `src/constants.ts:17-34` 8 `WireType`s; dispatch `src/decode/state.ts:258-292`, `src/decode/fast.ts:82-174` | Sequence-end is single byte `0x07` (`ostream.ts:273`). |
| 5 | Fixlen word `(length<<3)\|subtype`, LE floats, UTF-8 no terminator, blobs (§4.6) | PASS | `src/encode/ostream.ts:299-302` `fixlenHead()`; LE pack `src/varint/num64.ts`; `src/encode/fixlen.ts:12-14` UTF-8 (no terminator); blob `ostream.ts:184` | Float round-trip bit-exact (DataView LE); subtype range checked on decode `state.ts:124`, `fast.ts:99`. |
| 6 | Integer arrays + fixlen arrays w/ single shared word; no dynamic subtypes; **zero-count arrays (§4.7–4.8)** | **GAP** | Non-empty arrays correct (`ostream.ts:200-259`, decode `state.ts:169-241`, `fast.ts:116-163`); no dynamic subtypes possible (only fp32/fp64 array writers; decode rejects non-fp element types `state.ts:214-221`, `fast.ts:144-146`). **But zero-count is rejected:** encoder `arrayHead` throws on `count < 1` (`ostream.ts:304-310`); decoders throw on count 0 (`state.ts:174`, `fast.ts:186`). fp32/fp64 array writers always emit a `fixlen_word` (`ostream.ts:234,249`) and decoders always expect it (`state.ts:177-180`, `fast.ts:140`), so a count-0 fixlen array is unrepresentable per §4.8. | Valid empty arrays `03 00`/`04 00`/`05 00` cannot be encoded or decoded. Fails new §4.7–4.8. |
| 7 | Sequence framing, fresh scope, `0x07` end, **empty sequence (§4.9)**, skip-by-walking w/ depth, reject nesting > `MAX_DEPTH`=255 | **GAP** | Framing/scope/skip OK (`state.ts:283-299`, `fast.ts:71-77,165-177`). **Empty sequence works** (encode `ostream.ts:264-275`; decode `state.ts:294-299`, `fast.ts:71-77`) and passes vectors `empty_sequence`/`nested_empty_sequences`/`empty_sequence_between_fields` (`assets/test_vectors.json:658-697`). **No `MAX_DEPTH` constant** in `src/constants.ts`; encoder `depth` (`ostream.ts:62,266`) has no ceiling; decoders push onto an unbounded `Visitor[]` stack (`state.ts:285`, `fast.ts:168`) with no depth check. | Empty-sequence aspect now PASS; the GAP is solely the missing `MAX_DEPTH`=255 limit (§4.9/§6.2) — silent accept + unbounded-recursion exposure. |
| 8 | Streaming encode into smaller buffer via flush + mid-stream buffer swap (§5.1) | PASS | `src/encode/ostream.ts:104-126` `flush()`/`setBuffer()`; auto-flush on fill `ostream.ts:324-353`; `test/ostream.test.ts` | `offset` reserve supported (`ostream.ts:69,119`). |
| 9 | Streaming decode via `feed` of tiny chunks, push/pull, lazy binding, auto-skip (§5.2) | PASS | `src/decode/istream.ts` + resumable machine `src/decode/state.ts` (≤1 varint buffered); `test/istream.chunked.test.ts` (one-byte-at-a-time, 135 cases) | Visitor methods optional ⇒ unhandled fields auto-skipped. |
| 10 | Error reporting per §6.3 baseline (or idiomatic exceptions) | PASS | `src/errors.ts:10-19` `SofabErrorCode` = `Argument`/`Usage`/`BufferFull`/`InvalidMsg` (maps InvalidArgument/UsageError/BufferFull/InvalidMessage) | Throws `SofabError` (idiomatic TS). Minor: invalid UTF-8 in strings not validated (raw zero-copy bytes to visitor) — acceptable for a borrowed-view port, noted vs §6.3. |
| 11 | Streaming primitives suffice for a thin generated-object layer; one-shot helpers thin wrappers (§6.1) | PASS | Visitor w/ child-returning `sequenceBegin` (`istream.ts:59-67`); one-shot `decode()` (`istream.ts`); in-memory `OStream` + `bytes()` | `decode()` is a contiguous fast path (`src/decode/fast.ts`), not literally an `IStream` wrapper; both are vector-validated, so a generated layer can build on the streaming primitives. No generated layer ships here (not required of corelib). |
| 12 | All shared vectors pass encode+decode, + chunked/roundtrip/malformed/skip (§7) | PARTIAL | `test/vectors.test.ts` (135), `test/istream.chunked.test.ts` (135), `test/roundtrip.test.ts`, `test/errors.test.ts`, `test/skip.test.ts`, `test/skip-ids.test.ts` — **337 tests pass**; `assets/test_vectors.json` 67 vectors | Suite passes, but (a) it encodes the **old** rule: `errors.test.ts:43-46` asserts count-0 array → `InvalidMsg`, `errors.test.ts:102-104` asserts `writeUnsignedArray(1, [])` → `Argument`; (b) `test_vectors.json` has **no** zero-count integer/fixlen array vector (predates the spec change) and no >255-depth malformed case (ties to items 6 & 7). Empty-sequence vectors present and passing. |
| 13 | `assets/` populated per §8 | PASS | `assets/sofabuffers_logo.png`, `assets/sofabuffers_icon.png`, `assets/test_vectors.json` (header: generated from the C encoder) | Branding + C-sourced vectors present (vectors file should be re-copied once the C generator emits zero-count array cases — see item 12). |
| 14 | README family format, badges, required sections (§9) | PASS | `README.md:1-8` header/tagline/org link; CI+Coverage+Branches+Docs badges; "Why this design" table, Usage (basic + streaming), API summary, Feature flags, Build & test, Benchmarks | Dependency-free; states Node 18+. All §9 sections present. |
| 15 | `perf` + `bench` tools present & runnable (§10) | PASS | `bench/perf.ts`, `bench/bench.ts`, `bench/common.ts`, `bench/run_callgrind.sh`; scripts in `package.json` | `perf` uses CPU-time/op + callgrind instructions/op (allowed for managed runtimes). No in-repo `BENCH_SPEC.md` (§10 names it the cross-language SoT), so workload comparability can't be verified from this repo alone. |
| 16 | `.devcontainer/` complete; extensions incl. `anthropic.claude-code`; `.env` gitignored (§11) | PARTIAL | All files present (`Dockerfile`, `build.sh`, `start.sh`, `attach.sh`, `devcontainer.json`, `.env.example`); extension list incl. `anthropic.claude-code`; `.env` gitignored via `.devcontainer/.gitignore` | Deviations: (a) `devcontainer.json` has no `runArgs` `--env-file ${localWorkspaceFolder}/.devcontainer/.env` (§11.2 mandatory); (b) running container `sofa-ts-dev` (`start.sh:17`, `attach.sh:4`) not `ts-devcontainer` (§11.3; image tag correct in `build.sh:6`); (c) `.env.example` lacks `GH_TOKEN` + scope comments (§11.1); (d) `start.sh` bind-mounts `.claude-config` instead of a named `claude-config` volume (§11.1). |
| 17 | `ci.yml` builds+tests on push & PR; version matrix; coverage uploaded + badge (§12.1) | PARTIAL | `.github/workflows/ci.yml:4-7` push+PR; matrix `node: [18,20,24]` (`ci.yml:15-17`); coverage job + badge JSON to `badges` branch; badges in README | Missing `strategy.fail-fast: false` (§12.1 requires it with a matrix). Coverage to a self-hosted `badges` branch rather than Codecov — acceptable as an "equivalent". |
| 18 | `docs.yml` builds HTML & deploys to Pages via Actions (no `gh-pages`); Docs badge links to site (§12.2) | PASS | `.github/workflows/docs.yml` TypeDoc, `permissions: pages/id-token write`, `upload-pages-artifact` + `deploy-pages`, no `gh-pages`; `typedoc.json:3` out `docs`; Docs badge → `https://sofa-buffers.github.io/corelib-ts/` | Uses action versions newer than the spec examples; compatible. |

---

## Remediation Plan

Ordered by severity. Code is not changed by this audit; each subsection is the plan a
follow-up PR should execute.

### 1. (GAP) Accept zero-count arrays on encode and decode (§4.7–4.8)

**Problem.** §4.7 makes `element_count` range `0..2,147,483,647`; a zero-count
unsigned/signed array is `[ header ][ count=0 ]` with nothing after, and §4.8 makes a
zero-count fixlen array `[ header ][ count=0 ]` with **no `fixlen_word` and no payload**.
Today:

- Encoder `arrayHead` throws on `count < 1` (`src/encode/ostream.ts:304-310`), so all four
  array writers reject an empty array. `writeFp32Array`/`writeFp64Array` also write the
  `fixlen_word` unconditionally (`ostream.ts:234,249`), which would be wrong for count 0.
- Streaming decoder throws on `count < 1` (`src/decode/state.ts:174`); for fixlen arrays it
  transitions to `S.ArrayElemLen` to read the element-length word (`state.ts:177-180`),
  which a count-0 array does not carry.
- Fast decoder throws on `count < 1` (`src/decode/fast.ts:186`, `arrayCount()` 183-188) and
  unconditionally reads the element-length word for fixlen arrays (`fast.ts:140`).

**Fix.**
- Encoder: change the guard to `count < 0 || count > ARRAY_MAX`
  (`ostream.ts:304-310`). In `writeFp32Array`/`writeFp64Array`, **skip the `fixlen_word`
  when `values.length === 0`** (`ostream.ts:232-259`) so the wire is exactly
  `[ header ][ 0 ]`.
- Streaming decoder (`state.ts:169-186`): allow `count === 0`; when zero, emit
  `arrayBegin(id, kind, 0)` then `arrayEnd(id)` and return to `S.Header` **without**
  reading any element-length word or elements — for both integer and fixlen kinds (the
  fixlen kind is then unknown, which is acceptable for an empty array; report the wire
  kind from the header, e.g. a fixlen-array marker, per the visitor contract).
- Fast decoder (`fast.ts:138-163,183-188`): allow `count === 0`; for fixlen arrays, when
  count is 0 do **not** read the element-length word — emit `arrayBegin`/`arrayEnd` and
  continue.

**Files.** `src/encode/ostream.ts`, `src/decode/state.ts`, `src/decode/fast.ts`, plus
tests (see item 3 below).

**Acceptance criteria.**
- `writeUnsignedArray(id, [])` → `03 00`; `writeSignedArray(id, [])` → `04 00`;
  `writeFp32Array(id, [])`/`writeFp64Array(id, [])` → `05 00` (no `fixlen_word`).
- `decode()` and `IStream.feed()` accept `03 00`, `04 00`, `05 00`, delivering an empty
  array (`arrayBegin` count 0 then `arrayEnd`, no element callbacks).
- Round-trip of each empty array kind is byte-identical; existing non-empty vectors/tests
  still pass.

### 2. (GAP) Enforce `MAX_DEPTH = 255` on encode and decode (§4.9, §6.2)

**Problem.** 255 is the normative maximum nested-sequence depth. There is no `MAX_DEPTH`
constant, the encoder's `depth` counter (`src/encode/ostream.ts:62,266`) has no ceiling,
and both decoders grow an unbounded `Visitor[]` stack (`src/decode/state.ts:285`,
`src/decode/fast.ts:168`) with no depth check. A deeply nested (or malicious) message is
silently accepted — an unbounded-recursion / resource exposure on decode.

**Fix.**
- Add `export const MAX_DEPTH = 255;` to `src/constants.ts` and re-export from
  `src/index.ts`.
- Encoder: in `writeSequenceBegin` (`ostream.ts:264`), throw `argumentError`/`usageError`
  when opening a 256th nested sequence.
- Streaming decoder: in `dispatch` `SequenceStart` (`state.ts:283-288`), throw
  `invalidMsgError` before pushing past depth 255.
- Fast decoder: same check at `fast.ts:165-170`.

**Files.** `src/constants.ts`, `src/index.ts`, `src/encode/ostream.ts`,
`src/decode/state.ts`, `src/decode/fast.ts`, tests.

**Acceptance criteria.** Encoding a 256th nested `sequenceBegin` throws `SofabError`; both
decoders reject a message nesting 256 deep with `InvalidMsg`; exactly 255 deep still
decodes; `MAX_DEPTH` exported and equals 255.

### 3. (PARTIAL) Refresh the test suite for the new empty-collection rules (§7)

**Problem.** The suite encodes the pre-revision rule: `test/errors.test.ts:43-46`
asserts a valid zero-count array (`03 00`) is `InvalidMsg`, and `test/errors.test.ts:102-104`
asserts `writeUnsignedArray(1, [])` is `Argument`. The shared `assets/test_vectors.json`
(67 vectors) has no zero-count integer/fixlen array vector, and there is no >255-depth
malformed test.

**Fix.**
- Remove/replace the two tests above with positive tests: encoding `[]` for each array
  kind yields `03 00`/`04 00`/`05 00`, and decoding those yields an empty array.
- Re-copy `assets/test_vectors.json` from `corelib-c-cpp` once it emits zero-count
  integer and fixlen array vectors (the C generator is the source of truth, §7/§8), and
  ensure `test/vectors.test.ts` exercises them for encode + decode + chunked.
- Add a >255-depth malformed test (`InvalidMsg`) once item 2 lands.

**Files.** `test/errors.test.ts`, `test/vectors.test.ts`, `assets/test_vectors.json`.

**Acceptance criteria.** Tests assert zero-count arrays are valid (not errors); refreshed
vectors covering count-0 arrays pass encode + decode + chunked; suite stays green.

### 4. (PARTIAL) Bring the devcontainer to §11 conformance

**Problem.** (a) `devcontainer.json` never loads `.devcontainer/.env` — §11.2 mandates
`runArgs` containing `"--env-file", "${localWorkspaceFolder}/.devcontainer/.env"`; (b) the
running container is `sofa-ts-dev` (`start.sh:17`, `attach.sh:4`) but §11.3 fixes it to
`ts-devcontainer`; (c) `.env.example` omits the mandated `GH_TOKEN` (and per-variable
scope comments) for the `gh` CLI (§11.1); (d) `start.sh` bind-mounts `.claude-config`
instead of a named `claude-config` volume (§11.1).

**Fix.** Add the `runArgs` `--env-file`; rename container to `ts-devcontainer` in
`start.sh`/`attach.sh` (image tag in `build.sh` already correct); add `GH_TOKEN=` with a
scope comment to `.env.example`; switch the Claude-config mount to a named volume
(`-v claude-config:/root/.claude`).

**Files.** `.devcontainer/devcontainer.json`, `.devcontainer/start.sh`,
`.devcontainer/attach.sh`, `.devcontainer/.env.example`.

**Acceptance criteria.** Opening in VS Code Dev Containers loads `.devcontainer/.env`;
`build.sh`/`start.sh`/`attach.sh` all use `ts-devcontainer`; `.env.example` lists
`GH_TOKEN`; `.env` stays gitignored.

### 5. (PARTIAL) Add `fail-fast: false` to the CI matrix (§12.1)

**Problem.** The `build-test` job defines a Node `[18,20,24]` matrix
(`.github/workflows/ci.yml:15-17`) but omits `fail-fast`, so it defaults to `true` and one
Node failure cancels the others.

**Fix.** Add `fail-fast: false` under `strategy:` in the `build-test` job.

**Files.** `.github/workflows/ci.yml`.

**Acceptance criteria.** All matrix legs run to completion and report independently.

### 6. (PARTIAL) Surface the `sofab` namespace and align the package name (§6)

**Problem.** §6 fixes the namespace `sofab` and the registry package name `SofaBuffers`.
The library exports symbols flat (`src/index.ts:27-54`) with no `sofab` alias, and the npm
name is `@sofabuffers/corelib` (`package.json:2`).

**Fix.** Document/provide the `sofab` idiom (e.g. `import * as sofab from "..."`, and
optionally an aggregate `sofab` export); reconcile the package name with §6 (register/alias
`SofaBuffers`, or record the scoped-name deviation explicitly).

**Files.** `src/index.ts`, `package.json`, `README.md`.

**Acceptance criteria.** A documented `sofab`-namespaced import path exists; the
registered/installed name matches §6 (or the deviation is explicitly justified).

### 7. (Minor / advisory) Add `BENCH_SPEC.md`

**Problem.** §10 names `BENCH_SPEC.md` as the single source of truth for the
cross-language benchmark workloads/timing/output. The `perf`/`bench` tools run, but the
repo has no `BENCH_SPEC.md`, so comparability can't be verified from this repo alone.

**Fix.** Add `BENCH_SPEC.md` (or link the canonical one) and confirm `bench/*.ts` follow it.

**Files.** `BENCH_SPEC.md` (new), `bench/*.ts` (verify only).

**Acceptance criteria.** `perf`/`bench` output and workloads match the documented spec.
