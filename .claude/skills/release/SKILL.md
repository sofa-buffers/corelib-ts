---
name: release
description: Cut a release of @sofa-buffers/corelib (corelib-ts) — pick the version, bump every manifest, update the CHANGELOG, merge the release PR, tag it, and publish via the GitHub Release. Use when the user asks to release, cut a version, bump the version, tag a release, or publish to npm.
---

# Release @sofa-buffers/corelib

The git tag is the **single source of truth** for the version. `release.yml`
overwrites `package.json` with the tag-derived version before publishing, so a
correct tag will publish correctly even from a stale manifest — but
`version-consistency.yml` fails the tag push if the repo disagrees with it.
Both must be right.

## What is automated vs. manual

| Step | Who |
| --- | --- |
| Bump `package.json` + `package-lock.json` | **you** |
| Update `CHANGELOG.md` | **you** |
| Release PR + merge to `main` | **you** |
| Push tag `vX.Y.Z` | **you** |
| Verify tag == `package.json` + lockfile + CHANGELOG (`version-consistency.yml`) | CI, on tag push |
| Create GitHub Release | **you** (`gh release create`) |
| typecheck → test → build → `npm publish` | CI (`release.yml`), on release *published* |
| npm auth | none needed — OIDC Trusted Publishing, no `NPM_TOKEN` |

Never run `npm publish` by hand. Publishing only happens when a GitHub Release
is **published**.

## Versioning rule

Pre-`1.0.0`: **a breaking API or wire-format change bumps the MINOR version,
never the patch.** Patch is for non-breaking fixes only. This is stated in the
CHANGELOG header and was applied for `0.10.0`.

Tags are always `vX.Y.Z` — lowercase `v`, then plain semver (`v1.2.3`,
`v0.11.0-rc.1`). See step 8.

Do **not** touch `API_VERSION` in `src/constants.ts` — that is the SofaBuffers
*spec* API version (currently `1`), unrelated to the package version. It changes
only when the spec does.

## Procedure

### 1. Preconditions

```bash
git checkout main && git pull -p
git status --short                       # must be empty
gh run list --branch main --limit 5      # CI green on the commit you are releasing
```

### 2. Pick the version

Review what landed since the last tag and apply the pre-1.0 rule above:

```bash
git describe --tags --abbrev=0
git log --oneline "$(git describe --tags --abbrev=0)"..main
```

A `!` in a commit subject, or a `BREAKING CHANGE:` footer, forces a minor bump.

### 3. Release branch

```bash
git checkout -b release/vX.Y.Z
```

### 4. Bump the manifests

```bash
npm version X.Y.Z --no-git-tag-version
```

This updates `package.json` and both version fields npm keeps in
`package-lock.json`. Verify — the release guard checks exactly these:

```bash
node -p "require('./package.json').version"
jq -r '.version, .packages."".version' package-lock.json
```

If the lockfile is somehow untouched, `npm install --package-lock-only` fixes it.

### 5. CHANGELOG.md

Normal flow: rename the `## [Unreleased]` heading to `## [X.Y.Z] - YYYY-MM-DD`
(today's date) and open a fresh empty `## [Unreleased]` above it. Format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Add the release's link reference at the bottom of the file alongside the others:

```
[X.Y.Z]: https://github.com/sofa-buffers/corelib-ts/releases/tag/vX.Y.Z
```

`version-consistency.yml` enforces this on the tag push: the file must exist,
its topmost released section must be exactly the tag's version, and the heading
must carry an ISO date. An `## [Unreleased]` heading above it is fine. The link
reference is not checked.

### 6. Commit

```bash
git commit -am "$(cat <<'EOF'
chore(release): X.Y.Z

The git tag is the source of truth for the version; this brings every package
manifest in line with the vX.Y.Z tag that follows.

<one paragraph: what changed since the last tag, and why it is a minor/patch
bump under the pre-1.0 rule>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
git push -u origin release/vX.Y.Z
```

### 7. PR and merge

```bash
gh pr create --base main --title "chore(release): X.Y.Z" --body "..."
gh pr checks <n> --watch      # all of CI must pass
gh pr merge <n> --rebase --delete-branch
```

**Rebase, not merge.** The repository allows only rebase merges
(`allow_merge_commit` and `allow_squash_merge` are both false), so `--merge`
fails with *"Merge commits are not allowed on this repository"*. Releases up to
`v0.10.0` were merge commits and predate that setting. Rebase rewrites the SHA,
so read the new commit off `main` before tagging rather than reusing the
branch's.

### 8. Tag

Tag the release commit **as it landed on `main`**, not the branch's own SHA — the rebase gave it a new one:

```bash
git checkout main && git pull -p
git tag -a vX.Y.Z -m "SofaBuffers corelib-ts X.Y.Z"
git push origin vX.Y.Z
```

The tag name is always a lowercase `v` followed by the plain semver version —
`v1.2.3`, never `1.2.3`, `V1.2.3` or `release-1.2.3`. `version-consistency.yml`
triggers only on `v*`, so a tag without the prefix silently skips the check that
the manifests match; `release.yml` strips a leading `v` but does not require one,
so nothing else would catch it either.

`v0.9.0` is annotated, the others are lightweight; either works, annotated is
preferred.

Watch that check before going further:

```bash
gh run list --workflow version-consistency.yml --limit 1
```

If it fails, the manifests disagree with the tag — fix them on `main`, delete
and re-cut the tag.

### 9. Publish the GitHub Release

This is what triggers `npm publish`.

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "<changelog section for X.Y.Z>"
```

For a prerelease tag (`vX.Y.Z-rc.1`) add `--prerelease`.

### 10. Verify

```bash
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
npm view @sofa-buffers/corelib version
npm view @sofa-buffers/corelib dist-tags
```

## Prereleases

The tag's prerelease identifier becomes the npm dist-tag: `0.11.0-rc.1` → `rc`,
so a bare `npm i` keeps getting `latest`.

- The identifier must start with a letter (`-rc.1`, `-beta.2`). Numeric ones
  (`-1`, `-0.3`) are rejected by the guard.
- **Marking a release as prerelease on GitHub while the tag is stable is a hard
  error** — it would hand `latest` to the wrong build.
- A prerelease tag with the box unticked only logs a notice and still publishes
  under its own dist-tag.

## Guards that will stop you

`release.yml`'s `guard` job fails the whole run before anything is built:

1. Tag does not parse as semver.
2. `package-lock.json` version (either field) disagrees with `package.json`.
3. That version is already on npm — versions are immutable, bump and re-cut.
4. GitHub release flagged prerelease but the tag is stable.

`version-consistency.yml` runs on the tag push and checks every place the
version is written by hand against the tag:

1. `package.json` `version`.
2. `package-lock.json` — `.version` and `.packages."".version`, plus `name` and
   `license` against `package.json`.
3. `CHANGELOG.md` — present, topmost released section == the tag, ISO-dated.

Each is its own step, so one run reports every mismatch rather than the first.
Nothing else in the repo stores the version: `typedoc.json` reads it from
`package.json` (`includeVersion`), the README pins no version, and
`API_VERSION` is the spec's.

## If it goes wrong

- **Bad tag, nothing published yet** — `git push --delete origin vX.Y.Z`,
  `git tag -d vX.Y.Z`, fix, re-tag.
- **Already on npm** — npm versions cannot be replaced. Bump to the next patch
  and release again.
- **Release published but the workflow failed** — fix the cause on `main`, then
  re-run the failed run (`gh run rerun <id>`); the release event does not need
  to be re-fired.
