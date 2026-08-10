/**
 * The bench tools' output is a machine-readable interface.
 *
 * A central harness builds every `corelib-*` port and parses the three tools'
 * stdout into the cross-language comparison tables with the regexes BENCH_SPEC
 * fixes ("Output grammar"). A row that is one space out of column, a label that
 * says `blob (1MB)` instead of `blob 1MB`, or a workload that quietly stopped
 * printing does not fail anything locally — it simply drops out of the tables,
 * which is the failure mode this test exists to prevent.
 *
 * So the tools are run for real, and their output is matched with BENCH_SPEC's
 * own regexes, copied here verbatim. `--smoke` runs one operation per row
 * instead of a ~1 s CPU-time loop: the numbers are then meaningless (and the
 * tools say so), but the rows, labels and columns are exactly the ones the
 * measuring run prints, which is what is under test here.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** BENCH_SPEC "Output grammar", verbatim. */
const HEADER_RE = /=== SofaBuffers (.+?) throughput/;
const PEROP_HEADER_RE = /=== SofaBuffers (.+?) per-op/;
const ROW_RE =
  /^(encode|decode):\s+(u64 array \(1000\)|typical message|blob 1MB one-shot|blob 1MB streaming|blob 1MB passthrough|blob 1MB|composite skip-all|composite)\s+([\d.]+)$/;

/** Every row BENCH_SPEC requires; `blob 1MB passthrough` is the optional one. */
const REQUIRED_ROWS = [
  "encode: u64 array (1000)",
  "encode: typical message",
  "encode: blob 1MB one-shot",
  "encode: blob 1MB streaming",
  "encode: composite",
  "decode: u64 array (1000)",
  "decode: typical message",
  "decode: blob 1MB",
  "decode: composite",
  "decode: composite skip-all",
];

function run(script: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", script, "--smoke"], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("bench output grammar (BENCH_SPEC)", () => {
  it("bench prints every required row, parseable and non-zero", { timeout: 120_000 }, () => {
    const out = run("bench/bench.ts");
    const label = HEADER_RE.exec(out);
    expect(label?.[1]).toBe("TypeScript");

    const rows = new Map<string, number>();
    for (const line of out.split("\n")) {
      const m = ROW_RE.exec(line);
      if (m) rows.set(`${m[1]}: ${m[2]}`, Number(m[3]));
    }
    expect([...rows.keys()]).toEqual(REQUIRED_ROWS);
    // A stub row would parse and print 0.00; every workload must do real work.
    for (const [name, v] of rows) expect(v, name).toBeGreaterThan(0);

    expect(out).toContain("MB = 1e6 bytes. ~1s CPU-time loop per workload.");
  });

  it("perf prints the five lines per direction", { timeout: 120_000 }, () => {
    const out = run("bench/perf.ts");
    expect(PEROP_HEADER_RE.exec(out)?.[1]).toBe("TypeScript");
    expect(out).toContain("perf: serialize");
    expect(out).toContain("perf: deserialize");
    // 170 bytes is BENCH_SPEC's parity check on the perf dataset.
    expect(out).toMatch(/message size {2}: 170 bytes/);
    expect(out).toMatch(/cycles\/op {5}: \(cycle counter unavailable/);
    expect(out).toMatch(/CPU time\/op {3}: [\d.]+ ns/);
    expect(out).toMatch(/throughput {4}: [\d.]+ MB\/s/);
    expect(out).toContain("cycles/op tracks code cost; MB/s is this machine's throughput.");
  });
});
