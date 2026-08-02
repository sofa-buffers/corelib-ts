/**
 * Shared bench plumbing: process-CPU timing and a checksum visitor.
 *
 * Throughput is measured against **process CPU time** (not wall-clock), the
 * Node equivalent of the C tool's `clock()`, so the numbers line up with the
 * C / C++ / Rust / C# / Java / Python benches. MB = 1e6 bytes throughout.
 */

import type { Visitor } from "../src/index.js";

export const MIN_SECONDS = 1.0;
export const WARMUP = 200_000;
export const BATCH_SECONDS = 0.01; // clock cost lands under ~0.01% of a batch

/** Process CPU time in seconds (user + system), not wall-clock. */
export function cpuNow(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
}

/**
 * Grow a batch until it spans {@link BATCH_SECONDS}, so the clock read that
 * ends it is a rounding error against the work it timed. `cpuNow()` costs
 * about a microsecond per call — sampling it once per operation would make
 * cheap workloads measure mostly the timer. Doubles as extra warmup.
 */
export function calibrateBatch(body: () => void): number {
  for (let batch = 1; ; batch *= 2) {
    const t0 = cpuNow();
    for (let k = 0; k < batch; k++) body();
    if (cpuNow() - t0 >= BATCH_SECONDS) return batch;
  }
}

/** A decode sink that folds every value into a checksum so nothing is elided. */
export class Checksum implements Visitor {
  acc = 0n;
  unsigned(id: number, v: number | bigint): void {
    this.acc += (typeof v === "bigint" ? v : BigInt(v)) ^ BigInt(id);
  }
  signed(id: number, v: number | bigint): void {
    this.acc += (typeof v === "bigint" ? v : BigInt(v)) ^ BigInt(id);
  }
  fp32(_id: number, v: number): void {
    this.acc += BigInt(Math.round(v));
  }
  fp64(_id: number, v: number): void {
    this.acc += BigInt(Math.trunc(v));
  }
  string(_id: number, _total: number, _offset: number, chunk: Uint8Array): void {
    this.acc += BigInt(chunk.length);
  }
  blob(_id: number, _total: number, _offset: number, chunk: Uint8Array): void {
    this.acc += BigInt(chunk.length);
  }
  arrayUnsigned(_id: number, _i: number, v: number | bigint): void {
    this.acc += typeof v === "bigint" ? v : BigInt(v);
  }
  arraySigned(_id: number, _i: number, v: number | bigint): void {
    this.acc += typeof v === "bigint" ? v : BigInt(v);
  }
  arrayFp32(_id: number, _i: number, v: number): void {
    this.acc += BigInt(Math.round(v));
  }
  arrayFp64(_id: number, _i: number, v: number): void {
    this.acc += BigInt(Math.trunc(v));
  }
}

let blackhole = 0n;
/** Consume an accumulator so the JIT cannot elide the measured work. */
export function sink(value: bigint): void {
  blackhole ^= value;
}
/** Read once at process exit so `blackhole` is observably live. */
export function blackholeValue(): bigint {
  return blackhole;
}
