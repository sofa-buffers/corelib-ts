/**
 * Generated-layer support: reassembling a `string` / `blob` payload that the
 * decoder reported in pieces.
 *
 * This is the **static helper layer** of CORELIB_PLAN §6.6.1, not part of the
 * codec: it allocates, on the generated layer's behalf, and the codec never calls
 * into it — the call graph runs generated code → helper → codec, never the other
 * way round. §6.6 binds the codec; this side of the boundary is where a value gets
 * built.
 *
 * {@link IStream} reports a payload to {@link Visitor.string} /
 * {@link Visitor.blob} as one or more pieces, each a range of the caller's own fed
 * chunk tagged with the field's `total` byte length and the `offset` of the piece
 * within it. That memory is borrowed only for the duration of the call (§6.0), so
 * a consumer that wants the *value* has to copy out — and generated code always
 * wants the value: a schema field is a `string`, not a sequence of pieces.
 *
 * That join has the same shape for every schema — it is decided entirely by
 * `total` and `offset`, both runtime values — so it lives here rather than in
 * every generated package (ARCHITECTURE §8). It is also the piece that is easiest
 * to get subtly wrong and hardest to catch: two implementations can disagree about
 * where a payload was split and still produce byte-identical output on every
 * shared vector, because the split is a property of how the caller fed the bytes,
 * not of the bytes. {@link PayloadAcc} is pinned instead by a unit test that
 * splits one payload at *every* offset and requires one answer.
 */

/**
 * Joins a `string` / `blob` payload that arrived across several fed pieces.
 *
 * **One per decoder, shared by every field.** Exactly one payload is in flight at
 * a time across a whole decode, however deep the nesting — a fixlen payload is
 * atomic on the wire, so nothing can begin inside it — so one accumulator is
 * enough.
 *
 * **What it returns is owned by the caller** and aliases nothing: the bytes are
 * copied into storage this accumulator allocated, on the whole-payload path
 * exactly as on the split one (§6.7 — "there is no mode in which the destination
 * aliases the input"). A consumer may keep the result, and a payload that arrived
 * whole is not a special case with a different lifetime.
 *
 * Sizing follows the declared `total`, so a hostile length word is bounded by
 * whatever bound the caller already applied to it — the schema `maxlen` its
 * generated guard checks, or the receiver caps of §6.2.1, both of which
 * are enforced at the length word before a piece is ever delivered. This class
 * enforces neither: it is handed a payload the caller has already accepted.
 */
export class PayloadAcc {
  private buf: Uint8Array | null = null;
  private len = 0;

  /**
   * Contribute one piece — the bytes `src[start..end)` at `offset` of a
   * `total`-byte payload — and return the **whole** payload once it is complete,
   * or `null` while bytes are still outstanding.
   *
   * `offset === 0` starts a payload — and *resets* the accumulator, so a decode
   * that was abandoned mid-payload (an `INVALID` field, a declined subtree) leaves
   * nothing behind to corrupt the next one.
   *
   * A late piece with no payload in progress returns `null` rather than writing
   * anywhere: the accumulator has no buffer to append to, and inventing one would
   * fabricate a payload out of a fragment.
   */
  take(
    total: number,
    offset: number,
    src: Uint8Array,
    start: number,
    end: number,
  ): Uint8Array | null {
    if (offset === 0) {
      this.buf = new Uint8Array(total);
      this.len = 0;
    }
    const b = this.buf;
    if (b === null) return null;
    // Clamped to the room that is left. Unreachable from this library's decoder —
    // a piece never runs past the payload it belongs to — and cheap: an over-long
    // piece would otherwise leave the corelib as a platform `RangeError` from
    // `set`, which is not one of the outcomes a caller's
    // `catch (e) { if (e instanceof SofabError) … }` handles.
    let n = end - start;
    const room = total - this.len;
    if (n > room) n = room;
    if (n > 0) {
      b.set(src.subarray(start, start + n), this.len);
      this.len += n;
    }
    if (this.len < total) return null;
    this.buf = null;
    return b;
  }
}
