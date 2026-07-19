// Smoke test for the *built* IIFE bundle (dist/index.global.js) in a scope that
// has no Node globals at all.
//
// Why this exists: testing on Node, Deno and Bun does NOT prove the bundle is
// runtime-agnostic, because Deno 2 and Bun both implement the `node:` builtins
// and most Node globals on purpose. An accidental `process`/`Buffer`/`require`
// dependency in src/ would pass on all three and only break in the browser —
// which package.json explicitly promises via its description and the
// `unpkg` / `jsdelivr` fields pointing at this very bundle.
//
// So we load the IIFE into a bare vm context that is given *only* Web APIs
// (TextEncoder/TextDecoder/console) on top of the standard JS intrinsics. There
// is deliberately no `process`, `require`, `Buffer`, `module` or `setTimeout`
// in scope: any use of them throws a ReferenceError and fails this test. That
// buys us the browser-relevant guarantee without a headless browser or a single
// new devDependency.
//
//   node test/smoke-browser.mjs
//
// The assertions are a compact round-trip written inline and executed *inside*
// the sandbox on purpose: running them from the host realm would compare
// cross-realm Uint8Arrays and could fail spuriously on `instanceof`. Full API
// coverage is the job of smoke.mjs / smoke.cjs on the real runtimes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const bundle = readFileSync(fileURLToPath(new URL("../dist/index.global.js", import.meta.url)), "utf8");

// Only Web APIs — everything Node-specific is intentionally absent.
const sandbox = vm.createContext({ console, TextEncoder, TextDecoder });

let failures = 0;
const check = (name, cond) => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.error(`  FAIL ${name}`); failures++; }
};

console.log("\n[IIFE bundle — dist/index.global.js, Node globals absent]");

for (const forbidden of ["process", "require", "Buffer", "module", "global", "setTimeout"]) {
  check(`sandbox has no '${forbidden}'`, vm.runInContext(`typeof ${forbidden} === "undefined"`, sandbox));
}

try {
  vm.runInContext(bundle, sandbox);
  check("bundle evaluates without touching Node globals", true);
} catch (err) {
  check(`bundle evaluates without touching Node globals (${err.message})`, false);
}

if (failures === 0) {
  check("defines the global 'SofaBuffers'", vm.runInContext(`typeof SofaBuffers === "object"`, sandbox));

  const ok = vm.runInContext(`(() => {
    const { OStream, decode } = SofaBuffers;
    const os = new OStream();
    os.writeUnsigned(1, 42);
    os.writeUnsigned(2, 2n ** 60n);
    os.writeString(3, "sofa🛋");
    const bytes = os.bytes().slice();
    const got = {};
    decode(bytes, {
      unsigned(id, v) { got[id] = v; },
      string(id, total, offset, chunk) { got[id] = new TextDecoder().decode(chunk.slice()); },
    });
    return got[1] === 42 && got[2] === 2n ** 60n && got[3] === "sofa🛋";
  })()`, sandbox);
  check("encode/decode round-trips inside the sandbox", ok);
}

if (failures > 0) {
  console.error(`\nsmoke: ${failures} check(s) FAILED for the IIFE bundle`);
  process.exit(1);
}
console.log(`\nsmoke: all checks passed for the IIFE bundle (no Node globals in scope)`);
