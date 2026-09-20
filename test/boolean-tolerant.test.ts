/**
 * The shared `boolean_tolerant` block — CORELIB_PLAN §4.4.
 *
 * > **Canonical on encode, tolerant on decode.** An encoder **MUST** write `true`
 * > as `1`. A decoder **MUST** read **every value other than `0`** as `true`: such
 * > a value is **not** `INVALID` (§5.2), it is normalized away, and a re-encode
 * > emits `1`.
 *
 * A boolean has no wire type of its own — it is an unsigned integer (`0b000`), and
 * a boolean array rides the unsigned-varint array (`0b011`). So every byte string
 * in this block is ordinary, well-formed wire; what is under test is only how the
 * **boolean surface** interprets it, and what it emits back.
 *
 * The positive vectors cannot reach this half of §4.4: their bytes come from
 * replaying `fields` through a conforming encoder, and a conforming encoder never
 * writes a non-canonical boolean. `2`, `256` and `2^64-1` at a boolean position
 * only ever arrive from *someone else's* encoder — hence a hand-authored block,
 * decode-then-re-encode only.
 *
 * **Three defects, three different assertions**, and no two of them overlap:
 *
 * | the defect | what it does | caught by |
 * |---|---|---|
 * | rejection | answers `INVALID` for `256`, treating a boolean as a 1-byte type | the outcome check |
 * | truncation | masks the varint to the destination width *before* the zero test, so `256` becomes **false** | the value check — the outcome is `complete` and looks perfect |
 * | no normalization | stores the raw `2` | the **re-encode** check — the outcome passes, and so does any "is it true?" test, because `2` is true under every truthiness rule in every language |
 *
 * A runner that asserts only the outcome certifies a decoder that violates §4.4 in
 * two of the three ways; one that adds a *truthy* value check still certifies the
 * third. All three are asserted below, per case.
 *
 * **Where the boolean surface is in this port.** The codec has a boolean *write*
 * surface for both shapes (`writeBoolean`; an array goes out through
 * `writeUnsignedArray` over the normalized bytes) and a boolean *read* surface for
 * an array — {@link BoolArrayTarget}, a `Uint8Array` of one byte per element that
 * the decoder fills with `1` for any non-zero, which is exactly §4.4's
 * normalization performed inside the codec. A **scalar** boolean has no callback
 * of its own: it arrives on {@link Visitor.unsigned} with its full 64 bits, as
 * `value` and as the two halves, and the `!== 0` test is the generated layer's.
 * The runner therefore performs that one test itself for a scalar case — and
 * asserts the two representations agree first, so a decoder that truncated either
 * one fails here rather than being normalized into looking right.
 *
 * That is the one place this file is weaker than a port with a scalar boolean
 * reader, and it is a property of the surface, not of the runner: there is no
 * narrower destination for the codec to truncate *into*, because it never stores a
 * scalar at all.
 */

import { describe, expect, it } from "vitest";
import {
  ArrayKind,
  DecodeStatus,
  IStream,
  type OStream,
  SofabError,
  SofabErrorCode,
  growingOStream,
  type FeedStatus,
  type Visitor,
} from "../src/index.js";
import { bytesToHex, hexToBytes } from "./helpers/hex.js";
import { reportingTally } from "./helpers/vector-tally.js";
import {
  loadBooleanTolerantCases,
  missingBlockCapabilities,
  unknownBlockCapabilityTags,
  type BooleanTolerantCase,
} from "./helpers/vectors.js";

const cases = loadBooleanTolerantCases();
const tally = reportingTally("boolean-tolerant");
tally.found(cases.length);

/**
 * The byte an untouched destination slot keeps: neither `0`, nor `1`, nor any
 * legal boolean representation.
 *
 * Without it a decoder that never writes the destination passes
 * `boolean_tolerant_zero` against a zero-filled buffer — green, and having tested
 * nothing for that case.
 */
const POISON = 0xaa;

/** Which cases the run actually exercised, on either path — asserted at the end. */
const observed = { decoded: new Set<string>(), rejected: new Set<string>() };

/**
 * What one decode delivered — recorded by the visitor, asserted **after** `feed`
 * returns.
 *
 * Never asserted from inside a callback: an expectation that throws there is
 * raised out of the decoder's own call stack, which can leave the stream latched
 * for a reason the test did not intend and reports the failure at the wrong place.
 */
interface Seen {
  /** How often the case's field was delivered — exactly one is required. */
  deliveries: number;
  /**
   * A **scalar** case's raw 64 bits, both ways the callback offers them.
   * `undefined` until the field arrives, which is this shape's poison: neither
   * `true` nor `false`, so a decoder that delivers nothing cannot pass.
   */
  scalar?: { value: number | bigint; lo: number; hi: number };
  /** An **array** case's destination: one normalized byte per element, poisoned. */
  bytes?: Uint8Array;
  /** What the array header declared, for the §13 cross-check against the block. */
  array?: { kind: ArrayKind; count: number };
}

