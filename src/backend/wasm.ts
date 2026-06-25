/**
 * Optional WebAssembly acceleration loader.
 *
 * Unlike the native addon, a WASM kernel runs in the browser too. This module
 * does nothing at import time; call {@link loadWasmKernel} with the compiled
 * module's bytes (or a streaming source) to instantiate it and install it as
 * the active {@link Kernel}. A real WASM build is shipped separately; this
 * loader is the stable entry point the rest of the library is wired through.
 */

import { setKernel, type Kernel } from "./kernel.js";

/** A factory the WASM glue exposes: given the instance exports, build a Kernel. */
export type WasmKernelFactory = (
  exports: WebAssembly.Exports,
) => Kernel;

/**
 * Instantiate a WASM module and install the kernel it produces.
 *
 * @param source compiled-module bytes, a `Response`/stream, or a ready module.
 * @param factory wraps the instance exports into a {@link Kernel}.
 * @returns `true` once installed; throws only if instantiation itself fails.
 */
export async function loadWasmKernel(
  source: BufferSource | Response | PromiseLike<Response> | WebAssembly.Module,
  factory: WasmKernelFactory,
  imports: WebAssembly.Imports = {},
): Promise<boolean> {
  let instance: WebAssembly.Instance;
  if (source instanceof WebAssembly.Module) {
    instance = await WebAssembly.instantiate(source, imports);
  } else if (
    typeof Response !== "undefined" &&
    (source instanceof Response || isThenable(source))
  ) {
    const result = await WebAssembly.instantiateStreaming(
      source as Response | PromiseLike<Response>,
      imports,
    );
    instance = result.instance;
  } else {
    const result = await WebAssembly.instantiate(source as BufferSource, imports);
    instance = result.instance;
  }
  setKernel(factory(instance.exports));
  return true;
}

function isThenable(x: unknown): x is PromiseLike<unknown> {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as { then?: unknown }).then === "function"
  );
}
