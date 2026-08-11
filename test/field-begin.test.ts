/**
 * `Visitor.fieldBegin` — the push twin of `Cursor.readHeader()`.
 *
 * The visitor path had no callback between a field's **header varint** and the
 * value's own header word. For a fixlen field the earliest signal was
 * `fixlenBegin`, which needs the *complete* fixlen word — so a message that ends
 * inside that word delivered no event at all and a visitor could not latch a
 * bound the header alone had already decided (an element id past the schema
 * `count`, MESSAGE_SPEC §7.1/§5.1). The pull path has no such gap: `readHeader()`
 * publishes `id` / `wire` (and peeks `fixSub`) one byte into the word, which is
 * exactly why the two paths disagreed — whole-buffer `INVALID`, chunked
 * `INCOMPLETE`. CORELIB_PLAN §5.2 gives INVALID precedence over INCOMPLETE, and
 * §6.4 / MESSAGE_SPEC §7.2 forbid a chunk boundary changing the outcome.
 *
 * Reproducer: Crucible F-0061 `r3_wrapper_reopen_overindex_trunc.bin` against
 * the `probe` schema (`string_array` at id 200, `count: 5`), corelib-ts#97.
 */

import { describe, expect, it } from "vitest";
import {
  ArrayKind,
  Cursor,
  DecodeStatus,
  FixlenSubtype,
  IStream,
  OStream,
  SofabError,
  SofabErrorCode,
  WireType,
  decode,
  type Visitor,
} from "../src/index.js";

/** The schema `count` of `probe.string_array`: element ids 0..4 are in range. */
const COUNT = 5;
/** The wrapper array's field id. */
const WRAPPER = 200;

// c6 0c        wrapper id 200, sequence start
// 02 0a 41     element 0: fixlen, String, length 1, payload "A"
// 07           sequence end
// c6 0c        the SAME wrapper re-opened (MESSAGE_SPEC §7.4)
// 8a 0a        element header: id 161, wire Fixlen  <- 161 >= count 5 is INVALID
// c2           the fixlen word begins and the message ends inside it
const REPRO = new Uint8Array([
  0xc6, 0x0c, 0x02, 0x0a, 0x41, 0x07, 0xc6, 0x0c, 0x8a, 0x0a, 0xc2,
]);

// The in-range control: element id 0 in place of the over-index one, and the
// re-opened wrapper properly closed. Must decode clean — otherwise the bound is
// only shown to reject, not to reject *the right thing*.
const CTRL = new Uint8Array([
  0xc6, 0x0c, 0x02, 0x0a, 0x41, 0x07, 0xc6, 0x0c, 0x02, 0x0a, 0x42, 0x07,
]);

const CHUNKINGS = [1, 2, 3, 5, 8, 16];

function statusOf(e: unknown): DecodeStatus {
  if (e instanceof SofabError) {
    if (e.code === SofabErrorCode.InvalidMsg) return DecodeStatus.Invalid;
    if (e.code === SofabErrorCode.Incomplete) return DecodeStatus.Incomplete;
  }
  throw e;
}

/** Feed `bytes` in `size`-byte chunks (0 = one feed), returning the outcome. */
function feed(bytes: Uint8Array, size: number, visitor: Visitor): DecodeStatus {
  const is = new IStream();
  try {
    if (size <= 0) is.feed(bytes, visitor);
    else {
      for (let i = 0; i < bytes.length; i += size) {
        is.feed(bytes.subarray(i, i + size), visitor);
      }
    }
  } catch (e) {
    return statusOf(e);
  }
  return is.end();
}

/** One-shot push decode, reported as the three-valued outcome. */
function whole(bytes: Uint8Array, visitor: Visitor): DecodeStatus {
  try {
    decode(bytes, visitor);
  } catch (e) {
    return statusOf(e);
  }
  return DecodeStatus.Complete;
}

// --- the two readers a generator would emit for `probe` --------------------

/** Pull reader: the element bound is taken from `readHeader()`'s `id`. */
function cursorVerdict(bytes: Uint8Array): DecodeStatus {
  try {
    const c = new Cursor(bytes);
    while (c.readHeader()) {
      if (c.id === WRAPPER && c.wire === WireType.SequenceStart) {
        while (c.readHeader()) {
          // Re-read into a local: `c.wire` is a mutable field, so the outer
          // `=== SequenceStart` test must not narrow the element's wire type.
          const wire: number = c.wire;
          if (wire !== WireType.Fixlen || c.fixSub !== FixlenSubtype.String) {
            c.skip(wire);
            continue;
          }
          if (c.id >= COUNT) {
            throw new SofabError(SofabErrorCode.InvalidMsg, `element ${c.id} >= count ${COUNT}`);
          }
          c.readString();
        }
      } else c.skip(c.wire);
    }
    return DecodeStatus.Complete;
  } catch (e) {
    return statusOf(e);
  }
}

