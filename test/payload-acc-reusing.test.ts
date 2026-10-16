/**
 * `PayloadAcc.takeReusing` — the one choice a decode into a reused destination
 * makes per payload: write over the buffer the previous decode left when it is
 * exactly the payload's length, allocate when it is not (or there is none), and
 * never refuse. Split at every offset, like the rest of the accumulator's tests.
 */

import { describe, expect, it } from "vitest";
import { PayloadAcc } from "../src/index.js";

function payload(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 7 + 1) & 0xff);
}

describe("PayloadAcc.takeReusing", () => {
  it("writes into the kept buffer when it is exactly the payload's length", () => {
    const p = payload(9);
    const kept = new Uint8Array(9);
    for (let cut = 0; cut <= 9; cut++) {
      const acc = new PayloadAcc();
      kept.fill(0xee);
      expect(acc.takeReusing(kept, 9, 0, p, 0, cut), `cut ${cut}`).toBe(cut === 9 ? kept : null);
      if (cut < 9) expect(acc.takeReusing(kept, 9, cut, p, cut, 9), `cut ${cut}`).toBe(kept);
      expect([...kept], `cut ${cut}`).toStrictEqual([...p]);
    }
  });

  it("allocates, and leaves the kept buffer alone, when the length differs or there is none", () => {
    const p = payload(5);
    for (const kept of [new Uint8Array(4).fill(0xee), new Uint8Array(6).fill(0xee), null]) {
      const acc = new PayloadAcc();
      expect(acc.takeReusing(kept, 5, 0, p, 0, 2)).toBe(null);
      const done = acc.takeReusing(kept, 5, 2, p, 2, 5);
      expect(done).not.toBe(kept);
      expect([...done!]).toStrictEqual([...p]);
      if (kept !== null) expect(kept.every((b) => b === 0xee)).toBe(true);
    }
  });

  it("takes an empty payload into an empty kept buffer", () => {
    const kept = new Uint8Array(0);
    expect(new PayloadAcc().takeReusing(kept, 0, 0, new Uint8Array(0), 0, 0)).toBe(kept);
  });
});
