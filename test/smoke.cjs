// Smoke test for the *built* CJS bundle (dist/index.cjs).
//
// package.json ships three artifacts (ESM, CJS, IIFE) but only the ESM one used
// to be smoke-tested, so a tsup format regression in `cjs` could ship silently
// and break every `require()` consumer. This covers the `main` / `require`
// half of the package.
//
//   node test/smoke.cjs   |   bun ./test/smoke.cjs
//
// Requires a CJS context, hence the .cjs extension in a "type": "module"
// package. The shared checks are ESM, so they come in via dynamic import().

(async () => {
  const { runChecks, runtimeName, report } = await import("./smoke-checks.mjs");

  let failures = 0;

  failures += runChecks(require("../dist/index.cjs"), "CJS bundle — dist/index.cjs");

  // Self-reference specifier: resolved through the `exports` map's `require`
  // condition, which the relative path above bypasses.
  failures += runChecks(require("@sofa-buffers/corelib"), "CJS via exports map — require('@sofa-buffers/corelib')");

  report(failures, runtimeName());
})();
