import type { Visitor } from "./istream.js";

/**
 * The scope a consumer declined — what the decoder dispatches to while it
 * consumes a subtree {@link Visitor.sequenceBegin} answered `false` for.
 *
 * It declares no callback at all, so every dispatch short-circuits on it through
 * the optional call the decoder already uses, and the arguments are never
 * evaluated: nothing inside a declined subtree is decoded into existence, and no
 * piece of a payload is reported.
 *
 * A sentinel rather than a `skipping` flag tested at each dispatch, and the
 * difference is measured: the flag put a branch on every dispatch of every
 * decode, declined or not, and cost `decode: typical message` about 4% Ir/op.
 * This costs a live decode nothing — the two places that do ask
 * (`this.cur !== SKIP`) are the receiver caps, which are exactly where declining
 * is supposed to save something.
 *
 * Frozen and empty, so it adds one hidden class to the decoder's dispatch sites
 * and no more.
 */
export const SKIP: Visitor = Object.freeze({});
