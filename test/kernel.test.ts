/**
 * The acceleration seam: the default kernel is the JS one, a replacement kernel
 * produces byte-identical output (so a native/WASM build is a drop-in), bad
 * kernels are rejected, and a missing native addon falls back silently.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  type Kernel,
  OStream,
  decode,
  getKernel,
  jsKernel,
  loadNativeKernel,
  loadWasmKernel,
  setKernel,
} from "../src/index.js";
import { bytesToHex } from "./helpers/hex.js";

/** The 8-byte header of a valid, empty WebAssembly module. */
const EMPTY_WASM = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function encodeArrays(): string {
  const os = new OStream();
  os.writeUnsignedArray(1, [1n, 2n, 1n << 40n]);
  os.writeSignedArray(2, [-1, -2, -1000000]);
  os.writeFp32Array(3, [1.5, 2.5, 3.5]);
  os.writeFp64Array(4, [1.25, -2.75]);
  return bytesToHex(os.bytes());
}

afterEach(() => setKernel(jsKernel));

describe("kernel registry", () => {
  it("defaults to the JS kernel", () => {
    expect(getKernel()).toBe(jsKernel);
    expect(getKernel().name).toBe("js");
  });

  it("rejects a kernel missing required methods", () => {
    expect(() => setKernel({ name: "broken" } as unknown as Kernel)).toThrow(TypeError);
  });

  it("a replacement kernel produces byte-identical output", () => {
    const baseline = encodeArrays();

    let calls = 0;
    const wrapping: Kernel = {
      name: "wrapping",
      encodeUnsignedVarints: (v, o, p) => {
        calls++;
        return jsKernel.encodeUnsignedVarints(v, o, p);
      },
      encodeSignedVarints: (v, o, p) => jsKernel.encodeSignedVarints(v, o, p),
      packFp32Array: (v, o, p) => jsKernel.packFp32Array(v, o, p),
      packFp64Array: (v, o, p) => jsKernel.packFp64Array(v, o, p),
    };

    setKernel(wrapping);
    expect(encodeArrays()).toBe(baseline);
    expect(calls).toBeGreaterThan(0);
  });
});

describe("optional native acceleration", () => {
  it("falls back silently when the native addon is absent", async () => {
    const installed = await loadNativeKernel();
    expect(installed).toBe(false);
    expect(getKernel().name).toBe("js");
  });

  it("instantiates a WASM kernel from module bytes", async () => {
    const factory = (): Kernel => ({ ...jsKernel, name: "wasm-stub" });
    expect(await loadWasmKernel(EMPTY_WASM, factory)).toBe(true);
    expect(getKernel().name).toBe("wasm-stub");
  });

  it("instantiates a WASM kernel from a compiled module", async () => {
    const mod = new WebAssembly.Module(EMPTY_WASM);
    const factory = (): Kernel => ({ ...jsKernel, name: "wasm-mod" });
    expect(await loadWasmKernel(mod, factory)).toBe(true);
    expect(getKernel().name).toBe("wasm-mod");
  });
});

/**
 * The JS kernel inlines the body of `encodeVarintLoHi` into its unsigned bulk
 * loop — the innermost loop of the encoder, where the JIT will not inline the
 * shared helper. That duplication is only safe if the two provably agree, so
 * this pins them byte-for-byte over a corpus that covers every varint length
 * boundary, both sides of each power of two, and a spread of full-width values.
 */
describe("kernel parity: the inlined bulk writer matches the shared helper", () => {
  const corpus: bigint[] = [];
  for (let bit = 0n; bit < 64n; bit++) {
    for (const d of [-2n, -1n, 0n, 1n, 2n]) {
      const v = (1n << bit) + d;
      if (v >= 0n && v < 1n << 64n) corpus.push(v);
    }
  }
  for (let i = 0; i < 2000; i++) {
    corpus.push((BigInt(i) * 0x9e37_79b9_7f4a_7c15n) & ((1n << 64n) - 1n));
  }
  // Number-typed elements take the kernel's other branch; cover it too.
  const numeric = [0, 1, 127, 128, 16383, 16384, 2 ** 31, Number.MAX_SAFE_INTEGER];

  it("agrees with a per-element encodeVarint for the whole corpus", () => {
    const viaKernel = new OStream();
    viaKernel.writeUnsignedArray(1, corpus);

    // Reference: the same values, each written as its own unsigned scalar, so
    // the payload bytes come from OStream's non-bulk `encodeVarintLoHi` route.
    const ref = new OStream();
    for (const v of corpus) ref.writeUnsigned(1, v);

    // Strip the array header + count from one and the per-field headers from
    // the other by comparing only the varint payload runs.
    const kernelHex = bytesToHex(viaKernel.bytes());
    let refPayload = "";
    const refOne = new OStream();
    for (const v of corpus) {
      refOne.reset();
      refOne.writeUnsigned(0, v);
      refPayload += bytesToHex(refOne.bytes()).slice(2); // drop the 1-byte header
    }
    expect(kernelHex.endsWith(refPayload)).toBe(true);
    expect(ref.bytesUsed).toBeGreaterThan(0);
  });

  it("agrees for number-typed elements too", () => {
    const viaKernel = new OStream();
    viaKernel.writeUnsignedArray(1, numeric);

    let refPayload = "";
    const refOne = new OStream();
    for (const v of numeric) {
      refOne.reset();
      refOne.writeUnsigned(0, v);
      refPayload += bytesToHex(refOne.bytes()).slice(2);
    }
    expect(bytesToHex(viaKernel.bytes()).endsWith(refPayload)).toBe(true);
  });

  it("round-trips the whole corpus through the decoder", () => {
    const os = new OStream();
    os.writeUnsignedArray(7, corpus);
    const seen: bigint[] = [];
    decode(os.bytes(), {
      arrayUnsigned(_id, _i, v) {
        seen.push(typeof v === "bigint" ? v : BigInt(v));
      },
    });
    expect(seen).toEqual(corpus);
  });
});
