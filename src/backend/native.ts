/**
 * Optional native (N-API) acceleration loader.
 *
 * This module performs **no** work at import time and statically imports
 * nothing native, so pulling it into a browser or bundled build is harmless.
 * Call {@link loadNativeKernel} explicitly (only meaningful on Node.js /
 * Electron) to try to load the optional `@sofabuffers/corelib-native` addon and
 * install it as the active {@link Kernel}. If the addon is absent or the host
 * is not Node, it returns `false` and the pure-JS kernel stays active.
 */

import { setKernel, type Kernel } from "./kernel.js";

/** The package id of the optional native addon (an `optionalDependency`). */
export const NATIVE_PACKAGE = "@sofabuffers/corelib-native";

function isNode(): boolean {
  return (
    typeof process !== "undefined" &&
    !!(process as { versions?: { node?: string } }).versions?.node
  );
}

/**
 * Attempt to load and install the native kernel.
 *
 * @returns `true` if a valid native kernel was installed, `false` if it could
 *   not be loaded (not on Node, addon not installed, or wrong shape). Never
 *   throws for a missing addon — the JS kernel remains the fallback.
 */
export async function loadNativeKernel(): Promise<boolean> {
  if (!isNode()) return false;
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const mod = require(NATIVE_PACKAGE) as { kernel?: Kernel } | Kernel;
    const kernel = (mod as { kernel?: Kernel }).kernel ?? (mod as Kernel);
    setKernel(kernel);
    return true;
  } catch {
    return false;
  }
}
