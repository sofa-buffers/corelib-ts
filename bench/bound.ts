/**
 * corelib-ts#69 — schema-bound reject at the header: max-speed check.
 *
 * The whole-unit {@link Cursor} readers now take an optional per-field schema
 * bound (array `count` / string `maxlen`) and reject an over-count / over-maxlen
 * at the deciding count/length word — so a message that is BOTH schema-invalid
 * AND truncated is INVALID, not INCOMPLETE (§5.2). The contract is that on valid
 * data the added check is a predicted-false integer compare with no hot-path
 * cost. This bench proves it: it decodes the same wire with the reader called
 * WITHOUT the bound (old behavior) and WITH it (new behavior) and reports both
 * throughputs side by side. Run with: `npm run bench:bound` / `tsx bench/bound.ts`.
 */

import { Cursor, OStream } from "../src/index.js";
import { MIN_SECONDS, WARMUP, cpuNow, sink } from "./common.js";

const N = 1000;
const GOLDEN = 0x9e37_79b9_7f4a_7c15n;
const MASK64 = (1n << 64n) - 1n;

function encode(write: (os: OStream) => void): Uint8Array {
  const os = new OStream();
  write(os);
  return os.bytes().slice();
}

const u64src = Array.from({ length: N }, (_, i) => (BigInt(i) * GOLDEN) & MASK64);
const fp64src = Array.from({ length: N }, (_, i) => i * 1.5);
const str = "the quick brown fox jumps over the lazy dog"; // 43 bytes UTF-8

const u64Wire = encode((os) => os.writeUnsignedArray(1, u64src));
const fp64Wire = encode((os) => os.writeFp64Array(1, fp64src));
const strWire = encode((os) => os.writeString(1, str));

/** Run `body` for ~1 s of CPU time after warmup; return millions of ops/s. */
function measure(body: () => void): number {
  for (let i = 0; i < WARMUP; i++) body();
  let it = 0;
  const t0 = cpuNow();
  let el: number;
  do {
    body();
    it++;
    el = cpuNow() - t0;
  } while (el < MIN_SECONDS);
  return it / el / 1e6;
}

// Each pair decodes identical wire; only the reader argument differs.
const cases: [string, () => void, () => void][] = [
  [
    "decode: u64 array (1000)",
    () => {
      const c = new Cursor(u64Wire);
      c.readHeader();
      const a = c.readUnsignedArray(); // no bound (old)
      sink(BigInt(a.length));
    },
    () => {
      const c = new Cursor(u64Wire);
      c.readHeader();
      const a = c.readUnsignedArray(N); // schema bound (new)
      sink(BigInt(a.length));
    },
  ],
  [
    "decode: fp64 array (1000)",
    () => {
      const c = new Cursor(fp64Wire);
      c.readHeader();
      const a = c.readFp64Array();
      sink(BigInt(a.length));
    },
    () => {
      const c = new Cursor(fp64Wire);
      c.readHeader();
      const a = c.readFp64Array(N);
      sink(BigInt(a.length));
    },
  ],
  [
    "decode: string (43 bytes)",
    () => {
      const c = new Cursor(strWire);
      c.readHeader();
      const s = c.readString();
      sink(BigInt(s.length));
    },
    () => {
      const c = new Cursor(strWire);
      c.readHeader();
      const s = c.readString(64);
      sink(BigInt(s.length));
    },
  ],
];

const REPEATS = 5; // take the best of N runs per variant to cut scheduler noise
function best(body: () => void): number {
  let m = 0;
  for (let i = 0; i < REPEATS; i++) m = Math.max(m, measure(body));
  return m;
}

console.log("=== corelib-ts#69 schema-bound reader: hot-path cost (Mops/s, best of 5) ===");
console.log(
  "Workload".padEnd(28) +
    "no-bound".padStart(12) +
    "with-bound".padStart(12) +
    "delta".padStart(9),
);
console.log("-".repeat(61));
for (const [label, noBound, withBound] of cases) {
  const a = best(noBound);
  const b = best(withBound);
  const delta = ((b - a) / a) * 100;
  console.log(
    label.padEnd(28) +
      a.toFixed(3).padStart(12) +
      b.toFixed(3).padStart(12) +
      `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`.padStart(9),
  );
}
console.log("");
console.log("Mops = 1e6 decode ops/s. Same wire per row; only the reader arg differs.");
