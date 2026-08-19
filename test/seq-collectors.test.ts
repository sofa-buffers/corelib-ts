/**
 * `StringSeq` / `BlobSeq` — the element collectors for a wrapper-sequence array
 * of `string` / `blob` (MESSAGE_SPEC §5.1).
 *
 * Like {@link PayloadAcc}, these decide things the shared vectors cannot see.
 * The vectors fix the *bytes*; what a gap, a repeated index or an over-capacity
 * index turns into is a property of the decoded **value**, and two collectors
 * that disagree about all three still re-encode identically. So §5.1's three
 * placement rules — a gap keeps the indices after it, the length is the highest
 * present id + 1, a repeat replaces — are pinned here field by field.
 *
 * The bound checks get the same treatment from two directions: through real wire
 * bytes, where the point is *when* the verdict lands (an over-long element must
 * be `INVALID` even when the message is cut off inside it — §5.2 gives `INVALID`
 * precedence, and §6.4 forbids a chunk boundary changing the answer), and by
 * calling the collector directly, where the point is *what it costs* — an index
 * near 2^31 must be rejected before a single slot is allocated.
 */

import { describe, expect, it } from "vitest";
import {
  BlobSeq,
  DecodeStatus,
  FixlenSubtype,
  IStream,
  OStream,
  PayloadAcc,
  SofabError,
  SofabErrorCode,
  StringSeq,
  decode,
  type Visitor,
} from "../src/index.js";

/** The array field's own id in the enclosing scope. */
const ARRAY_ID = 7;

/** Unbounded, the value a schema without `count` / `maxlen` supplies (§7.2). */
const NONE = -1;

/** Wrap `body` — the elements — in the array's wrapper sequence. */
function wrapper(body: (os: OStream) => void): Uint8Array {
  const os = new OStream();
  os.writeSequenceBeginLazy(ARRAY_ID);
  body(os);
  os.writeSequenceEndKeep();
  return os.bytes().slice();
}

/** Decode `wire` with a {@link StringSeq} bound to the wrapper, returning the elements. */
function strings(wire: Uint8Array, cap = NONE, elemMax = NONE): string[] {
  const out: string[] = [];
  const acc = new PayloadAcc();
  const root: Visitor = {
    sequenceBegin: (id) =>
      id === ARRAY_ID ? new StringSeq(out, acc, cap, elemMax, "tags") : undefined,
  };
  decode(wire, root);
  return out;
}

/** The {@link BlobSeq} twin of {@link strings}. */
function blobs(wire: Uint8Array, cap = NONE, elemMax = NONE): Uint8Array[] {
  const out: Uint8Array[] = [];
  const acc = new PayloadAcc();
  const root: Visitor = {
    sequenceBegin: (id) =>
      id === ARRAY_ID ? new BlobSeq(out, acc, cap, elemMax, "chunks") : undefined,
  };
  decode(wire, root);
  return out;
}

function expectInvalid(fn: () => unknown): SofabError {
  try {
    fn();
    expect.unreachable("expected an INVALID_MSG rejection");
  } catch (e) {
    expect(e).toBeInstanceOf(SofabError);
    expect((e as SofabError).code).toBe(SofabErrorCode.InvalidMsg);
    return e as SofabError;
  }
  throw new Error("unreachable");
}