/** A fresh, poisoned destination for one case — never shared with another. */
function freshSeen(c: BooleanTolerantCase): Seen {
  const n = c.expect.values.length;
  return n === 1 ? { deliveries: 0 } : { deliveries: 0, bytes: new Uint8Array(n).fill(POISON) };
}

/**
 * The visitor that materializes field `c.id` through the boolean surface —
 * the array destination for a multi-value case, the unsigned callback (this
 * port's scalar boolean surface) for a single-value one.
 */
function booleanReader(c: BooleanTolerantCase, seen: Seen): Visitor {
  if (seen.bytes === undefined) {
    return {
      unsigned(id, value, lo, hi) {
        if (id !== c.id) return;
        seen.deliveries++;
        seen.scalar = { value, lo, hi };
      },
    };
  }
  const dest = seen.bytes;
  return {
    arrayBegin(id, kind, count) {
      if (id === c.id) seen.array = { kind, count };
    },
    // The `bool` destination is the codec's own boolean read surface: it carries
    // no element bound (§4.4 gives a boolean no width), and the decoder writes
    // `1` for any non-zero rather than storing the value raw.
    arrayBulk: (id) => (id === c.id ? { bool: dest } : null),
    arrayEnd(id) {
      if (id === c.id) seen.deliveries++;
    },
  };
}

/** Feed one case's bytes to a fresh stream, in chunks of `chunk` bytes. */
function feed(
  c: BooleanTolerantCase,
  seen: Seen,
  chunk: number,
): { status?: FeedStatus; error?: SofabError } {
  const bytes = hexToBytes(c.serialized_hex);
  const stream = new IStream(booleanReader(c, seen));
  try {
    let status = stream.feed(bytes.subarray(0, chunk));
    for (let i = chunk; i < bytes.length; i += chunk) {
      status = stream.feed(bytes.subarray(i, i + chunk));
    }
    return { status };
  } catch (e) {
    if (e instanceof SofabError) return { error: e };
    throw e;
  }
}

/** The normalized bytes the case states: `0` for a `false`, `1` for a `true`. */
function wanted(c: BooleanTolerantCase): number[] {
  return c.expect.values.map((v) => (v ? 1 : 0));
}

/**
 * The decode's result in the shape both halves of the check need: the bytes the
 * destination now holds, and how to write exactly those back out.
 *
 * The re-encode is driven from **here**, never from `expect.values`: feeding the
 * JSON expectation into the encoder would match `reencoded_hex` for every case
 * while leaving the decode half unverified.
 */
function decoded(
  c: BooleanTolerantCase,
  seen: Seen,
): { bytes: number[]; writeBack: (os: OStream) => void } {
  if (seen.bytes !== undefined) {
    const dest = seen.bytes;
    return { bytes: [...dest], writeBack: (os) => os.writeUnsignedArray(c.id, dest) };
  }
  expect(seen.scalar, `${c.name}: field ${c.id} was never delivered`).toBeDefined();
  const s = seen.scalar!;
  // The two representations of the same 64 bits, each tested against zero on its
  // own. A decoder that truncated one of them is caught by their disagreement
  // even where the other still says `true` — and where it truncated both, the
  // value comparison against `wanted()` catches it.
  const byHalves = s.lo !== 0 || s.hi !== 0;
  const byValue = typeof s.value === "bigint" ? s.value !== 0n : s.value !== 0;
  expect(byHalves, `${c.name}: the delivered value and its halves disagree`).toBe(byValue);
  return {
    bytes: [byValue ? 1 : 0],
    writeBack: (os) => os.writeBoolean(c.id, byValue),
  };
}

/** Assert the positive outcome and the normalized values, and return the result. */
function decodeAndCheck(c: BooleanTolerantCase, chunk: number): ReturnType<typeof decoded> {
  // Read the stated outcome rather than assuming it, so a case that ever carries
  // another one fails loudly instead of being silently mis-run.
  expect(c.expect.outcome, `${c.name}: this runner only knows the 'complete' outcome`).toBe(
    "complete",
  );
  const seen = freshSeen(c);
  const { status, error } = feed(c, seen, chunk);

  // A tolerated value is not a rejected one: §4.4 forbids `INVALID` here, and an
  // `INCOMPLETE` left at the end of the bytes is just as wrong.
  expect(error, `${c.name}: ${c.description}`).toBeUndefined();
  expect(status, `${c.name}: ${c.description}`).toBe(DecodeStatus.Complete);
  expect(seen.deliveries, `${c.name}: field ${c.id} arrived ${seen.deliveries} times`).toBe(1);
  if (seen.bytes !== undefined) {
    // The wire count is the block's element count — a decoder delivering fewer
    // elements than the header declares would otherwise leave poison behind and
    // be reported as a value mismatch rather than as what it is.
    expect(seen.array).toStrictEqual({
      kind: ArrayKind.Unsigned,
      count: c.expect.values.length,
    });
  }

  const got = decoded(c, seen);
  // Every slot holds exactly `0` or `1` — not "something truthy". This is where a
  // decoder that masked `256` into a byte before testing it fails: the outcome
  // above is `complete` and the value here is `false`.
  expect(got.bytes, `${c.name}: ${c.description}`).toStrictEqual(wanted(c));
  return got;
}

