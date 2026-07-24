/**
 * §4.6: float payloads round-trip **bit-for-bit** — the corelib never inspects
 * or normalizes a value, so every float, *including a signaling NaN*, survives
 * decode → re-encode unchanged.
 *
 * The hard case (issue #66 / Crucible F-0031) is an fp32 **signaling** NaN
 * (`0x7F800001`). A JS `number` is a 64-bit double, and widening an fp32 sNaN
 * into a double quiets it (sets the is-quiet bit 22 → `0x7FC00001`). So a
 * bit-exact round-trip cannot go through the `value` a visitor receives; it
 * must carry the raw wire bytes ({@link Visitor.fp32}'s `raw`, re-emitted with
 * {@link OStream.writeFixlen} / {@link OStream.writeFp32ArrayRaw}). fp64 has no
 * such hazard — a double holds all 64 bits verbatim — so it is the control.
 */

import { describe, expect, it } from "vitest";
import {
  Cursor,
  FixlenSubtype,
  IStream,
  OStream,
  decode,
  type Visitor,
} from "../src/index.js";
import { bytesToHex } from "./helpers/hex.js";
import { TranscodeVisitor } from "./helpers/recording-visitor.js";

// fp32 bit patterns, little-endian on the wire.
const FP32_SNAN = Uint8Array.of(0x01, 0x00, 0x80, 0x7f); // 0x7F800001 (signaling)
const FP32_QNAN = Uint8Array.of(0x01, 0x00, 0xc0, 0x7f); // 0x7FC00001 (quiet)
const FP32_NEG_QNAN = Uint8Array.of(0x00, 0x00, 0xc0, 0xff); // 0xFFC00000
const FP32_NORMAL = Uint8Array.of(0xd0, 0x0f, 0x49, 0x40); // ~3.14159
// fp64 signaling NaN 0x7FF0000000000001, little-endian.
const FP64_SNAN = Uint8Array.of(0x01, 0, 0, 0, 0, 0, 0xf0, 0x7f);

/** Decode `bytes` in one shot (contiguous fast path) into `visitor`. */
function decodeWhole(bytes: Uint8Array, visitor: Visitor): void {
  decode(bytes, visitor);
}

/** Decode `bytes` one byte at a time (resumable streaming state machine). */
function decodeChunked(bytes: Uint8Array, visitor: Visitor): void {
  const is = new IStream();
  for (let i = 0; i < bytes.length; i++) is.feed(bytes.subarray(i, i + 1), visitor);
  is.end();
}

const DRIVERS: [string, (b: Uint8Array, v: Visitor) => void][] = [
  ["contiguous decode", decodeWhole],
  ["streaming decode", decodeChunked],
];

/** Re-encode `wire` through the transcode visitor and return the bytes. */
function roundtrip(wire: Uint8Array, drive: (b: Uint8Array, v: Visitor) => void): Uint8Array {
  const out = new OStream();
  drive(wire, new TranscodeVisitor(out));
  return out.bytes();
}

describe("fp32 float payloads round-trip bit-for-bit (§4.6; #66)", () => {
  for (const [name, drive] of DRIVERS) {
    describe(name, () => {
      it("preserves a scalar signaling NaN (not quieted to 0x7FC00001)", () => {
        const os = new OStream();
        os.writeFixlen(7, FP32_SNAN, FixlenSubtype.Fp32);
        const wire = os.bytes();

        expect(bytesToHex(roundtrip(wire, drive))).toBe(bytesToHex(wire));
        // Guard the specific regression: the payload stays sNaN (…80 7f), not
        // the quieted …c0 7f.
        expect(bytesToHex(wire).endsWith("0100807f")).toBe(true);
      });

      it("preserves quiet, negative-quiet and normal scalars", () => {
        for (const bits of [FP32_QNAN, FP32_NEG_QNAN, FP32_NORMAL]) {
          const os = new OStream();
          os.writeFixlen(3, bits, FixlenSubtype.Fp32);
          const wire = os.bytes();
          expect(bytesToHex(roundtrip(wire, drive))).toBe(bytesToHex(wire));
        }
      });

      it("preserves a signaling NaN element inside an fp32 array", () => {
        // Two elements: a signaling NaN followed by a normal value.
        const payload = new Uint8Array(8);
        payload.set(FP32_SNAN, 0);
        payload.set(FP32_NORMAL, 4);
        const os = new OStream();
        os.writeFp32ArrayRaw(5, payload);
        const wire = os.bytes();

        expect(bytesToHex(roundtrip(wire, drive))).toBe(bytesToHex(wire));
      });

      it("control: an fp64 signaling NaN round-trips (no widening hazard)", () => {
        const os = new OStream();
        os.writeFixlen(2, FP64_SNAN, FixlenSubtype.Fp64);
        const wire = os.bytes();
        expect(bytesToHex(roundtrip(wire, drive))).toBe(bytesToHex(wire));
      });
    });
  }
});

