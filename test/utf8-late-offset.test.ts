/**
 * Invalid UTF-8 in a string that sits **late in the buffer** — the case the shared
 * `invalid_utf8` vectors never build.
 *
 * Every vector in that suite puts its string field at buffer offset 2 with a
 * payload of 1–4 bytes, so the offset of the payload and its length stay in the
 * same small range. A validator handed a *length* where an exclusive *end index*
 * was wanted (or the reverse) therefore still rejects them — it happens to be
 * scanning the right bytes — and a family-wide conformance run stays green while
 * the check is comprehensively broken. That is not hypothetical: it is exactly how
 * a `.length`-for-`end` bug survived a full conformance suite in a sibling port.
 *
 * The distinguishing case is a string whose **start offset is at or beyond its own
 * length**, so length-based and offset-based ranges cannot coincide. This file
 * replays the whole shared negative suite behind enough padding to force that.
 *
 * The decoder reports payload pieces as `(src, start, end)` into the caller's own
 * chunk (§6.6.3) and validates nothing itself (§6.4.5), so the coordinates are
 * precisely what is under test here: {@link decodeUtf8} is handed them, and a
 * decoder that reported a length where an end index belongs would scan the wrong
 * bytes. The suite also runs the payload through a `Uint8Array` that is itself a
 * view at a non-zero `byteOffset` into a larger `ArrayBuffer` — the other way an
 * offset-confused reader picks up the wrong bytes.
 *
 * The positive controls are what make it a test of validation rather than of
 * blanket rejection: a *valid* string at the same late offset must decode to the
 * exact expected text, and an invalid one that is merely **skipped** must not be
 * validated at all, leaving the decode `COMPLETE`.
 */

import { describe, expect, it } from "vitest";
import {
  DecodeStatus,
  IStream,
  SofabError,
  SofabErrorCode,
  decode,
  decodeUtf8,
  growingOStream,
  type Visitor,
} from "../src/index.js";
import { hexToBytes } from "./helpers/hex.js";
import { loadInvalidUtf8 } from "./helpers/vectors.js";

const invalid = loadInvalidUtf8();

/** Padding written ahead of the field under test: one 96-byte blob at id 3. */
const PAD_BLOB = 96;

/** `pad || tail`, where the pad is a well-formed blob field the decoder skips. */
function behindPadding(tail: Uint8Array): Uint8Array {
  const os = growingOStream();
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

/**
 * Materialize field `id` as a string, the way generated code does: join the pieces
 * the decoder reports and run the strict decoder over them.
 */
function materialize(msg: Uint8Array, id: number): string {
  let text: string | undefined;
  const v: Visitor = {
    string(fieldId, total, offset, src, start, end) {
      if (fieldId !== id) return;
      // The whole-payload shape, which is what a contiguous decode produces.
      if (offset === 0 && end - start === total) text = decodeUtf8(src, start, end);
    },
  };
  decode(msg, v);
  if (text === undefined) throw new Error(`field ${id} not found`);
  return text;
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
    // The vectors are parsed with bigint fidelity, so the id arrives as a bigint
    // and has to be narrowed before it is compared with a decoded one.
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

    it("is rejected as INVALID_MSG once it is materialized", () => {
      expect(codeOf(() => materialize(msg, id))).toBe(SofabErrorCode.InvalidMsg);
    });

    it("is rejected the same way through a non-zero byteOffset view", () => {
      const view = asOffsetView(msg, 7);
      expect(view.byteOffset).toBe(7);
      expect(codeOf(() => materialize(view, id))).toBe(SofabErrorCode.InvalidMsg);
    });

    it("reports the payload's exact coordinates, not a length-for-end mix-up", () => {
      // The decoder's own half of the contract: `(src, start, end)` must span
      // exactly the payload, wherever in the buffer it sits.
      let seen: number[] | undefined;
      decode(msg, {
        string: (fieldId, total, offset, src, start, end) => {
          if (fieldId === id) seen = [total, offset, start, end, ...src.subarray(start, end)];
        },
      });
      expect(seen).toStrictEqual([
        payload.length,
        0,
        payloadStart,
        msg.length,
        ...payload,
      ]);
    });

    it("is not validated when the field is skipped instead (§6.4.5)", () => {
      // Validation belongs where a string is materialized; a field nobody reads is
      // never materialized, so the message is COMPLETE, not INVALID.
      expect(() => decode(msg, {})).not.toThrow();
      // Declining the pieces is the same thing one level up: the bytes are handed
      // over unvalidated, and the decode completes.
      const pieces: number[][] = [];
      expect(() =>
        decode(msg, {
          string: (fieldId, total, offset, src, start, end) => {
            if (fieldId === id) pieces.push([total, offset, ...src.subarray(start, end)]);
          },
        }),
      ).not.toThrow();
      expect(pieces).toStrictEqual([[payload.length, 0, ...payload]]);
    });

    it("reaches the streaming visitor with field-relative offsets, one byte at a time", () => {
      // The `offset` a piece carries is its position *within the field*, not
      // within the buffer — the distinction this whole file is about. Fed one byte
      // at a time, a late field must still report 0, 1, 2, … and complete.
      const offsets: number[] = [];
      const seen: number[] = [];
      const sink: Visitor = {
        string: (fieldId, _total, offset, src, start, end) => {
          if (fieldId !== id) return;
          offsets.push(offset);
          for (let i = start; i < end; i++) seen.push(src[i]!);
        },
      };
      const is = new IStream(sink);
      for (const b of msg) is.feed(Uint8Array.of(b));
      expect(offsets).toStrictEqual(Array.from(payload, (_b, i) => i));
      expect(seen).toStrictEqual([...payload]);
      expect(is.status()).toBe(DecodeStatus.Complete);
    });
  });
});

describe("valid strings at the same late offset still decode (the control)", () => {
  const texts = ["a", "ok", "héllo", "日本語", "\u{1f600}", "x".repeat(200)];

  it.each(texts)("%j round-trips from behind the padding", (text) => {
    const inner = growingOStream();
    inner.writeString(0, text);
    const msg = behindPadding(inner.bytes());
    const payloadLen = new TextEncoder().encode(text).length;

    expect(materialize(msg, 0)).toBe(text);

    // And from a shifted view of the identical bytes.
    expect(materialize(asOffsetView(msg, 5), 0)).toBe(text);

    // Long enough for the offset >= length shape except for the last, deliberate
    // over-long case, which checks the reader does not depend on it either.
    expect(msg.length - payloadLen).toBeGreaterThan(0);
  });
});

describe("truncating a late invalid string is INCOMPLETE, not INVALID", () => {
  // A payload that is malformed *and* cut short is only incomplete: the bytes that
  // would decide it have not arrived (§5.2.3 — the length word is legal, so there
  // is nothing yet proving the message malformed), and the pieces delivered so far
  // never complete the payload, so nothing is materialized to validate.
  it.each(invalid.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    const full = behindPadding(hexToBytes(v.serialized_hex));
    const cut = full.subarray(0, full.length - 1);
    expect(codeOf(() => materialize(cut, Number(v.id)))).toBe(SofabErrorCode.Incomplete);
  });
});
