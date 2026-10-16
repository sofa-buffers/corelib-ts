/**
 * {@link tryDecode}: the one-shot decode that RETURNS the outcome of the whole
 * buffer instead of throwing on truncation, on the same pooled machine as
 * {@link decode}.
 *
 * Pinned from the outside, against the two surfaces it must agree with:
 *
 * - **{@link IStream.feed}**, for the verdict. One feed of the whole buffer is the
 *   definition, so every prefix of a reference message gets the same answer from
 *   both — `Complete` on a field boundary, `Incomplete` inside a field or an open
 *   sequence, and the same refusal code where the bytes are malformed.
 * - **{@link decode}**, for everything the visitor sees. Same callbacks, same
 *   order, same values.
 *
 * And it shares {@link decode}'s pooled machine, so an aborted `tryDecode` must
 * leave nothing behind for the next `decode` (or `tryDecode`), a decode started
 * from inside a visitor callback must still work, and a refusal must leave on the
 * error channel — never as a returned `Invalid` (one fact, one channel). What
 * these tests pin is that the machine is left clean either way; that it IS the
 * pooled one is the function body's, which allocates nothing an outside
 * observer can count.
 */

import { describe, expect, it } from "vitest";
import v8 from "node:v8";
import vm from "node:vm";
import { FP64_HANDLE_MIN } from "../src/constants.js";
import {
  DecodeStatus,
  IStream,
  SofabError,
  SofabErrorCode,
  decode,
  decodeUtf8,
  growingOStream,
  tryDecode,
  type Visitor,
} from "../src/index.js";

/**
 * `WeakRef` is ES2021 and this project's `lib` is ES2020 — the floor the library
 * itself compiles against, which one test has no business raising. Node has had it
 * since 14, so the retention check below reaches it through the runtime global.
 */
interface Weak<T extends object> {
  deref(): T | undefined;
}
const WeakRef = (
  globalThis as unknown as { WeakRef: new <T extends object>(target: T) => Weak<T> }
).WeakRef;

/** A message touching every construct the decoder keeps state for. */
function reference(): Uint8Array {
  const os = growingOStream();
  os.writeUnsigned(1, 0xdead_beefn);
  os.writeSigned(2, -12345);
  os.writeFp32(3, 1.5);
  os.writeFp64(4, -2.25);
  os.writeString(5, "sofab");
  os.writeBlob(6, Uint8Array.of(9, 8, 7));
  os.writeUnsignedArray(7, [10, 20, 30, 40]);
  os.writeSequenceBeginLazy(9);
  os.writeUnsigned(1, 99);
  os.writeSequenceEndKeep();
  return os.bytes().slice();
}

const REFERENCE = reference();

/** A visitor that logs every callback, so two decodes can be compared whole. */
function logger(log: string[]): Visitor {
  let elems: (number | bigint)[] = [];
  return {
    unsigned: (id, value) => void log.push(`u ${id}=${value}`),
    signed: (id, value) => void log.push(`s ${id}=${value}`),
    fp32: (id, value, bits) => void log.push(`f32 ${id}=${value} ${bits >>> 0}`),
    fp64: (id, value) => void log.push(`f64 ${id}=${value}`),
    string: (id, total, offset, src, start, end) =>
      void log.push(`str ${id} ${total} ${offset} ${decodeUtf8(src, start, end)}`),
    blob: (id, total, offset, src, start, end) =>
      void log.push(`blob ${id} ${total} ${offset} ${[...src.subarray(start, end)].join(",")}`),
    arrayBegin: (id, kind, count) => {
      log.push(`ab ${id} ${kind} ${count}`);
      elems = [];
    },
    arrayBulk: () => ({ values: elems, minLo: 0, minHi: 0, maxLo: 0xffffffff, maxHi: 0xffffffff }),
    arrayEnd: (id) => void log.push(`ae ${id} [${elems.join(",")}]`),
    sequenceBegin: (id, depth) => {
      log.push(`sb ${id}@${depth}`);
      return true;
    },
    sequenceEnd: (id, depth) => void log.push(`se ${id}@${depth}`),
  };
}

/** The outcome of `fn`: what it returned, or the code of the SofabError it threw. */
function outcomeOf(fn: () => string | void): string {
  try {
    return fn() ?? "none";
  } catch (e) {
    if (e instanceof SofabError) return `throw ${e.code}`;
    throw e;
  }
}