// The pull (Cursor) decoder is the third decode surface, alongside the two
// visitor drivers above. Its value readers (readFp32 / readFp32Array) return a
// JS `number` and so quiet an fp32 sNaN identically; the bit-preserving
// companions (readFp32Raw / readFp32ArrayRaw) are what let generated bit-exact
// decode round-trip one on this path (corelib-ts#66).
describe("Cursor fp32 raw readers round-trip bit-for-bit (§4.6; #66)", () => {
  it("preserves a scalar signaling NaN via readFp32Raw", () => {
    const os = new OStream();
    os.writeFixlen(7, FP32_SNAN, FixlenSubtype.Fp32);
    const wire = os.bytes();

    const c = new Cursor(wire);
    expect(c.readHeader()).toBe(true);
    const raw = c.readFp32Raw();
    expect(bytesToHex(raw)).toBe(bytesToHex(FP32_SNAN)); // …80 7f, not …c0 7f

    // Re-encode from the raw bytes and confirm the wire is byte-identical.
    const out = new OStream();
    out.writeFixlen(7, raw, FixlenSubtype.Fp32);
    expect(bytesToHex(out.bytes())).toBe(bytesToHex(wire));
  });

  it("the scalar value reader (readFp32) still quiets the sNaN — why Raw exists", () => {
    const os = new OStream();
    os.writeFixlen(7, FP32_SNAN, FixlenSubtype.Fp32);

    const c = new Cursor(os.bytes());
    c.readHeader();
    const value = c.readFp32();
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, value, true);
    expect(dv.getUint32(0, true)).toBe(0x7fc00001);
  });

  it("preserves a signaling NaN element via readFp32ArrayRaw", () => {
    const payload = new Uint8Array(8);
    payload.set(FP32_SNAN, 0);
    payload.set(FP32_NORMAL, 4);
    const os = new OStream();
    os.writeFp32ArrayRaw(5, payload);
    const wire = os.bytes();

    const c = new Cursor(wire);
    expect(c.readHeader()).toBe(true);
    const raw = c.readFp32ArrayRaw();
    expect(bytesToHex(raw)).toBe(bytesToHex(payload));

    const out = new OStream();
    out.writeFp32ArrayRaw(5, raw);
    expect(bytesToHex(out.bytes())).toBe(bytesToHex(wire));
  });

  it("preserves quiet, negative-quiet and normal scalars via readFp32Raw", () => {
    for (const bits of [FP32_QNAN, FP32_NEG_QNAN, FP32_NORMAL]) {
      const os = new OStream();
      os.writeFixlen(3, bits, FixlenSubtype.Fp32);
      const wire = os.bytes();

      const c = new Cursor(wire);
      c.readHeader();
      const raw = c.readFp32Raw();
      const out = new OStream();
      out.writeFixlen(3, raw, FixlenSubtype.Fp32);
      expect(bytesToHex(out.bytes())).toBe(bytesToHex(wire));
    }
  });
});

describe("Visitor.fp32 raw channel vs. the quieted double (#66)", () => {
  it("delivers the exact wire bytes while `value` alone loses the sNaN", () => {
    const os = new OStream();
    os.writeFixlen(1, FP32_SNAN, FixlenSubtype.Fp32);

    let seenValue = 0;
    let seenRaw: Uint8Array | undefined;
    decode(os.bytes(), {
      fp32Raw: true, // opt into the raw channel
      fp32(_id, value, raw) {
        seenValue = value;
        seenRaw = raw?.slice();
      },
    });

    // raw is the exact payload — the bit-exact "materialized" oracle.
    expect(seenRaw && bytesToHex(seenRaw)).toBe(bytesToHex(FP32_SNAN));

    // The double `value`, re-narrowed on its own, is already quieted — which is
    // exactly why the raw channel exists.
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, seenValue, true);
    expect(dv.getUint32(0, true)).toBe(0x7fc00001);
  });
});
