/**
 * The acceleration seam.
 *
 * The encoder's bulk array paths run through a {@link Kernel} — a small set of
 * self-contained, buffer-oriented transforms over a region the caller has
 * already sized. The default {@link "./js"} kernel is pure TypeScript and works
 * everywhere; a C++ (N-API) or WebAssembly build can implement the same
 * interface and be swapped in with {@link setKernel} for a speed-up, with **no
 * change to the public API**. The boundary is deliberately *bulk* (a whole
 * array per call, into guaranteed capacity) so the cost of crossing into native
 * code is amortised — never one call per element.
 */

import { jsKernel } from "./js.js";

/**
 * Bulk, capacity-guaranteed transforms used on the encoder's fast path.
 *
 * Every method writes into `out` starting at `pos`, assuming the caller has
 * already ensured enough room, and returns the position just past the last byte
 * written. Headers, counts, flushing and validation stay in the stream classes;
 * a kernel only moves bytes.
 */
export interface Kernel {
  /** A short identifier, surfaced in diagnostics and the parity tests. */
  readonly name: string;

  /** Encode each element as an unsigned varint. */
  encodeUnsignedVarints(
    values: ArrayLike<number | bigint>,
    out: Uint8Array,
    pos: number,
  ): number;

  /** Zig-zag then varint-encode each element. */
  encodeSignedVarints(
    values: ArrayLike<number | bigint>,
    out: Uint8Array,
    pos: number,
  ): number;

  /** Pack each element as a little-endian fp32 (4 bytes). */
  packFp32Array(values: ArrayLike<number>, out: Uint8Array, pos: number): number;

  /** Pack each element as a little-endian fp64 (8 bytes). */
  packFp64Array(values: ArrayLike<number>, out: Uint8Array, pos: number): number;
}

// Initialised directly (not via an import side effect) so that bundlers honouring
// the package's `"sideEffects": false` can never tree-shake the default away.
let active: Kernel = jsKernel;

/** Install `kernel` as the active acceleration backend. */
export function setKernel(kernel: Kernel): void {
  validateKernel(kernel);
  active = kernel;
}

/** The currently active kernel (the JS kernel until something replaces it). */
export function getKernel(): Kernel {
  return active;
}

/** Throws if `kernel` is missing a required method — used by {@link setKernel}. */
export function validateKernel(kernel: Kernel): void {
  const required: (keyof Kernel)[] = [
    "encodeUnsignedVarints",
    "encodeSignedVarints",
    "packFp32Array",
    "packFp64Array",
  ];
  for (const m of required) {
    if (typeof kernel[m] !== "function") {
      throw new TypeError(`kernel "${kernel?.name}" is missing ${String(m)}()`);
    }
  }
}