/**
 * Push reader applying the same bound — from `fixlenBegin`, not `fieldBegin`.
 *
 * `fieldBegin` fires as soon as the field HEADER varint ends, which is before
 * the `fixlen_word` exists. CORELIB_PLAN §4.1 forbids acting on that word early
 * "even when the field's id would violate a schema bound (MESSAGE_SPEC §7.1)":
 * §7.3 makes the bound apply only to a field that IS the declared one, and only
 * the subtype settles that. A visitor that rejects from `fieldBegin` therefore
 * reaches a verdict the format does not license yet — which is what generated
 * code avoids by binding this to `fixlenBegin`.
 */
class Elements implements Visitor {
  readonly seen: string[] = [];
  fixlenBegin(id: number, sub: FixlenSubtype, _total: number): void {
    if (sub === FixlenSubtype.String && id >= COUNT) {
      throw new SofabError(SofabErrorCode.InvalidMsg, `element ${id} >= count ${COUNT}`);
    }
  }
  string(id: number, _total: number, _offset: number, chunk: Uint8Array): void {
    this.seen.push(`${id}:${chunk.length}`);
  }
}

class Probe implements Visitor {
  readonly elements = new Elements();
  sequenceBegin(id: number): Visitor | void {
    if (id === WRAPPER) return this.elements;
  }
}

// --- event recording -------------------------------------------------------

type Ev = string;

class Rec implements Visitor {
  constructor(readonly ev: Ev[] = []) {}
  fieldBegin(id: number, wire: WireType): void {
    this.ev.push(`fieldBegin ${id} ${wire}`);
  }
  unsigned(id: number): void {
    this.ev.push(`unsigned ${id}`);
  }
  signed(id: number): void {
    this.ev.push(`signed ${id}`);
  }
  fp64(id: number): void {
    this.ev.push(`fp64 ${id}`);
  }
  fixlenBegin(id: number, subtype: FixlenSubtype, total: number): void {
    this.ev.push(`fixlenBegin ${id} ${subtype} ${total}`);
  }
  string(id: number, total: number, offset: number): void {
    this.ev.push(`string ${id} ${total} ${offset}`);
  }
  blob(id: number, total: number, offset: number): void {
    this.ev.push(`blob ${id} ${total} ${offset}`);
  }
  arrayBegin(id: number, kind: ArrayKind, count: number): void {
    this.ev.push(`arrayBegin ${id} ${kind} ${count}`);
  }
  arrayUnsigned(id: number, index: number): void {
    this.ev.push(`arrayUnsigned ${id} ${index}`);
  }
  arrayEnd(id: number): void {
    this.ev.push(`arrayEnd ${id}`);
  }
  sequenceBegin(id: number): Visitor | void {
    this.ev.push(`sequenceBegin ${id}`);
    return new Rec(this.ev); // same log, child scope
  }
  sequenceEnd(): void {
    this.ev.push("sequenceEnd");
  }
}

