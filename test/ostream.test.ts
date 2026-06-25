/**
 * Encoder mechanics: streaming through a buffer smaller than the message, the
 * reserve-offset, large-payload chunking, and accepting both `number`/`bigint`
 * and typed-array inputs. Value-level coverage lives in `roundtrip.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { type FlushSink, IStream, OStream, decode } from "../src/index.js";
import { RecordingVisitor } from "./helpers/recording-visitor.js";

function collect(): { sink: FlushSink; bytes: () => Uint8Array } {
  const acc: number[] = [];
  return {
    sink: (c) => {
      for (let i = 0; i < c.length; i++) acc.push(c[i]!);
    },
    bytes: () => Uint8Array.from(acc),
  };
}

describe("OStream streaming", () => {
  it("flushes through a buffer far smaller than the message", () => {
    const { sink, bytes } = collect();
    const streamed = new OStream(new Uint8Array(8), 0, sink);
    for (let i = 0; i < 200; i++) streamed.writeUnsigned(i, BigInt(i * 1000));
    streamed.flush();

    const mem = new OStream();
    for (let i = 0; i < 200; i++) mem.writeUnsigned(i, BigInt(i * 1000));

    expect(bytes()).toEqual(mem.bytes());
  });

  it("streams every array kind through a small buffer (per-element path)", () => {
    const build = (os: OStream): void => {
      os.writeUnsignedArray(1, [1, 2, 300000, 1n << 50n]);
      os.writeSignedArray(2, [-1, -2, -300000]);
      os.writeFp32Array(3, [1.5, 2.5, 3.5]);
      os.writeFp64Array(4, [1.25, -2.75, 1e120]);
    };

    const { sink, bytes } = collect();
    const streamed = new OStream(new Uint8Array(12), 0, sink);
    build(streamed);
    streamed.flush();

    const mem = new OStream();
    build(mem);

    expect(bytes()).toEqual(mem.bytes());
  });

  it("streams a large blob in chunks through a tiny buffer", () => {
    const data = new Uint8Array(1000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;

    const { sink, bytes } = collect();
    const os = new OStream(new Uint8Array(8), 0, sink);
    os.writeBlob(3, data);
    os.flush();

    const seen = new RecordingVisitor();
    decode(bytes(), seen);
    const ev = seen.events[0]!;
    expect(ev.kind).toBe("blob");
    if (ev.kind === "blob") expect(ev.bytes).toEqual(data);
  });

  it("reserves a front offset and leaves it untouched", () => {
    const buf = new Uint8Array(64);
    const os = new OStream(buf, 4);
    os.writeUnsigned(1, 7);
    expect(buf.subarray(0, 4)).toEqual(new Uint8Array(4)); // still zero
    expect(os.bytesUsed).toBe(os.bytes().length);
    expect(os.bytes().byteOffset).toBe(4);
  });

  it("flush() is a no-op without a sink", () => {
    const os = new OStream();
    os.writeUnsigned(1, 1);
    const before = os.bytesUsed;
    os.flush();
    expect(os.bytesUsed).toBe(before);
  });
});

describe("OStream input flexibility", () => {
  it("accepts number and bigint interchangeably", () => {
    const a = new OStream();
    a.writeUnsigned(1, 42);
    const b = new OStream();
    b.writeUnsigned(1, 42n);
    expect(a.bytes()).toEqual(b.bytes());
  });

  it("accepts typed arrays for array writers", () => {
    const a = new OStream();
    a.writeUnsignedArray(1, new BigUint64Array([1n, 2n, 3n]));
    const b = new OStream();
    b.writeUnsignedArray(1, [1n, 2n, 3n]);
    expect(a.bytes()).toEqual(b.bytes());

    const c = new OStream();
    c.writeFp64Array(2, new Float64Array([1.5, 2.5]));
    const d = new OStream();
    d.writeFp64Array(2, [1.5, 2.5]);
    expect(c.bytes()).toEqual(d.bytes());
  });

  it("round-trips a streamed message back through the decoder", () => {
    const { sink, bytes } = collect();
    const os = new OStream(new Uint8Array(16), 0, sink);
    os.writeUnsigned(1, 1);
    os.writeString(2, "streamed");
    os.writeSequenceBegin(3);
    os.writeSigned(1, -9);
    os.writeSequenceEnd();
    os.flush();

    const seen = new RecordingVisitor();
    const is = new IStream();
    is.feed(bytes(), seen);
    is.end();
    expect(seen.events.map((e) => e.kind)).toEqual([
      "unsigned",
      "string",
      "sequenceBegin",
      "signed",
      "sequenceEnd",
    ]);
  });
});
