/**
 * README.md guarded against CORELIB_PLAN §9 — the README contract.
 *
 * §9 fixes one shape for the whole corelib family: "Do not change the section
 * ordering and do not invent new top-level sections; that shared shape is the
 * point." A reader who knows one port's README navigates this one by position.
 * Nothing else in this suite can notice when that drifts — a seventh chapter, a
 * missing badge or a dead anchor is invisible to every TypeScript test — so the
 * check has to read the document.
 *
 * The sibling ports carry the same guard: corelib-cpp's
 * `test/test_readme_structure.sh` and corelib-go's `readme_shape_test.go`.
 *
 * Shape (a section that goes missing or arrives uninvited):
 *
 *   1. §9.1 the centered header block: logo, `# SofaBuffers`, tagline, org link.
 *   2. §9.2 the badge block opening the library section carries CI, coverage and
 *      Docs badges, in that order, before any prose.
 *   3. §9   the `## ` sections are exactly the prescribed list, in order.
 *   4. §9.4 no API-documentation section at any heading level; the Docs badge is
 *      the only pointer to the generated reference.
 *
 * Content (a section that keeps its heading and loses the fact a reader came
 * for — the half a shrink threatens):
 *
 *   5. §9.5 the Usage chapter still shows each example the plan lists.
 *   6. §6.4 the port's string-validity contract is documented, including the
 *      lossy-platform-encoder hazard §6.4 names for this language (below).
 *   7. §9.6 MIN_OUTPUT_BUFFER is stated *in the memory chapter*.
 *   8. §6.1.1 no spelling outside the closed generated-object name set.
 *   9. every in-document link still resolves to a heading.
 *
 * **Which §6.4 case this port is.** §6.4 splits targets by their string
 * representation. Byte-container targets (C `char[]`, Go `string`, Zig
 * `[]const u8`) MUST expose a `SOFAB_STRICT_UTF8` knob, and the sibling guards
 * check for it by name. JavaScript strings are a **Unicode** string type, which
 * "cannot hold non-UTF-8 bytes … so they are always strict"; for them §6.4 makes
 * the option a no-op and lets a port "omit it entirely (documented as
 * always-ON)". This port omits it, so the knob check is **skipped by
 * construction** — there is no knob to find, and asserting one would demand a
 * configuration switch the plan forbids this port to have. What §6.4 does oblige
 * here is the always-strict statement plus the hazard it calls out by name for
 * this language: JavaScript's `TextEncoder` / default `TextDecoder` silently
 * substitute `U+FFFD` for an unpaired surrogate, which the format forbids in
 * either direction. Check 6 guards that pair instead.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const README = readFileSync(
  fileURLToPath(new URL("../README.md", import.meta.url)),
  "utf8",
);

interface Heading {
  level: number;
  text: string;
}

/**
 * The document with fenced code blocks blanked out. A `# comment` inside a
 * ```bash block is not a chapter, and Build & test is full of them.
 */
const PROSE: string = (() => {
  let fenced = false;
  return README.split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        fenced = !fenced;
        return "";
      }
      return fenced ? "" : line;
    })
    .join("\n");
})();

/** Every ATX heading outside a code fence, with its level. */
const HEADINGS: Heading[] = PROSE.split("\n").flatMap((line) => {
  const m = /^(#{1,6}) +(.*?)\s*$/.exec(line);
  return m ? [{ level: m[1]!.length, text: m[2]! }] : [];
});

/** GitHub's heading slug: lowercase, punctuation dropped, spaces to hyphens. */
function anchor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/ /g, "-");
}

/** The body of a `## ` chapter, up to the next `## `. */
function chapter(name: string): string {
  const lines = PROSE.split("\n");
  const start = lines.findIndex((l) => l === `## ${name}`);
  expect(start, `README must have a '## ${name}' chapter`).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

describe("§9.1 header block", () => {
  it.each([
    ['<p align="center"><img src="assets/sofabuffers_logo.png"', "centered logo"],
    ["\n# SofaBuffers\n", "the `# SofaBuffers` title"],
    ["<b>Structured Objects For Anyone</b><br>", "the tagline"],
    ["https://github.com/sofa-buffers", "a link back to the organization"],
  ])("carries %s", (needle) => {
    expect(README).toContain(needle);
  });
});

describe("§9.2 badge block", () => {
  /**
   * Everything between the library heading and the first blank line after it:
   * §9.2 puts the badges first in the section, ahead of the GitHub link and the
   * summary. Alt texts only — `[![CI](…)](…)` yields `CI`.
   */
  const badges: string[] = (() => {
    const lines = PROSE.split("\n");
    const start = lines.findIndex((l) => /^## SofaBuffers .* library$/.test(l));
    const out: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "") {
        if (out.length > 0) break;
        continue;
      }
      const m = /^\[!\[([^\]]*)\]/.exec(line);
      if (!m) break;
      out.push(m[1]!);
    }
    return out;
  })();

  it("opens the library section", () => {
    expect(badges.length, "the library section opens with no badge block").toBeGreaterThan(0);
  });

  it.each(["CI", "Coverage", "Docs"])("carries a %s badge", (want) => {
    expect(badges.map((b) => b.toLowerCase())).toContain(want.toLowerCase());
  });

  it("lists them in the CI / coverage / Docs order", () => {
    const ranked = badges
      .map((b) => b.toLowerCase())
      .filter((b) => b === "ci" || b === "coverage" || b === "docs");
    expect(ranked).toStrictEqual(["ci", "coverage", "docs"]);
  });
});

