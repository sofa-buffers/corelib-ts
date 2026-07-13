/**
 * Opt-in decode limits (corelib-ts#38).
 *
 * A receiver may cap array counts and string / blob byte lengths by passing
 * {@link DecodeLimits} to a decode entry point. An over-limit field is rejected
 * at its header — before it is materialized or streamed — with a `SofabError`
 * whose code is {@link SofabErrorCode.LimitExceeded}, kept deliberately distinct
 * from `InvalidMsg` (policy, not malformation). With no options the identical
 * bytes decode unchanged (no corelib-side default cap).
 *
 * Every case is checked on all three decode paths: the one-shot push
 * {@link decode} (fast path), the pull {@link Cursor}, and the streaming
 * {@link IStream}.
 */

import { describe, expect, it } from "vitest";
import {
  Cursor,
  IStream,
  OStream,
  SofabError,
  SofabErrorCode,
  decode,
  type DecodeLimits,
  type Visitor,
} from "../src/index.js";

/** Run `fn` and return the SofabError code it throws (or fail loudly). */
function codeOf(fn: () => unknown): SofabErrorCode {
  try {
    fn();
  } catch (e) {
    if (e instanceof SofabError) return e.code;
    throw e;
  }
  throw new Error("expected a SofabError, but nothing was thrown");
}

/** Drive a whole buffer through the pull Cursor, reading every field's value. */
function drainCursor(buf: Uint8Array, limits?: DecodeLimits): void {
  const c = new Cursor(buf, limits);
  while (c.readHeader()) {
    switch (c.wire) {
      case 0: c.readUnsigned(); break;
      case 1: c.readSigned(); break;
      case 2: c.skip(2); break; // fixlen scalar: string/blob/fp — skip reads len
      case 3: c.readUnsignedArray(); break;
      case 4: c.readSignedArray(); break;
      case 5: c.skip(5); break;
      default: c.skip(c.wire); break;
    }
  }
}

/** Feed a whole buffer to a streaming IStream in one push. */
function drainStream(buf: Uint8Array, limits?: DecodeLimits, visitor: Visitor = {}): void {
  const is = new IStream(limits);
  is.feed(buf, visitor);
}

describe("decode limits: array count (maxArrayCount)", () => {
  // An otherwise-valid message carrying LIMIT + 1 unsigned elements.
  const LIMIT = 65536;
  const oversize = (() => {
    const os = new OStream();
    os.writeUnsignedArray(1, new Array(LIMIT + 1).fill(0));
    return os.bytes().slice();
  })();

  it("decodes unchanged with no options (no corelib-side default cap)", () => {
    expect(() => decode(oversize, {})).not.toThrow();
    expect(() => drainCursor(oversize)).not.toThrow();
    expect(() => drainStream(oversize)).not.toThrow();
  });

  it("throws LimitExceeded on every path once maxArrayCount is set", () => {
    const limits = { maxArrayCount: LIMIT };
    expect(codeOf(() => decode(oversize, {}, limits))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainCursor(oversize, limits))).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainStream(oversize, limits))).toBe(SofabErrorCode.LimitExceeded);
  });

  it("is distinct from InvalidMsg (policy, not malformation)", () => {
    expect(codeOf(() => decode(oversize, {}, { maxArrayCount: LIMIT }))).not.toBe(
      SofabErrorCode.InvalidMsg,
    );
  });

  it("accepts a count exactly at the limit, rejects one past it", () => {
    const at = (() => {
      const os = new OStream();
      os.writeUnsignedArray(1, new Array(8).fill(1));
      return os.bytes().slice();
    })();
    expect(() => decode(at, {}, { maxArrayCount: 8 })).not.toThrow();
    expect(codeOf(() => decode(at, {}, { maxArrayCount: 7 }))).toBe(
      SofabErrorCode.LimitExceeded,
    );
  });

  it("rejects before the array is materialized (streaming: no arrayBegin)", () => {
    let began = false;
    const spy: Visitor = { arrayBegin: () => { began = true; } };
    expect(codeOf(() => drainStream(oversize, { maxArrayCount: LIMIT }, spy))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    expect(began).toBe(false);
  });

  it("also caps signed and float arrays", () => {
    const signed = (() => {
      const os = new OStream();
      os.writeSignedArray(1, new Array(20).fill(-1));
      return os.bytes().slice();
    })();
    const floats = (() => {
      const os = new OStream();
      os.writeFp32Array(1, new Array(20).fill(1.5));
      return os.bytes().slice();
    })();
    expect(codeOf(() => decode(signed, {}, { maxArrayCount: 10 }))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    expect(codeOf(() => decode(floats, {}, { maxArrayCount: 10 }))).toBe(
      SofabErrorCode.LimitExceeded,
    );
  });
});

