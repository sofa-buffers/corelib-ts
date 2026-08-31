/**
 * `Visitor.sequenceBegin` returning `false` — decline this subtree.
 *
 * Before it existed, a reader with no destination for a scope had to supply a
 * visitor that swallowed everything, and every generated TypeScript module
 * carried one for the purpose:
 *
 *     const _DEAD: Visitor = { sequenceBegin(): Visitor { return _DEAD; } };
 *
 * The dummy stood in for a decoder state that was missing, so a discarded subtree
 * still paid for property lookups and the receiver caps of a reader that was never
 * going to see it. `false` says the thing directly, and corelib-dart already had
 * it (`onSequenceStart` returning null sets `_skipDepth`). corelib-ts#149, epic
 * sofa-buffers/generator#345.
 *
 * What a skip does NOT change: the subtree is still parsed — a sequence is
 * framed by markers, not by a length, so its end has to be found — and every
 * FORMAT ceiling still applies inside it. Only the reader's own policy stops.
 */

import { describe, expect, it } from "vitest";
import {
  ArrayKind,
  DecodeStatus,
  FixlenSubtype,
  IStream,
  MAX_DEPTH,
  OStream,
  SofabError,
  SofabErrorCode,
  decode,
  type Visitor, growingOStream } from "../src/index.js";

const CHUNKINGS = [1, 2, 3, 5, 8, 16, 64];

/** Every event a visitor tree saw, in order. */
class Rec implements Visitor {
  constructor(readonly ev: string[] = [], readonly skipId?: number) {}
  fieldBegin(id: number): void { this.ev.push(`field ${id}`); }
  unsigned(id: number): void { this.ev.push(`u ${id}`); }
  string(id: number, total: number): void { this.ev.push(`s ${id} ${total}`); }
  blob(id: number, total: number): void { this.ev.push(`b ${id} ${total}`); }
  arrayBegin(id: number, k: ArrayKind, n: number): void { this.ev.push(`arr ${id} ${k} ${n}`); }
  arrayUnsigned(id: number, i: number): void { this.ev.push(`ae ${id} ${i}`); }
  arrayEnd(id: number): void { this.ev.push(`arrEnd ${id}`); }
  sequenceBegin(id: number): boolean {
    this.ev.push(`seq ${id}`);
    return id !== this.skipId;
  }
  sequenceEnd(): void { this.ev.push("seqEnd"); }
}

/**
 * A message whose id 7 subtree holds one of every field kind, plus a nested
 * scope of its own — so "nothing fired in there" is a claim with something to
 * fire. Id 9 after it proves the parent scope resumes.
 */
function message(): Uint8Array {
  const os = growingOStream();
  os.writeUnsigned(1, 5);
  os.writeSequenceBeginLazy(7);
  os.writeUnsigned(1, 99);
  os.writeString(2, "discarded");
  os.writeBlob(3, new Uint8Array([1, 2, 3]));
  os.writeUnsignedArray(4, [1, 2, 3]);
  os.writeSequenceBeginLazy(5); // nested inside the skipped scope
  os.writeUnsigned(1, 1);
  os.writeSequenceEnd();
  os.writeSequenceEnd();
  os.writeUnsigned(9, 6);
  return os.bytes().slice();
}

/** Feed in `size`-byte chunks (0 = one feed), returning the outcome. */
function feed(bytes: Uint8Array, size: number, v: Visitor): DecodeStatus {
  const is = new IStream(v);
  try {
    if (size <= 0) is.feed(bytes);
    else for (let i = 0; i < bytes.length; i += size) is.feed(bytes.subarray(i, i + size));
  } catch (e) {
    if (e instanceof SofabError) {
      if (e.code === SofabErrorCode.InvalidMsg) return DecodeStatus.Invalid;
      if (e.code === SofabErrorCode.Incomplete) return DecodeStatus.Incomplete;
    }
    throw e;
  }
  return is.status();
}

describe("sequenceBegin returning false", () => {
  const LIVE = ["field 1", "u 1", "field 7", "seq 7", "field 9", "u 9"];

  it("delivers nothing from the subtree, on the contiguous path", () => {
    const r = new Rec([], 7);
    decode(message(), r);
    expect(r.ev).toEqual(LIVE);
  });

  for (const size of CHUNKINGS) {
    it(`delivers nothing from the subtree at ${size}-byte chunks`, () => {
      const r = new Rec([], 7);
      expect(feed(message(), size, r)).toBe(DecodeStatus.Complete);
      expect(r.ev).toEqual(LIVE);
    });
  }

  it("does not offer a scope nested inside a skipped one", () => {
    const r = new Rec([], 7);
    decode(message(), r);
    expect(r.ev.filter((e) => e.startsWith("seq"))).toEqual(["seq 7"]); // not `seq 5`
  });

  it("fires no sequenceEnd for the scope it skipped", () => {
    const r = new Rec([], 7);
    decode(message(), r);
    expect(r.ev).not.toContain("seqEnd");
  });

  it("keeps 'return nothing' meaning 'descend'", () => {
    // The other answer: the nested scope's fields arrive on this same visitor —
    // which, with a flat visitor, is where they always arrive. A reader that wants
    // to tell the scopes apart routes on the (id, depth) pair sequenceBegin gives
    // it; one that does not sees all three id spaces merged, as here.
    const ev: string[] = [];
    const stay: Visitor = {
      unsigned: (id, v) => void ev.push(`${id}=${v}`),
      sequenceBegin: () => undefined,
    };
    decode(message(), stay);
    expect(ev).toEqual(["1=5", "1=99", "1=1", "9=6"]);
  });

  it("reports the id and depth of each scope, and of its end", () => {
    // What replaces a child visitor: the events carry enough for a flat reader to
    // route by itself, and they nest.
    const ev: string[] = [];
    decode(message(), {
      sequenceBegin: (id, depth) => void ev.push(`begin ${id}@${depth}`),
      sequenceEnd: (id, depth) => void ev.push(`end ${id}@${depth}`),
    });
    expect(ev).toEqual(["begin 7@1", "begin 5@2", "end 5@2", "end 7@1"]);
  });
});

