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
 * This costs a live decode nothing, and nothing asks for it by name any more:
 * the receiver caps (§6.2.1) test whether the *callback for this field* exists,
 * which is the broader question — a declined scope and a visitor that simply
 * declares no handler both skip the field, and neither may be capped. Declaring
 * nothing is what makes this sentinel answer `no` to every one of those probes.
 *
 * Frozen and empty, so it adds one hidden class to the decoder's dispatch sites
 * and no more.
 */
export const SKIP: Visitor = Object.freeze({});
