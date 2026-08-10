/**
 * Two promises the published package makes about itself, checked against the
 * source rather than the prose (CORELIB_PLAN §9, README "Dependencies" and
 * "Why this design").
 *
 * 1. **Zero runtime dependencies.** Every module id the library resolves at
 *    run time — statically, or through `import()` / `require()` — is either
 *    relative, a `node:` builtin, or a package declared in `package.json`. A
 *    loader for a package nobody declares cannot load anything: it compiles,
 *    it type-checks, its "addon absent" test passes on every host, and it is
 *    dead weight in all three shipped bundles.
 * 2. **The acceleration seam is the `Kernel` interface.** No accelerated
 *    backend is published today, so the surface must not advertise a loader
 *    that installs one; `setKernel()` is the whole seam (#115).
 */

import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Drop comments so documentation examples are not mistaken for real imports. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Every module id this file could hand to the module system: the specifiers of
 * static `import` / `export ... from`, of dynamic `import()` and `require()`,
 * and — because a loader may route its id through a constant — every bare
 * scoped-package literal in the file.
 */
function moduleIds(code: string): string[] {
  const ids: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
    /["'](@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)["']/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) ids.push(m[1]!);
  }
  return ids;
}

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const declared = new Set([
  pkg.name, // the self-reference specifier
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]);

const builtin = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

describe("the published surface matches what the package actually ships", () => {
  it("resolves no module id that is not relative, builtin, or declared", () => {
    const undeclared: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const id of moduleIds(code)) {
        if (id.startsWith(".") || builtin.has(id) || declared.has(id)) continue;
        undeclared.push(`${file.slice(SRC.length + 1)}: ${id}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("advertises no loader for an acceleration backend that is not published", () => {
    const loaders = Object.keys(api).filter((name) => /^load[A-Za-z]*Kernel$/.test(name));
    expect(loaders).toEqual([]);
  });

  it("still exports the acceleration seam itself", () => {
    expect(typeof api.setKernel).toBe("function");
    expect(typeof api.getKernel).toBe("function");
    expect(api.getKernel()).toBe(api.jsKernel);
  });
});