describe("§9 top-level sections", () => {
  /**
   * The list §9 prescribes, in order. Only the first varies per port
   * (`## SofaBuffers <Language> library`). Anything else at `## ` level is an
   * invented section — demote it to a `###` subsection of the chapter it
   * belongs to instead of adding a row here.
   */
  const EXPECTED = [
    "SofaBuffers TypeScript library",
    "Why this design",
    "Usage",
    "Memory handling",
    "Build & test",
    "Benchmarks",
  ];

  it("are exactly the prescribed list, in order", () => {
    const got = HEADINGS.filter((h) => h.level === 2).map((h) => h.text);
    expect(got).toStrictEqual(EXPECTED);
  });
});

describe("§9.4 no API-documentation chapter", () => {
  it("has none at any heading level", () => {
    const forbidden = [
      "api reference",
      "api documentation",
      "api docs",
      "source documentation",
    ];
    const found = HEADINGS.filter((h) => forbidden.includes(h.text.toLowerCase()));
    expect(
      found,
      "the Docs badge is the only pointer to the generated reference",
    ).toStrictEqual([]);
  });
});

describe("§9.5 the Usage chapter's examples", () => {
  /**
   * §9.5 lists the examples every port must carry, and they are what a reader
   * opens Usage for. Dropping one drops a use case, not prose. `Serialize
   * stream` and `Deserialize stream` are the buffer-smaller-than-the-message
   * pair (OStream sink / IStream feed); `Code generator` is the §6.1.1
   * generated-object path.
   */
  const usage = chapter("Usage");

  it.each([
    "Serialize",
    "Serialize stream",
    "Deserialize",
    "Deserialize stream",
    "Code generator",
  ])("Usage shows '%s'", (want) => {
    expect(usage.split("\n")).toContain(`### ${want}`);
  });
});

describe("§6.4 string validity (Unicode-string target: no knob to check)", () => {
  it("states that this port is always strict", () => {
    expect(README).toMatch(/always strict/);
  });

  it("names the lossy platform encoders §6.4 calls out for JavaScript", () => {
    // "Beware that platform default encoders are often lossy — … JavaScript's
    // `TextEncoder` replace unpaired surrogates with U+FFFD — use the
    // strict/fatal variants."
    expect(README).toContain("TextDecoder");
    expect(README).toMatch(/U\+FFFD/);
    expect(README).toMatch(/unpaired surrogate/i);
    expect(README).toMatch(/fatal/);
  });
});

describe("§9.6 the memory chapter", () => {
  /**
   * §9.6 puts MIN_OUTPUT_BUFFER in the memory chapter specifically: it is the
   * number a caller needs before it can size a streaming buffer, and the memory
   * chapter is where they go to find out who allocates what, so stating it
   * elsewhere does not reach them.
   */
  it("states MIN_OUTPUT_BUFFER", () => {
    expect(chapter("Memory handling")).toContain("MIN_OUTPUT_BUFFER");
  });
});

describe("§6.1.1 the closed generated-object name set", () => {
  /**
   * §6.1.1 closes the generated-object layer to encode / decode / try_decode /
   * serialize / deserialize / decoder, and lists the spellings a port must not
   * invent beside them. Teaching one in the docs sends a reader looking for a
   * surface sofabgen does not emit — as effectively as emitting it would.
   *
   * Both the plan's snake_case spellings and this language's casing are
   * rejected, with one deliberate exception: `decodeFrom`, which the README's
   * generated-code example shows because **sofabgen emits it** for TypeScript
   * (`Point.decode` delegates to it to share one cursor across a nested
   * message). §9 requires the README to match the code as it stands, so that
   * name is the generator's to settle, not this document's; a guard that
   * rejected it here would only push the README into documenting a method that
   * does not exist.
   */
  it.each([
    "marshal",
    "unmarshal",
    "serialize_to",
    "serializeTo",
    "to_bytes",
    "toBytes",
    "from_bytes",
    "fromBytes",
    "decode_from",
    "decode_into",
    "decodeInto",
  ])("never spells %s", (bad) => {
    const hits = README.split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => new RegExp(`\\b${bad}\\b`).test(line));
    expect(hits, `a name outside the closed generated-object set: ${bad}`).toStrictEqual([]);
  });
});

describe("in-document links", () => {
  /**
   * A heading that moves takes its anchor with it. That is the cheapest way for
   * a restructuring to break navigation while breaking nothing a build sees.
   */
  const anchors = new Set(HEADINGS.map((h) => anchor(h.text)));
  const links = [...README.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!);

  it("exist at all (else the scan is broken)", () => {
    expect(links.length).toBeGreaterThan(0);
  });

  it("every one resolves to a heading", () => {
    expect(links.filter((l) => !anchors.has(l))).toStrictEqual([]);
  });
});
