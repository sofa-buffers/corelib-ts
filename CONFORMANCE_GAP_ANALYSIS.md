# SofaBuffers `corelib-ts` — Conformance Gap Analysis & Remediation Plan

Audit of the TypeScript core-library port (`@sofabuffers/corelib`, repo `corelib-ts`)
against the language-independent specification `CORELIB_PLAN.md`, with primary focus on
the **§13 Conformance Checklist**. Every item below was verified by reading the source,
not inferred from names. Line references are to files in this repository.

> Scope note: this document is the only file added by this audit. No existing file was
> modified. Tests were not executed in this environment (dev dependencies are not
> installed); test coverage is assessed by reading the suites and the wire logic they
> exercise.

## Summary

| Status | Count |
|--------|-------|
| PASS    | 14 |
| PARTIAL | 3  |
| GAP     | 1  |
| **Total** | **18** |

Headline findings:

- **GAP — `MAX_DEPTH` (255) is not implemented anywhere.** No constant, and neither the
  encoder nor either decoder rejects nesting beyond 255. This is a normative wire/safety
  requirement (§4.9, §6.2) and an unbounded-recursion exposure on the decode side.
- **PARTIAL — devcontainer.** `devcontainer.json` never loads `.devcontainer/.env`
  (§11.2 mandatory `--env-file` in `runArgs` is missing), the running container is named
  `sofa-ts-dev` instead of `ts-devcontainer` (§11.3), and `.env.example` omits the
  mandated `GH_TOKEN` (with required-scope comments).
- **PARTIAL — CI matrix** is missing `fail-fast: false` (§12.1).
- **PARTIAL — namespace / package name.** No `sofab` namespace is surfaced and the npm
  package is registered as `@sofabuffers/corelib`, not `SofaBuffers` (§6).

---

## Per-checklist-item results

