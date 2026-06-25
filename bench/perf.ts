/**
 * SofaBuffers TypeScript — per-operation cost benchmark.
 *
 * Mirror of `bench/c/perf.c`, `benches/perf.rs`, C#'s `Perf` and Java's `Perf`:
 * encodes and decodes the identical message (same field ids, types and values)
 * and prints the same report. Two metrics per workload:
 *
 *   1. cycles/op — code cost off a hardware cycle counter. JavaScript VMs expose
 *      no portable cycle counter, so — like the .NET and JVM tools — this is
 *      reported as unavailable and CPU time/op is the clock-independent proxy.
 *      (For a fully hardware-independent figure, `bench/run_callgrind.sh` counts
 *      instructions/op under Valgrind, mirroring the Python tool.)
 *   2. throughput MB/s + CPU time/op — a speedtest for this machine, from
 *      process CPU time (not wall-clock). MB = 1e6 bytes.
 *
 * Run with: `npm run perf`
 */

import { IStream, OStream } from "../src/index.js";
import { Checksum, MIN_SECONDS, WARMUP, blackholeValue, cpuNow, sink } from "./common.js";

const PERF_STRING = "perf-benchmark-message";
const PERF_SAMPLES = [1e6, 2e6, 3e6, 4e6, 5e6, 6e6, 7e6, 8e6];
const PERF_DELTAS = [-1e5, -2e5, -3e5, -4e5, -5e5, -6e5, -7e5, -8e5];
const PERF_FP64 = [3.14159265, 6.2831853, 9.42477795, 12.5663706];

function perfEncode(os: OStream): void {
  os.writeUnsigned(1, 0xdead_beefn);
  os.writeSigned(2, -12345);
  os.writeUnsigned(3, 0x0123_4567_89ab_cdefn);
  os.writeSigned(4, -5_000_000_000_000);
  os.writeBoolean(5, true);
  os.writeFp32(6, 3.14159);
  os.writeFp64(7, 2.718281828459045);
  os.writeString(8, PERF_STRING);
  os.writeUnsignedArray(9, PERF_SAMPLES);
  os.writeSignedArray(10, PERF_DELTAS);
  os.writeFp64Array(11, PERF_FP64);
  os.writeSequenceBegin(12);
  os.writeUnsigned(1, 99);
  os.writeSigned(2, -7);
  os.writeSequenceEnd();
}

interface Result {
  iterations: number;
  nsOp: number;
  mbs: number;
}

function measure(bytes: number, body: () => void): Result {
  for (let i = 0; i < WARMUP; i++) body();
  let it = 0;
  const t0 = cpuNow();
  let el: number;
  do {
    body();
    it++;
    el = cpuNow() - t0;
  } while (el < MIN_SECONDS);
  return { iterations: it, nsOp: (el / it) * 1e9, mbs: (bytes * it) / el / 1e6 };
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
  const wire = (() => {
    const os = new OStream();
    perfEncode(os);
    return os.bytes().slice();
  })();
  const size = wire.length;

  const enc = measure(size, () => {
    const os = new OStream();
    perfEncode(os);
    sink(BigInt(os.bytesUsed));
  });
  const dec = measure(size, () => {
    const c = new Checksum();
    new IStream().feed(wire, c);
    sink(c.acc);
  });

  console.log("=== SofaBuffers TypeScript per-op cost (cycles/op + throughput MB/s) ===");
  report("serialize (stream API)", enc, size);
  report("deserialize (stream API)", dec, size);
  console.log("\ncycles/op tracks code cost; MB/s is this machine's throughput.");

  if (blackholeValue() === 42n) console.error("");
}

main();
