/**
 * Generated-layer support: one decode visitor per destination, kept across
 * decodes (#216, generator#775, ARCHITECTURE §8).
 *
 * A generated `tryDecode(bytes, out)` drives a visitor over a destination the
 * caller holds and decodes into again — and built that visitor per call:
 *
 * ```ts
 * const v = new _Example__Visitor(out, new PayloadAcc());
 * ```
 *
 * which is the visitor, its {@link PayloadAcc}, the array target objects it holds
 * and every field initialiser of its constructor, once per message. {@link decode}
 * and {@link tryDecode} pool their {@link DecoderState} precisely to keep that off
 * a receive loop ("constructing a decoder is the only allocating step there is"),
 * and the generated layer then put it back one level up. Measured on the
 * generator's own bench schema (34 fields, 434 bytes; Callgrind Ir/op, both V8
 * tiers), a cache here is **-2.4 % on the optimizing tier** (105,152 -> 102,674)
 * and -0.4 % on the baseline one, and it removes nine allocations per decode.
 *
 * A visitor is **bound to its destination** — generated visitors take it in the
 * constructor and hold it `readonly` — so the cache is keyed on that destination,
 * and a caller decoding into two messages in turn gets a visitor for each. The
 * generated class declares one cache per message type and asks it per call:
 *
 * ```ts
 * const _Example__VC = new VisitorCache<Example, _Example__Visitor>(
 *   (o) => new _Example__Visitor(o, new PayloadAcc()),
 * );
 * ```
 *
 * **Why this is here and not three lines in generated code.** Normalised for
 * names and types, those three lines are the same for every schema, which is
 * ARCHITECTURE §8's test for a static helper. It is also the faster side of the
 * boundary, which is not the usual direction: the same memo written inline in the
 * generated module measured 103,153 Ir/op against this one's 102,674, and a
 * `private` field on the generated message — the fastest lookup there is, a
 * monomorphic load — 103,022. The miss path is what differs. Behind this call it
 * is a branch in another module that the hot path never enters; inline it is a
 * `new` in the middle of the function V8 is optimizing for the hit.
 *
 * **Why the factory is held and not passed per call.** `get(destination)` is a
 * one-argument monomorphic call that way, and the closure is built once at module
 * load instead of per decode. Passing it measured 102,722 Ir/op, 48 more than
 * holding it.
 *
 * **Why a `WeakMap` and not a one-slot cache in front of it.** A slot holding the
 * last destination would keep that message alive in a module-level singleton for
 * the life of the process, which is what {@link DecoderState.release} exists not to
 * do (CORELIB_PLAN §6.6/§6.7, "keep nothing of the caller's alive in the pool").
 * It would also buy nothing measurable: the per-destination field variant above,
 * which is that lookup at its cheapest, is already slower than this.
 *
 * **What a cached visitor means for the caller.** It holds whatever its last
 * decode left in it — the destination's own storage, a {@link PayloadAcc} whose
 * scratch buffer is reused, the array targets' last destinations — and a generated
 * visitor is reset by its own `_reuse()` hook at the start of every decode. Two
 * decodes into the **same** destination at the same time therefore share one
 * visitor where they used to get one each; they already shared the destination's
 * fields, so neither was ever a supported thing to do.
 */

/**
 * One visitor per destination object, built on first use and kept for later
 * decodes into that same destination.
 *
 * `D` is the generated message class, `V` its visitor. Neither is known here: the
 * cache stores what `make` returns and never looks inside it.
 */
export class VisitorCache<D extends object, V> {
  /** Weak on purpose: a destination the caller drops takes its visitor with it. */
  private readonly made = new WeakMap<D, V>();

  /**
   * @param make builds the visitor for one destination. Called once per
   *   destination this cache is asked for, never on a hit.
   */
  constructor(private readonly make: (destination: D) => V) {}

  /** The visitor for `destination`, built on the first ask and kept after it. */
  get(destination: D): V {
    let v = this.made.get(destination);
    if (v === undefined) {
      v = this.make(destination);
      this.made.set(destination, v);
    }
    return v;
  }
}