/**
 * The reject path: what an **unsatisfied** `requires` tag means in this block.
 *
 * It is the vectors' rule, not `header_limits`': §4.4 lifts the width bound the
 * *type* carries, never the one a *build* has, so under a narrowed accumulator
 * (§6.2.2 "scalar value width 32-bit") a boolean carrying `2^64-1` overflows
 * before any boolean rule can apply, and `INVALID` is the conformant answer
 * (§5.2.2). Skipping the case would assert nothing at all — in exactly the build
 * most likely to truncate.
 *
 * Unreachable in this port, which ships one full-featured profile and satisfies
 * every tag (`PORT_CAPABILITIES` in `vectors.ts`). It is written anyway, so the day
 * a reduced profile appears the block is already correct for it.
 */
function expectRejected(c: BooleanTolerantCase): void {
  const invalid = expect.objectContaining({ code: SofabErrorCode.InvalidMsg });
  // A handler that binds nothing: what is asserted is the verdict, not which
  // fields arrived before the offending one.
  const stream = new IStream({});
  expect(() => stream.feed(hexToBytes(c.serialized_hex)), c.description).toThrow(invalid);
  // And terminal: a verdict a later feed lifts is a defect in its own right.
  expect(() => stream.feed(Uint8Array.of(0x00)), `${c.name}: the rejection is not terminal`).toThrow(
    invalid,
  );
}

describe("boolean tolerance (§4.4)", () => {
  it("has the shared cases to run", () => {
    // A floor, never an equality: the block may grow upstream. A vector file
    // predating it yields `[]` here, and every `describe.each` below would then
    // run nothing at all and pass.
    expect(cases.length).toBeGreaterThanOrEqual(8);
  });

  it("knows every capability tag the block uses", () => {
    // An unrecognised tag must not gate a case out: the reference runner treats it
    // as contributing nothing to the needed set, so the case runs positively. This
    // is where adopting a file with a new tag becomes a deliberate decision.
    expect(unknownBlockCapabilityTags(cases)).toEqual([]);
  });

  it("carries both halves of the rule", () => {
    // Scalar *and* array. A runner that quietly filtered on `values.length === 1`
    // would lose the element-level half of §4.4 and stay green.
    expect(cases.filter((c) => c.expect.values.length === 1).length).toBeGreaterThanOrEqual(5);
    expect(cases.filter((c) => c.expect.values.length > 1).length).toBeGreaterThanOrEqual(2);
  });

  it("carries the truncation trap on both sides of one byte", () => {
    // 255 and 256 sit one step apart on purpose: the pair is what separates "reads
    // wide varints" from "truncates to the destination width". Neither alone does.
    const hexes = new Set(cases.map((c) => c.serialized_hex));
    expect(hexes, "the largest one-byte value").toContain("00ff01");
    expect(hexes, "the first value that does not fit one byte").toContain("008002");
  });

  describe.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const missing = missingBlockCapabilities(c);

    if (missing.length === 0) {
      it("decodes to the normalized values", () => {
        tally.vector(c.name);
        observed.decoded.add(c.name);
        decodeAndCheck(c, Number.MAX_SAFE_INTEGER);
        tally.check();
      });

      it("re-encodes what it decoded, canonically", () => {
        // Against `reencoded_hex`, never against `serialized_hex`: for the first
        // two cases the two are identical and for the rest they differ, and that
        // difference *is* §4.4's "a re-encode emits 1". Full bytes, not a length:
        // `0002` and `0001` are the same length.
        const os = growingOStream();
        decodeAndCheck(c, Number.MAX_SAFE_INTEGER).writeBack(os);
        const out = os.bytes();
        expect(bytesToHex(out), `${c.name}: ${c.description}`).toBe(c.expect.reencoded_hex);
        expect(out.length).toBe(c.expect.reencoded_hex.length / 2);
        tally.check();
      });

      it("decodes the same one byte at a time", () => {
        // The varints of the two `u64_max` cases are ten bytes long, so this is
        // where a value accumulator that does not survive a feed boundary shows.
        // Same values, same terminal outcome, whatever the chunking.
        expect(decodeAndCheck(c, 1).bytes).toStrictEqual(wanted(c));
        tally.check();
      });
    } else {
      // Unreachable here — see `expectRejected`. The gate is present so a reduced
      // profile is a configuration change rather than a rewrite.
      it(`rejects the message, needing ${missing.join("+")}`, () => {
        tally.rejectedCase(c.name);
        observed.rejected.add(c.name);
        expectRejected(c);
        tally.check();
      });
    }
  });

  it("ran every case the block carries", () => {
    // found = decoded + rejected, with nothing skipped and nothing counted twice.
    // Every way of running less of this block than the file holds — a stale copy,
    // a tagged case dropped, a scalar-only filter — lands here.
    expect(cases.length).toBeGreaterThan(0);
    expect(observed.decoded.size + observed.rejected.size).toBe(cases.length);
    expect(observed.rejected.size, "this port satisfies every tag the block uses").toBe(0);
  });
});
