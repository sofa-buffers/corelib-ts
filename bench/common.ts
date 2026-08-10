/**
 * Shared bench plumbing: process-CPU timing.
 *
 * Throughput is measured against **process CPU time** (not wall-clock), the
 * Node equivalent of the C tool's `clock()`, so the numbers line up with the
 * C / C++ / Rust / C# / Java / Python benches. MB = 1e6 bytes throughout.
 */

const MIN_SECONDS = 1.0;
const BATCH_SECONDS = 0.01; // clock cost lands under ~0.01% of a batch
/**
 * Warmup, bounded two ways: enough operations to get V8 past its tiers, and a
 * ceiling on the CPU time spent doing it. The count alone was fine while every
 * workload was a sub-microsecond message, but `blob 1MB` copies a megabyte per
 * op — 200,000 of those is 200 GB of memcpy before a single number is measured,
 * and it warms nothing the first few dozen ops did not already warm.
 */
const WARMUP_OPS = 200_000;
const WARMUP_SECONDS = 0.25;

/** Process CPU time in seconds (user + system), not wall-clock. */
function cpuNow(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
}

/**
 * Grow a batch until it spans {@link BATCH_SECONDS}, so the clock read that
 * ends it is a rounding error against the work it timed. `cpuNow()` costs
 * about a microsecond per call — sampling it once per operation would make
 * cheap workloads measure mostly the timer. Doubles as extra warmup.
 */
function calibrateBatch(body: () => void): number {
  for (let batch = 1; ; batch *= 2) {
    const t0 = cpuNow();
    for (let k = 0; k < batch; k++) body();
    if (cpuNow() - t0 >= BATCH_SECONDS) return batch;
  }
}

/** Run `body` until it is warm: {@link WARMUP_OPS} ops, or {@link WARMUP_SECONDS}. */
function warmup(body: () => void): void {
  const t0 = cpuNow();
  for (let i = 0; i < WARMUP_OPS; i++) {
    body();
    if ((i & 15) === 15 && cpuNow() - t0 >= WARMUP_SECONDS) return;
  }
}

let smoke = false;

/**
 * Switch every later {@link measure} to a **single** operation per workload.
 *
 * The tools run every row end to end in a second or two instead of the ~12 s the
 * real loops take, which is what lets the test suite check that each workload
 * still runs and still prints BENCH_SPEC's grammar. The numbers it prints are
 * real but meaningless — one un-warmed op timed against a clock of comparable
 * cost — so a smoke run must never be pasted anywhere as a measurement, and the
 * tools say so in their output.
 */
export function setSmoke(on: boolean): void {
  smoke = on;
}

/** What {@link measure} observed: how many times `body` ran, and for how long. */
export interface Timing {
  iterations: number;
  seconds: number;
}

/**
 * Run `body` for at least {@link MIN_SECONDS} of process CPU time after warmup,
 * in calibrated batches, and report what was observed. Every tool in this
 * directory times through this one loop: they had a copy each, and one of them
 * (`bound.ts`) had drifted into reading the clock once per *operation* — which,
 * at ~1 µs a read, is several times the cost of the sub-microsecond decodes it
 * was reporting, so its rows measured mostly `process.cpuUsage`.
 */
export function measure(body: () => void, minSeconds = MIN_SECONDS): Timing {
  if (smoke) {
    // One un-warmed op, timed against a clock of comparable cost: a liveness
    // check for the row, never a measurement (see `setSmoke`).
    const t0 = cpuNow();
    body();
    return { iterations: 1, seconds: Math.max(cpuNow() - t0, 1e-9) };
  }
  warmup(body);
  const batch = calibrateBatch(body);
  let iterations = 0;
  const t0 = cpuNow();
  let seconds: number;
  do {
    for (let k = 0; k < batch; k++) body();
    iterations += batch;
    seconds = cpuNow() - t0;
  } while (seconds < minSeconds);
  return { iterations, seconds };
}

let blackhole = 0;
/**
 * Consume an accumulator so the JIT cannot elide the measured work.
 *
 * A `number`, not a `bigint`: this runs once per operation, and a `bigint` XOR
 * allocates — on a workload whose whole op is a few hundred nanoseconds that
 * allocation is a measurable part of the row, which is precisely the kind of
 * thing the benchmark must not be measuring.
 */
export function sink(value: number): void {
  blackhole += value;
}
/** Read once at process exit so `blackhole` is observably live. */
export function blackholeValue(): number {
  return blackhole;
}
