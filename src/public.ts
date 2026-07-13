/**
 * The complete public surface of the library, re-exported by {@link "./index"}
 * both as flat named exports and, aggregated, under the `sofab` namespace.
 */

export {
  API_VERSION,
  ArrayKind,
  DecodeStatus,
  FixlenSubtype,
  WireType,
  ID_MAX,
  FIXLEN_MAX,
  ARRAY_MAX,
  MAX_DEPTH,
  U64_MAX,
  I64_MIN,
  I64_MAX,
} from "./constants.js";

export { SofabError, SofabErrorCode } from "./errors.js";

export { Long } from "./long.js";
export { OStream } from "./encode/ostream.js";
export type { FlushSink } from "./encode/sink.js";

export { IStream, decode } from "./decode/istream.js";
export type { Visitor } from "./decode/istream.js";
export { Cursor } from "./decode/cursor.js";

export { getKernel, setKernel } from "./backend/kernel.js";
export type { Kernel } from "./backend/kernel.js";
export { jsKernel } from "./backend/js.js";
export { loadNativeKernel } from "./backend/native.js";
export { loadWasmKernel } from "./backend/wasm.js";
export type { WasmKernelFactory } from "./backend/wasm.js";
