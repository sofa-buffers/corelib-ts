/**
 * {@link VisitorCache}: one visitor per destination, and nothing retained
 * (generator#775).
 *
 * Three promises, and each is a defect a caller would otherwise meet in
 * production rather than here: the hit returns the SAME visitor (a fresh one per
 * call is the allocation this class exists to remove), two destinations never
 * share one (a visitor is bound to its destination, so a shared one would decode
 * into the wrong message), and a destination the caller drops is collected with
 * its visitor (a module-level cache that holds the last message alive is
 * CORELIB_PLAN §6.6's "keep nothing of the caller's alive", read as liveness).
 */

import { describe, expect, it } from "vitest";
import { VisitorCache } from "../src/index.js";
import { survivors } from "./helpers/retention.js";

/** A destination and a visitor, as little of each as the cache can tell apart. */
class Dst {
  constructor(readonly name: string) {}
}
class Vis {
  constructor(readonly dst: Dst) {}
}

describe("VisitorCache", () => {
  it("builds one visitor per destination and keeps it", () => {
    let built = 0;
    const cache = new VisitorCache<Dst, Vis>((d) => {
      built++;
      return new Vis(d);
    });
    const a = new Dst("a");

    const first = cache.get(a);
    expect(built).toBe(1);
    expect(first.dst).toBe(a);

    for (let i = 0; i < 5; i++) expect(cache.get(a)).toBe(first);
    expect(built).toBe(1);
  });

  it("never hands one destination's visitor to another", () => {
    const cache = new VisitorCache<Dst, Vis>((d) => new Vis(d));
    const a = new Dst("a");
    const b = new Dst("b");

    const va = cache.get(a);
    const vb = cache.get(b);
    expect(vb).not.toBe(va);
    expect(va.dst).toBe(a);
    expect(vb.dst).toBe(b);

    // Alternating destinations, the two-buffer receive loop: each keeps its own.
    for (let i = 0; i < 3; i++) {
      expect(cache.get(a)).toBe(va);
      expect(cache.get(b)).toBe(vb);
    }
  });

  it("keeps a visitor whose destination the caller still holds", () => {
    const cache = new VisitorCache<Dst, Vis>((d) => new Vis(d));
    const held = new Dst("held");
    const v = cache.get(held);
    // Ask for 50 other destinations in between: a one-slot cache would have
    // evicted `held` and built a second visitor for it.
    for (let i = 0; i < 50; i++) cache.get(new Dst(`other${i}`));
    expect(cache.get(held)).toBe(v);
  });

  it("retains neither the destination nor its visitor", async () => {
    const cache = new VisitorCache<Dst, Vis>((d) => new Vis(d));
    expect(
      await survivors(() => {
        const d = new Dst("dropped");
        return { destination: d, visitor: cache.get(d) as object };
      }),
    ).toEqual([]);
  });
});
