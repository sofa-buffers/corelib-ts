/**
 * The default, pure-TypeScript {@link Kernel}.
 *
 * Always available — no native dependency, no WebAssembly — so SofaBuffers runs
 * unchanged in Node.js, browsers, Electron and bundled builds. Importing this
 * module registers it as the default kernel (idempotently); a native or WASM
 * kernel can later override it via {@link setKernel}.
 */

import { encodeVarint } from "../varint/leb128.js";
import { packFp32, packFp64, toBigInt } from "../varint/num64.js";
import { zigzagEncode } from "../varint/zigzag.js";
import type { Kernel } from "./kernel.js";

export const jsKernel: Kernel = {
  name: "js",

  encodeUnsignedVarints(values, out, pos) {
    for (let i = 0; i < values.length; i++) {
      pos = encodeVarint(toBigInt(values[i]!), out, pos);
    }
    return pos;
  },

  encodeSignedVarints(values, out, pos) {
    for (let i = 0; i < values.length; i++) {
      pos = encodeVarint(zigzagEncode(toBigInt(values[i]!)), out, pos);
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
