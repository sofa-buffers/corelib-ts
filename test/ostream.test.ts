/**
 * Encoder mechanics: streaming through a buffer smaller than the message, the
 * reserve-offset, large-payload chunking, and accepting both `number`/`bigint`
 * and typed-array inputs. Value-level coverage lives in `roundtrip.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { FixlenSubtype, type FlushSink, IStream, Long, OStream, decode } from "../src/index.js";
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
    os.writeSequenceBeginLazy(3);
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
  // materialises via TextEncoder. For every *valid* input — including 4-byte
  // code points — both must emit byte-identical fields. Strict UTF-8 (§8/§6.4)
  // means unpaired surrogates are rejected, not collapsed to U+FFFD; that
  // encode-reject behaviour is covered in test/utf8.test.ts.
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
    "a\u0000b", // embedded U+0000 round-trips (valid UTF-8)
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
      // Every case is valid UTF-8, so it round-trips unchanged.
      expect(got).toBe(s);
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
    os.writeSequenceBeginLazy(2);
    os.reset();

    // A clean encode afterwards must match a fresh encoder — the leftover
    // depth and bytes from the aborted attempt are gone.
    os.writeUnsigned(1, 7);
    os.writeSequenceBeginLazy(2);
    os.writeSigned(1, -9);
    os.writeSequenceEnd();

    const fresh = new OStream();
    fresh.writeUnsigned(1, 7);
    fresh.writeSequenceBeginLazy(2);
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

  it("drops a held-back sequence header left by an aborted encode", () => {
    const os = new OStream();
    // Abort with a sequence opened but never closed: its header is pending
    // encoder state, not buffer content, so `pos = start` alone would not clear
    // it and the *next* message would inherit a phantom `begin`.
    os.writeSequenceBeginLazy(4);
    os.reset();

    os.writeUnsigned(1, 7);
    expect(os.bytes()).toEqual(Uint8Array.from([0x08, 0x07]));
  });
});

// --- lazy sequence framing (MESSAGE_SPEC §2) --------------------------------

describe("OStream lazy sequence framing", () => {
  /** Encode with an in-memory stream and return a plain byte array. */
  function enc(body: (os: OStream) => void): number[] {
    const os = new OStream();
    body(os);
    return Array.from(os.bytes());
  }

  it("emits nothing for a sequence that never got content", () => {
    // An all-default sequence carries no information, so the field is omitted —
    // where the eager API would have written the two-byte empty frame 0E 07.
    expect(enc((os) => {
      os.writeSequenceBeginLazy(1);
      os.writeSequenceEnd();
    })).toEqual([]);
  });

  it("frames a contentless sequence when closed with endKeep", () => {
    // The array-element and explicit-empty cases of §2/§5.1.
    expect(enc((os) => {
      os.writeSequenceBeginLazy(1);
      os.writeSequenceEndKeep();
    })).toEqual([0x0e, 0x07]);
  });

  it("commits the enclosing run when an inner sequence is kept", () => {
    // Forcing a frame forces its ancestors too: the outer sequence got content
    // (the inner frame), so it is framed as well.
    expect(enc((os) => {
      os.writeSequenceBeginLazy(1);
      os.writeSequenceBeginLazy(2);
      os.writeSequenceEndKeep();
      os.writeSequenceEnd();
    })).toEqual([0x0e, 0x16, 0x07, 0x07]);
  });

  it("endKeep matches end once content exists", () => {
    // With content it makes no difference — the headers are already out.
    const withKeep = enc((os) => {
      os.writeSequenceBeginLazy(1);
      os.writeUnsigned(0, 42);
      os.writeSequenceEndKeep();
    });
    const withEnd = enc((os) => {
      os.writeSequenceBeginLazy(1);
      os.writeUnsigned(0, 42);
      os.writeSequenceEnd();
    });
    expect(withKeep).toEqual([0x0e, 0x00, 0x2a, 0x07]);
    expect(withKeep).toEqual(withEnd);
  });

  it("commits the whole held-back run on the first content", () => {
    // One child field commits the whole run, outermost header first, so a
    // non-default leaf deep inside brings every enclosing frame back in wire
    // order.
    expect(enc((os) => {
      os.writeSequenceBeginLazy(1);
      os.writeSequenceBeginLazy(2);
      os.writeUnsigned(0, 42);
      os.writeSequenceEnd();
      os.writeSequenceEnd();
    })).toEqual([0x0e, 0x16, 0x00, 0x2a, 0x07, 0x07]);
  });

  it("drops only the empty inner sequence", () => {
    // The outer one has content (the leaf) and is framed. This is the
    // interleaving a naive "drop the whole run" would get wrong.
    expect(enc((os) => {
      os.writeSequenceBeginLazy(1);
      os.writeSequenceBeginLazy(2);
      os.writeSequenceEnd();
      os.writeUnsigned(0, 42);
      os.writeSequenceEnd();
    })).toEqual([0x0e, 0x00, 0x2a, 0x07]);
  });

  it("keeps a dropped sequence after content independent of its siblings", () => {
    expect(enc((os) => {
      os.writeUnsigned(0, 1);
      os.writeSequenceBeginLazy(1);
      os.writeSequenceEnd();
      os.writeUnsigned(2, 3);
    })).toEqual([0x00, 0x01, 0x10, 0x03]);
  });

  it("produces the same bytes through a buffer far smaller than the message", () => {
    // Held-back headers are encoder state, not buffer content, so a flush can
    // never split a pending run: a 3-byte buffer sees the one-shot bytes.
    const { sink, bytes } = collect();
    const os = new OStream(new Uint8Array(3), 0, sink);
    os.writeSequenceBeginLazy(1);
    os.writeSequenceBeginLazy(2);
    os.writeSequenceEnd();
    os.writeUnsigned(0, 42);
    os.writeSequenceEnd();
    os.flush();
    expect(Array.from(bytes())).toEqual([0x0e, 0x00, 0x2a, 0x07]);
  });

  it("commits the run for every writer, not just the scalar one", () => {
    // Invariant: every writer on the public surface must emit the held-back run
    // before its own first byte. One that forgot would silently drop the frame.
    const writes: Array<[string, (os: OStream) => void]> = [
      ["unsigned", (os) => os.writeUnsigned(0, 1)],
      ["signed", (os) => os.writeSigned(0, -1)],
      ["boolean", (os) => os.writeBoolean(0, true)],
      ["fp32", (os) => os.writeFp32(0, 1.5)],
      ["fp64", (os) => os.writeFp64(0, 1.5)],
      ["string", (os) => os.writeString(0, "x")],
      ["blob", (os) => os.writeBlob(0, Uint8Array.from([1]))],
      ["fixlen", (os) => os.writeFixlen(0, Uint8Array.from([1]), FixlenSubtype.Blob)],
      ["unsignedArray", (os) => os.writeUnsignedArray(0, [1])],
      ["signedArray", (os) => os.writeSignedArray(0, [-1])],
      ["unsignedArrayLong", (os) => os.writeUnsignedArrayLong(0, [Long.fromNumber(1)])],
      ["signedArrayLong", (os) => os.writeSignedArrayLong(0, [Long.fromNumber(-1)])],
      ["fp32Array", (os) => os.writeFp32Array(0, [1.5])],
      ["fp32ArrayRaw", (os) => os.writeFp32ArrayRaw(0, new Uint8Array(4))],
      ["fp64Array", (os) => os.writeFp64Array(0, [1.5])],
    ];

    for (const [name, write] of writes) {
      // Same field, once inside a lazily-opened sequence and once bare: the
      // framed form must be exactly the bare form wrapped in 0E ... 07.
      const framed = enc((os) => {
        os.writeSequenceBeginLazy(1);
        write(os);
        os.writeSequenceEnd();
      });
      const bare = enc(write);
      expect(framed, `${name} must commit the pending run`).toEqual([0x0e, ...bare, 0x07]);
    }
  });

  it("keeps a wrapper-array element framed while omitting an all-default field", () => {
    // The one asymmetry that changes a *value*: an all-default element keeps its
    // frame so the array's length (highest present id + 1, §5.1) survives; an
    // all-default field vanishes. Here row id 1 is all-default and the array
    // must still decode as length 2.
    const os = new OStream();
    os.writeSequenceBeginLazy(3); // the wrapper array
    os.writeSequenceBeginLazy(0); // element 0: has content
    os.writeUnsigned(0, 7);
    os.writeSequenceEndKeep();
    os.writeSequenceBeginLazy(1); // element 1: all-default, still present
    os.writeSequenceEndKeep();
    os.writeSequenceEnd();
    os.writeSequenceBeginLazy(4); // an all-default struct *field*: omitted
    os.writeSequenceEnd();

    expect(Array.from(os.bytes())).toEqual([
      0x1e, // begin id 3 (wrapper)
      0x06, // begin id 0 (element 0)
      0x00, 0x07, // unsigned id 0 = 7
      0x07, // end element 0
      0x0e, // begin id 1 (element 1, empty but present)
      0x07, // end element 1
      0x07, // end wrapper
    ]);

    const seen = new RecordingVisitor();
    decode(os.bytes(), seen);
    expect(seen.events.filter((e) => e.kind === "sequenceBegin").map((e) => e.id)).toEqual([3, 0, 1]);
  });
});