describe("decode limits: string length (maxStringLen)", () => {
  const msg = (() => {
    const os = new OStream();
    os.writeString(1, "x".repeat(100));
    return os.bytes().slice();
  })();

  it("decodes unchanged with no options", () => {
    expect(() => decode(msg, {})).not.toThrow();
    expect(() => drainCursor(msg)).not.toThrow();
    expect(() => drainStream(msg)).not.toThrow();
  });

  it("throws LimitExceeded on every path once maxStringLen is set", () => {
    const limits = { maxStringLen: 64 };
    expect(codeOf(() => decode(msg, {}, limits))).toBe(SofabErrorCode.LimitExceeded);
    // Cursor.readString is the path that actually decodes the payload.
    expect(
      codeOf(() => {
        const c = new Cursor(msg, limits);
        c.readHeader();
        c.readString();
      }),
    ).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainStream(msg, limits))).toBe(SofabErrorCode.LimitExceeded);
  });

  it("rejects before any string chunk reaches the visitor (streaming)", () => {
    let gotChunk = false;
    const spy: Visitor = { string: () => { gotChunk = true; } };
    expect(codeOf(() => drainStream(msg, { maxStringLen: 64 }, spy))).toBe(
      SofabErrorCode.LimitExceeded,
    );
    expect(gotChunk).toBe(false);
  });

  it("a blob is not capped by maxStringLen (independent limits)", () => {
    const blob = (() => {
      const os = new OStream();
      os.writeBlob(1, new Uint8Array(100));
      return os.bytes().slice();
    })();
    expect(() => decode(blob, {}, { maxStringLen: 4 })).not.toThrow();
  });
});

describe("decode limits: blob length (maxBlobLen)", () => {
  const msg = (() => {
    const os = new OStream();
    os.writeBlob(1, new Uint8Array(100));
    return os.bytes().slice();
  })();

  it("throws LimitExceeded on every path once maxBlobLen is set", () => {
    const limits = { maxBlobLen: 64 };
    expect(codeOf(() => decode(msg, {}, limits))).toBe(SofabErrorCode.LimitExceeded);
    expect(
      codeOf(() => {
        const c = new Cursor(msg, limits);
        c.readHeader();
        c.readBlob();
      }),
    ).toBe(SofabErrorCode.LimitExceeded);
    expect(codeOf(() => drainStream(msg, limits))).toBe(SofabErrorCode.LimitExceeded);
  });

  it("a string is not capped by maxBlobLen (independent limits)", () => {
    const str = (() => {
      const os = new OStream();
      os.writeString(1, "x".repeat(100));
      return os.bytes().slice();
    })();
    expect(() => decode(str, {}, { maxBlobLen: 4 })).not.toThrow();
  });
});

describe("decode limits: Part A hardening (Cursor pre-sizing)", () => {
  // A hand-crafted array header claiming far more elements than the buffer can
  // hold must be rejected as truncation (INCOMPLETE) before `new Array(count)`
  // is sized — never allowed to drive a giant allocation from a tiny buffer.
  it("rejects an array count larger than the remaining bytes as INCOMPLETE", () => {
    // header id 1 ArrayUnsigned (wire 3) = 0x0b, then count varint 1000, then
    // only a couple of payload bytes.
    const buf = Uint8Array.from([0x0b, 0xe8, 0x07, 0x01, 0x01]);
    expect(codeOf(() => drainCursor(buf))).toBe(SofabErrorCode.Incomplete);
  });
});
