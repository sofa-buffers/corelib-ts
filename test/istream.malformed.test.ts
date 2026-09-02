/**
 * Malformed input on the **resumable** decoder, and the rule that ties it to the
 * whole-buffer ones: a chunk boundary must never change the verdict
 * (CORELIB_PLAN §5.2 / §6.4).
 *
 * There is one decoder (`src/decode/state.ts`), but two ways through it: the fast
 * lane, which runs while a whole field is known to be in the chunk, and the
 * resumable ladder, which suspends mid-varint and mid-word. So each rejection is
 * asserted at several chunkings, not just on the one-shot path the vector suite
 * drives:
 *
 *  - an `array<fixlen>` element word that is neither `fp32`/4 nor `fp64`/8
 *    (§4.8) — including the empty-array case, where the word is the only thing
 *    that carries the element kind;
 *  - a fixlen length word above `FIXLEN_MAX` (§4.6), which must be `INVALID`
 *    even though the payload it announces is missing — `INVALID` outranks
 *    `INCOMPLETE` for input already known to be malformed;
 *  - a varint past the 10-byte / 64-bit bound (§4.1), fed at **every** split
 *    point, which is what forces the resumable ladder and the whole-varint fast
 *    path to agree.
 */

import { describe, expect, it } from "vitest";
import {
  DecodeStatus,
  IStream,
  OStream,
  SofabError,
  SofabErrorCode,
  decode,
  type Visitor, growingOStream } from "../src/index.js";

function bytes(...n: number[]): Uint8Array {
  return Uint8Array.from(n);
}

// No receiver cap appears anywhere in this file, and none is needed: the codec
// holds none (§6.2.1) and these visitors state none, so the only thing left to
// reject is the bytes — which is what a file about the FORMAT ceiling and about
// truncation wants. Before §6.2.1 was honoured, every decode here had to pass a
// limits object raised to the format ceilings, to stop the codec's own defaulted
// caps from answering a capacity rejection to a malformed-input question.

/** Run `fn` and return the `SofabError` code it throws, or `"COMPLETE"`. */
function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SofabError) return e.code;
    throw e;
  }
  return "COMPLETE";
}

/** Feed `msg` to a fresh `IStream` in `size`-byte chunks; report the outcome. */
function feedInChunks(msg: Uint8Array, size: number, visitor: Visitor = {}): string {
  const is = new IStream(visitor);
  let st: string = DecodeStatus.Complete;
  try {
    for (let i = 0; i < msg.length; i += size) {
      st = is.feed(msg.subarray(i, Math.min(i + size, msg.length)));
    }
  } catch (e) {
    if (e instanceof SofabError) return e.code;
    throw e;
  }
  return st;
}

