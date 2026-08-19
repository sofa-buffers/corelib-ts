import type { AnyVisitor } from "./istream.js";

/**
 * The scope a consumer declined — what goes in the slot when
 * {@link Visitor.sequenceBegin} returns `null`.
 *
 * It declares no callback at all, so every dispatch short-circuits on it
 * through the optional call the decoders already use, and the arguments are
 * never evaluated: nothing inside a skipped subtree is decoded into existence.
 * Nesting needs no bookkeeping either — with no `sequenceBegin` of its own, a
 * scope opened inside a skipped one falls through to "keep the current visitor"
 * and stays skipped by construction.
 *
 * A sentinel rather than `null` in a nullable slot, and the difference is
 * measured. The nullable version put a null check on every dispatch of every
 * decode, skipped or not, and cost `decode: typical message` 5162 → 5366 Ir/op
 * (+4%). This costs a live decode nothing: the two places that do ask — the
 * receiver caps and the payload view — are exactly the two places where
 * skipping is supposed to save something.
 */
export const SKIP: AnyVisitor = Object.freeze({});
