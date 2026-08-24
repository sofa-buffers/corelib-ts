/**
 * Documentation examples must materialize a string chunk with a **fatal**
 * `TextDecoder` (CORELIB_PLAN §6.4, corelib-ts#117).
 *
 * §6.4 forbids silent replacement in every mode: an implementation MUST NOT
 * substitute `U+FFFD` for an invalid-UTF-8 `string`, and it calls out
 * JavaScript's default (non-fatal) `TextDecoder` / `TextEncoder` as exactly the
 * lossy platform primitive to avoid. The corelib itself materializes strings
 * with `new TextDecoder("utf-8", { fatal: true })` (`src/decode/cursor.ts`), but
 * the *visitor* surfaces hand out raw, unvalidated wire bytes — validation
 * belongs where a string is materialized, and on that path the caller is the one
 * doing the materializing. So a doc snippet that decodes a chunk is the pattern
 * consumers copy, and a lossy one teaches them to violate §6.4.
 *
 * Two checks below:
 *  1. a lint over the shipped docs (TSDoc `@example` blocks in `src/`, and the
 *     README's fenced code) — every `new TextDecoder(...)` must be fatal;
 *  2. the behaviour that makes the lint matter — the visitor path really does
 *     deliver invalid UTF-8 and really does stay COMPLETE, so only the fatal
 *     constructor turns those bytes into an error.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SofabError, SofabErrorCode, decode, decodeUtf8, type Visitor } from "../src/index.js";

const ROOT = new URL("../", import.meta.url);

/** Every `.ts` file under `src/`, recursively. */
function sourceFiles(dir = new URL("src/", ROOT)): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...sourceFiles(new URL(`${entry.name}/`, dir)));
    else if (entry.name.endsWith(".ts")) out.push(fileURLToPath(new URL(entry.name, dir)));
  }
  return out;
}

/** The documentation files whose code a reader is invited to copy. */
function documentationFiles(): string[] {
  return [...sourceFiles(), fileURLToPath(new URL("README.md", ROOT))];
}

/** `{ file, args }` for every `new TextDecoder(...)` construction in `text`. */
function decoderConstructions(file: string, text: string): { file: string; args: string }[] {
  return [...text.matchAll(/new TextDecoder\(([^)]*)\)/g)].map((m) => ({
    file,
    args: m[1]!,
  }));
}

describe("doc examples construct a fatal TextDecoder (§6.4)", () => {
  const found = documentationFiles().flatMap((f) =>
    decoderConstructions(f, readFileSync(f, "utf8")),
  );

  it("finds the constructions it is meant to police", () => {
    expect(found.length).toBeGreaterThan(0);
  });

  it.each(found.map((c, i) => [`${c.file} #${i}`, c] as const))(
    "%s is fatal",
    (_name, c) => {
      expect(
        /fatal\s*:\s*true/.test(c.args),
        `${c.file}: new TextDecoder(${c.args}) is lossy — §6.4 forbids silent U+FFFD ` +
          `substitution; use new TextDecoder("utf-8", { fatal: true })`,
      ).toBe(true);
    },
  );
});

describe("why the fatal decoder is required on the visitor path", () => {
  // id 1, wire type 2 (fixlen), length 2, subtype 0 (string): payload `ff fe`,
  // which is not valid UTF-8 in any position.
  const bad = Uint8Array.of(0x0a, 0x12, 0xff, 0xfe);

  it("hands the visitor the raw invalid bytes and still completes", () => {
    const chunks: Uint8Array[] = [];
    const sink: Visitor = {
      string: (_id, _total, _off, src, start, end) => {
        chunks.push(src.slice(start, end));
      },
    };
    expect(() => decode(bad, sink)).not.toThrow();
    expect(chunks).toHaveLength(1);
    expect([...chunks[0]!]).toStrictEqual([0xff, 0xfe]);
  });

  it("a default TextDecoder would silently replace them (the bug)", () => {
    // Not the library's behaviour — the platform's. Pinned here so the lint
    // above has a stated reason: this is what a copied lossy snippet produces.
    expect(new TextDecoder().decode(Uint8Array.of(0xff, 0xfe))).toBe("��");
  });

  it("the fatal TextDecoder rejects them, as the example must", () => {
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.of(0xff, 0xfe)),
    ).toThrow();
  });

  it("the same bytes through decodeUtf8 are INVALID_MSG", () => {
    // decodeUtf8 is the strict decoder the docs point generated code at: it maps
    // the platform decoder's bare TypeError onto the INVALID verdict every other
    // malformation reports (§6.4).
    try {
      decode(bad, {
        string: (_id, _total, _offset, src, start, end) => void decodeUtf8(src, start, end),
      });
      expect.unreachable("decodeUtf8 must reject invalid UTF-8");
    } catch (e) {
      expect(e).toBeInstanceOf(SofabError);
      expect((e as SofabError).code).toBe(SofabErrorCode.InvalidMsg);
    }
  });
});
