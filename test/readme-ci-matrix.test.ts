/**
 * The README's Node-version prose, checked against the files that decide it —
 * `.github/workflows/ci.yml` and `package.json` — rather than against itself
 * (CORELIB_PLAN §9: "every fact, command, version number, dependency, feature
 * flag, and API name the README states must match the code as it stands
 * today").
 *
 * Two numbers in the README are load-bearing for anyone sizing their runtime
 * support against this package:
 *
 *   * the **minimum** Node line ("Node.js 20+"), which must be the floor
 *     `package.json`'s `engines.node` actually promises; and
 *   * the **tested** matrix ("CI runs …"), which must be the `build-test`
 *     job's `node-version` list. A README that under-reads the matrix tells a
 *     reader a supported line is untested (corelib-ts#119).
 *
 * These drift on exactly the events that make them wrong — adding or dropping
 * a Node line in CI, or raising the `engines` floor — and nothing else in the
 * suite reads the workflow, so this test is the only thing standing between a
 * matrix change and a stale README.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const README = read("../README.md");
const CI_YML = read("../.github/workflows/ci.yml");
const PKG = JSON.parse(read("../package.json")) as {
  engines: { node: string };
};

/**
 * The `node-version` matrix of a named job in `ci.yml`, as a list of major
 * versions. Sliced to the job's own block so the `smoke-node` matrix (the
 * boundaries only) cannot be mistaken for `build-test`'s (every line).
 */
function ciMatrix(job: string): number[] {
  const start = CI_YML.indexOf(`\n  ${job}:\n`);
  expect(start, `ci.yml must define a job named ${job}`).toBeGreaterThanOrEqual(0);
  const rest = CI_YML.slice(start + 1);
  const end = rest.search(/\n {2}[A-Za-z][\w-]*:\n/);
  const block = end < 0 ? rest : rest.slice(0, end);
  const m = block.match(/node-version:\s*\[([^\]]*)\]/);
  expect(m, `job ${job} must declare a node-version matrix`).not.toBeNull();
  return m![1]!
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

/** Every "20 / 22 / 24 / 26"-shaped list the README states as the CI matrix. */
function documentedMatrices(): number[][] {
  const found = [...README.matchAll(/CI (?:runs|type-checks[^.]*?on Node) ((?:\d+)(?:\s*\/\s*\d+)*)/g)]
    .map((m) => m[1]!.split("/").map((s) => Number(s.trim())));
  expect(
    found.length,
    "README must state the CI Node matrix (a `CI runs …` / `CI type-checks … on Node …` list)",
  ).toBeGreaterThanOrEqual(2);
  return found;
}

/** The minimum Node line the README's "Requirements" section promises. */
function documentedMinimum(): number {
  const m = README.match(/Node\.js (\d+)\+/);
  expect(m, "README must state a minimum Node version as `Node.js N+`").not.toBeNull();
  return Number(m![1]);
}

describe("README Node matrix matches .github/workflows/ci.yml", () => {
  it("states the full build-test matrix, not a subset", () => {
    const actual = ciMatrix("build-test");
    expect(actual.length).toBeGreaterThan(0);
    for (const listed of documentedMatrices()) {
      expect(listed, "README's CI Node list must match ci.yml's build-test matrix")
        .toEqual(actual);
    }
  });

  it("keeps every mention of the matrix in agreement", () => {
    const listed = documentedMatrices();
    for (const other of listed.slice(1)) expect(other).toEqual(listed[0]);
  });
});

describe("README minimum Node version matches package.json engines", () => {
  it("states the floor `engines.node` promises", () => {
    const m = PKG.engines.node.match(/>=\s*(\d+)/);
    expect(m, "package.json engines.node must be a `>=N` range").not.toBeNull();
    expect(documentedMinimum()).toBe(Number(m![1]));
  });

  it("is a line CI actually tests", () => {
    expect(ciMatrix("build-test")).toContain(documentedMinimum());
  });
});
