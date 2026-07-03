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

  it("accepts a brand-new buffer mid-stream via setBuffer", () => {
    const { sink, bytes } = collect();
    let swaps = 0;
    const os = new OStream(new Uint8Array(8), 0, (chunk) => {
      sink(chunk); // copy out before swapping
      os.setBuffer(new Uint8Array(8)); // hand the encoder a fresh buffer each drain
      swaps++;
    });
    for (let i = 0; i < 200; i++) os.writeUnsigned(i, BigInt(i * 1000));
    os.flush();

    const mem = new OStream();
    for (let i = 0; i < 200; i++) mem.writeUnsigned(i, BigInt(i * 1000));

    expect(bytes()).toEqual(mem.bytes());
    expect(swaps).toBeGreaterThan(1);
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

describe("OStream writeString UTF-8", () => {
  // The in-memory (growable) writeString scans the UTF-8 length and writes the
  // characters straight into the buffer; the streaming (fixed-buffer) path still
  // materialises via TextEncoder. Both must emit byte-identical fields for every
  // input — including 4-byte code points and unpaired surrogates (which WHATWG,
  // and therefore TextEncoder, replaces with U+FFFD).
  const cases = [
    "",
    "a",
    "Hello, World!",
    "äöüÄÖÜß",
    "äöü€",
    "😀😁🎉", // 4-byte code points (surrogate pairs)
    "𝕳𝖊𝖑𝖑𝖔",
    "日本語テスト",
    "café naïve",
    "\uD800", // lone high surrogate -> U+FFFD
    "\uDC00", // lone low surrogate -> U+FFFD
    "a\uD800b", // lone high surrogate in the middle
    "a\uDC00b", // lone low surrogate in the middle
    "\uD800\uD800", // two high surrogates (first is unpaired)
    "\uDFFF\uD83D", // low then high (both unpaired)
    "x".repeat(500) + "€", // longer, with a multibyte tail
  ];

  it("in-memory fast path matches the TextEncoder streaming path", () => {
    for (const s of cases) {
      const fast = new OStream();
      fast.writeString(0, s);

      const streamed = new OStream(new Uint8Array(8192), 0);
      streamed.writeString(0, s);

      expect(fast.bytes()).toEqual(streamed.bytes());
    }
  });

  it("round-trips every string through the decoder", () => {
    const dec = new TextDecoder();
    for (const s of cases) {
      const os = new OStream();
      os.writeString(0, s);
      let got: string | undefined;
      decode(os.bytes(), {
        string: (_id, _total, _offset, chunk) => {
          got = dec.decode(chunk);
        },
      });
      // Compare against TextEncoder's own normalisation (unpaired surrogates
      // become U+FFFD), which is what a correct encoder must have written.
      expect(got).toBe(dec.decode(new TextEncoder().encode(s)));
    }
  });
});

describe("OStream reset", () => {
  const write = (os: OStream, id: number): void => {
    os.writeUnsigned(id, id * 1000);
    os.writeString(id + 1, "pooled");
  };

  it("rewinds so one pooled encoder reproduces fresh encodes", () => {
    const pooled = new OStream();

    write(pooled, 1);
    const fresh1 = new OStream();
    write(fresh1, 1);
    expect(pooled.bytes()).toEqual(fresh1.bytes());

    pooled.reset();
    expect(pooled.bytesUsed).toBe(0);

    write(pooled, 5);
    const fresh2 = new OStream();
    write(fresh2, 5);
    expect(pooled.bytes()).toEqual(fresh2.bytes());
  });

  it("clears nesting depth left by an aborted encode", () => {
    const os = new OStream();
    // Abort mid-message with an unbalanced sequence, leaving depth > 0.
    os.writeUnsigned(1, 7);
    os.writeSequenceBegin(2);
    os.reset();

    // A clean encode afterwards must match a fresh encoder — the leftover
    // depth and bytes from the aborted attempt are gone.
    os.writeUnsigned(1, 7);
    os.writeSequenceBegin(2);
    os.writeSigned(1, -9);
    os.writeSequenceEnd();

    const fresh = new OStream();
    fresh.writeUnsigned(1, 7);
    fresh.writeSequenceBegin(2);
    fresh.writeSigned(1, -9);
    fresh.writeSequenceEnd();

    expect(os.bytes()).toEqual(fresh.bytes());
  });

  it("preserves a reserved front offset across reset", () => {
    const os = new OStream(new Uint8Array(64), 4);
    os.writeUnsigned(1, 7);
    os.reset();
    expect(os.bytesUsed).toBe(0);
    os.writeUnsigned(1, 7);
    expect(os.bytes().byteOffset).toBe(4); // still writing past the reserve
  });
});