describe("a skipped subtree and the two kinds of bound", () => {
  // The reader's own policy: it bounds what this reader is handed, and a
  // skipped scope hands it nothing. corelib-dart takes the same position —
  // its cap sits inside `if (read)`, and `_decideRead` is false while skipping.
  //
  // The caps are the reader's own, held and compared by the reader — the codec
  // holds none (§6.2.1). It declines *sequences* and caps every field kind it is
  // handed. Both halves matter: without the capping callbacks the tests below
  // would pass for the wrong reason — nothing is capped anywhere — and the
  // declined-scope rule would go unexercised.
  const CAPS = { string: 4, blob: 2, array: 1 };
  const skipper: Visitor = {
    sequenceBegin: () => false,
    fixlenBegin(_id, sub, total) {
      if (sub !== FixlenSubtype.String && sub !== FixlenSubtype.Blob) return;
      const cap = sub === FixlenSubtype.String ? CAPS.string : CAPS.blob;
      if (total > cap) throw new SofabError(SofabErrorCode.LimitExceeded, "over cap");
    },
    arrayBegin(_id, _kind, count) {
      if (count > CAPS.array) throw new SofabError(SofabErrorCode.LimitExceeded, "over cap");
    },
  };

  it("does not apply the receiver caps inside it (contiguous)", () => {
    expect(() => decode(message(), skipper)).not.toThrow();
  });

  for (const size of CHUNKINGS) {
    it(`does not apply the receiver caps inside it at ${size}-byte chunks`, () => {
      expect(feed(message(), size, skipper)).toBe(DecodeStatus.Complete);
    });
  }

  it("still applies them outside it", () => {
    const os = growingOStream();
    os.writeString(1, "far too long");
    try {
      decode(os.bytes().slice(), skipper);
      expect.unreachable("the cap should have fired on a field nobody skipped");
    } catch (e) {
      expect((e as SofabError).code).toBe(SofabErrorCode.LimitExceeded);
    }
  });

  // The format ceilings are not the reader's to waive: they bound what the wire
  // may express, so they hold everywhere, skipped or not.
  it("still enforces MAX_DEPTH inside it", () => {
    // Hand-built: the encoder enforces MAX_DEPTH itself, so it cannot produce
    // the message this asks the DECODER about. `0x0e` is (id 1 << 3) | 6, a
    // sequence start; the run is deliberately unterminated because depth, not
    // balance, is what is on trial.
    const bytes = new Uint8Array(MAX_DEPTH + 2).fill(0x0e);
    try {
      decode(bytes, skipper);
      expect.unreachable("MAX_DEPTH should have fired inside the skipped subtree");
    } catch (e) {
      expect((e as SofabError).code).toBe(SofabErrorCode.InvalidMsg);
    }
    for (const size of CHUNKINGS) {
      expect(feed(bytes, size, skipper)).toBe(DecodeStatus.Invalid);
    }
  });

  it("still rejects a reserved fixlen subtype inside it", () => {
    // 0x06 = id 0, sequence start (skipped). 0x02 = id 0, fixlen. 0x04 = a
    // fixlen word of length 0 and subtype 4 — reserved, and INVALID wherever
    // it appears (§4.6).
    const bytes = new Uint8Array([0x06, 0x02, 0x04]);
    expect(feed(bytes, 0, skipper)).toBe(DecodeStatus.Invalid);
    expect(() => decode(bytes, skipper)).toThrow(SofabError);
  });

  it("still counts the skipped scope as open: truncation is INCOMPLETE, not COMPLETE", () => {
    const os = growingOStream();
    os.writeSequenceBeginLazy(7);
    os.writeUnsigned(1, 1);
    const bytes = os.bytes().slice(); // no sequence end
    expect(feed(bytes, 0, skipper)).toBe(DecodeStatus.Incomplete);
    expect(() => decode(bytes, skipper)).toThrow(SofabError);
  });

  it("still rejects an unbalanced sequence end after one", () => {
    const os = growingOStream();
    os.writeSequenceBeginLazy(7);
    os.writeSequenceEnd();
    const bytes = new Uint8Array([...os.bytes().slice(), 0x07]); // one end too many
    expect(feed(bytes, 0, skipper)).toBe(DecodeStatus.Invalid);
  });
});
