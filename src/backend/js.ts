/**
 * The default, pure-TypeScript {@link Kernel}.
 *
 * Always available — no native dependency, no WebAssembly — so SofaBuffers runs
 * unchanged in Node.js, browsers, Electron and bundled builds. Importing this
 * module registers it as the default kernel (idempotently); a native or WASM
 * kernel can later override it via {@link setKernel}.
 */

import { HI, LO, S_U32, S_U64 } from "../varint/bits64.js";
import { encodeVarintLoHi, encodeVarintNum } from "../varint/leb128.js";
import { packFp32, packFp64, toBigInt } from "../varint/num64.js";
import { zigzagEncode } from "../varint/zigzag.js";
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
      // A `bigint` element: one scratch store reduces it mod 2^64 and yields
      // both halves, which is exactly the truncation the mask-and-shift split
      // performed — at ~1/28th the cost (bits64). Out-of-range elements keep
      // wrapping here rather than throwing, as before; the non-growable path
      // in OStream is the one that range-checks.
      S_U64[0] = toBigInt(v);
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
        // zigzagEncode's `& U64_MAX` already reduces to 64 bits, so the split
        // below is exact and the wire bytes are unchanged.
        S_U64[0] = zigzagEncode(toBigInt(v));
        pos = encodeVarintLoHi(S_U32[LO]!, S_U32[HI]!, out, pos);
      }
    }
    return pos;
  },

  packFp32Array(values, out, pos) {
    for (let i = 0; i < values.length; i++) {
      pos = packFp32(out, pos, values[i]!);
    }
    return pos;
  },

  packFp64Array(values, out, pos) {
    for (let i = 0; i < values.length; i++) {
      pos = packFp64(out, pos, values[i]!);
    }
    return pos;
  },
};
