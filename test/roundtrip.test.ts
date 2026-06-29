/**
 * Encode → decode value preservation across the type system, including 64-bit
 * boundaries (which require `bigint`), IEEE specials, empty payloads, and
 * hierarchical nested sequences routed to child visitors.
 */

import { describe, expect, it } from "vitest";
import {
  ArrayKind,
  I64_MAX,
  I64_MIN,
  IStream,
  OStream,
  U64_MAX,
  decode,
  type Visitor,
} from "../src/index.js";
import { RecordingVisitor } from "./helpers/recording-visitor.js";

function roundtrip(write: (os: OStream) => void): RecordingVisitor {
  const os = new OStream();
  write(os);
  const seen = new RecordingVisitor();
  decode(os.bytes(), seen);
  return seen;
}

describe("scalar round-trips", () => {
  it("preserves unsigned 64-bit boundaries", () => {
    const seen = roundtrip((os) => {
      os.writeUnsigned(1, 0n);
      os.writeUnsigned(2, U64_MAX);
    });
    // Number-first decode: values that fit are delivered as `number`, the
    // 64-bit boundary (> 2^53) as `bigint`.
    expect(seen.events).toEqual([
      { kind: "unsigned", id: 1, value: 0 },
      { kind: "unsigned", id: 2, value: U64_MAX },
    ]);
  });

  it("preserves signed 64-bit boundaries", () => {
    const seen = roundtrip((os) => {
      os.writeSigned(1, I64_MIN);
      os.writeSigned(2, I64_MAX);
      os.writeSigned(3, -1n);
    });
    expect(seen.events).toEqual([
      { kind: "signed", id: 1, value: I64_MIN },
      { kind: "signed", id: 2, value: I64_MAX },
      { kind: "signed", id: 3, value: -1 },
    ]);
  });

  it("preserves booleans (as unsigned 0/1)", () => {
    const seen = roundtrip((os) => {
      os.writeBoolean(1, true);
      os.writeBoolean(2, false);
    });
    expect(seen.events).toEqual([
      { kind: "unsigned", id: 1, value: 1 },
      { kind: "unsigned", id: 2, value: 0 },
    ]);
  });

  it("preserves fp32 (with float32 rounding) and fp64", () => {
    const seen = roundtrip((os) => {
      os.writeFp32(1, 3.14159);
      os.writeFp64(2, Math.PI);
      os.writeFp32(3, Infinity);
      os.writeFp64(4, -Infinity);
    });
    expect(seen.events[0]).toEqual({ kind: "fp32", id: 1, value: Math.fround(3.14159) });
    expect(seen.events[1]).toEqual({ kind: "fp64", id: 2, value: Math.PI });
    expect(seen.events[2]).toEqual({ kind: "fp32", id: 3, value: Infinity });
    expect(seen.events[3]).toEqual({ kind: "fp64", id: 4, value: -Infinity });
  });

  it("preserves strings, unicode and empties", () => {
    const seen = roundtrip((os) => {
      os.writeString(1, "Hello, Sofab!");
      os.writeString(2, "äöü€");
      os.writeString(3, "");
      os.writeBlob(4, Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
      os.writeBlob(5, new Uint8Array(0));
    });
    expect(seen.events).toEqual([
      { kind: "string", id: 1, text: "Hello, Sofab!" },
      { kind: "string", id: 2, text: "äöü€" },
      { kind: "string", id: 3, text: "" },
      { kind: "blob", id: 4, bytes: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]) },
      { kind: "blob", id: 5, bytes: new Uint8Array(0) },
    ]);
  });
});

describe("array round-trips", () => {
  it("preserves unsigned and signed arrays at the boundaries", () => {
    const seen = roundtrip((os) => {
      os.writeUnsignedArray(1, [0n, U64_MAX]);
      os.writeSignedArray(2, [I64_MIN, 0n, I64_MAX]);
    });
    expect(seen.events[0]).toEqual({ kind: "array", id: 1, arrayKind: ArrayKind.Unsigned, values: [0, U64_MAX] });
    expect(seen.events[1]).toEqual({
      kind: "array",
      id: 2,
      arrayKind: ArrayKind.Signed,
      values: [I64_MIN, 0, I64_MAX],
    });
  });

  it("preserves float arrays", () => {
    const seen = roundtrip((os) => {
      os.writeFp32Array(1, [1, 2, 3]);
      os.writeFp64Array(2, [1.5, -2.5, 1e308]);
    });
    expect(seen.events[0]).toEqual({ kind: "array", id: 1, arrayKind: ArrayKind.Fp32, values: [1, 2, 3] });
    expect(seen.events[1]).toEqual({ kind: "array", id: 2, arrayKind: ArrayKind.Fp64, values: [1.5, -2.5, 1e308] });
  });
});

describe("nested sequences", () => {
  it("records balanced begin/end markers", () => {
    const seen = roundtrip((os) => {
      os.writeUnsigned(1, 1);
      os.writeSequenceBegin(2);
      os.writeUnsigned(1, 2);
      os.writeSequenceBegin(3);
      os.writeUnsigned(1, 3);
      os.writeSequenceEnd();
      os.writeSequenceEnd();
    });
    expect(seen.events.map((e) => e.kind)).toEqual([
      "unsigned",
      "sequenceBegin",
      "unsigned",
      "sequenceBegin",
      "unsigned",
      "sequenceEnd",
      "sequenceEnd",
    ]);
  });

  it("routes nested fields to a child visitor returned from sequenceBegin", () => {
    // Outer collects id 1; the nested sequence's fields go to a fresh Inner.
    class Inner implements Visitor {
      value: number | bigint = 0;
      unsigned(_id: number, v: number | bigint): void {
        this.value = v;
      }
    }
    class Outer implements Visitor {
      value: number | bigint = 0;
      readonly inner = new Inner();
      unsigned(_id: number, v: number | bigint): void {
        this.value = v;
      }
      sequenceBegin(): Visitor {
        return this.inner;
      }
    }

    const os = new OStream();
    os.writeUnsigned(1, 11n);
    os.writeSequenceBegin(2);
    os.writeUnsigned(1, 99n); // must land on Inner, not Outer
    os.writeSequenceEnd();

    const outer = new Outer();
    const is = new IStream();
    is.feed(os.bytes(), outer);
    is.end();

    expect(outer.value).toBe(11);
    expect(outer.inner.value).toBe(99);
  });
});
