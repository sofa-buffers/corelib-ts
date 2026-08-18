/**
 * Generated-layer support: the element collectors for a **wrapper-sequence
 * array** of `string` or `blob` (MESSAGE_SPEC §5.1).
 *
 * A wrapper array is an ordinary sequence whose child fields *are* the elements,
 * and whose field id *is* the array index. On the push path that means a nested
 * {@link Visitor}: {@link Visitor.sequenceBegin} returns a collector, the
 * collector receives one `string` / `blob` field per element, and it places each
 * value at `out[id]`.
 *
 * Every part of that is schema-independent. The index bound (the schema `count`)
 * and the per-element byte bound (the element `maxlen`) arrive as constructor
 * arguments — runtime values, exactly as {@link Cursor} already takes them on the
 * pull path — and the field name is carried along only so a rejection can say
 * which field it was about. So the collectors belong here rather than being
 * re-emitted, textually identical, into every generated package
 * (ARCHITECTURE §8).
 *
 * Three rules of §5.1 are implemented here and are worth stating once, since
 * nothing in the shared vectors can distinguish an implementation that gets them
 * wrong from one that does not — they are properties of the *decoded value*, not
 * of the bytes:
 *
 * - **Gaps are legal.** An interior element equal to its default is not written
 *   at all, so ids `0, 2, 3` are well-formed. The missing index is filled with
 *   the element default, never skipped over: everything after a gap must keep
 *   its index.
 * - **Length is highest present id + 1.** The wrapper carries no length, and the
 *   last element is never elided, so growing to `id + 1` on each element is
 *   exactly right and no trailing fill is ever needed.
 * - **A repeated element id replaces.** Last occurrence wins per id (§7.4);
 *   placing at `out[id]` does that by construction, with no bookkeeping.
 */

import { FixlenSubtype } from "../constants.js";
import { invalidMsgError } from "../errors.js";
import type { PayloadAcc } from "./acc.js";
import type { Visitor } from "./istream.js";
import { decodeUtf8 } from "./text.js";

/** Shared placeholder for a gap in a {@link BlobSeq}; zero-length, so sharing one is safe. */
const NO_BYTES = new Uint8Array(0);

/**
 * Swallows a nested sequence that appears inside a leaf collector.
 *
 * A `string` / `blob` array has no nested scope of its own, so a sequence
 * starting inside one is a field the schema does not know — forward
 * compatibility, and it must be skipped whole. Returning nothing would *not* do
 * that: this port resolves a child scope as `parent.sequenceBegin?.(id) ??
 * parent`, so "nothing" means *keep the current visitor*, and the unknown
 * subtree's children would then be delivered to the collector as if they were
 * elements. This visitor implements no field callback and returns itself from
 * `sequenceBegin`, so a subtree of any depth evaporates into it.
 */
const SKIP: Visitor = { sequenceBegin: (): Visitor => SKIP };

/** No bound — the value `cap` / `elemMax` take for an array or element the schema left unbounded (§7.2). */
const UNBOUNDED = -1;

/**
 * Collects the elements of a `string` wrapper-sequence array into `out`.
 *
 * @param out The destination, placed at `out[id]`; grown as elements arrive, with
 * gaps filled by the element default `""`.
 * @param acc The decoder's shared {@link PayloadAcc} — one per decode, since only
 * one payload is ever in flight.
 * @param cap The schema `count`, an index **capacity**: an element id at or above
 * it is `INVALID` (§7.1/§5.1). Leave it at `-1` for an unbounded array, whose
 * length is then dictated by the sender (§7.2).
 * @param elemMax The element `maxlen` in bytes, or `-1` for unbounded.
 * @param name The schema field name, used only in the rejection message.
 */
export class StringSeq implements Visitor {
  constructor(
    readonly out: string[],
    readonly acc: PayloadAcc,
    readonly cap: number = UNBOUNDED,
    readonly elemMax: number = UNBOUNDED,
    readonly name: string = "array",
  ) {}