describe("StringSeq places elements the way §5.1 requires", () => {
  it("places each element at its own index", () => {
    const wire = wrapper((os) => {
      os.writeString(0, "alpha");
      os.writeString(1, "beta");
      os.writeString(2, "gamma");
    });
    expect(strings(wire)).toStrictEqual(["alpha", "beta", "gamma"]);
  });

  it("fills a gap with the element default instead of shifting", () => {
    // ids 0, 2, 3: the encoder elided an interior element equal to its default.
    // Everything after the gap must keep its index — the failure mode is a
    // collector that appends and silently returns ["a", "c", "d"].
    const wire = wrapper((os) => {
      os.writeString(0, "a");
      os.writeString(2, "c");
      os.writeString(3, "d");
    });
    expect(strings(wire)).toStrictEqual(["a", "", "c", "d"]);
  });

  it("takes its length from the highest present id", () => {
    const wire = wrapper((os) => os.writeString(4, "last"));
    expect(strings(wire)).toStrictEqual(["", "", "", "", "last"]);
  });

  it("lets a repeated index replace rather than append (§7.4)", () => {
    const wire = wrapper((os) => {
      os.writeString(0, "first");
      os.writeString(1, "keep");
      os.writeString(0, "second");
    });
    expect(strings(wire)).toStrictEqual(["second", "keep"]);
  });

  it("decodes an element that arrives in pieces", () => {
    const wire = wrapper((os) => {
      os.writeString(0, "a payload longer than any single fed chunk");
      os.writeString(1, "short");
    });
    const out: string[] = [];
    const acc = new PayloadAcc();
    const is = new IStream();
    const root: Visitor = {
      sequenceBegin: (id) => (id === ARRAY_ID ? new StringSeq(out, acc, NONE, NONE, "tags") : undefined),
    };
    let st: DecodeStatus = DecodeStatus.Complete;
    for (let i = 0; i < wire.length; i++) st = is.feed(wire.subarray(i, i + 1), root);
    expect(st).toBe(DecodeStatus.Complete);
    expect(out).toStrictEqual(["a payload longer than any single fed chunk", "short"]);
  });

  it("rejects invalid UTF-8 in an element as INVALID_MSG", () => {
    const wire = wrapper((os) => os.writeFixlen(0, Uint8Array.of(0xff, 0xfe), FixlenSubtype.String));
    expectInvalid(() => strings(wire));
  });
});

describe("BlobSeq places elements the same way, and copies them", () => {
  it("fills a gap with an empty blob", () => {
    const wire = wrapper((os) => {
      os.writeBlob(0, Uint8Array.of(1, 2));
      os.writeBlob(2, Uint8Array.of(3));
    });
    const got = blobs(wire);
    expect(got.map((b) => [...b])).toStrictEqual([[1, 2], [], [3]]);
  });

  it("joins an element that arrives in pieces", () => {
    const big = Uint8Array.from({ length: 40 }, (_, i) => i);
    const wire = wrapper((os) => {
      os.writeBlob(0, big);
      os.writeBlob(1, Uint8Array.of(0xff));
    });
    const out: Uint8Array[] = [];
    const acc = new PayloadAcc();
    const is = new IStream();
    const root: Visitor = {
      sequenceBegin: (id) => (id === ARRAY_ID ? new BlobSeq(out, acc, NONE, NONE, "chunks") : undefined),
    };
    let st: DecodeStatus = DecodeStatus.Complete;
    for (let i = 0; i < wire.length; i++) st = is.feed(wire.subarray(i, i + 1), root);
    expect(st).toBe(DecodeStatus.Complete);
    expect(out.map((b) => [...b])).toStrictEqual([[...big], [0xff]]);
  });

  it("copies out of the fed chunk, so a reused buffer cannot rot an element", () => {
    // The difference from StringSeq: decoding already produces a value, while a
    // blob would otherwise be a view into memory the caller may reuse (§6).
    const wire = wrapper((os) => os.writeBlob(0, Uint8Array.of(9, 8, 7)));
    const scratch = wire.slice();
    const out: Uint8Array[] = [];
    const acc = new PayloadAcc();
    const is = new IStream();
    is.feed(scratch, {
      sequenceBegin: (id) => (id === ARRAY_ID ? new BlobSeq(out, acc, NONE, NONE, "chunks") : undefined),
    });
    scratch.fill(0xee);
    expect([...out[0]!]).toStrictEqual([9, 8, 7]);
  });
});

