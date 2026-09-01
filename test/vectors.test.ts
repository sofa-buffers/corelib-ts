/**
 * Cross-language conformance: encode and decode every shared test vector.
 *
 * For each vector we (1) replay its field list and assert the bytes equal the
 * reference hex, and (2) decode the reference hex, re-encode what we read, and
 * assert it reproduces the same hex — proving the decoder read every field,
 * value and length correctly.
 */

import { describe, expect, it } from "vitest";
import { OStream, decode, growingOStream } from "../src/index.js";
import { bytesToHex, hexToBytes } from "./helpers/hex.js";
import { TranscodeVisitor } from "./helpers/recording-visitor.js";
import { reportingTally } from "./helpers/vector-tally.js";
import {
  encodeFields,
  loadVectors,
  missingCapabilities,
  unknownCapabilityTags,
} from "./helpers/vectors.js";

const vectors = loadVectors();
const tally = reportingTally("vectors");

describe("conformance vectors", () => {
  it("loads the shared suite", () => {
    // The file is copied verbatim from corelib-c-cpp (§7.1/§8) and currently
    // holds 131 vectors. Asserted as a floor, so a stale or truncated copy fails
    // here instead of quietly testing less.
    expect(vectors.length).toBeGreaterThanOrEqual(131);
  });

  it("knows every capability tag the file uses", () => {
    // An unrecognised `requires` tag counts as unsupported and would gate its
    // vectors out — silently running less of the suite. Fail here instead, so
    // adopting a file with a new tag is a decision this port takes deliberately.
    expect(unknownCapabilityTags(vectors)).toEqual([]);
  });

  describe.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    const missing = missingCapabilities(vector);
    if (missing.length > 0) tally.gatedOut(vector.name, missing);

    // A vector needing a feature this build cannot represent is *reported* as
    // gated out, never dropped silently (`requires`, test_vectors_README.md).
    // This port ships one full-featured profile, so nothing is ever gated.
    describe.skipIf(missing.length > 0)("runs", () => {
      it("encodes to the reference bytes", () => {
        tally.vector(vector.name);
        const os = growingOStream();
        encodeFields(os, vector.fields);
        expect(bytesToHex(os.bytes())).toBe(vector.serialized.hex);
        tally.check();
      });

      // The shape CORELIB_PLAN §5.1 puts first: one caller buffer sized from the
      // schema's MAX_SIZE, with no owner and no sink. It reaches the wire through
      // different code than the accumulator above — a bulk string / array write is
      // taken only where the payload already fits where the cursor stands and
      // falls back to the element-at-a-time route where it does not — so both
      // routes are pinned against the reference bytes here: `0` slack is an
      // exactly-MAX_SIZE buffer (which cannot take a worst-case array reserve, so
      // the fallback runs), `4096` a roomy one (the bulk route throughout).
      it.each([0, 4096])("encodes to the reference bytes in a caller buffer (+%i)", (slack) => {
        const want = hexToBytes(vector.serialized.hex);
        const os = new OStream(new Uint8Array(want.length + slack));
        encodeFields(os, vector.fields);
        expect(bytesToHex(os.bytes())).toBe(vector.serialized.hex);
        tally.check();
      });

      it("decodes and round-trips back to the reference bytes", () => {
        const out = growingOStream();
        decode(hexToBytes(vector.serialized.hex), new TranscodeVisitor(out));
        expect(bytesToHex(out.bytes())).toBe(vector.serialized.hex);
        tally.check();
      });
    });
  });
});

/**
 * The loader must carry the file's largest constructs through at full size.
 *
 * The upstream C harness had a fixed `MAXSKIP` that *truncated* an over-long
 * `skip_ids` list: the extra ids were read instead of skipped, so the vector
 * still passed while testing less than it claimed (corelib-c-cpp#160). Nothing
 * here has a fixed bound — JSON arrays become JS arrays — but "nothing has a
 * bound" is a claim worth pinning, so this asserts the concrete sizes the skip
 * vectors need, on the loaded objects rather than on the file.
 */
describe("vector loader fidelity", () => {
  const skipLists = vectors.flatMap((v) => (v.skip_ids ? [v.skip_ids] : []));

  it("keeps the longest skip_ids list whole", () => {
    expect(Math.max(...skipLists.map((ids) => ids.length))).toBeGreaterThanOrEqual(9);
  });

  it("keeps large field ids exactly", () => {
    const ids = vectors.flatMap((v) => v.fields.map((f) => f.id ?? 0));
    expect(Math.max(...ids)).toBeGreaterThanOrEqual(100001);
  });

  it("keeps long arrays and payloads whole", () => {
    const counts = vectors.flatMap((v) =>
      v.fields.filter((f) => f.op === "array").map((f) => f.values!.length),
    );
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(130);

    const payloads = vectors.flatMap((v) =>
      v.fields.map((f) =>
        f.op === "string"
          ? new TextEncoder().encode(f.value as string).length
          : f.op === "blob"
            ? f.value_hex!.length / 2
            : 0,
      ),
    );
    expect(Math.max(...payloads)).toBeGreaterThanOrEqual(130);
  });

  it("carries fp64 arrays, whose element length comes from the fixlen word", () => {
    const fp64Arrays = vectors.filter((v) =>
      v.fields.some((f) => f.op === "array" && f.element_type === "fp64"),
    );
    expect(fp64Arrays.length).toBeGreaterThan(0);
    expect(fp64Arrays.some((v) => v.skip_ids !== undefined)).toBe(true);
  });

  it("narrows ids to `number` while leaving values exact", () => {
    // Index-like numbers must be `number`: a `bigint` id silently matches no
    // decoded id at all, which is how a skip scenario can pass while skipping
    // nothing. Values keep their 64-bit fidelity as `bigint`.
    for (const ids of skipLists) for (const id of ids) expect(typeof id).toBe("number");
    for (const v of vectors) {
      expect(typeof v.serialized.length).toBe("number");
      for (const f of v.fields) if (f.id !== undefined) expect(typeof f.id).toBe("number");
    }
    const u64max = vectors
      .flatMap((v) => v.fields)
      .find((f) => f.op === "unsigned" && f.value === 18446744073709551615n);
    expect(u64max, "the u64 maximum vector is still exact").toBeDefined();
  });
});
