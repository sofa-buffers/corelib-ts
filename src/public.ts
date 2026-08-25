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
  MIN_OUTPUT_BUFFER,
  DEFAULT_MAX_DYN_ARRAY_COUNT,
  DEFAULT_MAX_DYN_STRING_LEN,
  DEFAULT_MAX_DYN_BLOB_LEN,
  U64_MAX,
  I64_MIN,
  I64_MAX,
} from "./constants.js";

export { SofabError, SofabErrorCode } from "./errors.js";

export { Long } from "./long.js";
export { OStream } from "./encode/ostream.js";
export { growingOStream } from "./encode/accumulate.js";
export type { FlushSink } from "./encode/sink.js";

// The one decode surface (CORELIB_PLAN §5.3.1): a visitor, driven by IStream.
// There is no pull parser, iterator or cursor to export beside it.
export { IStream, decode } from "./decode/istream.js";
export type { Visitor } from "./decode/istream.js";
export type { DecodeLimits } from "./decode/limits.js";

// The generated layer's support (ARCHITECTURE §8): schema-free helpers that a
// generated message class would otherwise carry its own copy of. Nothing here
// knows a schema — a capacity, a maxlen or a payload length is an argument.
export { decodeUtf8 } from "./decode/text.js";
export { PayloadAcc } from "./decode/acc.js";
export { BlobSeq, ElementSeq, StringSeq } from "./decode/seq.js";
export { elementsEqual } from "./encode/equal.js";

export { getKernel, setKernel } from "./backend/kernel.js";
export type { Kernel } from "./backend/kernel.js";
export { jsKernel } from "./backend/js.js";