  /**
   * The bounds are decided by the element's length word, so they are checked
   * here — before any payload byte — and again in {@link string} below.
   *
   * That is not redundancy for its own sake: a message that ends *inside* an
   * over-long element must still be `INVALID`, and only this hook runs early
   * enough to say so. Without it the verdict would degrade to `INCOMPLETE`,
   * which the same field read through {@link Cursor.readString} does not do, and
   * CORELIB_PLAN §5.2 gives `INVALID` precedence for input already known to be
   * malformed while §6.4 forbids a chunk boundary changing the outcome.
   *
   * An element of the wrong fixlen subtype is left alone: §7.3 requires it to be
   * *skipped*, not rejected, and it is skipped by this class simply not
   * implementing the callback its wire type would deliver.
   */
  fixlenBegin(id: number, subtype: FixlenSubtype, total: number): void {
    if (subtype !== FixlenSubtype.String) return;
    this.check(id, total);
  }

  string(id: number, total: number, offset: number, chunk: Uint8Array): void {
    this.check(id, total);
    const payload = this.acc.take(total, offset, chunk);
    if (payload === null) return;
    while (this.out.length <= id) this.out.push("");
    this.out[id] = decodeUtf8(payload);
  }

  sequenceBegin(): Visitor {
    return SKIP;
  }

  /** Both schema bounds for one element. Rejects before the destination grows. */
  private check(id: number, total: number): void {
    if (this.cap >= 0 && id >= this.cap) {
      throw invalidMsgError(`${this.name}: array index above schema capacity ${this.cap}`);
    }
    if (this.elemMax >= 0 && total > this.elemMax) {
      throw invalidMsgError(
        `${this.name} element: string byte length above schema maxlen ${this.elemMax}`,
      );
    }
  }
}

/**
 * Collects the elements of a `blob` wrapper-sequence array into `out`. The
 * `string` twin above, with two differences: the payload is stored as bytes
 * rather than decoded, and gaps are filled with an empty {@link Uint8Array}.
 *
 * Each element is **copied** out of the payload. What {@link PayloadAcc} returns
 * can be the fed chunk itself, which the caller may reuse the moment `feed`
 * returns (CORELIB_PLAN §6), so a stored view would silently rot; a decoded
 * `string` needs no such copy because decoding already produced a value.
 *
 * @param out The destination, placed at `out[id]`.
 * @param acc The decoder's shared {@link PayloadAcc}.
 * @param cap The schema `count` as an index capacity, or `-1` for unbounded.
 * @param elemMax The element `maxlen` in bytes, or `-1` for unbounded.
 * @param name The schema field name, used only in the rejection message.
 */
export class BlobSeq implements Visitor {
  constructor(
    readonly out: Uint8Array[],
    readonly acc: PayloadAcc,
    readonly cap: number = UNBOUNDED,
    readonly elemMax: number = UNBOUNDED,
    readonly name: string = "array",
  ) {}

  /** See {@link StringSeq.fixlenBegin} — the early bound check, for subtype `blob`. */
  fixlenBegin(id: number, subtype: FixlenSubtype, total: number): void {
    if (subtype !== FixlenSubtype.Blob) return;
    this.check(id, total);
  }

  blob(id: number, total: number, offset: number, chunk: Uint8Array): void {
    this.check(id, total);
    const payload = this.acc.take(total, offset, chunk);
    if (payload === null) return;
    while (this.out.length <= id) this.out.push(NO_BYTES);
    this.out[id] = payload.slice();
  }

  sequenceBegin(): Visitor {
    return SKIP;
  }

  /** Both schema bounds for one element. Rejects before the destination grows. */
  private check(id: number, total: number): void {
    if (this.cap >= 0 && id >= this.cap) {
      throw invalidMsgError(`${this.name}: array index above schema capacity ${this.cap}`);
    }
    if (this.elemMax >= 0 && total > this.elemMax) {
      throw invalidMsgError(
        `${this.name} element: blob byte length above schema maxlen ${this.elemMax}`,
      );
    }
  }
}
