/**
 * The unrolled 64-bit varint reader is defined **once** (corelib-ts#114).
 *
 * The pull decoder ({@link Cursor}, `src/decode/cursor.ts`) and the contiguous
 * push decoder (`src/decode/fast.ts`) used to carry their own verbatim copy of
 * the same unrolled LEB128 reader plus the half-combining helpers around it —
 * ~65 identical lines each. Every varint-level decode fix (corelib-ts#82, #88,
 * #99/#100, #131) then had to be applied to both copies by hand, and a fix
 * landing in only one of them is invisible to review: the shared vectors feed
 * both surfaces the same well-formed bytes, so only a hostile varint separates
 * them. Both now inherit the one copy from `src/decode/reader.ts`.
 *
 * Two guards, at two levels:
 *
 * - **Structural** — the reader has one definition, and no long verbatim block
 *   survives between the two decoders. These fail the moment a copy is pasted
 *   back in, which is the drift this issue is about.
 * - **Behavioural** — both surfaces are fed the same adversarial varints (the
 *   64-bit boundary, the >64-bit overflows, truncation at every prefix length)
 *   and must return the same value or the same error code. This is what a
 *   one-sided fix would break.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  Cursor,
  SofabError,
  SofabErrorCode,
  U64_MAX,
  decode,
} from "../src/index.js";
import type { Visitor } from "../src/index.js";

/** Source text of `src/<rel>` — empty when the module does not exist. */
function src(rel: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
  } catch {
    return "";
  }
}

// --- structural: one definition, no verbatim blocks ---------------------------

/**
 * Code lines of a source file: the import prologue, blank lines and whole-line
 * comments dropped, the rest trimmed. Comment text is excluded on purpose — two
 * blocks that differ only in their prose are still the same code, and that is
 * exactly how the two copies of the reader drifted apart in wording while
 * staying identical in behaviour. Imports are excluded because two modules that
 * pull the same names out of `constants.js` / `errors.js` are *sharing* code,
 * not copying it.
 */
function codeLines(text: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\b/.test(lines[i]!) || /^\} from "/.test(lines[i]!)) lastImport = i;
  }
  return lines.slice(lastImport + 1);
}

/** Length of the longest run of consecutive code lines `a` and `b` share. */
function longestCommonRun(a: string[], b: string[]): { len: number; at: number } {
  let best = 0;
  let bestAt = -1;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1]! + 1;
        if (cur[j]! > best) {
          best = cur[j]!;
          bestAt = i - cur[j]!;
        }
      }
    }
    prev = cur;
  }
  return { len: best, at: bestAt };
}

describe("the unrolled varint reader has a single definition (corelib-ts#114)", () => {
  // The bounds-checked reader's signature line. state.ts's varintFull is a
  // deliberately different reader — the caller has already proved 10 bytes are
  // present, so it carries no per-byte bounds check and cannot match this.
  const SIGNATURE = 'if (p >= n) throw incompleteError("truncated varint");';

  it("defines the bounds-checked unrolled reader in exactly one module", () => {
    const owners = ["decode/reader.ts", "decode/cursor.ts", "decode/fast.ts", "decode/state.ts"]
      .filter((f) => src(f).includes(SIGNATURE));
    expect(owners).toEqual(["decode/reader.ts"]);
  });

  it("leaves no verbatim block of code shared between cursor.ts and fast.ts", () => {
    const { len } = longestCommonRun(codeLines(src("decode/cursor.ts")), codeLines(src("decode/fast.ts")));
    // All that legitimately remains identical is the constructor's limit wiring
    // (6 lines); the reader this issue is about was a 55-line block inside a
    // 72-line common run. Anything approaching this ceiling is a pasted block —
    // put it on the shared BufferReader base instead of copying it.
    expect(len).toBeLessThan(10);
  });
});

// --- behavioural: both surfaces read the same varints -------------------------

/** Collect the single unsigned field of a message decoded by the push path. */
class OneUnsigned implements Visitor {
  value: number | bigint | undefined;
  unsigned(_id: number, value: number | bigint): void {
    this.value = value;
  }
}

/** The outcome of a decode: the value read, or the SofabError code raised. */
type Outcome = { value: number | bigint } | { code: SofabErrorCode };

function outcome(fn: () => number | bigint | undefined): Outcome {
  try {
    return { value: fn()! };
  } catch (e) {
    if (e instanceof SofabError) return { code: e.code };
    throw e;
  }
}

/** Field 1, wire 0 (unsigned), followed by the raw varint bytes under test. */
function msg(...varint: number[]): Uint8Array {
  return Uint8Array.from([0x08, ...varint]);
}

const CASES: [string, Uint8Array][] = [
  ["one-byte value", msg(0x7f)],
  ["two-byte value", msg(0x80, 0x01)],
  ["five-byte value (32-bit boundary)", msg(0xff, 0xff, 0xff, 0xff, 0x0f)],
  ["nine-byte value", msg(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f)],
  ["bit 63 alone", msg(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01)],
  ["u64 max (ten bytes)", msg(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01)],
  // Payload bit 1 of the tenth byte is bit 64 — past the 64-bit bound (§4.1).
  ["overflow: bit 64 set", msg(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02)],
  // Tenth byte still asks for an eleventh: over the 10-byte maximum.
  ["overflow: eleventh byte", msg(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x81, 0x01)],
  // The header varint itself, not the value: id 2^60, way past ID_MAX.
  ["header id out of range", Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01])],
];

// Truncation at every prefix length: 1..9 continuation bytes and no terminator.
for (let k = 1; k <= 9; k++) {
  CASES.push([`truncated after ${k} byte(s)`, msg(...new Array<number>(k).fill(0x80))]);
}

describe("pull and push decoders agree on every varint edge case (corelib-ts#114)", () => {
  for (const [name, wire] of CASES) {
    it(name, () => {
      const pull = outcome(() => {
        const c = new Cursor(wire);
        return c.readHeader() ? c.readUnsigned() : undefined;
      });
      const push = outcome(() => {
        const v = new OneUnsigned();
        decode(wire, v);
        return v.value;
      });
      expect(push).toEqual(pull);
    });
  }

  it("reads u64 max exactly on both surfaces", () => {
    const wire = msg(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01);
    const c = new Cursor(wire);
    c.readHeader();
    expect(c.readUnsigned()).toBe(U64_MAX);
    const v = new OneUnsigned();
    decode(wire, v);
    expect(v.value).toBe(U64_MAX);
  });

  it("rejects a >64-bit varint as INVALID, not INCOMPLETE, on both surfaces", () => {
    const wire = msg(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02);
    for (const o of [
      outcome(() => {
        const c = new Cursor(wire);
        c.readHeader();
        return c.readUnsigned();
      }),
      outcome(() => {
        const v = new OneUnsigned();
        decode(wire, v);
        return v.value;
      }),
    ]) {
      expect(o).toEqual({ code: SofabErrorCode.InvalidMsg });
    }
  });
});