| # | Checklist item (§13) | Status | Evidence | Notes |
|---|----------------------|--------|----------|-------|
| 1 | All public symbols under the `sofab` namespace (§6) | PARTIAL | `src/index.ts:27-54` flat named exports; package name `@sofabuffers/corelib` in `package.json:2`; README install `@sofabuffers/corelib` (`README.md:44`) | TS uses flat module exports (an allowed "module" equivalent), but no `sofab` namespace alias is exported and the registry name is not `SofaBuffers` as §6 fixes it. |
| 2 | API version constant/getter returns `1` (§6) | PASS | `src/constants.ts:14` `API_VERSION = 1`; re-exported `src/index.ts:28` | Exposed and documented. |
| 3 | Varint & zig-zag match §4.1–4.2 | PASS | `src/varint/leb128.ts` (encode/decode, 10-byte overflow guard `leb128.ts:105`); `src/varint/zigzag.ts` 64-bit transform; streaming `src/decode/state.ts:324-351`; fast `src/decode/fast.ts:258-320` | Overlong/overflow varints rejected with `INVALID_MSG`. |
| 4 | Field header `(id<<3)\|type` + all 8 wire types (§4.3) | PASS | `src/encode/ostream.ts:291-297` `header()`; `src/constants.ts:17-34` 8 `WireType`s; dispatch `src/decode/state.ts:258-292`, `src/decode/fast.ts:82-174` | Sequence-end is single byte `0x07` (`ostream.ts:273`). |
| 5 | Fixlen word `(length<<3)\|subtype`, LE floats, UTF-8 no terminator, blobs (§4.6) | PASS | `src/encode/ostream.ts:299-302` `fixlenHead()`; LE pack `src/varint/num64.ts:34-48`; `src/encode/fixlen.ts:12-14` UTF-8 (no terminator); blob `ostream.ts:184` | Float round-trip is bit-exact (DataView LE); subtype range checked on decode `state.ts:124`. |
| 6 | Integer arrays + fixlen arrays w/ single shared word; no dynamic subtypes in fixlen arrays (§4.7–4.8) | PASS | `src/encode/ostream.ts:200-259` array writers; single fixlen word `ostream.ts:234,249`; decode rejects non-fp element types `state.ts:208-222`, `fast.ts:138-146` | Encoder exposes only fp32/fp64 array writers, so string/blob in a fixlen array is structurally impossible. |
| 7 | Sequence framing, fresh scope, `0x07` end, skip-by-walking w/ depth, reject nesting > `MAX_DEPTH`=255 (§4.9) | **GAP** | Framing/scope/skip OK (`state.ts:283-299`, `fast.ts:71-77,165-170`). **No `MAX_DEPTH` constant** in `src/constants.ts`; encoder only tracks `depth` (`ostream.ts:62,266`) with no upper bound; decoders push onto an unbounded `Visitor[]` stack with no depth check | A message nesting > 255 is silently accepted; decode-side it is an unbounded-recursion / resource exposure. Fails the normative §4.9/§6.2 limit. |
| 8 | Streaming encode into smaller buffer via flush + mid-stream buffer swap (§5.1) | PASS | `src/encode/ostream.ts:104-126` `flush()`/`setBuffer()`; auto-flush on fill `ostream.ts:324-353`; `test/ostream.test.ts` | `offset` reserve supported (`ostream.ts:69,119`). |
| 9 | Streaming decode via `feed` of tiny chunks, push/pull, lazy binding, auto-skip (§5.2) | PASS | `src/decode/istream.ts` + resumable machine `src/decode/state.ts` (≤1 varint buffered); `test/istream.chunked.test.ts` (one-byte-at-a-time) | Visitor methods optional ⇒ unhandled fields auto-skipped (`istream.ts:30-67`). |
| 10 | Error reporting per §6.3 baseline (or idiomatic exceptions) | PASS | `src/errors.ts:10-19` `SofabErrorCode` = `Argument`/`Usage`/`BufferFull`/`InvalidMsg` (maps InvalidArgument/UsageError/BufferFull/InvalidMessage) | Throws `SofabError` (idiomatic for TS). Minor: invalid UTF-8 in strings is not validated (raw, zero-copy bytes handed to the visitor); acceptable for a borrowed-view port but worth noting vs. §6.3's "invalid UTF-8". |
| 11 | Streaming primitives suffice for a thin generated-object layer; one-shot helpers are thin wrappers (§6.1) | PASS | Visitor w/ child-returning `sequenceBegin` (`istream.ts:59-67`); one-shot `decode()` (`istream.ts:106-108`); in-memory `OStream` + `bytes()` | Note: `decode()` is a distinct contiguous fast path (`src/decode/fast.ts`), not literally a wrapper over `IStream`; both are vector-validated, so the generated layer can be built from the streaming primitives. No generated layer ships here (not required of corelib). |
| 12 | All shared vectors pass encode+decode, + chunked/roundtrip/malformed/skip (§7) | PASS | `test/vectors.test.ts` (encode + decode-transcode), `test/istream.chunked.test.ts`, `test/roundtrip.test.ts`, `test/errors.test.ts`, `test/skip.test.ts`, `test/skip-ids.test.ts`; `assets/test_vectors.json` 67 vectors across all groups | Not executed here, but the suites cover every required kind; no malformed test exercises a >255-depth message (ties to item 7). |
| 13 | `assets/` populated per §8 | PASS | `assets/sofabuffers_logo.png`, `assets/sofabuffers_icon.png`, `assets/test_vectors.json` (header: "generated from the C encoder") | Branding + C-sourced vectors present. |
| 14 | README family format, badges, required sections (§9) | PASS | `README.md:1-8` header/tagline/org link; badges CI+Coverage+Branches+Docs `README.md:12-15`; "Why this design" table, Usage (basic + streaming), API summary, Feature flags, Build & test, Benchmarks | Dependency-free; states Node 18+. All §9 sections present. |
| 15 | `perf` + `bench` tools present & runnable (§10) | PASS | `bench/perf.ts`, `bench/bench.ts`, `bench/common.ts`, `bench/run_callgrind.sh`; scripts `package.json:61-63` | `perf` reports cycles/op unavailable on a VM and uses CPU-time/op + callgrind instructions/op (allowed for managed runtimes). Note: no `BENCH_SPEC.md` in-repo (§10 names it the cross-language SoT), so workload comparability can't be verified against it. |
| 16 | `.devcontainer/` complete; extensions incl. `anthropic.claude-code`; `.env` gitignored (§11) | PARTIAL | All files present (`Dockerfile`, `build.sh`, `start.sh`, `attach.sh`, `devcontainer.json`, `.env.example`); extension list `devcontainer.json:14-19` incl. `anthropic.claude-code`; `.env` gitignored via `.devcontainer/.gitignore:6` (verified `git ls-files` tracks only `.env.example`) | Deviations: (a) `devcontainer.json` has no `runArgs` `--env-file ${localWorkspaceFolder}/.devcontainer/.env` (§11.2 mandatory); (b) running container is `sofa-ts-dev` (`start.sh:17`, `attach.sh:4`) not `ts-devcontainer` (§11.3; image tag is correct in `build.sh:6`); (c) `.env.example` lacks `GH_TOKEN` and required-scope comments (§11.1); (d) `start.sh` bind-mounts `.claude-config` rather than a named `claude-config` volume (§11.1). |
| 17 | `ci.yml` builds+tests on push & PR; version matrix; coverage uploaded + badge (§12.1) | PARTIAL | `.github/workflows/ci.yml:4-7` push+PR; matrix `node: [18,20,24]` (`ci.yml:15-17`); coverage job + badge JSON to `badges` branch (`ci.yml:75-119`); badges in README | Missing `strategy.fail-fast: false` (§12.1 requires it when a matrix is used). Coverage is published to a self-hosted `badges` branch rather than Codecov — acceptable as an "equivalent". Single build config (no explicit debug+release) — reasonable for TS. |
| 18 | `docs.yml` builds HTML & deploys to Pages via Actions (no `gh-pages`); Docs badge links to site (§12.2) | PASS | `.github/workflows/docs.yml` TypeDoc, `permissions: pages/id-token write`, `upload-pages-artifact` + `deploy-pages`, no `gh-pages`; `typedoc.json:3` out `docs`; Docs badge → `https://sofa-buffers.github.io/corelib-ts/` (`README.md:15`) | Uses action versions newer than the spec examples (v5/v6); compatible. |

