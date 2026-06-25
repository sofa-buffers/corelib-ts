/**
 * A visitor implements only the field kinds it cares about; every other kind is
 * silently dropped. A fully empty visitor must consume any message without
 * throwing, and a partial visitor must see only the methods it defines.
 */

import { describe, expect, it } from "vitest";
import { OStream, decode, type Visitor } from "../src/index.js";

function everyKind(os: OStream): void {
  os.writeUnsigned(1, 7);
  os.writeSigned(2, -7);
  os.writeBoolean(3, true);
  os.writeFp32(4, 1.5);
  os.writeFp64(5, 2.5);
  os.writeString(6, "hi");
  os.writeBlob(7, Uint8Array.from([1, 2, 3]));
  os.writeUnsignedArray(8, [1, 2, 3]);
  os.writeSignedArray(9, [-1, -2]);
  os.writeFp32Array(10, [1, 2]);
  os.writeFp64Array(11, [3, 4]);
  os.writeSequenceBegin(12);
  os.writeUnsigned(1, 1);
  os.writeSequenceEnd();
}

describe("visitor defaults", () => {
  it("a no-op visitor silently drops every field kind", () => {
    const os = new OStream();
    everyKind(os);
    expect(() => decode(os.bytes(), {})).not.toThrow();
  });

  it("a partial visitor sees only the methods it defines", () => {
    const os = new OStream();
    everyKind(os);

    const seen: string[] = [];
    const visitor: Visitor = {
      unsigned: (id) => seen.push(`u${id}`),
      string: (id) => seen.push(`s${id}`),
    };
    decode(os.bytes(), visitor);

    // unsigned id 1 (twice: top-level + nested), boolean id 3 (unsigned wire),
    // string id 6 — and nothing else.
    expect(seen).toEqual(["u1", "u3", "s6", "u1"]);
  });
});
