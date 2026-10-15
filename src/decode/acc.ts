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

import { argumentError } from "../errors.js";

/**
 * Joins a `string` / `blob` payload that arrived across several fed pieces.
 *
 * **One per decoder, shared by every field.** Exactly one payload is in flight at
 * a time across a whole decode, however deep the nesting — a fixlen payload is
 * atomic on the wire, so nothing can begin inside it — so one accumulator is
 * enough.
 *
 * **What it returns is owned by the caller** and aliases nothing: the bytes are
 * copied into storage this accumulator allocated — or, with
 * {@link PayloadAcc.takeInto}, into storage the caller handed over and already
 * owns — on the whole-payload path exactly as on the split one (§6.7 — "there is no mode in
 * which the destination aliases the input"). A consumer may keep the result, and a
 * payload that arrived whole is not a special case with a different lifetime.
 *
 * **The join is written out twice**, once in each entry point, rather than shared
 * through a private method both call. Measured on a 16-element `blob` wrapper
 * array decoded with a fresh collector (Callgrind rep-subtraction, 2000 → 22000
 * reps): sharing it cost **+1.8 %** on the V8 **baseline** tier — 179,070 against
 * 175,929 Ir/op — and nothing at all on the optimizing tier, which inlines the
 * call. The baseline tier is the one the `ts` bench rows measure, and this is the
 * path every caller that never asked for reuse already takes. The two bodies are a
 * dozen lines and differ in one of them, and the every-offset split test pins both
 * to the same answer, which is the guard that makes the duplication safe.
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

  /**
   * {@link take}, into a buffer **you** already hold: the same join, writing into
   * `dst` instead of into storage this accumulator allocates.
   *
   * What it is for: a decode into a reused destination (ARCHITECTURE §8). A
   * generated message decoded a second time into the same object already holds a
   * `Uint8Array` for its `blob` field, and where the new payload is the same
   * length that buffer is the right place to put it — so the receive loop stops
   * allocating one payload-sized buffer per decode and per element. The choice is
   * the caller's and it is `dst.length === total`; this method is the copy.
   *
   * **The chunked path too**, which is the half a caller cannot write for itself
   * without re-implementing the join: `dst` is adopted at `offset === 0` and the
   * pieces land in it as they arrive, so a payload split across `feed` calls costs
   * no more than one that arrived whole. The pieces of **one** payload must all be
   * offered the same `dst`; what comes back is the buffer the payload was actually
   * assembled in, which is the one adopted at offset 0.
   *
   * **A destination of the wrong size is a caller mistake**, not a verdict about
   * the message: `Argument` (CORELIB_PLAN §6.3's third row, §6.6.3 — "a
   * destination too short for the value is `InvalidArgument`"), refused before a
   * byte is copied. It is `!==` rather than `<` because the payload's length *is*
   * part of the value: a longer buffer returned whole would overstate the payload,
   * and returning a `subarray` of it would alias storage the caller still owns.
   *
   * Everything else is {@link take}: `null` until the last piece lands, `offset
   * === 0` resets whatever an abandoned payload left behind, and a late piece with
   * no payload in progress returns `null` without writing anywhere.
   *
   * It allocates nothing, which does **not** make it a codec primitive: it is
   * still the static helper layer (§6.6.1), reached from generated code only.
   */
  takeInto(
    dst: Uint8Array,
    total: number,
    offset: number,
    src: Uint8Array,
    start: number,
    end: number,
  ): Uint8Array | null {
    if (dst.length !== total) {
      throw argumentError(
        `payload destination holds ${dst.length} bytes, the payload is ${total} — ` +
          `reuse a buffer only where the length matches, allocate otherwise`,
      );
    }
    if (offset === 0) {
      this.buf = dst;
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
