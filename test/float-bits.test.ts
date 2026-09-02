/**
 * §4.6: float payloads round-trip **bit-for-bit** — the corelib never inspects
 * or normalizes a value, so every float, *including a signaling NaN*, survives
 * decode → re-encode unchanged.
 *
 * The hard case (issue #66 / Crucible F-0031) is an fp32 **signaling** NaN
 * (`0x7F800001`). A JS `number` is a 64-bit double, and widening an fp32 sNaN
 * into a double quiets it (sets the is-quiet bit 22 → `0x7FC00001`). So a
 * bit-exact round-trip cannot go through the `value` a visitor receives; it must
 * carry the raw wire bits ({@link Visitor.fp32}'s `bits` — the "32-bit bits
 * accessor" §6.5 names — re-emitted with {@link OStream.writeFp32Bits} /
 * {@link OStream.writeFp32ArrayRaw}). fp64 has no such hazard — a double holds all
 * 64 bits verbatim — so it is the control.
 */

import { describe, expect, it } from "vitest";
import {
  FixlenSubtype,
  IStream,
  OStream,
  decode,
  type Visitor, growingOStream } from "../src/index.js";
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
  const is = new IStream(visitor);
  for (let i = 0; i < bytes.length; i++) is.feed(bytes.subarray(i, i + 1));
}

const DRIVERS: [string, (b: Uint8Array, v: Visitor) => void][] = [
  ["contiguous decode", decodeWhole],
  ["streaming decode", decodeChunked],
];

/** Re-encode `wire` through the transcode visitor and return the bytes. */
function roundtrip(wire: Uint8Array, drive: (b: Uint8Array, v: Visitor) => void): Uint8Array {
  const out = growingOStream();
  drive(wire, new TranscodeVisitor(out));
  return out.bytes();
}

describe("fp32 float payloads round-trip bit-for-bit (§4.6; #66)", () => {
  for (const [name, drive] of DRIVERS) {
    describe(name, () => {
      it("preserves a scalar signaling NaN (not quieted to 0x7FC00001)", () => {
        const os = growingOStream();
        os.writeFixlen(7, FP32_SNAN, FixlenSubtype.Fp32);
        const wire = os.bytes();

        expect(bytesToHex(roundtrip(wire, drive))).toBe(bytesToHex(wire));
        // Guard the specific regression: the payload stays sNaN (…80 7f), not
        // the quieted …c0 7f.
        expect(bytesToHex(wire).endsWith("0100807f")).toBe(true);
      });

      it("preserves quiet, negative-quiet and normal scalars", () => {
        for (const bits of [FP32_QNAN, FP32_NEG_QNAN, FP32_NORMAL]) {
          const os = growingOStream();
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
        const os = growingOStream();
        os.writeFp32ArrayRaw(5, payload);
        const wire = os.bytes();

        expect(bytesToHex(roundtrip(wire, drive))).toBe(bytesToHex(wire));
      });

      it("control: an fp64 signaling NaN round-trips (no widening hazard)", () => {
        const os = growingOStream();
        os.writeFixlen(2, FP64_SNAN, FixlenSubtype.Fp64);
        const wire = os.bytes();
        expect(bytesToHex(roundtrip(wire, drive))).toBe(bytesToHex(wire));
      });
    });
  }
});

// The bits channel, exercised the way generated bit-exact decode uses it: read
// `bits`, re-encode with writeFp32Bits, compare the wire. This is §6.5's
// "raw-wire-bytes path" for a double-only target — there is no second decode
// surface to test it on (§5.3.1), so the drivers above are the whole matrix.
describe("fp32 bits re-encode byte-for-byte (§4.6/§6.5; #66)", () => {
  /** Decode one fp32 field and return its `bits`. */
  function bitsOf(wire: Uint8Array, drive: (b: Uint8Array, v: Visitor) => void): number {
    let bits = 0;
    drive(wire, { fp32: (_id, _v, b) => void (bits = b >>> 0) });
    return bits;
  }

  for (const [name, drive] of DRIVERS) {
    it(`preserves a scalar signaling NaN (${name})`, () => {
      const os = growingOStream();
      os.writeFixlen(7, FP32_SNAN, FixlenSubtype.Fp32);
      const wire = os.bytes().slice();

      const bits = bitsOf(wire, drive);
      expect(bits).toBe(0x7f800001); // …80 7f, not …c0 7f

      const out = growingOStream();
      out.writeFp32Bits(7, bits);
      expect(bytesToHex(out.bytes())).toBe(bytesToHex(wire));
    });

    it(`preserves quiet, negative-quiet and normal scalars (${name})`, () => {
      for (const payload of [FP32_QNAN, FP32_NEG_QNAN, FP32_NORMAL]) {
        const os = growingOStream();
        os.writeFixlen(3, payload, FixlenSubtype.Fp32);
        const wire = os.bytes().slice();

        const out = growingOStream();
        out.writeFp32Bits(3, bitsOf(wire, drive));
        expect(bytesToHex(out.bytes())).toBe(bytesToHex(wire));
      }
    });

    it(`preserves a signaling NaN array element (${name})`, () => {
      const payload = new Uint8Array(8);
      payload.set(FP32_SNAN, 0);
      payload.set(FP32_NORMAL, 4);
      const os = growingOStream();
      os.writeFp32ArrayRaw(5, payload);
      const wire = os.bytes().slice();

      const seen: number[] = [];
      drive(wire, { arrayFp32: (_id, _i, _v, bits) => void seen.push(bits >>> 0) });

      const raw = new Uint8Array(seen.length * 4);
      const dv = new DataView(raw.buffer);
      seen.forEach((b, k) => dv.setUint32(k * 4, b, true));
      const out = growingOStream();
      out.writeFp32ArrayRaw(5, raw);
      expect(bytesToHex(out.bytes())).toBe(bytesToHex(wire));
    });
  }

  it("the value alone still quiets the sNaN — why the bits channel exists", () => {
    const os = growingOStream();
    os.writeFixlen(7, FP32_SNAN, FixlenSubtype.Fp32);
    let value = 0;
    decode(os.bytes(), { fp32: (_id, v) => void (value = v) });
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, value, true);
    expect(dv.getUint32(0, true)).toBe(0x7fc00001);
  });
});

