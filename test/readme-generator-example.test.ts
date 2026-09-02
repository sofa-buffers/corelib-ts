/**
 * The README's "### Code generator" example must show **both** halves of the
 * generated surface, and must actually work (CORELIB_PLAN §9.5, corelib-ts#118).
 *
 * §9.5 requires that section to demonstrate "using generated object code (the
 * one-shot `encode()` / `decode()` helpers *and* the streaming `serialize` /
 * `decoder()` path, §6.1.1)". The generated layer is the only surface most
 * callers ever touch, and the chunked transport is precisely the case the
 * one-shot helpers cannot serve — a reader who finds only whole-buffer calls
 * there concludes the generated path does not stream and hand-rolls a visitor,
 * which is the mistake the section exists to prevent.
 *
 * Two checks, because a doc example can fail in two ways:
 *
 *  1. **Shape** — the fenced block under "### Code generator" is character-for-
 *     character `test/helpers/readme-generator-example.ts` (modulo the import
 *     specifier), so the snippet a reader copies is a module this repo compiles
 *     under `tsc --noEmit` and runs in CI; and it names the §6.1.1 streaming
 *     surface rather than the whole-buffer half alone.
 *  2. **Behaviour** — that module really does round-trip through a sink-driven
 *     `serialize` and a chunk-fed `decoder()`, so the section documents
 *     something true.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DecodeStatus } from "../src/index.js";
import {
  Point,
  got,
  parts,
  st,
  streamed,
  wire,
} from "./helpers/readme-generator-example.js";

const ROOT = new URL("../", import.meta.url);
const HELPER = fileURLToPath(new URL("test/helpers/readme-generator-example.ts", ROOT));
const README = readFileSync(fileURLToPath(new URL("README.md", ROOT)), "utf8");

/** The body of the "### Code generator" section, up to the next heading. */
function generatorSection(): string {
  const start = README.indexOf("### Code generator");
  expect(start, "README must have a `### Code generator` section (§9.5)").toBeGreaterThan(-1);
  const rest = README.slice(start + "### Code generator".length);
  const end = rest.search(/^#{2,3} /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every fenced `ts` block in `text`. */
function tsBlocks(text: string): string[] {
  return [...text.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!.trim());
}

/**
 * The helper module as the README spells it: without the file's own header
 * comment and its trailing re-export, and with the published package specifier
 * in place of the relative one.
 */
function helperAsDocumented(): string {
  const src = readFileSync(HELPER, "utf8");
  const body = src.slice(src.indexOf("import {"));
  return body
    .replace(/\n?export \{[^}]*\};\n?$/, "\n")
    .replace('"../../src/index.js"', '"@sofa-buffers/corelib"')
    .trim();
}

describe("README `### Code generator` shows the streaming half (§9.5)", () => {
  const section = generatorSection();
  const blocks = tsBlocks(section);

  it("has exactly one example block", () => {
    expect(blocks).toHaveLength(1);
  });

  it("is the compiled, executed example in test/helpers", () => {
    expect(blocks[0]).toBe(helperAsDocumented());
  });

  it.each([
    ["serialize(", "the §6.1.1 encode entry point"],
    ["decoder()", "the §6.1.1 streaming decode entry point"],
    ["IStream", "the resumable decoder the generated reader is bound to"],
    ["feed(", "the chunk-at-a-time drive"],
    ["DecodeStatus", "the three-valued outcome a chunked caller reads"],
    ["FlushSink", "the sink that drains a buffer smaller than the message"],
  ])("names %s (%s)", (needle) => {
    expect(section).toContain(needle);
  });
});

describe("the documented example does what the section claims", () => {
  it("encodes the message the one-shot way", () => {
    // writeSigned(1, 3) -> 09 06, writeSigned(2, 4) -> 11 08
    expect([...wire]).toStrictEqual([0x09, 0x06, 0x11, 0x08]);
  });

  it("decodes it whole-buffer through the one-shot entry point", () => {
    expect([got.x, got.y]).toStrictEqual([3, 4]);
  });

  it("streams the same bytes out through a buffer smaller than the message", () => {
    const joined = parts.flatMap((c) => [...c]);
    expect(parts.length).toBeGreaterThan(0);
    expect(joined).toStrictEqual([...wire]);
  });

  it("assembles the message from chunks through the generated decoder", () => {
    expect(st).toBe(DecodeStatus.Complete);
    expect(streamed).not.toBeNull();
    expect([streamed!.x, streamed!.y]).toStrictEqual([3, 4]);
  });

  it("resumes across any chunking, one byte at a time", () => {
    const dec = Point.decoder();
    const seen: DecodeStatus[] = [];
    for (const b of wire) seen.push(dec.feed(Uint8Array.of(b)));

    // A header alone leaves the decoder mid-field; each value byte closes it.
    expect(seen).toStrictEqual([
      DecodeStatus.Incomplete,
      DecodeStatus.Complete,
      DecodeStatus.Incomplete,
      DecodeStatus.Complete,
    ]);
    // The generated handle offers no accessor beside `feed`, so re-reading the
    // outcome is a feed that consumes nothing.
    expect(dec.feed(new Uint8Array(0))).toBe(DecodeStatus.Complete);
    expect([dec.message.x, dec.message.y]).toStrictEqual([3, 4]);
  });
});
