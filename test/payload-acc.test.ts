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
import { PayloadAcc, SofabError, SofabErrorCode } from "../src/index.js";

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

/**
 * `takeInto` — the same join, into a buffer the caller already holds, for a decode
 * into a reused destination (ARCHITECTURE §8).
 *
 * Two things make it worth its own block. The buffer is the **caller's**, so
 * identity is the assertion that matters: a method that quietly allocated after
 * all would pass every structural check and lose the whole point. And the split
 * path is the one a caller cannot write for itself, so it gets the same treatment
 * `take` gets above — cut at every offset, one answer.
 */
describe("PayloadAcc.takeInto writes into a buffer the caller owns", () => {
  const p = payload(11);

  /** `feedSplit`'s twin: the pieces go into `dst`, which must come back. */
  function feedSplitInto(dst: Uint8Array, src: Uint8Array, cuts: number[]): Uint8Array {
    const acc = new PayloadAcc();
    const bounds = [0, ...cuts, src.length];
    const done: Uint8Array[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const from = bounds[i]!;
      const got = acc.takeInto(dst, src.length, from, src, from, bounds[i + 1]!);
      if (got !== null) done.push(got);
    }
    expect(done, `cuts at ${cuts.join(",")}`).toHaveLength(1);
    return done[0]!;
  }

  it("returns the destination itself, not a copy of it", () => {
    const acc = new PayloadAcc();
    const dst = new Uint8Array(p.length);
    const got = acc.takeInto(dst, p.length, 0, p, 0, p.length);
    expect(got).toBe(dst);
    expect([...dst]).toStrictEqual([...p]);
  });

  it("is unaffected by where the payload is cut — every offset 0..n", () => {
    for (let cut = 0; cut <= p.length; cut++) {
      const dst = new Uint8Array(p.length);
      expect(feedSplitInto(dst, p, [cut]), `cut at ${cut}`).toBe(dst);
      expect([...dst], `cut at ${cut}`).toStrictEqual([...p]);
    }
  });

  it("joins a byte-at-a-time feed into the same buffer", () => {
    const acc = new PayloadAcc();
    const dst = new Uint8Array(p.length);
    const seen: (Uint8Array | null)[] = [];
    for (let i = 0; i < p.length; i++) seen.push(acc.takeInto(dst, p.length, i, p, i, i + 1));
    expect(seen.slice(0, -1).every((x) => x === null)).toBe(true);
    expect(seen[seen.length - 1]).toBe(dst);
    expect([...dst]).toStrictEqual([...p]);
  });

  it("copies out of the fed chunk, so a reused chunk cannot corrupt the join", () => {
    const acc = new PayloadAcc();
    const dst = new Uint8Array(p.length);
    const scratch = new Uint8Array(4);
    scratch.set(p.subarray(0, 4));
    expect(acc.takeInto(dst, p.length, 0, scratch, 0, scratch.length)).toBeNull();
    scratch.fill(0xee);
    expect(acc.takeInto(dst, p.length, 4, p, 4, p.length)).toBe(dst);
    expect([...dst]).toStrictEqual([...p]);
  });

  it("refuses a destination that is not the payload's length — ARGUMENT, nothing copied", () => {
    // §6.6.3 / §6.3's third row: a destination that does not fit the value is a
    // caller mistake, not a verdict about the message. `!==` rather than `<`,
    // because the buffer's length *is* the payload's length — a longer one handed
    // back would overstate it, and a view of it would alias storage the caller
    // still owns.
    const acc = new PayloadAcc();
    for (const size of [p.length - 1, p.length + 1]) {
      const dst = new Uint8Array(size);
      let code: SofabErrorCode | undefined;
      try {
        acc.takeInto(dst, p.length, 0, p, 0, p.length);
      } catch (e) {
        expect(e).toBeInstanceOf(SofabError);
        code = (e as SofabError).code;
      }
      expect(code, `destination of ${size}`).toBe(SofabErrorCode.Argument);
      expect([...dst].every((b) => b === 0), `destination of ${size}`).toBe(true);
    }
    // …and the accumulator is still usable afterwards: nothing was started.
    const dst = new Uint8Array(p.length);
    expect(acc.takeInto(dst, p.length, 0, p, 0, p.length)).toBe(dst);
  });

  it("ignores a fragment with no payload in progress, leaving the destination alone", () => {
    const acc = new PayloadAcc();
    const dst = new Uint8Array(8);
    expect(acc.takeInto(dst, 8, 4, payload(4), 0, 4)).toBeNull();
    expect([...dst].every((b) => b === 0)).toBe(true);
  });

  it("starts clean after a payload was abandoned part-way, in either direction", () => {
    // What an INVALID field or a declined subtree leaves behind, now that two
    // entry points share the accumulator: `offset === 0` adopts a buffer and
    // resets, whichever of the two started the payload that was dropped.
    const acc = new PayloadAcc();
    const abandoned = new Uint8Array(9);
    expect(acc.takeInto(abandoned, 9, 0, payload(9), 0, 5)).toBeNull();
    const next = payload(4);
    expect([...acc.take(4, 0, next, 0, next.length)!]).toStrictEqual([...next]);

    expect(acc.take(9, 0, payload(9), 0, 5)).toBeNull();
    const dst = new Uint8Array(4);
    expect(acc.takeInto(dst, 4, 0, next, 0, next.length)).toBe(dst);
    expect([...dst]).toStrictEqual([...next]);
  });

  it("trims a chunk that runs past the declared total", () => {
    const acc = new PayloadAcc();
    const dst = new Uint8Array(4);
    expect(acc.takeInto(dst, 4, 0, p, 0, p.length)).toBe(dst);
    expect([...dst]).toStrictEqual([...p.subarray(0, 4)]);
  });

  it("does not clobber a finished payload with the next one", () => {
    const acc = new PayloadAcc();
    const first = new Uint8Array(6);
    const bytes = payload(6);
    expect(acc.takeInto(first, 6, 0, bytes, 0, 3)).toBeNull();
    expect(acc.takeInto(first, 6, 3, bytes, 3, 6)).toBe(first);
    const second = new Uint8Array(6);
    acc.takeInto(second, 6, 0, payload(6).map((b) => b ^ 0xff), 0, 6);
    expect([...first]).toStrictEqual([...bytes]);
  });

  it("returns a zero-length payload as the empty destination", () => {
    const acc = new PayloadAcc();
    const dst = new Uint8Array(0);
    expect(acc.takeInto(dst, 0, 0, new Uint8Array(0), 0, 0)).toBe(dst);
  });
});
