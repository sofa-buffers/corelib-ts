/**
 * SofaBuffers TypeScript — per-operation cost benchmark.
 *
 * The `perf` tool of BENCH_SPEC, mirroring `bench/c/perf.c`, `benches/perf.rs`,
 * C#'s `Perf` and Java's `Perf`: it encodes and decodes the identical 12-field,
 * **170-byte** `perf` message (same field ids, types and values on every port —
 * a different `message size` here means the encoding has diverged) and prints
 * the same five lines per direction. Two metrics per workload:
 *
 *   1. cycles/op — code cost off a hardware cycle counter. JavaScript VMs expose
 *      no portable cycle counter, so — like the .NET and JVM tools — this is
 *      reported as unavailable and CPU time/op is the clock-independent proxy.
 *      (For a fully hardware-independent figure, `bench/run_callgrind.sh` counts
 *      instructions/op under Valgrind.)
 *   2. throughput MB/s + CPU time/op — a speedtest for this machine, from
 *      process CPU time (not wall-clock). MB = 1e6 bytes.
 *
 * Both directions run the **stream API** — the encoder over a caller-supplied
 * buffer and the resumable {@link IStream} — which is what the label says and
 * what the other ports' `perf` drives. `bench`'s whole-message decode rows use
 * the contiguous `decode()` fast path instead; the two are different questions,
 * and the gap between them is this port's cost of resumability.
 *
 * ```
 * npm run perf                 # the measuring run
 * tsx bench/perf.ts --smoke    # one op per direction: liveness, not a measurement
 * ```
 */

import { IStream, OStream } from "../src/index.js";
import { blackholeValue, measure, setSmoke, sink } from "./common.js";
import { Checksum, PERF_ENCODED_SIZE, encodePerf, encodeToBytes } from "./workloads.js";

interface Result {
  iterations: number;
  nsOp: number;
  mbs: number;
}

function run(bytes: number, body: () => void): Result {
  const { iterations, seconds } = measure(body);
  return {
    iterations,
    nsOp: (seconds / iterations) * 1e9,
    mbs: (bytes * iterations) / seconds / 1e6,
  };
}

function report(what: string, r: Result, bytes: number): void {
  console.log(`\n--- perf: ${what} ---`);
  console.log(`  iterations    : ${r.iterations}`);
  console.log(`  message size  : ${bytes} bytes`);
  console.log("  cycles/op     : (cycle counter unavailable on this VM)");
  console.log(`  CPU time/op   : ${r.nsOp.toFixed(1)} ns  (process CPU time, not wall-clock)`);
  console.log(`  throughput    : ${r.mbs.toFixed(1)} MB/s  (speedtest, MB = 1e6 bytes)`);
}

function main(): void {
  const smoke = process.argv.includes("--smoke");
  setSmoke(smoke);

  const wire = encodeToBytes(encodePerf);
  const size = wire.length;
  if (size !== PERF_ENCODED_SIZE) {
    throw new Error(`perf message is ${size} bytes, expected ${PERF_ENCODED_SIZE}`);
  }

  // One caller-supplied buffer for the whole loop (CORELIB_PLAN §5.1), rewound
  // per op: the row is the encoder's cost, not the allocator's.
  const os = new OStream(new Uint8Array(1024));
  const enc = run(size, () => {
    os.reset();
    encodePerf(os);
    sink(os.bytesUsed);
  });
  const dec = run(size, () => {
    const c = new Checksum();
    new IStream().feed(wire, c);
    sink(c.acc);
  });

  console.log("=== SofaBuffers TypeScript per-op cost (cycles/op + throughput MB/s) ===");
  report("serialize (stream API)", enc, size);
  report("deserialize (stream API)", dec, size);
  console.log("\ncycles/op tracks code cost; MB/s is this machine's throughput.");
  if (smoke) {
    console.log("--smoke: one op per direction. Liveness check, NOT a measurement.");
  }

  if (blackholeValue() === 42) console.error("");
}

main();
