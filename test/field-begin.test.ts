/**
 * `Visitor.fieldBegin` — the field-header event, and where a schema bound must
 * *not* be taken.
 *
 * The hook was added for the divergence Crucible F-0061 found
 * (`r3_wrapper_reopen_overindex_trunc.bin` against the `probe` schema —
 * `string_array` at id 200, `count: 5`, corelib-ts#97): an element id past the
 * declared `count` in a message that ends inside the element's fixlen word. The
 * push path saw no event at all, because `fixlenBegin` needs the *complete*
 * word, and answered `INCOMPLETE`; the removed pull path peeked the subtype one byte
 * into that word and answered `INVALID`. The same bytes, two verdicts.
 *
 * It was closed from both ends. CORELIB_PLAN §4.1.1 makes the peek the defect: a
 * varint has no value before its final byte, and a decoder MUST NOT let a settled
 * low bit influence an outcome "even when the field's id would violate a schema
 * bound (MESSAGE_SPEC §7.1) once the subtype confirmed the field is the declared
 * one" — because §7.3 skips a field whose subtype contradicts the declared type
 * instead of rejecting it, so the id alone never settles anything. And §5.3.1 has
 * since removed the second surface outright, so there is one implementation of the
 * rule left to keep honest.
 *
 * So this file pins two things: the timing (every chunking, both entry points) and
 * what the hook is actually for — announcing every field header, in wire order, to
 * a reader that would otherwise implement eight value callbacks to see the same
 * thing.
 */

import { describe, expect, it } from "vitest";
import {
  ArrayKind,
  DecodeStatus,
  FixlenSubtype,
  IStream,
  OStream,
  SofabError,
  SofabErrorCode,
  WireType,
  decode,
  type Visitor, growingOStream } from "../src/index.js";

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
  const is = new IStream(visitor);
  // The outcome is what the last `feed` returned; a refusal arrives as a throw.
  let st: DecodeStatus = DecodeStatus.Complete;
  try {
    if (size <= 0) st = is.feed(bytes);
    else {
      for (let i = 0; i < bytes.length; i += size) {
        st = is.feed(bytes.subarray(i, i + size));
      }
    }
  } catch (e) {
    return statusOf(e);
  }
  return st;
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

// --- the reader a generator would emit for `probe` -------------------------

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
class Probe implements Visitor {
  readonly seen: string[] = [];
  private inWrapper = false;
  sequenceBegin(id: number): void {
    if (id === WRAPPER) this.inWrapper = true;
  }
  sequenceEnd(id: number): void {
    if (id === WRAPPER) this.inWrapper = false;
  }
  fixlenBegin(id: number, sub: FixlenSubtype, _total: number): void {
    if (this.inWrapper && sub === FixlenSubtype.String && id >= COUNT) {
      throw new SofabError(SofabErrorCode.InvalidMsg, `element ${id} >= count ${COUNT}`);
    }
  }
  string(id: number, _total: number, _offset: number, _src: Uint8Array, start: number, end: number): void {
    if (this.inWrapper) this.seen.push(`${id}:${end - start}`);
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
  sequenceBegin(id: number): void {
    this.ev.push(`sequenceBegin ${id}`);
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
    it("is INCOMPLETE: the word carrying the subtype never ended", () => {
      expect(whole(REPRO, new Probe())).toBe(DecodeStatus.Incomplete);
    });

    for (const size of CHUNKINGS) {
      it(`keeps that verdict at ${size}-byte chunks (§6.4: chunking cannot change it)`, () => {
        expect(feed(REPRO, size, new Probe())).toBe(DecodeStatus.Incomplete);
      });
    }

    it("rejects the moment one more byte completes that word", () => {
      const done = new Uint8Array([...REPRO, 0x00]);
      expect(whole(done, new Probe())).toBe(DecodeStatus.Invalid);
      for (const size of CHUNKINGS) {
        expect(feed(done, size, new Probe())).toBe(DecodeStatus.Invalid);
      }
    });

    it("does not reject the in-range control", () => {
      const p = new Probe();
      expect(whole(CTRL, p)).toBe(DecodeStatus.Complete);
      expect(p.seen).toEqual(["0:1", "0:1"]);
      for (const size of CHUNKINGS) {
        const q = new Probe();
        expect(feed(CTRL, size, q)).toBe(DecodeStatus.Complete);
        expect(q.seen).toEqual(["0:1", "0:1"]);
      }
    });
  });

  // The clause that makes the id alone insufficient, shown on bytes rather than
  // by argument: the SAME over-index id, this time with a complete fixlen word
  // whose subtype is Blob where the schema declares String. MESSAGE_SPEC §7.3
  // skips such a field — it was never this array's value, so the array's bound
  // has nothing to say about it — and it wins against the schema bound. A
  // reader that rejected at the header would answer INVALID here, on a message
  // that is valid.
  describe("an over-index element whose subtype contradicts the schema (§7.3)", () => {
    // c6 0c        wrapper id 200, sequence start
    // 02 0a 41     element 0: fixlen, String, length 1, payload "A"
    // 07           sequence end
    // c6 0c        the same wrapper re-opened (MESSAGE_SPEC §7.4)
    // 8a 0a        element header: id 161, wire Fixlen  <- 161 >= count 5
    // 0b 41        fixlen word: length 1, subtype Blob  <- not the declared String
    // 07           sequence end
    const SKIPPED = new Uint8Array([
      0xc6, 0x0c, 0x02, 0x0a, 0x41, 0x07, 0xc6, 0x0c, 0x8a, 0x0a, 0x0b, 0x41, 0x07,
    ]);

    it("is skipped, not rejected", () => {
      const p = new Probe();
      expect(whole(SKIPPED, p)).toBe(DecodeStatus.Complete);
      expect(p.seen).toEqual(["0:1"]); // only the in-range string element
      for (const size of CHUNKINGS) {
        expect(feed(SKIPPED, size, new Probe())).toBe(DecodeStatus.Complete);
      }
    });

    it("would be rejected by a bound taken from fieldBegin — which is why it is not", () => {
      let inWrapper = false;
      const wrong: Visitor = {
        sequenceBegin: (id) => {
          if (id === WRAPPER) inWrapper = true;
        },
        sequenceEnd: (id) => {
          if (id === WRAPPER) inWrapper = false;
        },
        fieldBegin(elem: number): void {
          if (inWrapper && elem >= COUNT) {
            throw new SofabError(SofabErrorCode.InvalidMsg, `element ${elem} >= count ${COUNT}`);
          }
        },
      };
      expect(whole(SKIPPED, wrong)).toBe(DecodeStatus.Invalid);
    });
  });

  describe("the general guarantee", () => {
    const os = growingOStream();
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
      // opening a field, and its id is discarded (§4.9).
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
