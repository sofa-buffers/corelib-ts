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

/** Process CPU time in seconds (user + system), not wall-clock. */
export function cpuNow(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
}

/** A decode sink that folds every value into a checksum so nothing is elided. */
export class Checksum implements Visitor {
  acc = 0n;
  unsigned(id: number, v: bigint): void {
    this.acc += v ^ BigInt(id);
  }
  signed(id: number, v: bigint): void {
    this.acc += v ^ BigInt(id);
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
  arrayUnsigned(_id: number, _i: number, v: bigint): void {
    this.acc += v;
  }
  arraySigned(_id: number, _i: number, v: bigint): void {
    this.acc += v;
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