describe("the schema bounds bind, and bind early (§7.1, §5.2)", () => {
  it("accepts the last index the capacity allows and rejects the next", () => {
    const ok = wrapper((os) => os.writeString(3, "in"));
    expect(strings(ok, 4)).toHaveLength(4);
    const over = wrapper((os) => os.writeString(4, "out"));
    const err = expectInvalid(() => strings(over, 4));
    expect(err.message).toContain("tags");
    expect(err.message).toContain("4");
  });

  it("accepts an element of exactly maxlen and rejects one byte more", () => {
    const ok = wrapper((os) => os.writeString(0, "12345"));
    expect(strings(ok, NONE, 5)).toStrictEqual(["12345"]);
    const over = wrapper((os) => os.writeString(0, "123456"));
    expectInvalid(() => strings(over, NONE, 5));
  });

  it("rejects an over-long element whose payload never arrives", () => {
    // The anti-folding case. Cut the message right after the element's fixlen
    // word: the bound is already decided, so the verdict must be INVALID and not
    // the INCOMPLETE a payload-only check would produce.
    const wire = wrapper((os) => os.writeString(0, "far too long"));
    const truncated = wire.subarray(0, wire.length - 12);
    const out: string[] = [];
    const acc = new PayloadAcc();
    const is = new IStream();
    expectInvalid(() =>
      is.feed(truncated, {
        sequenceBegin: (id) => (id === ARRAY_ID ? new StringSeq(out, acc, NONE, 4, "tags") : undefined),
      }),
    );
    expect(out).toStrictEqual([]);
  });

  it("leaves both bounds off when they are -1 (§7.2)", () => {
    const wire = wrapper((os) => os.writeString(9, "a string no maxlen bounds"));
    expect(strings(wire)).toHaveLength(10);
  });

  it("rejects an index near 2^31 before allocating a single slot", () => {
    // The adversarial shape: `while (out.length <= id) push(default)` is O(id),
    // so the capacity check has to come first. Called directly — no encoder will
    // produce this, and the point is exactly that the guard runs before the work.
    const out: string[] = [];
    const seq = new StringSeq(out, new PayloadAcc(), 4, NONE, "tags");
    expectInvalid(() => seq.string(2 ** 31 - 1, 1, 0, Uint8Array.of(0x41)));
    expectInvalid(() => seq.fixlenBegin(2 ** 31 - 1, FixlenSubtype.String, 1));
    expect(out).toStrictEqual([]);
  });

  it("applies the same two bounds in BlobSeq", () => {
    const over = wrapper((os) => os.writeBlob(2, Uint8Array.of(1)));
    const err = expectInvalid(() => blobs(over, 2));
    expect(err.message).toContain("chunks");
    const long = wrapper((os) => os.writeBlob(0, Uint8Array.of(1, 2, 3)));
    expectInvalid(() => blobs(long, NONE, 2));
  });
});

describe("what a collector must not treat as an element", () => {
  it("skips an element of the wrong fixlen subtype instead of rejecting it (§7.3)", () => {
    // A blob among strings is a schema mismatch, and §7.3 makes that a skip —
    // including when its index is past the capacity, which is not the string
    // array's business at all.
    const wire = wrapper((os) => {
      os.writeString(0, "a");
      os.writeBlob(9, Uint8Array.of(1, 2, 3));
      os.writeString(1, "b");
    });
    expect(strings(wire, 2)).toStrictEqual(["a", "b"]);
  });

  it("skips a string element among blobs, and swallows a nested sequence (BlobSeq)", () => {
    const wire = wrapper((os) => {
      os.writeBlob(0, Uint8Array.of(1));
      os.writeString(9, "not a blob");
      os.writeSequenceBeginLazy(1);
      os.writeBlob(0, Uint8Array.of(0xaa));
      os.writeSequenceEndKeep();
      os.writeBlob(2, Uint8Array.of(2));
    });
    expect(blobs(wire, 3).map((b) => [...b])).toStrictEqual([[1], [], [2]]);
  });

  it("swallows a nested sequence whole rather than binding it into the array", () => {
    // Returning nothing from sequenceBegin would keep *this* visitor, so the
    // unknown subtree's own `string(0, …)` would land at index 0 of the array.
    const wire = wrapper((os) => {
      os.writeString(0, "a");
      os.writeSequenceBeginLazy(1);
      os.writeString(0, "POISON");
      os.writeSequenceBeginLazy(0);
      os.writeString(0, "DEEPER POISON");
      os.writeSequenceEndKeep();
      os.writeSequenceEndKeep();
      os.writeString(2, "c");
    });
    expect(strings(wire)).toStrictEqual(["a", "", "c"]);
  });
});
