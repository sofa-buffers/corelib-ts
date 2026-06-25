/**
 * SofaBuffers — streaming, dependency-free binary serialization for TypeScript.
 *
 * The public surface is the streaming core: {@link OStream} to encode and
 * {@link IStream} (driving a {@link Visitor}) to decode, both chunkable so a
 * message can be far larger than any buffer. Generated message classes call
 * these primitives directly. Hot paths run through a swappable {@link Kernel}
 * ({@link setKernel}) so an optional native or WASM build can accelerate them
 * without any API change.
 *
 * @example Encode then decode
 * ```ts
 * import { OStream, decode, type Visitor } from "@sofabuffers/corelib";
 *
 * const os = new OStream();
 * os.writeUnsigned(1, 42);
 * os.writeString(2, "hi");
 *
 * const sink: Visitor = {
 *   unsigned: (id, v) => { if (id === 1) console.log("n", v); },
 *   string:   (id, _t, _o, c) => console.log("s", new TextDecoder().decode(c)),
 * };
 * decode(os.bytes(), sink);
 * ```
 */

export {
  API_VERSION,
  ArrayKind,
  FixlenSubtype,
  WireType,
  ID_MAX,
  FIXLEN_MAX,
  ARRAY_MAX,
  U64_MAX,
  I64_MIN,
  I64_MAX,
} from "./constants.js";

export { SofabError, SofabErrorCode } from "./errors.js";

export { OStream } from "./encode/ostream.js";
export type { FlushSink } from "./encode/sink.js";

export { IStream, decode } from "./decode/istream.js";
export type { Visitor } from "./decode/istream.js";

export { getKernel, setKernel } from "./backend/kernel.js";
export type { Kernel } from "./backend/kernel.js";
export { jsKernel } from "./backend/js.js";
export { loadNativeKernel } from "./backend/native.js";
export { loadWasmKernel } from "./backend/wasm.js";
export type { WasmKernelFactory } from "./backend/wasm.js";
