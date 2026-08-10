/**
 * SofaBuffers TypeScript — throughput benchmark (CPU time, MB/s).
 *
 * The `bench` tool of BENCH_SPEC, mirroring `bench/c/bench.c`,
 * `benches/bench.rs`, C#'s `Bench` and Dart's `bench.dart`: encode / decode
 * throughput over a ~1 s CPU-time loop per workload, printed in the fixed
 * grammar a central harness parses into the cross-language tables. The four
 * datasets are the 1000-element `u64 array`, the small `typical` message, the
 * unbounded 1 MB `blob`, and the `composite` message that reaches the paths the
 * three flat ones never touch (wrapper array, multi-byte UTF-8, depth-3 nesting,
 * an omitted default field, a two-byte field header).
 *
 * **Read the `blob 1MB` rows against each other, not against the others.** Five
 * bytes of that message are metadata and a million are payload, so its MB/s is
 * this machine's memory bandwidth rather than a statement about the corelib. The
 * signal is the *difference* between the one-shot and streaming rows — the cost
 * of the divisible-run flush path (CORELIB_PLAN §5.1) — and under MB/s that
 * difference is a low-single-digit fraction of a bandwidth-bound row. Read it as
 * Callgrind `Ir/op` (`bench/run_callgrind.sh`), where instruction counts do not
 * care about bandwidth.
 *
 * ```
 * npm run bench                      # the measuring run
 * tsx bench/bench.ts --smoke         # one op per row: liveness, not a measurement
 * tsx bench/bench.ts <workload> <n>  # n ops, no timing — the Callgrind harness
 * ```
 */

import { blackholeValue, measure, setSmoke } from "./common.js";
import { buildWorkloads, type Workload } from "./workloads.js";

/** Run `body` for ~1 s of CPU time after warmup; return MB/s for `bytes`. */
function throughput(bytes: number, body: () => void): number {
  const { iterations, seconds } = measure(body);
  return (bytes * iterations) / seconds / 1e6;
}

function main(): void {
  const args = process.argv.slice(2);
  const smoke = args.includes("--smoke");
  setSmoke(smoke);

  const workloads = buildWorkloads();

  // Callgrind mode: `bench.ts <workload> <reps>` runs one workload `reps` times
  // with no timing at all and reports its byte size on stderr.
  // run_callgrind.sh subtracts two rep counts to get instructions/op.
  const cliWorkload = args.find((a) => !a.startsWith("-"));
  if (cliWorkload !== undefined) {
    const w = workloads.find((x) => x.key === cliWorkload);
    if (w === undefined) {
      console.error(`unknown workload ${cliWorkload}; one of: ${workloads.map((x) => x.key).join(" ")}`);
      process.exitCode = 2;
      return;
    }
    const reps = Number(args[args.indexOf(cliWorkload) + 1] ?? "100000");
    for (let i = 0; i < reps; i++) w.run();
    process.stderr.write(`bytes=${w.bytes} sink=${blackholeValue()}\n`);
    return;
  }

  const row = (w: Workload): string =>
    w.label.padEnd(26) + " " + throughput(w.bytes, w.run).toFixed(2).padStart(12);

  console.log("=== SofaBuffers TypeScript throughput (CPU time, MB/s) ===");
  console.log("Workload".padEnd(26) + " " + "MB/s".padStart(12));
  console.log("--------".padEnd(26) + " " + "----".padStart(12));
  // BENCH_SPEC's table order. `encode: blob 1MB passthrough` is its one optional
  // row and is absent here: this port grants no pass-through permission, so the
  // row is omitted entirely rather than filled with a placeholder.
  for (const w of workloads) console.log(row(w));
  console.log("");
  console.log("MB = 1e6 bytes. ~1s CPU-time loop per workload.");
  console.log("blob 1MB is bandwidth-bound: read one-shot vs streaming, not either alone.");
  if (smoke) {
    console.log("--smoke: one op per row. Liveness check for the rows, NOT a measurement.");
  }

  if (blackholeValue() === 42) console.error(""); // keep the blackhole live
}

main();
