/**
 * The default, pure-TypeScript {@link Kernel}.
 *
 * Always available — no native dependency, no WebAssembly — so SofaBuffers runs
 * unchanged in Node.js, browsers, Electron and bundled builds. Importing this
 * module registers it as the default kernel (idempotently); a native or WASM
 * kernel can later override it via {@link setKernel}.
 */

import { argumentError } from "../errors.js";
import { FP32_HANDLE_MIN, FP64_HANDLE_MIN } from "../constants.js";
import { HI, LO, S_U32, splitI64, splitU64 } from "../varint/bits64.js";
import { encodeVarintNum } from "../varint/leb128.js";
import { packFp32, packFp64, toBigInt } from "../varint/num64.js";
import { encodeZigzagVarintLoHi } from "../varint/zigzag.js";
import type { Kernel } from "./kernel.js";

// Largest signed magnitude whose zig-zag (|v|*2) stays an exact integer.
const SIGNED_FAST_MAX = 0x10_0000_0000_0000; // 2^52

/**
 * The default, pure-TypeScript {@link Kernel} — active until {@link setKernel}
 * installs another. It implements the bulk encoder transforms with no native or
 * WebAssembly dependency, so it works in every environment.
 */
export const jsKernel: Kernel = {
  name: "js",

  encodeUnsignedVarints(values, out, pos) {
    const n = values.length;
    for (let i = 0; i < n; i++) {
      const v = values[i]!;
      // Number elements (u8..u32 and any small u64) skip bigint entirely.
      if (typeof v === "number" && v >= 0 && v <= Number.MAX_SAFE_INTEGER && Number.isInteger(v)) {
        pos = encodeVarintNum(v, out, pos);
        continue;
      }
      // Anything else goes through the unsigned 64-bit scratch, whose store
      // yields both halves at ~1/28th the cost of a mask-and-shift split
      // (bits64) *and* range-checks in the same breath: `splitU64` reloads the
      // stored value and compares, which differs from the input exactly when it
      // was negative or ≥ 2^64. An element outside the domain (§6.2) is a caller
      // mistake and must be rejected, not reduced modulo 2^64 — the same answer
      // the element-at-a-time streaming path in OStream gives (#106).
      const b = toBigInt(v);
      if (!splitU64(b)) throw argumentError(`unsigned value ${b} out of range`);
      let lo = S_U32[LO]!;
      const hi = S_U32[HI]!;
      // The body of `encodeVarintLoHi`, inlined. This is the one place the
      // duplication earns its keep: it is the innermost loop of the whole
      // encoder, and the JIT does not inline the shared helper at this size, so
      // the call costs ~10% of the per-element budget. `kernelParity` in
      // test/kernel.test.ts pins these bytes against the shared helper over a
      // wide value corpus, so the two cannot drift.
      if (hi === 0) {
        while (lo > 0x7f) {
          out[pos++] = (lo & 0x7f) | 0x80;
          lo >>>= 7;
        }
        out[pos++] = lo;
        continue;
      }
      out[pos++] = (lo & 0x7f) | 0x80;
      out[pos++] = ((lo >>> 7) & 0x7f) | 0x80;
      out[pos++] = ((lo >>> 14) & 0x7f) | 0x80;
      out[pos++] = ((lo >>> 21) & 0x7f) | 0x80;
      const b4 = (lo >>> 28) | ((hi & 0x07) << 4);
      let h = hi >>> 3;
      if (h === 0) {
        out[pos++] = b4;
        continue;
      }
      out[pos++] = b4 | 0x80;
      while (h > 0x7f) {
        out[pos++] = (h & 0x7f) | 0x80;
        h >>>= 7;
      }
      out[pos++] = h;
    }
    return pos;
  },

  encodeSignedVarints(values, out, pos) {
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      if (typeof v === "number" && v >= -SIGNED_FAST_MAX && v <= SIGNED_FAST_MAX && Number.isInteger(v)) {
        pos = encodeVarintNum(v >= 0 ? v * 2 : -v * 2 - 1, out, pos);
      } else {
        // As in encodeUnsignedVarints, the signed scratch round-trip is both
        // the §6.2 domain check and the split: an element outside
        // `-2^63 .. 2^63 - 1` is rejected rather than wrapped (#106). Zig-zag
        // then runs on the two halves, producing the very same bytes as
        // `zigzagEncode` in `bigint` with nothing allocated.
        const b = toBigInt(v);
        if (!splitI64(b)) throw argumentError(`signed value ${b} out of range`);
        pos = encodeZigzagVarintLoHi(S_U32[LO]!, S_U32[HI]!, out, pos);
      }
    }
    return pos;
  },

  // Both float packers take one `DataView` over the destination *once the run is
  // long enough to pay for it* — the language-forced handle of CORELIB_PLAN §6.6.2,
  // and the only way to place an IEEE-754 value at a byte offset. It carries no
  // message bytes (the storage is the caller's) and no wire number sizes it.
  //
  // The threshold is arithmetic, not taste. Measured on Node 24:
  // `new DataView(buf.buffer, off, len)` costs **129 ns**, while the handle saves
  // 1.9 ns per `fp32` (4.11 -> 2.23) and 7.3 ns per `fp64` (10.48 -> 3.20). So it
  // breaks even at ~68 `fp32` and ~18 `fp64` elements; below that the scratch route
  // wins, and a two-element array through a handle is a pessimisation.
  packFp32Array(values, out, pos) {
    const n = values.length;
    if (n < FP32_HANDLE_MIN) {
      for (let i = 0; i < n; i++) pos = packFp32(out, pos, values[i]!);
      return pos;
    }
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (let i = 0; i < n; i++) {
      dv.setFloat32(pos, values[i]!, true);
      pos += 4;
    }
    return pos;
  },

  packFp64Array(values, out, pos) {
    const n = values.length;
    if (n < FP64_HANDLE_MIN) {
      for (let i = 0; i < n; i++) pos = packFp64(out, pos, values[i]!);
      return pos;
    }
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (let i = 0; i < n; i++) {
      dv.setFloat64(pos, values[i]!, true);
      pos += 8;
    }
    return pos;
  },
};
