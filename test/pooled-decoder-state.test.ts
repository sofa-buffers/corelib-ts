/**
 * The one-shot {@link decode} reuses one decoder across calls, and this is what
 * makes that safe.
 *
 * Constructing a decoder is the only allocating step there is (CORELIB_PLAN §6.6),
 * so paying it per message would be most of the cost of decoding a small one.
 * `decode()` therefore keeps one machine and re-binds it — and `DecoderState.begin`
 * clears only the fields a fresh decode can *read*, because every other one is
 * written before it is read on every path that reads it (see its doc comment).
 *
 * That reasoning is exactly the kind that rots under later edits, so it is pinned
 * here from the outside: **abort a decode inside every construct the machine has
 * state for, then decode a good message on the same pooled machine and require the
 * right answer.** A field that leaked would show up as a wrong value, a wrong
 * length, or a verdict carried over from the previous message.
 *
 * The aborts cover a partial varint, a partial fixlen payload, a partial fp32, a
 * half-read array, an unclosed sequence, a latched `INVALID`, and a terminal
 * receiver-cap rejection — the last two because they are the only verdicts that
 * *are* meant to outlive a `feed`, and must not outlive the `decode` that ended.
 */

import { describe, expect, it } from "vitest";
import {
  ArrayKind,
  SofabError,
  SofabErrorCode,
  decode,
  decodeUtf8,
  growingOStream,
  type Visitor,
} from "../src/index.js";

/**
 * A generated-layer stand-in that holds the receiver caps and compares them
 * itself, at the header callbacks (§6.2.1 — the codec holds none). The
 * cap-rejection cases below drive the pooled machine through a throw raised from
 * inside a visitor callback, which is now the only way a cap rejection happens.
 */
function capped(caps: { array?: number; fixlen?: number }): Visitor {
  return {
    arrayBegin(_id, _kind, count) {
      if (caps.array !== undefined && count > caps.array) {
        throw new SofabError(SofabErrorCode.LimitExceeded, `count ${count} over cap`);
      }
    },
    fixlenBegin(_id, _sub, total) {
      if (caps.fixlen !== undefined && total > caps.fixlen) {
        throw new SofabError(SofabErrorCode.LimitExceeded, `length ${total} over cap`);
      }
    },
  };
}

/** A reference message touching every construct the decoder keeps state for. */
function reference(): Uint8Array {
  const os = growingOStream();
  os.writeUnsigned(1, 0xdead_beefn);
  os.writeSigned(2, -12345);
  os.writeFp32(3, 1.5);
  os.writeFp64(4, -2.25);
  os.writeString(5, "sofab");
  os.writeBlob(6, Uint8Array.of(9, 8, 7));
  os.writeUnsignedArray(7, [10, 20, 30, 40]);
  os.writeFp32Array(8, [1.5, 2.5]);
  os.writeSequenceBeginLazy(9);
  os.writeUnsigned(1, 99);
  os.writeSequenceEndKeep();
  return os.bytes().slice();
}

const REFERENCE = reference();

/** Everything the reference message decodes to, as one comparable log. */
function transcript(bytes: Uint8Array): string[] {
  const log: string[] = [];
  const v: Visitor = {
    unsigned: (id, value, lo, hi) => void log.push(`u ${id}=${value} ${lo}/${hi}`),
    signed: (id, value, lo, hi) => void log.push(`s ${id}=${value} ${lo}/${hi}`),
    fp32: (id, value, bits) => void log.push(`f32 ${id}=${value} ${bits >>> 0}`),
    fp64: (id, value) => void log.push(`f64 ${id}=${value}`),
    fixlenBegin: (id, subtype, total) => void log.push(`fb ${id} ${subtype} ${total}`),
    string: (id, total, offset, src, start, end) =>
      void log.push(`str ${id} ${total} ${offset} ${decodeUtf8(src, start, end)}`),
    blob: (id, total, offset, src, start, end) =>
      void log.push(`blob ${id} ${total} ${offset} ${[...src.subarray(start, end)].join(",")}`),
    arrayBegin: (id, kind: ArrayKind, count) => void log.push(`ab ${id} ${kind} ${count}`),
    arrayUnsigned: (id, i, value, lo, hi) => void log.push(`au ${id}[${i}]=${value} ${lo}/${hi}`),
    arrayFp32: (id, i, value, bits) => void log.push(`af32 ${id}[${i}]=${value} ${bits >>> 0}`),
    arrayEnd: (id) => void log.push(`ae ${id}`),
    sequenceBegin: (id, depth) => void log.push(`sb ${id}@${depth}`),
    sequenceEnd: (id, depth) => void log.push(`se ${id}@${depth}`),
  };
  decode(bytes, v);
  return log;
}

