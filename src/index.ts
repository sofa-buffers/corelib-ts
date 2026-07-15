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
 * Every public symbol is available two ways: as a flat named import, or under
 * the aggregate `sofab` namespace (`import * as sofab` is the §6 idiom, and a
 * ready-made `sofab` object is exported for `import { sofab }` / UMD use).
 *
 * @example Encode then decode
 * ```ts
 * import { OStream, decode, type Visitor } from "@sofa-buffers/corelib";
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
 *
 * @example The `sofab` namespace
 * ```ts
 * import * as sofab from "@sofa-buffers/corelib";
 * const os = new sofab.OStream();
 * ```
 */

// Flat named exports — the primary surface.
export * from "./public.js";

// The same surface aggregated under the `sofab` namespace (§6), for both
// `import * as sofab from "..."` and `import { sofab } from "..."`.
export * as sofab from "./public.js";
