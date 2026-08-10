/**
 * SofaBuffers — streaming, dependency-free binary serialization for TypeScript.
 *
 * The public surface is the streaming core: {@link OStream} to encode and
 * {@link IStream} (driving a {@link Visitor}) to decode, both chunkable so a
 * message can be far larger than any buffer. Generated message classes call
 * these primitives directly. Hot paths run through a swappable {@link Kernel}
 * ({@link setKernel}) so a native or WASM build — none is published today, and
 * the library ships no loader for one — can accelerate them without any API
 * change.
 *
 * Every public symbol is available two ways: as a flat named import, or under
 * the aggregate `sofab` namespace (`import * as sofab` is the §6 idiom, and a
 * ready-made `sofab` object is exported for `import { sofab }` / UMD use).
 *
 * @example Encode then decode
 * ```ts
 * import { growingOStream, decode, type Visitor } from "@sofa-buffers/corelib";
 *
 * const os = growingOStream();
 * os.writeUnsigned(1, 42);
 * os.writeString(2, "hi");
 *
 * // A visitor string chunk is raw, unvalidated wire bytes, so whoever
 * // materializes it owns the UTF-8 check: the *fatal* decoder is required —
 * // the default one silently substitutes U+FFFD, which §6.4 forbids.
 * const utf8 = new TextDecoder("utf-8", { fatal: true });
 *
 * const sink: Visitor = {
 *   unsigned: (id, v) => { if (id === 1) console.log("n", v); },
 *   string:   (id, _t, _o, c) => console.log("s", utf8.decode(c)),
 * };
 * decode(os.bytes(), sink);
 * ```
 *
 * @example The `sofab` namespace
 * ```ts
 * import * as sofab from "@sofa-buffers/corelib";
 * const os = sofab.growingOStream();
 * ```
 */

// Flat named exports — the primary surface.
export * from "./public.js";

// The same surface aggregated under the `sofab` namespace (§6), for both
// `import * as sofab from "..."` and `import { sofab } from "..."`.
export * as sofab from "./public.js";
