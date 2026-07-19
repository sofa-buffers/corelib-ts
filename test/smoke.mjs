// Cross-runtime smoke test for the *built* ESM bundle (dist/index.js).
//
// This is the only test that touches dist/ — the vitest suite covers src/ — so
// it is what stands between a broken tsup/exports config and a broken publish.
// It imports only the public entry and uses only standard JS / Web APIs (no
// test framework, no `node:` imports), so it runs unchanged everywhere.
//
//   node test/smoke.mjs   |   deno run --allow-read test/smoke.mjs   |   bun ./test/smoke.mjs
//
// On Node it additionally imports the package by *name*, which is the only way
// to exercise the `exports` map in package.json — importing the relative path
// bypasses it entirely, so a broken condition order would go unnoticed.
// Companion tests: smoke.cjs (the CJS bundle) and smoke-browser.mjs (the IIFE
// bundle, loaded without any Node globals in scope).

import { runChecks, runtimeName, report } from "./smoke-checks.mjs";

const isNode = typeof process !== "undefined" && !!process.versions?.node
  && typeof Deno === "undefined" && typeof Bun === "undefined";

let failures = 0;

failures += runChecks(await import("../dist/index.js"), "ESM bundle — dist/index.js");

if (isNode) {
  // Self-reference specifier: resolved through the `exports` map, not the path.
  failures += runChecks(await import("@sofa-buffers/corelib"), "ESM via exports map — import '@sofa-buffers/corelib'");
}

report(failures, runtimeName());
