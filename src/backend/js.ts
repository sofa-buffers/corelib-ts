/**
 * The default, pure-TypeScript {@link Kernel}.
 *
 * Always available — no native dependency, no WebAssembly — so SofaBuffers runs
 * unchanged in Node.js, browsers, Electron and bundled builds. Importing this
 * module registers it as the default kernel (idempotently); a native or WASM
 * kernel can later override it via {@link setKernel}.
 */

import { encodeVarint, encodeVarintNum } from "../varint/leb128.js";
import { packFp32, packFp64, toBigInt } from "../varint/num64.js";
import { zigzagEncode } from "../varint/zigzag.js";
import type { Kernel } from "./kernel.js";

// Largest signed magnitude whose zig-zag (|v|*2) stays an exact integer.
const SIGNED_FAST_MAX = 0x10_0000_0000_0000; // 2^52

export const jsKernel: Kernel = {
  name: "js",

  encodeUnsignedVarints(values, out, pos) {
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      // Number elements (u8..u32 and any small u64) skip bigint entirely.
      if (typeof v === "number" && v >= 0 && v <= Number.MAX_SAFE_INTEGER && Number.isInteger(v)) {
        pos = encodeVarintNum(v, out, pos);
      } else {
        pos = encodeVarint(toBigInt(v), out, pos);
      }
    }
    return pos;
  },

  encodeSignedVarints(values, out, pos) {
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      if (typeof v === "number" && v >= -SIGNED_FAST_MAX && v <= SIGNED_FAST_MAX && Number.isInteger(v)) {
        pos = encodeVarintNum(v >= 0 ? v * 2 : -v * 2 - 1, out, pos);
      } else {
        pos = encodeVarint(zigzagEncode(toBigInt(v)), out, pos);
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
