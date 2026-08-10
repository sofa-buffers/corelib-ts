/**
 * The README's error-code prose, checked against `src/errors.ts` rather than
 * against itself (CORELIB_PLAN §9: "every fact … and API name the README states
 * must match the code as it stands today").
 *
 * The list under "Usage" is the one place a caller learns which values
 * `SofabError.code` can take, so it is the list they write their `switch` /
 * `if (e.code === …)` against. A name in it that `SofabErrorCode` does not
 * define compiles into a branch that can never fire; a code missing from it is
 * a terminal failure the caller never learns to handle — and `LIMIT_EXCEEDED`
 * is exactly the one CORELIB_PLAN §6.2.1 requires callers to be able to tell
 * apart from `INVALID_MSG` (corelib-ts#116).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SofabErrorCode } from "../src/index.js";

const README = readFileSync(
  fileURLToPath(new URL("../README.md", import.meta.url)),
  "utf8",
);

/** The wire-visible values of every code the library can actually throw. */
const DEFINED_CODES = Object.values(SofabErrorCode) as string[];
/** The `SofabErrorCode.*` member names, as the README spells them in examples. */
const DEFINED_MEMBERS = Object.keys(SofabErrorCode);

/**
 * The README's enumeration of the codes: the parenthesised backticked list that
 * follows the mention of `SofabError.code`.
 */
function documentedCodes(): string[] {
  const m = README.match(/`SofabError\.code`[^(]*\(([^)]*)\)/);
  expect(m, "README must enumerate the codes after `SofabError.code`").not.toBeNull();
  return [...m![1]!.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((x) => x[1]!);
}

describe("README error-code list matches src/errors.ts", () => {
  it("names only codes that SofabErrorCode defines", () => {
    for (const name of documentedCodes()) {
      expect(DEFINED_CODES, `README documents a code the library never throws: ${name}`)
        .toContain(name);
    }
  });

  it("names every code SofabErrorCode defines", () => {
    for (const code of DEFINED_CODES) {
      expect(documentedCodes(), `SofabErrorCode.${code} is undocumented`).toContain(code);
    }
  });

  it("lists each code exactly once", () => {
    const listed = documentedCodes();
    expect(new Set(listed).size).toBe(listed.length);
  });
});

describe("README `SofabErrorCode.*` references resolve", () => {
  it("every member the README names exists on the exported object", () => {
    const referenced = new Set(
      [...README.matchAll(/SofabErrorCode\.([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]!),
    );
    expect(referenced.size).toBeGreaterThan(0);
    for (const member of referenced) {
      expect(DEFINED_MEMBERS, `README references SofabErrorCode.${member}, which does not exist`)
        .toContain(member);
    }
  });
});
