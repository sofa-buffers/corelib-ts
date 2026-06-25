/**
 * The acceleration seam: the default kernel is the JS one, a replacement kernel
 * produces byte-identical output (so a native/WASM build is a drop-in), bad
 * kernels are rejected, and a missing native addon falls back silently.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  type Kernel,
  OStream,
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