---

## Remediation Plan

Ordered by severity. Code is not changed by this audit; each subsection is the plan a
follow-up PR should execute.

### 1. (GAP) Enforce `MAX_DEPTH = 255` on encode and decode

**Problem.** §4.9 and §6.2 make 255 the normative maximum nested-sequence depth: an
encoder must not open a 256th nested sequence, and a decoder must reject a message that
nests deeper with `InvalidMessage` rather than risk unbounded recursion/stack growth.
Today there is no `MAX_DEPTH` constant, the encoder's `depth` counter (`src/encode/ostream.ts:62,266`)
has no ceiling, and both decoders grow an unbounded `Visitor[]` stack
(`src/decode/state.ts:286`, `src/decode/fast.ts:168`) with no depth check. A deeply nested
(or maliciously crafted) message is silently accepted.

**Fix.**
- Add `export const MAX_DEPTH = 255;` to `src/constants.ts` and re-export it from
  `src/index.ts` (it is a normative §6.2 constant and the other constants are already public).
- Encoder: in `writeSequenceBegin` (`src/encode/ostream.ts:264`), throw an
  `argumentError`/`usageError` when incrementing `depth` would exceed `MAX_DEPTH`.
- Streaming decoder: in `DecoderState.dispatch` `SequenceStart` (`src/decode/state.ts:283-288`),
  throw `invalidMsgError` when the stack already holds `MAX_DEPTH` nested sequences
  (i.e. before pushing the 256th). Track sequence depth explicitly (the stack can also
  grow from `sequenceBegin` returning the same visitor, so count sequence frames, not
  array length, if those can differ).
- Fast decoder: same check in `src/decode/fast.ts:165-170`.

**Files.** `src/constants.ts`, `src/index.ts`, `src/encode/ostream.ts`,
`src/decode/state.ts`, `src/decode/fast.ts`, and tests in `test/errors.test.ts`
(add a >255-depth message → `INVALID_MSG`) plus an encoder rejection test.

**Acceptance criteria.**
- Encoding a 256th nested `sequenceBegin` throws a `SofabError`.
- Both `decode()` and `IStream.feed()` reject a message nesting 256 deep with
  `SofabErrorCode.InvalidMsg`; a message nesting exactly 255 deep still decodes.
- `MAX_DEPTH` is exported and equals 255; existing vectors and tests still pass.

### 2. (PARTIAL) Bring the devcontainer to §11 conformance

**Problem.** Four §11 deviations: (a) `devcontainer.json` never loads
`.devcontainer/.env` — §11.2 mandates `runArgs` containing
`"--env-file", "${localWorkspaceFolder}/.devcontainer/.env"`; (b) the running container
name is `sofa-ts-dev` (`start.sh:17`, `attach.sh:4`) but §11.3 fixes it to
`ts-devcontainer`; (c) `.env.example` omits the mandated `GH_TOKEN` (and per-variable
required-scope comments) for the `gh` CLI (§11.1); (d) `start.sh` bind-mounts
`.claude-config` instead of a named `claude-config` volume (§11.1).