const EXPECTED = transcript(REFERENCE);

/** Run `fn`, returning the `SofabError` code it threw (or `"none"`). */
function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SofabError) return e.code;
    throw e;
  }
  return "none";
}

/** The verdicts that are *meant* to outlive a `feed` — and must not outlive a decode. */
const ABORTS: [string, () => string][] = [
  [
    "a malformed message (INVALID, which latches)",
    // 0x07 with no open sequence: an unbalanced end.
    () => codeOf(() => decode(Uint8Array.of(0x07), {})),
  ],
  [
    "a receiver-cap rejection thrown from the visitor (LIMIT_EXCEEDED)",
    () => codeOf(() => decode(REFERENCE, capped({ array: 1 }))),
  ],
  [
    "a visitor that throws mid-message",
    () =>
      codeOf(() =>
        decode(REFERENCE, {
          fp64: () => {
            throw new SofabError(SofabErrorCode.InvalidMsg, "the reader gave up");
          },
        }),
      ),
  ],
];

describe("a pooled decoder carries nothing from the decode before it", () => {
  it("has a reference transcript to compare against", () => {
    expect(EXPECTED.length).toBeGreaterThan(15);
    expect(EXPECTED).toContain("str 5 5 0 sofab");
  });

  it("stays clean after an abort at every single cut point", () => {
    // Every prefix of the reference message, so every construct the machine holds
    // state for is abandoned in turn — mid-varint, mid-fixlen-word, mid-payload,
    // mid-float, mid-count, mid-element, inside the nested scope. Enumerating the
    // cuts instead of naming them is what keeps this honest when the message
    // changes: a cut that lands on a field boundary simply completes.
    let aborted = 0;
    for (let cut = 1; cut < REFERENCE.length; cut++) {
      if (codeOf(() => decode(REFERENCE.subarray(0, cut), {})) !== "none") aborted++;
      expect(transcript(REFERENCE), `after a cut at ${cut}`).toStrictEqual(EXPECTED);
    }
    // Most cuts land mid-field; if that stopped being true the loop above would
    // be testing a clean machine over and over.
    expect(aborted).toBeGreaterThan(REFERENCE.length / 2);
  });

  it.each(ABORTS)("after %s", (_name, abort) => {
    // The abort itself must fail — a case that stopped failing would silently
    // stop testing anything.
    expect(abort()).not.toBe("none");
    // …and the very next decode, on the same pooled machine, must be untouched.
    expect(transcript(REFERENCE)).toStrictEqual(EXPECTED);
  });

  it("survives every abort back to back, in one pass", () => {
    for (let cut = 1; cut < REFERENCE.length; cut++) {
      codeOf(() => decode(REFERENCE.subarray(0, cut), {}));
    }
    for (const [, abort] of ABORTS) abort();
    expect(transcript(REFERENCE)).toStrictEqual(EXPECTED);
  });

  it("does not leak a verdict: a latched INVALID ends with its decode", () => {
    expect(codeOf(() => decode(Uint8Array.of(0x07), {}))).toBe(SofabErrorCode.InvalidMsg);
    // A fresh one-shot decode of well-formed bytes must not inherit the latch.
    expect(codeOf(() => decode(REFERENCE, {}))).toBe("none");
  });

  it("does not leak a cap: a tight visitor on one decode does not bind the next", () => {
    // The machine is pooled, so a cap rejection must leave nothing behind. With
    // the numbers in the visitor there is nothing on the machine to leave — but
    // the abort still has to unwind cleanly, which is what this pins.
    expect(codeOf(() => decode(REFERENCE, capped({ array: 1 })))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    expect(codeOf(() => decode(REFERENCE, {}))).toBe("none");
    // …and the reverse: a loose decode does not loosen a tight one after it.
    expect(codeOf(() => decode(REFERENCE, capped({ fixlen: 1 })))).toBe(
      SofabErrorCode.LimitExceeded,
    );
  });

  it("keeps a re-entrant decode independent of the one it runs inside", () => {
    // The pool holds one machine, so a decode started from inside a visitor
    // callback builds its own. Both must complete, and neither may disturb the
    // other's position.
    const inner: string[] = [];
    const outer: string[] = [];
    decode(REFERENCE, {
      unsigned: (id) => {
        outer.push(`u${id}`);
        if (id === 1 && inner.length === 0) {
          decode(REFERENCE, { unsigned: (innerId) => void inner.push(`u${innerId}`) });
        }
      },
    });
    expect(inner).toStrictEqual(["u1", "u1"]);
    expect(outer).toStrictEqual(["u1", "u1"]);
    // And the pool is usable afterwards.
    expect(transcript(REFERENCE)).toStrictEqual(EXPECTED);
  });
});
