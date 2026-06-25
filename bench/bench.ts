/**
 * SofaBuffers TypeScript — throughput benchmark (CPU time, MB/s).
 *
 * Mirror of `bench/c/bench.c`, `benches/bench.rs`, C#'s `Bench` and Java's
 * `Bench`: encode / decode throughput for two workloads — a 1000-element u64
 * array and a small "typical" mixed message — over a ~1 s CPU-time loop each,
 * reported in the same table layout so the implementations compare directly.
 *
 * Run with: `npm run bench`
 */

import { IStream, OStream } from "../src/index.js";
import { Checksum, MIN_SECONDS, WARMUP, blackholeValue, cpuNow, sink } from "./common.js";

const N = 1000;
const GOLDEN = 0x9e37_79b9_7f4a_7c15n;
const MASK64 = (1n << 64n) - 1n;

function makeSrc(): bigint[] {
  const a = new Array<bigint>(N);
  for (let i = 0; i < N; i++) a[i] = (BigInt(i) * GOLDEN) & MASK64;
  return a;
}

function encodeTypical(os: OStream): void {
  os.writeUnsigned(1, 0xdead_beefn);
  os.writeSigned(2, -12345);
  os.writeBoolean(3, true);
  os.writeFp32(4, 3.14159);
  os.writeString(5, "sofab");
  os.writeUnsignedArray(6, [10, 20, 30, 40]);
  os.writeSequenceBegin(7);
  os.writeUnsigned(1, 99);
  os.writeSigned(2, -7);
  os.writeSequenceEnd();
}

/** Run `body` for ~1 s of CPU time after warmup; return MB/s for `bytes`. */
function measure(bytes: number, body: () => void): number {
  for (let i = 0; i < WARMUP; i++) body();
  let it = 0;
  const t0 = cpuNow();
  let el: number;
  do {
    body();
    it++;
    el = cpuNow() - t0;
  } while (el < MIN_SECONDS);
  return (bytes * it) / el / 1e6;
}

/** The four workloads, sharing one-time setup; keyed by the names the
 * callgrind harness passes on the command line. */
function buildWorkloads(): {
  order: string[];
  bytes: Record<string, number>;
  run: Record<string, () => void>;
} {
  const src = makeSrc();

  const encode = (write: (os: OStream) => void): Uint8Array => {
    const os = new OStream();
    write(os);
    return os.bytes().slice();
  };
  const u64Wire = encode((os) => os.writeUnsignedArray(1, src));
  const typWire = encode(encodeTypical);

  return {
    order: ["encode_u64_array", "encode_typical", "decode_u64_array", "decode_typical"],
    bytes: {
      encode_u64_array: u64Wire.length,
      encode_typical: typWire.length,
      decode_u64_array: u64Wire.length,
      decode_typical: typWire.length,
    },
    run: {
      encode_u64_array: () => {
        const os = new OStream();
        os.writeUnsignedArray(1, src);
        sink(BigInt(os.bytesUsed));
      },
      encode_typical: () => {
        const os = new OStream();
        encodeTypical(os);
        sink(BigInt(os.bytesUsed));
      },
      decode_u64_array: () => {
        const c = new Checksum();
        new IStream().feed(u64Wire, c);
        sink(c.acc);
      },
      decode_typical: () => {
        const c = new Checksum();
        new IStream().feed(typWire, c);
        sink(c.acc);
      },
    },
  };
}

const LABELS: Record<string, string> = {
  encode_u64_array: "encode: u64 array (1000)",
  encode_typical: "encode: typical message",
  decode_u64_array: "decode: u64 array (1000)",
  decode_typical: "decode: typical message",
};

function main(): void {
  const w = buildWorkloads();

  // Callgrind mode: `bench.ts <workload> <reps>` runs the workload `reps` times
  // (no timing) and reports the byte size on stderr. run_callgrind.sh subtracts
  // two rep counts to get instructions/op (see that script).
  const cliWorkload = process.argv[2];
  if (cliWorkload && w.run[cliWorkload]) {
    const reps = Number(process.argv[3] ?? "100000");
    const body = w.run[cliWorkload]!;
    for (let i = 0; i < reps; i++) body();
    process.stderr.write(`bytes=${w.bytes[cliWorkload]} sink=${blackholeValue()}\n`);
    return;
  }

  const row = (label: string, mbs: number): string => label.padEnd(26) + " " + mbs.toFixed(2).padStart(12);

  console.log("=== SofaBuffers TypeScript throughput (CPU time, MB/s) ===");
  console.log("Workload".padEnd(26) + " " + "MB/s".padStart(12));
  console.log("--------".padEnd(26) + " " + "----".padStart(12));
  for (const key of w.order) {
    console.log(row(LABELS[key]!, measure(w.bytes[key]!, w.run[key]!)));
  }
  console.log("");
  console.log("MB = 1e6 bytes. ~1s CPU-time loop per workload.");

  if (blackholeValue() === 42n) console.error(""); // keep the blackhole live
}

main();