describe("tryDecode", () => {
  it("returns Complete for a whole message, with the callbacks decode makes", () => {
    const viaDecode: string[] = [];
    decode(REFERENCE, logger(viaDecode));
    const viaTry: string[] = [];
    expect(tryDecode(REFERENCE, logger(viaTry))).toBe(DecodeStatus.Complete);
    expect(viaTry).toStrictEqual(viaDecode);
    expect(viaTry.length).toBeGreaterThan(10);
  });

  it("answers every prefix exactly as one IStream.feed of it does", () => {
    // Every cut point: mid-varint, mid-fixlen word, mid-payload, mid-float,
    // mid-array, inside the open sequence — and the field boundaries between them.
    const seen = new Set<string>();
    for (let cut = 0; cut <= REFERENCE.length; cut++) {
      const prefix = REFERENCE.subarray(0, cut);
      const want = outcomeOf(() => new IStream({}).feed(prefix));
      const got = outcomeOf(() => tryDecode(prefix, {}));
      expect(got, `cut at ${cut}`).toBe(want);
      seen.add(got);
    }
    // Both returned outcomes occur; a cut list that stopped producing one of them
    // would stop testing it.
    expect(seen).toStrictEqual(new Set([DecodeStatus.Complete, DecodeStatus.Incomplete]));
  });

  it("returns Incomplete for an unclosed sequence, where decode throws", () => {
    const open = Uint8Array.of(0x4e); // sequence start at id 9, never closed
    expect(tryDecode(open, {})).toBe(DecodeStatus.Incomplete);
    expect(outcomeOf(() => decode(open, {}))).toBe(`throw ${SofabErrorCode.Incomplete}`);
  });

  it("throws a refusal instead of returning it (one fact, one channel)", () => {
    // An unbalanced sequence end: malformed whatever follows.
    expect(outcomeOf(() => tryDecode(Uint8Array.of(0x07), {}))).toBe(
      `throw ${SofabErrorCode.InvalidMsg}`,
    );
    // An 11-byte varint header.
    const overlong = Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01);
    expect(outcomeOf(() => tryDecode(overlong, {}))).toBe(`throw ${SofabErrorCode.InvalidMsg}`);
    // A receiver cap the visitor enforces is LIMIT_EXCEEDED, not INVALID.
    const capped: Visitor = {
      arrayBegin: () => {
        throw new SofabError(SofabErrorCode.LimitExceeded, "over cap");
      },
    };
    expect(outcomeOf(() => tryDecode(REFERENCE, capped))).toBe(
      `throw ${SofabErrorCode.LimitExceeded}`,
    );
  });

  it("leaves the pooled machine clean after every abort", () => {
    const expected: string[] = [];
    decode(REFERENCE, logger(expected));
    for (let cut = 1; cut < REFERENCE.length; cut++) {
      // Aborted with a *real* visitor: `{}` installs no array destination and no
      // chunk handle, so a machine that kept them would still pass this sweep.
      tryDecode(REFERENCE.subarray(0, cut), logger([]));
      const log: string[] = [];
      expect(tryDecode(REFERENCE, logger(log)), `after a cut at ${cut}`).toBe(DecodeStatus.Complete);
      expect(log, `after a cut at ${cut}`).toStrictEqual(expected);
    }
    // A latched INVALID ends with the call that met it.
    expect(outcomeOf(() => tryDecode(Uint8Array.of(0x07), {}))).toBe(
      `throw ${SofabErrorCode.InvalidMsg}`,
    );
    const after: string[] = [];
    decode(REFERENCE, logger(after));
    expect(after).toStrictEqual(expected);
  });

  it("keeps nothing of the caller's alive in the pool after an abort", async () => {
    // What `release()` is *for*, and the only part of it an outside observer can
    // see: the machine goes back to the pool holding no reference to the visitor,
    // to the chunk it was fed, or to the destination an array hand-off gave it.
    // The sweep above cannot pin this — `begin()` clears `bulk` and re-points the
    // visitor on the next decode, and a stale chunk handle is rebuilt the moment a
    // different buffer arrives, so a machine that released nothing decodes exactly
    // the same. It would merely hold the last caller's message alive for the life
    // of the process (§6.6/§6.7), which is a liveness fact and is measured as one.
    //
    // An abort *inside* a bulk float array is the case that installs all three:
    // the hand-off destination, and — past FP64_HANDLE_MIN elements in the chunk —
    // the `DataView` over the fed buffer that the run takes.
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    v8.setFlagsFromString("--no-expose-gc");

    let status: string = DecodeStatus.Complete;
    const held = (() => {
      const os = growingOStream();
      os.writeFp64Array(1, Array.from({ length: 4 * FP64_HANDLE_MIN }, (_, i) => i + 0.5));
      // Cut a quarter of the elements short: the run left in the chunk is still
      // well past the handle threshold, and the array is open when the bytes end.
      const chunk = os.bytes().slice().subarray(0, os.bytes().length - FP64_HANDLE_MIN * 8);
      const dest = new Float64Array(4 * FP64_HANDLE_MIN);
      const visitor: Visitor = { arrayBulk: () => ({ f64: dest }) };
      status = tryDecode(chunk, visitor);
      return { visitor: new WeakRef(visitor), chunk: new WeakRef(chunk), dest: new WeakRef(dest) };
    })();
    expect(status).toBe(DecodeStatus.Incomplete);

    // A `WeakRef` made in this job keeps its target alive until the end of it, by
    // specification, so the collection has to happen on the other side of a turn.
    const settle = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 0));
      gc();
    };
    const alive = (): boolean =>
      held.visitor.deref() !== undefined ||
      held.chunk.deref() !== undefined ||
      held.dest.deref() !== undefined;
    for (let i = 0; i < 10 && alive(); i++) await settle();

    expect({
      visitor: held.visitor.deref(),
      chunk: held.chunk.deref(),
      dest: held.dest.deref(),
    }).toStrictEqual({ visitor: undefined, chunk: undefined, dest: undefined });
  });

  it("is re-entrant: a decode started inside a callback runs on its own machine", () => {
    const inner = Uint8Array.of(0x08, 0x05); // id 1 = 5
    let nested = "";
    const outer: Visitor = {
      unsigned: (id) => {
        if (id !== 1) return;
        const log: string[] = [];
        nested = `${tryDecode(inner, logger(log))} ${log.join(";")}`;
      },
    };
    expect(tryDecode(REFERENCE, outer)).toBe(DecodeStatus.Complete);
    expect(nested).toBe(`${DecodeStatus.Complete} u 1=5`);
    // …and the outer machine went back to the pool intact.
    const log: string[] = [];
    decode(REFERENCE, logger(log));
    const expected: string[] = [];
    new IStream(logger(expected)).feed(REFERENCE);
    expect(log).toStrictEqual(expected);
  });
});
