/**
 * Invalid UTF-8 in a string that sits **late in the buffer** — the case the
 * shared `invalid_utf8` vectors never build.
 *
 * Every vector in that suite puts its string field at buffer offset 2 with a
 * payload of 1–4 bytes, so the offset of the payload and its length stay in the
 * same small range. A validator handed a *length* where an exclusive *end index*
 * was wanted (or the reverse) therefore still rejects them — it happens to be
 * scanning the right bytes — and a family-wide conformance run stays green while
 * the check is comprehensively broken. That is not hypothetical: it is exactly
 * how a `.length`-for-`end` bug survived a full conformance suite in a sibling
 * port.
 *
 * The distinguishing case is a string whose **start offset is at or beyond its
 * own length**, so length-based and offset-based ranges cannot coincide. This
 * file replays the whole shared negative suite behind enough padding to force
 * that, on the pull path (`Cursor.readString`, the surface that materializes a
 * string and therefore owns the §6.4 check), including from a `Uint8Array` that
 * is itself a view at a non-zero `byteOffset` into a larger `ArrayBuffer` — the
 * other way an offset-confused reader picks up the wrong bytes.
 *
 * The positive controls are what make it a test of validation rather than of
 * blanket rejection: a *valid* string at the same late offset must decode to the
 * exact expected text, and an invalid one that is merely **skipped** must not be
 * validated at all (§6.4 puts the check where a string is materialized), leaving
 * the decode `COMPLETE`.
 */

import { describe, expect, it } from "vitest";
import {
  Cursor,
  DecodeStatus,
  IStream,
  OStream,
  SofabError,
  SofabErrorCode,
  WireType,
  decode,
  type Visitor,
} from "../src/index.js";
import { hexToBytes } from "./helpers/hex.js";
import { loadInvalidUtf8 } from "./helpers/vectors.js";

const invalid = loadInvalidUtf8();

/** Padding written ahead of the field under test: one 96-byte blob at id 3. */
const PAD_BLOB = 96;

/** `pad || tail`, where the pad is a well-formed blob field the walker skips. */
function behindPadding(tail: Uint8Array): Uint8Array {
  const os = new OStream();
  os.writeBlob(3, new Uint8Array(PAD_BLOB).fill(0x5a));
  const pad = os.bytes();
  const out = new Uint8Array(pad.length + tail.length);
  out.set(pad, 0);
  out.set(tail, pad.length);
  return out;
}

/** The same bytes, as a view starting at `byteOffset` inside a bigger buffer. */
function asOffsetView(msg: Uint8Array, byteOffset: number): Uint8Array {
  const backing = new Uint8Array(byteOffset + msg.length + 13).fill(0xcc);
  backing.set(msg, byteOffset);
  return backing.subarray(byteOffset, byteOffset + msg.length);
}

/** Walk to field `id` and hand back the cursor positioned on its value. */
function seek(msg: Uint8Array, id: number): Cursor {
  const c = new Cursor(msg);
  while (c.readHeader()) {
    if (c.id === id) return c;
    c.skip(c.wire);
  }
  throw new Error(`field ${id} not found`);
}

/** Run `fn` and return the `SofabError` code it throws (or fail). */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SofabError) return e.code;
    throw e;
  }
  throw new Error("expected a SofabError, but nothing was thrown");
}