**Fix.**
- Add `"runArgs": ["--env-file", "${localWorkspaceFolder}/.devcontainer/.env"]` to
  `.devcontainer/devcontainer.json`. (Document in `README`/`.env.example` that `.env`
  must exist first, per §11.2's note.)
- Rename the running container to `ts-devcontainer` in `start.sh` (`--name ts-devcontainer`)
  and `attach.sh` (`docker exec -it ts-devcontainer bash`); the image tag in `build.sh`
  is already correct.
- Add `GH_TOKEN=` to `.devcontainer/.env.example` with a comment describing purpose and
  required scopes (e.g. `repo`, `read:org`); add explanatory comments to each variable.
- Switch the Claude-config mount in `start.sh` to a named volume
  (e.g. `-v claude-config:/root/.claude`).

**Files.** `.devcontainer/devcontainer.json`, `.devcontainer/start.sh`,
`.devcontainer/attach.sh`, `.devcontainer/.env.example`.

**Acceptance criteria.**
- Opening the folder in VS Code Dev Containers loads `.devcontainer/.env` via `runArgs`.
- `build.sh` → image `ts-devcontainer`; `start.sh` → container `ts-devcontainer`;
  `attach.sh` attaches to `ts-devcontainer`.
- `.env.example` lists `GH_TOKEN` with a scope comment; `.devcontainer/.env` remains
  gitignored and untracked.

### 3. (PARTIAL) Add `fail-fast: false` to the CI matrix

**Problem.** §12.1: "When a matrix is used, set `fail-fast: false` so a failure on one
leg does not cancel the remaining legs." The `build-test` job's `strategy`
(`.github/workflows/ci.yml:15-17`) defines a Node `[18,20,24]` matrix but omits
`fail-fast`, so it defaults to `true` and a single Node failure cancels the others.

**Fix.** Add `fail-fast: false` under `strategy:` in the `build-test` job. Optionally
add the equivalent build-config breadth (debug/release) if desired, though a single TS
build is reasonable.

**Files.** `.github/workflows/ci.yml`.

**Acceptance criteria.** All matrix legs run to completion and report independently even
when one fails.

### 4. (PARTIAL) Surface the `sofab` namespace and align the package name

**Problem.** §6 fixes the namespace name as `sofab` and the registry package name as
`SofaBuffers`. The library exports symbols flat (`src/index.ts:27-54`) with no `sofab`
namespace alias, and the npm name is `@sofabuffers/corelib` (`package.json:2`), so users
neither install `SofaBuffers` nor `import ... as sofab` against a documented convention.

**Fix (choose per registry constraints).**
- Document and/or provide the `sofab` namespace idiom: e.g. add a usage note
  (`import * as sofab from "@sofabuffers/corelib"`) and, if desired, export a `sofab`
  namespace object aggregating the public API so `sofab.OStream` etc. work.
- Reconcile the package name with §6: either register/alias the package as `SofaBuffers`
  (subject to npm availability — a scope like `@sofabuffers/corelib` may be the practical
  realisation), or, if the scoped name is intentional, record the deviation explicitly so
  the family stays consistent.

**Files.** `src/index.ts` (optional `sofab` aggregate export), `package.json` (name),
`README.md` (install + import guidance).

**Acceptance criteria.** A documented `sofab`-namespaced import path exists, and the
registered/installed name matches the §6 expectation (or the deviation is explicitly
justified and consistent with sibling ports).

### 5. (Minor / advisory) Add `BENCH_SPEC.md`

**Problem.** §10 names `BENCH_SPEC.md` as the single source of truth for the
cross-language benchmark workloads, timing, and output grammar. The `perf`/`bench` tools
exist and run, but the repo has no `BENCH_SPEC.md`, so their workloads cannot be verified
comparable to the other ports from this repo alone. (Not a §13 checklist line on its own;
listed for completeness.)

**Fix.** Add `BENCH_SPEC.md` (or link to the canonical one) and confirm `bench/*.ts`
follow it.

**Files.** `BENCH_SPEC.md` (new), `bench/*.ts` (verify only).

**Acceptance criteria.** `perf`/`bench` output and workloads match the documented spec.
