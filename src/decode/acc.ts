/**
 * Generated-layer support: reassembling a `string` / `blob` payload that the
 * push decoder delivered in pieces.
 *
 * {@link IStream} hands a payload to {@link Visitor.string} / {@link Visitor.blob}
 * as one or more chunks, each tagged with the field's `total` byte length and the
 * `offset` of the chunk within it, and a chunk is only borrowed — it is reusable
 * the moment `feed` returns (CORELIB_PLAN §6). A consumer that wants the *value*
 * rather than the stream therefore has to join the pieces and copy out, and
 * generated code always wants the value: a schema field is a `string`, not a
 * sequence of chunks.
 *
 * That join has the same shape for every schema — it is decided entirely by
 * `total` and `offset`, both runtime values — so it lives here rather than in
 * every generated package (ARCHITECTURE §8). It is also the piece that is easiest
 * to get subtly wrong and hardest to catch: two implementations can disagree
 * about where a payload was split and still produce byte-identical output on
 * every shared vector, because the split is a property of how the caller fed the
 * bytes, not of the bytes. {@link PayloadAcc} is pinned instead by a unit test
 * that splits one payload at *every* offset and requires one answer.
 */

/**
 * Joins a `string` / `blob` payload that arrived across several fed chunks.
 *
 * **One per decoder, shared by every visitor in the tree.** Exactly one payload
 * is in flight at a time across a whole decode, however deep the nesting — a
 * fixlen payload is atomic on the wire, so nothing can begin inside it — so one
 * accumulator is enough, and giving each nested visitor its own would allocate
 * per sequence for no gain.
 *
 * **No allocation for a payload that arrives whole**, which is every payload on
 * the contiguous {@link decode} path and the common case when streaming: the
 * chunk itself is handed back. That means the returned view can alias the fed
 * chunk and is valid only for the duration of the visitor call — decode it, or
 * copy it, before returning. The buffered case returns a private buffer, but a
 * caller cannot tell the two apart and must treat both as borrowed.
 *
 * Sizing follows the declared `total`, so a hostile length word is bounded by
 * whatever bound the caller already applied to it — the schema `maxlen` its
 * generated guard checks, or the receiver's {@link DecodeLimits}. This class
 * enforces neither: it is handed a payload the caller has already accepted.
 */
export class PayloadAcc {
  private buf: Uint8Array | null = null;
  private len = 0;

  /**
   * Contribute one chunk of a `total`-byte payload and return the **whole**
   * payload once it is complete, or `null` while bytes are still outstanding.
   *
   * `offset === 0` starts a payload — and *resets* the accumulator, so a decode
   * that was abandoned mid-payload (an `INVALID` field, a skipped subtree)
   * leaves nothing behind to corrupt the next one.
   *
   * A late chunk with no payload in progress returns `null` rather than writing
   * anywhere: the accumulator has no buffer to append to, and inventing one
   * would fabricate a payload out of a fragment.
   */
  take(total: number, offset: number, chunk: Uint8Array): Uint8Array | null {
    if (offset === 0 && chunk.length >= total) {
      // Whole payload in one chunk: hand it straight back, no copy. The `>` case
      // cannot arise from this library's decoders — a chunk never runs past the
      // payload it belongs to — but trimming costs one comparison and keeps the
      // return exactly `total` bytes for any driver.
      return chunk.length === total ? chunk : chunk.subarray(0, total);
    }
    if (offset === 0) {
      this.buf = new Uint8Array(total);
      this.len = 0;
    }
    const b = this.buf;
    if (b === null) return null;
    // Clamped to the room that is left. Again unreachable from this library's
    // decoders, and again cheap: an over-long chunk would otherwise leave the
    // corelib as a platform `RangeError` from `set`, which is not one of the
    // outcomes a caller's `catch (e) { if (e instanceof SofabError) … }` handles.
    const room = total - this.len;
    const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
    b.set(part, this.len);
    this.len += part.length;
    if (this.len < total) return null;
    this.buf = null;
    return b;
  }
}