describe("array<fixlen> element word must be fp32/4 or fp64/8 (§4.8)", () => {
  // id 1, wire type 5 (array of fixlen) -> 0x0d, then the element count, then
  // the element word (byteLength << 3) | subtype.
  const cases: [string, number, number][] = [
    ["string subtype", 2, (4 << 3) | 2],
    ["blob subtype", 2, (4 << 3) | 3],
    ["fp32 with an 8-byte width", 2, (8 << 3) | 0],
    ["fp64 with a 4-byte width", 2, (4 << 3) | 1],
    ["fp32 with a zero width", 2, (0 << 3) | 0],
    ["reserved subtype 4", 2, (4 << 3) | 4],
    ["bad word on an empty array", 0, (4 << 3) | 2],
  ];

  it.each(cases)("%s is INVALID on the streaming path", (_name, count, word) => {
    const msg = bytes(0x0d, count, word, 0, 0, 0, 0, 0, 0, 0, 0);
    expect(feedInChunks(msg, msg.length)).toBe(SofabErrorCode.InvalidMsg);
    expect(feedInChunks(msg, 1)).toBe(SofabErrorCode.InvalidMsg);
  });

  it.each(cases)("%s is INVALID on the whole-buffer paths too", (_name, count, word) => {
    const msg = bytes(0x0d, count, word, 0, 0, 0, 0, 0, 0, 0, 0);
    expect(codeOf(() => decode(msg, {}))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("accepts the two legal element words as the control", () => {
    const fp32 = bytes(0x0d, 0x01, (4 << 3) | 0, 0, 0, 0x80, 0x3f);
    const fp64 = bytes(0x0d, 0x00, (8 << 3) | 1);
    expect(feedInChunks(fp32, 1)).toBe(DecodeStatus.Complete);
    expect(feedInChunks(fp64, 1)).toBe(DecodeStatus.Complete);
  });

  it("latches the verdict: a caught rejection cannot be decoded past", () => {
    const is = new IStream({});
    const msg = bytes(0x0d, 0x02, (4 << 3) | 2);
    expect(() => is.feed(msg)).toThrow(
      expect.objectContaining({ code: SofabErrorCode.InvalidMsg }),
    );
    // A well-formed continuation must not resurrect the stream (§5.2: terminal).
    // The rejection is re-raised rather than re-read: the throw is its only
    // channel, so no later call can hand back a status that forgot it.
    expect(() => is.feed(bytes(0x08, 0x01))).toThrow(
      expect.objectContaining({ code: SofabErrorCode.InvalidMsg }),
    );
  });
});

describe("a fixlen length word above FIXLEN_MAX is INVALID, not INCOMPLETE (§4.6/§5.2)", () => {
  /** id 0, fixlen; length word `(len << 3) | subtype`, as raw LEB128. */
  function fixlenHeader(len: bigint, subtype: number): Uint8Array {
    const out = [0x02];
    for (let v = (len << 3n) | BigInt(subtype); ; v >>= 7n) {
      if (v < 0x80n) {
        out.push(Number(v));
        return Uint8Array.from(out);
      }
      out.push(Number(v & 0x7fn) | 0x80);
    }
  }

  const TOO_BIG = 0x8000_0000n; // FIXLEN_MAX + 1
  const AT_MAX = 0x7fff_ffffn;

  it.each([
    ["string", 2],
    ["blob", 3],
  ])("%s: the over-range word is INVALID on every surface", (_name, sub) => {
    const msg = fixlenHeader(TOO_BIG, sub);
    expect(codeOf(() => decode(msg, {}))).toBe(SofabErrorCode.InvalidMsg);
    expect(feedInChunks(msg, msg.length)).toBe(SofabErrorCode.InvalidMsg);
    expect(feedInChunks(msg, 1)).toBe(SofabErrorCode.InvalidMsg);
  });

  it.each([
    ["string", 2],
    ["blob", 3],
  ])("%s: a length at FIXLEN_MAX with no payload is only INCOMPLETE", (_name, sub) => {
    // The control that makes the case above mean something: the same shape one
    // count lower is a representable field whose payload merely has not arrived.
    const msg = fixlenHeader(AT_MAX, sub);
    expect(codeOf(() => decode(msg, {}))).toBe(SofabErrorCode.Incomplete);
    expect(feedInChunks(msg, 1)).toBe(DecodeStatus.Incomplete);
  });
});

describe("a varint past the 64-bit bound is INVALID wherever the chunks fall (§4.1/§6.4)", () => {
  const ELEVEN = Uint8Array.from([...Array(10).fill(0x80), 0x00]); // 11 bytes
  const HIGH_BIT_SPILL = Uint8Array.from([...Array(9).fill(0x80), 0x02]); // bit 64

  it.each([
    ["an 11-byte varint", ELEVEN],
    ["a 10th byte carrying a bit above 63", HIGH_BIT_SPILL],
  ])("%s: same verdict at every chunk size", (_name, msg) => {
    for (let size = 1; size <= msg.length; size++) {
      expect(feedInChunks(msg, size)).toBe(SofabErrorCode.InvalidMsg);
    }
    expect(codeOf(() => decode(msg, {}))).toBe(SofabErrorCode.InvalidMsg);
  });

  it("same verdict at every single split point of the 11-byte varint", () => {
    // Split points matter beyond a fixed chunk size: the state machine takes the
    // ten-bytes-in-hand fast path only for a chunk that already holds them, so
    // the first cut decides which implementation sees the overflow.
    for (let cut = 0; cut <= ELEVEN.length; cut++) {
      const is = new IStream({});
      const code = codeOf(() => {
        is.feed(ELEVEN.subarray(0, cut));
        is.feed(ELEVEN.subarray(cut));
      });
      expect(code, `cut at ${cut}`).toBe(SofabErrorCode.InvalidMsg);
      // Terminal at every cut: the next feed raises the same code again.
      expect(() => is.feed(new Uint8Array(0))).toThrow(
        expect.objectContaining({ code: SofabErrorCode.InvalidMsg }),
      );
    }
  });

  it("accepts 2^64-1 — the largest legal varint — at every chunk size", () => {
    const os = growingOStream();
    os.writeUnsigned(1, 0xffff_ffff_ffff_ffffn);
    const msg = os.bytes().slice();
    for (let size = 1; size <= msg.length; size++) {
      const seen: (number | bigint)[] = [];
      expect(feedInChunks(msg, size, { unsigned: (_id, v) => void seen.push(v) })).toBe(
        DecodeStatus.Complete,
      );
      expect(seen).toStrictEqual([0xffff_ffff_ffff_ffffn]);
    }
  });
});

describe("a sequence still open at the end of the input is INCOMPLETE (§4.9/§7)", () => {
  // Not malformed: the closing marker could still arrive. The whole-buffer
  // decoder has to reach the same verdict as the resumable one, which reports it
  // from `depth !== 0` rather than from an unwound stack.
  const cases: [string, Uint8Array][] = [
    ["one open sequence", bytes(0x0e)],
    ["open sequence with a field in it", bytes(0x0e, 0x08, 0x2a)],
    ["two open sequences, one closed", bytes(0x0e, 0x16, 0x07)],
    ["nested three deep", bytes(0x0e, 0x16, 0x1e)],
  ];

  it.each(cases)("%s", (_name, msg) => {
    expect(codeOf(() => decode(msg, {}))).toBe(SofabErrorCode.Incomplete);
    expect(feedInChunks(msg, msg.length)).toBe(DecodeStatus.Incomplete);
    expect(feedInChunks(msg, 1)).toBe(DecodeStatus.Incomplete);
  });

  it("completes once the closers arrive", () => {
    expect(feedInChunks(bytes(0x0e, 0x16, 0x07, 0x07), 1)).toBe(DecodeStatus.Complete);
  });
});

describe("the streaming decoder reads every varint length like the whole-buffer one", () => {
  // One field per varint length 1..10. The trailing blob keeps ten bytes in hand
  // behind each header, so a single-chunk feed takes the whole-varint fast path
  // for all of them, while a one-byte feed takes the resumable ladder — the two
  // must produce the identical field list.
  const values = [
    0n,
    0x7fn,
    0x3fffn,
    0x1f_ffffn,
    0x0fff_ffffn,
    0x7_ffff_ffffn,
    0x3ff_ffff_ffffn,
    0x1_ffff_ffff_ffffn,
    0xff_ffff_ffff_ffffn,
    0x7fff_ffff_ffff_ffffn,
    0xffff_ffff_ffff_ffffn,
  ];

  const os = growingOStream();
  values.forEach((v, i) => os.writeUnsigned(i + 1, v));
  os.writeBlob(99, new Uint8Array(12));
  const msg = os.bytes().slice();

  /** Every `(id, value)` the decoder reports, as strings for easy comparison. */
  function fields(feed: (visitor: Visitor) => void): string[] {
    const out: string[] = [];
    feed({ unsigned: (id, v) => void out.push(`${id}=${v}`) });
    return out;
  }

  const expected = values.map((v, i) => `${i + 1}=${v}`);

  it("in one chunk", () => {
    expect(fields((v) => void new IStream(v).feed(msg))).toStrictEqual(expected);
  });

  it("one byte at a time", () => {
    expect(
      fields((v) => {
        const is = new IStream(v);
        for (const b of msg) is.feed(Uint8Array.of(b));
      }),
    ).toStrictEqual(expected);
  });

  it("and agrees with the whole-buffer decoder", () => {
    expect(fields((v) => decode(msg, v))).toStrictEqual(expected);
  });
});