describe("Visitor.fp32 bits vs. the quieted double (#66)", () => {
  it("delivers the exact wire bits while `value` alone loses the sNaN", () => {
    const os = growingOStream();
    os.writeFixlen(1, FP32_SNAN, FixlenSubtype.Fp32);

    let seenValue = 0;
    let seenBits = 0;
    decode(os.bytes(), {
      fp32(_id, value, bits) {
        seenValue = value;
        seenBits = bits;
      },
    });

    // `bits` is the exact payload — the bit-exact oracle, and always present: a
    // number needs no opt-in flag and no view (§6.5, §6.7).
    expect(seenBits >>> 0).toBe(0x7f800001);

    // The double `value`, re-narrowed on its own, is already quieted — which is
    // exactly why the bits channel exists.
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, seenValue, true);
    expect(dv.getUint32(0, true)).toBe(0x7fc00001);
  });
});

describe("the fp32 bits survive encoder use during the callback", () => {
  // The hazard a shared scratch buffer used to carry: the whole point of the
  // channel is to re-encode *inside* the callback, so a consumer that writes an
  // unrelated fp32 first must still emit its own payload intact. A number cannot
  // be clobbered by anything — which is the argument for passing one (§6.6/§6.7) —
  // and this pins that end-to-end.
  for (const [name, drive] of DRIVERS) {
    it(`keeps the sNaN payload intact across an interleaved writeFp32 (${name})`, () => {
      const os = growingOStream();
      os.writeFixlen(1, FP32_SNAN, FixlenSubtype.Fp32);
      const wire = os.bytes();

      const out = growingOStream();
      let seen = 0;
      drive(wire, {
        fp32(id, _value, bits) {
          // Pack an unrelated float first — this is what would clobber a shared
          // scratch — then re-emit the bits we were handed.
          out.writeFp32(99, 1.5);
          out.writeFp32Bits(id, bits);
          seen = bits >>> 0;
        },
      });

      expect(seen).toBe(0x7f800001);
      expect(bytesToHex(out.bytes()).endsWith("0100807f")).toBe(true);
    });
  }
});