describe("invalid UTF-8 whose payload starts at an offset >= its own length", () => {
  it("has vectors to replay", () => {
    expect(invalid.length).toBeGreaterThan(0);
  });

  describe.each(invalid.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    // The vectors are parsed with bigint fidelity, so the id arrives as a
    // bigint and has to be narrowed before it is compared with a decoded one.
    const id = Number(v.id);
    const wire = hexToBytes(v.serialized_hex);
    const payload = hexToBytes(v.string_hex);
    const msg = behindPadding(wire);
    const payloadStart = msg.length - payload.length;

    it("really is the offset >= length shape the vectors miss", () => {
      // If this ever fails, the padding above stopped doing its job and the
      // rejections below no longer test anything the shared suite does not.
      expect(payloadStart).toBeGreaterThanOrEqual(payload.length);
      expect(payload.length).toBeGreaterThan(0);
      expect([...msg.subarray(payloadStart)]).toStrictEqual([...payload]);
    });

    it("is rejected as INVALID_MSG by the materializing reader", () => {
      const c = seek(msg, id);
      expect(codeOf(() => c.readString())).toBe(SofabErrorCode.InvalidMsg);
    });

    it("is rejected the same way through a non-zero byteOffset view", () => {
      const view = asOffsetView(msg, 7);
      expect(view.byteOffset).toBe(7);
      const c = seek(view, id);
      expect(codeOf(() => c.readString())).toBe(SofabErrorCode.InvalidMsg);
    });

    it("is not validated when the field is skipped instead (§6.4)", () => {
      // Validation belongs where a string is materialized; a skipped field is
      // never materialized, so the message is COMPLETE, not INVALID.
      const c = new Cursor(msg);
      let seen = 0;
      while (c.readHeader()) {
        seen++;
        c.skip(c.wire);
      }
      expect(seen).toBe(2);

      // The push surfaces hand the raw bytes over unvalidated for the same
      // reason, and complete.
      const chunks: number[][] = [];
      const sink: Visitor = {
        string: (fieldId, total, offset, chunk) => {
          if (fieldId === id) chunks.push([total, offset, ...chunk]);
        },
      };
      expect(() => decode(msg, sink)).not.toThrow();
      expect(chunks).toStrictEqual([[payload.length, 0, ...payload]]);
    });

    it("reaches the streaming visitor with field-relative offsets, one byte at a time", () => {
      // The `offset` a chunk carries is its position *within the field*, not
      // within the buffer — the distinction this whole file is about. Fed one
      // byte at a time, a late field must still report 0, 1, 2, … and complete.
      const offsets: number[] = [];
      const seen: number[] = [];
      const is = new IStream();
      const sink: Visitor = {
        string: (fieldId, _total, offset, chunk) => {
          if (fieldId !== id) return;
          offsets.push(offset);
          seen.push(...chunk);
        },
      };
      for (const b of msg) is.feed(Uint8Array.of(b), sink);
      expect(offsets).toStrictEqual(Array.from(payload, (_b, i) => i));
      expect(seen).toStrictEqual([...payload]);
      expect(is.status()).toBe(DecodeStatus.Complete);
    });
  });
});

describe("valid strings at the same late offset still decode (the control)", () => {
  const texts = ["a", "ok", "héllo", "日本語", "\u{1f600}", "x".repeat(200)];

  it.each(texts)("%j round-trips from behind the padding", (text) => {
    const inner = new OStream();
    inner.writeString(0, text);
    const msg = behindPadding(inner.bytes());
    const payloadLen = new TextEncoder().encode(text).length;

    const c = seek(msg, 0);
    expect(c.wire).toBe(WireType.Fixlen);
    expect(c.readString()).toBe(text);

    // And from a shifted view of the identical bytes.
    expect(seek(asOffsetView(msg, 5), 0).readString()).toBe(text);

    // Long enough for the offset >= length shape except for the last, deliberate
    // over-long case, which checks the reader does not depend on it either.
    expect(msg.length - payloadLen).toBeGreaterThan(0);
  });
});

describe("truncating a late invalid string is INCOMPLETE, not INVALID", () => {
  // A payload that is malformed *and* cut short is only incomplete: the bytes
  // that would decide it have not arrived (§5.2 — the length word is legal, so
  // there is nothing yet proving the message malformed).
  it.each(invalid.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    const full = behindPadding(hexToBytes(v.serialized_hex));
    const cut = full.subarray(0, full.length - 1);
    const c = seek(cut, Number(v.id));
    expect(codeOf(() => c.readString())).toBe(SofabErrorCode.Incomplete);
  });
});
