/**
 * `PayloadAcc` — joining a `string` / `blob` payload the push decoder delivered
 * in pieces.
 *
 * This is the helper the shared vectors cannot check. Where a payload is split
 * is a property of how the caller fed the bytes, not of the bytes, so an
 * accumulator that mishandles a boundary still produces byte-identical output on
 * every vector in the suite; the family already has one documented blind spot of
 * exactly this shape (the `invalid_utf8` vectors never reach an offset at or past
 * the payload total). Hence the central test below: **split one payload at every
 * offset `0..n` and require an identical result**, plus byte-at-a-time and
 * every two-cut split.
 *
 * The other properties pinned here are the ones a caller depends on and cannot
 * see: that even a whole-in-one-piece payload is copied rather than aliased
 * (§6.7), that a
 * completed payload is not clobbered by the next one, that `offset === 0` clears
 * whatever an abandoned field left behind, and that a fragment with no payload in
 * progress allocates nothing at all — including when it claims two billion bytes.
 */

import { describe, expect, it } from "vitest";
import { PayloadAcc } from "../src/index.js";

/** `n` distinct bytes, so a mis-ordered join cannot pass by accident. */
function payload(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 7 + 1) & 0xff);
}

/**
 * Feed `p` through a fresh accumulator, cut at the offsets in `cuts`, and return
 * the payload it completed with.
 *
 * Completion is signalled **exactly once**, which is asserted here rather than
 * assumed: a caller acts on the non-null return and ignores the nulls, so an
 * accumulator that announced the same payload twice would place an element
 * twice, and one that announced it never would drop the field silently.
 */
function feedSplit(p: Uint8Array, cuts: number[]): Uint8Array {
  const acc = new PayloadAcc();
  const bounds = [0, ...cuts, p.length];
  const done: Uint8Array[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i]!;
    const got = acc.take(p.length, from, p, from, bounds[i + 1]!);
    if (got !== null) done.push(got);
  }
  expect(done, `cuts at ${cuts.join(",")}`).toHaveLength(1);
  return done[0]!;
}

describe("PayloadAcc joins a split payload", () => {
  const p = payload(11);

  it("copies even when the payload arrives whole — it never aliases the input", () => {
    const acc = new PayloadAcc();
    const got = acc.take(p.length, 0, p, 0, p.length)!;
    // §6.7: "there is no mode in which the destination aliases the input". The
    // whole-in-one-piece path is where a port is tempted to hand the input back,
    // and a caller that stored the result would then watch it rot when the next
    // `feed` reuses the buffer.
    expect(got).not.toBe(p);
    expect([...got]).toStrictEqual([...p]);
    const before = [...got];
    p.fill(0xee);
    expect([...got]).toStrictEqual(before);
  });

  it("is unaffected by where the payload is cut — every offset 0..n", () => {
    for (let cut = 0; cut <= p.length; cut++) {
      expect([...feedSplit(p, [cut])], `cut at ${cut}`).toStrictEqual([...p]);
    }
  });

  it("is unaffected by a two-cut split, for every pair of offsets", () => {
    for (let a = 0; a <= p.length; a++) {
      for (let b = a; b <= p.length; b++) {
        expect([...feedSplit(p, [a, b])], `cuts at ${a},${b}`).toStrictEqual([...p]);
      }
    }
  });

  it("joins a byte-at-a-time feed, reporting null until the last byte", () => {
    const acc = new PayloadAcc();
    const seen: (Uint8Array | null)[] = [];
    for (let i = 0; i < p.length; i++) seen.push(acc.take(p.length, i, p, i, i + 1));
    expect(seen.slice(0, -1).every((x) => x === null)).toBe(true);
    expect([...seen[seen.length - 1]!]).toStrictEqual([...p]);
  });

  it("copies out of the fed chunk, so a reused chunk cannot corrupt the join", () => {
    // CORELIB_PLAN §6.0: a fed chunk is reusable the moment `feed` returns, and a
    // streaming caller reuses one buffer.
    const acc = new PayloadAcc();
    const scratch = new Uint8Array(4);
    scratch.set(p.subarray(0, 4));
    expect(acc.take(p.length, 0, scratch, 0, scratch.length)).toBeNull();
    scratch.fill(0xee);
    scratch.set(p.subarray(4, 8));
    expect(acc.take(p.length, 4, scratch, 0, scratch.length)).toBeNull();
    scratch.fill(0xee);
    const got = acc.take(p.length, 8, p, 8, p.length);
    expect([...got!]).toStrictEqual([...p]);
  });

  it("returns a zero-length payload as an empty result", () => {
    const acc = new PayloadAcc();
    const got = acc.take(0, 0, new Uint8Array(0), 0, 0);
    expect(got).not.toBeNull();
    expect(got!.length).toBe(0);
  });

  it("trims a chunk that runs past the declared total", () => {
    const acc = new PayloadAcc();
    const got = acc.take(4, 0, p, 0, p.length);
    expect([...got!]).toStrictEqual([...p.subarray(0, 4)]);
  });

  it("trims a continuation chunk to the room that is left", () => {
    // The joined path's version of the same guard: without it the copy would
    // leave the corelib as a platform RangeError rather than a SofabError.
    const acc = new PayloadAcc();
    expect(acc.take(6, 0, p, 0, 3)).toBeNull();
    const got = acc.take(6, 3, p, 3, 9);
    expect([...got!]).toStrictEqual([...p.subarray(0, 6)]);
  });
});

describe("PayloadAcc keeps consecutive payloads apart", () => {
  it("does not clobber a finished payload with the next one", () => {
    const acc = new PayloadAcc();
    const first = payload(6);
    expect(acc.take(6, 0, first, 0, 3)).toBeNull();
    const a = acc.take(6, 3, first, 3, first.length)!;
    const second = payload(6).map((b) => b ^ 0xff);
    expect(acc.take(6, 0, second, 0, 3)).toBeNull();
    acc.take(6, 3, second, 3, second.length);
    expect([...a]).toStrictEqual([...first]);
  });

  it("starts clean after a payload was abandoned part-way", () => {
    // What an INVALID field or a skipped subtree leaves behind: half a payload
    // and no completion. The next `offset === 0` must reset rather than append.
    const acc = new PayloadAcc();
    const abandoned = payload(9);
    expect(acc.take(9, 0, abandoned, 0, 5)).toBeNull();
    const next = payload(4);
    const got = acc.take(4, 0, next, 0, next.length);
    expect([...got!]).toStrictEqual([...next]);
  });

  it("ignores a fragment with no payload in progress", () => {
    const acc = new PayloadAcc();
    expect(acc.take(8, 4, payload(4), 0, 4)).toBeNull();
    // …and the accumulator is still usable for a real payload afterwards.
    const p = payload(3);
    expect([...acc.take(3, 0, p, 0, p.length)!]).toStrictEqual([...p]);
  });

  it("allocates nothing for a two-billion-byte claim it never starts", () => {
    // The adversarial shape: a length word near 2^31 that no bound rejected.
    // Nothing is sized until a payload actually starts at offset 0, so a
    // fragment claiming one must return null rather than reserve the buffer.
    const acc = new PayloadAcc();
    expect(acc.take(2 ** 31 - 1, 1, Uint8Array.of(1, 2, 3), 0, 3)).toBeNull();
  });
});