describe("Visitor.fieldBegin", () => {
  describe("an over-index element truncated inside its fixlen word (#97)", () => {
    it("fires for the element header the fixlen word never completes", () => {
      const rec = new Rec();
      expect(whole(REPRO, rec)).toBe(DecodeStatus.Incomplete); // no bound applied
      expect(rec.ev).toContain(`fieldBegin 161 ${WireType.Fixlen}`);
    });

    for (const size of CHUNKINGS) {
      it(`fires at ${size}-byte chunks too`, () => {
        const rec = new Rec();
        expect(feed(REPRO, size, rec)).toBe(DecodeStatus.Incomplete);
        expect(rec.ev).toContain(`fieldBegin 161 ${WireType.Fixlen}`);
      });
    }

    // §4.1: the `fixlen_word` is truncated, so it has no value -- and the clause
    // says so for this exact case, "even when the field's id would violate a
    // schema bound once the subtype confirmed the field is the declared one".
    // Both surfaces therefore answer INCOMPLETE. One byte more (CTRL_OVER below)
    // completes the word and both answer INVALID, which is what shows the bound
    // itself is right and only its TIMING was wrong.
    it("is INCOMPLETE on both surfaces: the word carrying the subtype never ended", () => {
      expect(cursorVerdict(REPRO)).toBe(DecodeStatus.Incomplete);
      expect(whole(REPRO, new Probe())).toBe(DecodeStatus.Incomplete);
    });

    for (const size of CHUNKINGS) {
      it(`keeps that verdict at ${size}-byte chunks (§6.4: chunking cannot change it)`, () => {
        expect(feed(REPRO, size, new Probe())).toBe(DecodeStatus.Incomplete);
      });
    }

    it("rejects the moment one more byte completes that word", () => {
      const done = new Uint8Array([...REPRO, 0x00]);
      expect(cursorVerdict(done)).toBe(DecodeStatus.Invalid);
      expect(whole(done, new Probe())).toBe(DecodeStatus.Invalid);
      for (const size of CHUNKINGS) {
        expect(feed(done, size, new Probe())).toBe(DecodeStatus.Invalid);
      }
    });

    it("does not reject the in-range control", () => {
      expect(cursorVerdict(CTRL)).toBe(DecodeStatus.Complete);
      const p = new Probe();
      expect(whole(CTRL, p)).toBe(DecodeStatus.Complete);
      expect(p.elements.seen).toEqual(["0:1", "0:1"]);
      for (const size of CHUNKINGS) {
        const q = new Probe();
        expect(feed(CTRL, size, q)).toBe(DecodeStatus.Complete);
        expect(q.elements.seen).toEqual(["0:1", "0:1"]);
      }
    });
  });

  describe("the general guarantee", () => {
    const os = new OStream();
    os.writeUnsigned(1, 7);
    os.writeSigned(2, -7);
    os.writeString(3, "hi");
    os.writeBlob(4, new Uint8Array([1, 2]));
    os.writeFp64(5, 1.5);
    os.writeUnsignedArray(6, [1, 2]);
    os.writeSequenceBeginLazy(7);
    os.writeUnsigned(1, 9);
    os.writeSequenceEnd();
    const msg = os.bytes().slice();

    const expected = [
      `fieldBegin 1 ${WireType.Unsigned}`,
      "unsigned 1",
      `fieldBegin 2 ${WireType.Signed}`,
      "signed 2",
      `fieldBegin 3 ${WireType.Fixlen}`,
      `fixlenBegin 3 ${FixlenSubtype.String} 2`,
      "string 3 2 0",
      `fieldBegin 4 ${WireType.Fixlen}`,
      `fixlenBegin 4 ${FixlenSubtype.Blob} 2`,
      "blob 4 2 0",
      `fieldBegin 5 ${WireType.Fixlen}`,
      "fp64 5",
      `fieldBegin 6 ${WireType.ArrayUnsigned}`,
      `arrayBegin 6 ${ArrayKind.Unsigned} 2`,
      "arrayUnsigned 6 0",
      "arrayUnsigned 6 1",
      "arrayEnd 6",
      `fieldBegin 7 ${WireType.SequenceStart}`,
      "sequenceBegin 7",
      `fieldBegin 1 ${WireType.Unsigned}`,
      "unsigned 1",
      "sequenceEnd",
    ];

    it("announces every field header, before the value, on the contiguous path", () => {
      const rec = new Rec();
      expect(whole(msg, rec)).toBe(DecodeStatus.Complete);
      // No `fieldBegin` for the sequence end: it closes a scope rather than
      // opening a field, and its id is discarded — the pull twin says the same
      // by returning false from readHeader() instead of publishing a header.
      expect(rec.ev).toEqual(expected);
    });

    // A small chunk splits a string/blob payload into several calls, which is
    // the one legitimate difference between the two paths' event streams; the
    // continuation chunks (offset > 0) are dropped so the rest must match.
    const noContinuations = (ev: Ev[]): Ev[] =>
      ev.filter((e) => !/^(?:string|blob) \d+ \d+ [1-9]/.test(e));

    for (const size of [0, 1, 2, 3]) {
      it(`announces the identical stream at ${size || "whole"}-byte chunks`, () => {
        const rec = new Rec();
        expect(feed(msg, size, rec)).toBe(DecodeStatus.Complete);
        expect(noContinuations(rec.ev)).toEqual(expected);
      });
    }

    it("fires before an array's count word is even read", () => {
      // `05 06` — an fp32 array header plus the first byte of a multi-byte count
      // word. `arrayBegin` cannot fire (no count yet); the header can.
      const rec = new Rec();
      expect(feed(new Uint8Array([0x2b, 0x80]), 1, rec)).toBe(DecodeStatus.Incomplete);
      expect(rec.ev).toEqual([`fieldBegin 5 ${WireType.ArrayUnsigned}`]);
    });

    it("stays optional: a visitor without it decodes unchanged", () => {
      const seen: number[] = [];
      const plain: Visitor = { unsigned: (id) => void seen.push(id) };
      expect(whole(msg, plain)).toBe(DecodeStatus.Complete);
      expect(feed(msg, 1, plain)).toBe(DecodeStatus.Complete);
      expect(seen).toEqual([1, 1, 1, 1]);
    });
  });
});
