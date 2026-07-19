// Shared assertion suite for the smoke tests.
//
// Kept free of any import of its own so the same checks can be pointed at every
// artifact we ship — the ESM bundle, the CJS bundle, and (via the self-reference
// specifier) whatever the `exports` map resolves to. Uses only standard JS /
// Web APIs, no test framework and no `node:` imports, so it runs unchanged on
// Node, Deno and Bun.

/**
 * Run the smoke assertions against one loaded copy of the public API.
 *
 * @param {object} api   the module namespace / `require()` result to exercise
 * @param {string} label how to describe this artifact in the output
 * @returns {number} number of failed checks (0 = all good)
 */
export function runChecks(api, label) {
  const { OStream, IStream, decode } = api;

  let failures = 0;
  function check(name, cond) {
    if (cond) {
      console.log(`  ok   ${name}`);
    } else {
      console.error(`  FAIL ${name}`);
      failures++;
    }
  }
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

  console.log(`\n[${label}]`);

  check("exports the public API", typeof OStream === "function" && typeof IStream === "function" && typeof decode === "function");
  if (failures > 0) return failures; // nothing below can run

  // --- encode a message exercising every wire type ---
  const os = new OStream();
  os.writeUnsigned(1, 42); // small -> number on decode
  os.writeUnsigned(2, 2n ** 60n); // large -> bigint on decode
  os.writeSigned(3, -7);
  os.writeBoolean(4, true);
  os.writeFp32(5, 1.5);
  os.writeFp64(6, 2.5);
  os.writeString(7, "sofa🛋"); // multi-byte UTF-8
  os.writeBlob(8, Uint8Array.from([1, 2, 3]));
  os.writeUnsignedArray(9, [10, 20, 30]);
  os.writeSignedArray(10, [-1, -2]);
  os.writeFp64Array(11, [1.25, -3.5]);
  os.writeSequenceBegin(12);
  os.writeUnsigned(1, 99);
  os.writeSequenceEnd();
  const bytes = os.bytes().slice();

  // --- decode and collect what we saw ---
  const got = { u1: undefined, u2: undefined, s3: undefined, str7: undefined, nested: undefined };
  let stringBytes = null;
  const visitor = {
    unsigned(id, v) {
      if (id === 1) got.u1 = v;
      if (id === 2) got.u2 = v;
    },
    signed(id, v) {
      if (id === 3) got.s3 = v;
    },
    string(id, total, offset, chunk) {
      if (id === 7) stringBytes = chunk.slice();
    },
    sequenceBegin() {
      return { unsigned(id, v) { if (id === 1) got.nested = v; } };
    },
  };
  decode(bytes, visitor);
  if (stringBytes) got.str7 = new TextDecoder().decode(stringBytes);

  check("round-trips byte-for-byte (decode -> re-encode)", (() => {
    const out = new OStream();
    const transcode = {
      unsigned: (id, v) => out.writeUnsigned(id, v),
      signed: (id, v) => out.writeSigned(id, v),
      fp32: (id, v) => out.writeFp32(id, v),
      fp64: (id, v) => out.writeFp64(id, v),
      string: (() => {
        const buf = {};
        return (id, total, offset, chunk) => {
          (buf[id] ??= new Uint8Array(total)).set(chunk, offset);
          if (offset + chunk.length >= total) out.writeString(id, new TextDecoder().decode(buf[id]));
        };
      })(),
      blob: (() => {
        const buf = {};
        return (id, total, offset, chunk) => {
          (buf[id] ??= new Uint8Array(total)).set(chunk, offset);
          if (offset + chunk.length >= total) out.writeBlob(id, buf[id]);
        };
      })(),
      arrayBegin(id, kind) { this._a = { id, kind, vals: [] }; },
      arrayUnsigned(_id, _i, v) { this._a.vals.push(v); },
      arraySigned(_id, _i, v) { this._a.vals.push(v); },
      arrayFp32(_id, _i, v) { this._a.vals.push(v); },
      arrayFp64(_id, _i, v) { this._a.vals.push(v); },
      arrayEnd(id) {
        const a = this._a;
        if (a.kind === 0) out.writeUnsignedArray(id, a.vals);
        else if (a.kind === 1) out.writeSignedArray(id, a.vals);
        else if (a.kind === 2) out.writeFp32Array(id, a.vals);
        else out.writeFp64Array(id, a.vals);
      },
      sequenceBegin(id) { out.writeSequenceBegin(id); return this; },
      sequenceEnd() { out.writeSequenceEnd(); },
    };
    decode(bytes, transcode);
    return hex(out.bytes()) === hex(bytes);
  })());

  // --- number-first contract (the 0.2.0 behaviour) ---
  check("small unsigned decodes as number", typeof got.u1 === "number" && got.u1 === 42);
  check("large unsigned decodes as bigint", typeof got.u2 === "bigint" && got.u2 === 2n ** 60n);
  check("signed decodes as number", got.s3 === -7);
  check("UTF-8 string round-trips", got.str7 === "sofa🛋");
  check("nested-sequence field routed to child visitor", got.nested === 99);

  // --- chunked (streaming) decode, one byte at a time ---
  check("streaming decode reaches end() cleanly", (() => {
    const is = new IStream();
    for (let i = 0; i < bytes.length; i++) is.feed(bytes.subarray(i, i + 1), {});
    try { is.end(); return true; } catch { return false; }
  })());

  return failures;
}

/** Human-readable name of the host runtime, for the summary line. */
export function runtimeName() {
  return typeof Deno !== "undefined" ? `Deno ${Deno.version.deno}`
    : typeof Bun !== "undefined" ? `Bun ${Bun.version}`
    : typeof process !== "undefined" ? `Node ${process.version}`
    : "unknown runtime";
}

/** Exit non-zero if anything failed, in whatever way the host runtime allows. */
export function report(failures, runtime) {
  if (failures > 0) {
    console.error(`\nsmoke: ${failures} check(s) FAILED on ${runtime}`);
    if (typeof process !== "undefined") process.exit(1);
    throw new Error("smoke test failed");
  }
  console.log(`\nsmoke: all checks passed on ${runtime}`);
}
