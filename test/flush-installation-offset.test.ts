/**
 * The start offset belongs to the **installation**, not to the buffer
 * (CORELIB_PLAN §5.1, normative).
 *
 * A buffer-set — the constructor or `setBuffer` — begins an installation whose
 * cursor starts at *that call's* offset, and the offset is then **consumed**: a
 * flush whose callback returns without installing anything means the sink
 * copied, and the encoder resumes writing into the same buffer at offset `0`.
 * The reservation is not re-armed implicitly. A sink that wants header room in
 * every unit it is handed re-arms it explicitly by calling
 * `setBuffer(buf, offset)` from inside the callback — that is what distinguishes
 * the two shapes, and a bare return must not silently do it (corelib-ts#109).
 *
 * Neither shape changes the wire: the concatenation of the flushed units is the
 * same message either way, which is what the byte-identity assertions pin.
 */

import { describe, expect, it } from "vitest";
import { OStream } from "../src/index.js";

/** Two 1-byte fields per call: header `0x00` and value `0x00` — 16 bytes total. */
function write(os: OStream): void {
  for (let i = 0; i < 8; i++) os.writeUnsigned(0, 0);
}

/** The same fields encoded in one pass, as the reference byte sequence. */
function reference(): number[] {
  const os = new OStream(new Uint8Array(64));
  write(os);
  return Array.from(os.bytes());
}

describe("a flush consumes the installation offset (§5.1)", () => {
  it("resumes at 0 after a sink that returns without installing a buffer", () => {
    // 8-byte buffer, 4 reserved: the first unit is capped by the reservation,
    // every later one gets the whole buffer because the offset was consumed.
    const sizes: number[] = [];
    const out: number[] = [];
    const os = new OStream(new Uint8Array(8), 4, (buf, start, end) => {
      sizes.push(end - start);
      for (let i = start; i < end; i++) out.push(buf[i]!);
    });
    write(os);
    os.flush();

    expect(sizes).toEqual([4, 8, 4]);
    expect(out).toEqual(reference());
  });

  it("re-arms the reservation when the sink calls setBuffer with the same buffer", () => {
    // The sanctioned way to get header room in *every* flushed unit: a
    // buffer-set is a new installation, so its offset applies to the next unit.
    const buf = new Uint8Array(8);
    const sizes: number[] = [];
    const out: number[] = [];
    const os = new OStream(buf, 4, (b, start, end) => {
      sizes.push(end - start);
      for (let i = start; i < end; i++) out.push(b[i]!);
      os.setBuffer(buf, 4); // copy first: the swap invalidates the region
    });
    write(os);
    os.flush();

    expect(sizes).toEqual([4, 4, 4, 4]);
    expect(out).toEqual(reference());
  });

  it("honours the offset of a replacement buffer the sink installs", () => {
    // The take-and-replace shape: the sink hands each filled buffer on and
    // installs a fresh one, reserving 4 bytes in it. The installation the
    // callback made is the live one — the flush that invoked it must not reset
    // the cursor over it.
    const taken: Uint8Array[] = [];
    const sizes: number[] = [];
    const os = new OStream(new Uint8Array(8), 4, (buf, start, end) => {
      taken.push(buf.subarray(start, end)); // taken, not copied: handed on as-is
      sizes.push(end - start);
      os.setBuffer(new Uint8Array(8), 4);
    });
    write(os);
    os.flush();

    expect(sizes).toEqual([4, 4, 4, 4]);
    expect(taken.flatMap((c) => Array.from(c))).toEqual(reference());
    for (const chunk of taken) expect(chunk.byteOffset).toBe(4);
  });

  it("leaves the encoder empty at offset 0 after a flush", () => {
    const os = new OStream(new Uint8Array(8), 4, () => {});
    os.writeUnsigned(0, 0);
    os.flush();

    expect(os.bytesUsed).toBe(0);
    expect(os.bytes().length).toBe(0);
    expect(os.bytes().byteOffset).toBe(0);

    // ...and `reset()` rewinds to the consumed offset, not the original one.
    os.writeUnsigned(0, 0);
    os.reset();
    expect(os.bytesUsed).toBe(0);
    os.writeUnsigned(0, 0);
    expect(os.bytes().byteOffset).toBe(0);
  });

  it("keeps the reservation while nothing has been flushed", () => {
    // The offset is consumed by a flush that hands bytes over, not by the write
    // that fills the window: a sink-less stream keeps it forever, and so does a
    // streaming one until its first unit goes out.
    const os = new OStream(new Uint8Array(64), 4, () => {});
    os.writeUnsigned(0, 0);
    expect(os.bytes().byteOffset).toBe(4);
    os.flush();
    os.writeUnsigned(0, 0);
    expect(os.bytes().byteOffset).toBe(0);
  });

  it("splits a value across the consumed offset without changing the bytes", () => {
    // The same rule under a value that is itself split across flushes: a
    // 10-byte varint through an 8-byte buffer with 4 reserved.
    const out: number[] = [];
    const os = new OStream(new Uint8Array(8), 4, (buf, start, end) => {
      for (let i = start; i < end; i++) out.push(buf[i]!);
    });
    os.writeUnsigned(1, 2n ** 64n - 1n);
    os.writeString(2, "hello, world");
    os.flush();

    const one = new OStream(new Uint8Array(64));
    one.writeUnsigned(1, 2n ** 64n - 1n);
    one.writeString(2, "hello, world");
    expect(out).toEqual(Array.from(one.bytes()));
  });
});
