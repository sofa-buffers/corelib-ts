/**
 * Generated-layer support: the element collectors for a **wrapper-sequence array**
 * of `string` or `blob` (MESSAGE_SPEC §5.1).
 *
 * Static helper layer, not codec (CORELIB_PLAN §6.6.1): these allocate — that is
 * their job — and no codec path reaches them. Generated code drives them from
 * inside its own flat {@link Visitor}, which is what knows, from the schema, that
 * the scope it is currently in *is* the wrapper array.
 *
 * A wrapper array is an ordinary sequence whose child fields *are* the elements,
 * and whose field id *is* the array index. So a collector is fed the two events a
 * `string` / `blob` element produces — {@link StringSeq.begin} at the length word
 * and {@link StringSeq.element} per payload piece — and places each value at
 * `out[id]`.
 *
 * Every part of that is schema-independent. Both bounds on the index (the schema
 * `count`, the receiver cap) and both on the element's byte length (the element
 * `maxlen`, the receiver cap) arrive as constructor arguments — runtime values —
 * and the field name is carried along only so a rejection can say which field it
 * was about. So the collectors belong here rather than being re-emitted, textually
 * identical, into every generated package (ARCHITECTURE §8).
 *
 * Four rules are implemented here and are worth stating once, since nothing in the
 * shared vectors can distinguish an implementation that gets them wrong from one
 * that does not — they are properties of the *decoded value*, not of the bytes
 * (which is exactly why CORELIB_PLAN §7.2 item 8 asks for them separately):
 *
 * - **Gaps are legal.** An interior element equal to its default is not written at
 *   all, so ids `0, 2, 3` are well-formed. The missing index is filled with the
 *   element default, never skipped over: everything after a gap keeps its index.
 * - **Length is highest present id + 1.** The wrapper carries no length, and the
 *   last element is never elided, so growing to `id + 1` on each element is
 *   exactly right and no trailing fill is ever needed.
 * - **A repeated element id replaces.** Last occurrence wins per id (§7.4);
 *   placing at `out[id]` does that by construction, with no bookkeeping.
 * - **A rejected id extends nothing.** Every bound is checked before the
 *   destination grows, so a rejection leaves the array exactly as it was and a
 *   lower id delivered afterwards still lands correctly.
 *
 * **Two bounds, never both** (§6.2.1). Index and element length each carry a
 * schema bound and a receiver cap, and exactly one of the pair applies: where the
 * schema declared a bound its violation is `INVALID` — a statement about validity
 * — and where it declared none the receiver's cap governs and its violation is
 * `LIMIT_EXCEEDED`, a policy rejection on well-formed bytes. "They **MUST NOT** be
 * applied to a field the schema already bounds", so the caps are exclusive with
 * the bounds and never additive.
 */

import {
  DEFAULT_MAX_DYN_ARRAY_COUNT,
  DEFAULT_MAX_DYN_BLOB_LEN,
  DEFAULT_MAX_DYN_STRING_LEN,
  FixlenSubtype,
} from "../constants.js";
import { invalidMsgError, limitExceededError } from "../errors.js";
import type { PayloadAcc } from "./acc.js";
import { decodeUtf8 } from "./text.js";

/** Shared placeholder for a gap in a {@link BlobSeq}; zero-length, so sharing one is safe. */
const NO_BYTES = new Uint8Array(0);

/** No *schema* bound — what `cap` / `elemMax` take for an array or element the schema left open (§7.2). */
const UNBOUNDED = -1;

/**
 * The slots of a wrapper-sequence array: the index rules of MESSAGE_SPEC §5.1 and
 * the two bounds of CORELIB_PLAN §6.2.1, once, for any element type.
 *
 * {@link StringSeq} and {@link BlobSeq} place leaf elements through it, and
 * generated code places a **framed** element — a `struct` / `union` / nested row —
 * through it directly: {@link reserve} at the element's `sequenceBegin`, then build
 * the child into `out[id]`. The element kind changes which path arrives here and
 * nothing else, which is the point — the bound is the index (§7.2 item 8).
 *
 * @param out The destination array; grown to `id + 1` as elements arrive.
 * @param def The element default, written into a gap and into a reserved slot.
 * @param cap The schema `count` as an index capacity: `id >= cap` is `INVALID`
 * (§7.1) — a statement about validity. `-1` for an array the schema left open,
 * where `receiverCap` governs instead.
 * @param name The schema field name, used only in a rejection message.
 * @param receiverCap The receiver-side index cap for a schema-unbounded array
 * (§6.2.1): `id >= receiverCap` is `LIMIT_EXCEEDED`, a policy rejection. There is
 * no unlimited setting — a wrapper array announces no count, so the index is the
 * only place a receiver can bound it.
 */
export class ElementSeq<T> {
  constructor(
    readonly out: T[],
    readonly def: T,
    readonly cap: number = UNBOUNDED,
    readonly name: string = "array",
    readonly receiverCap: number = DEFAULT_MAX_DYN_ARRAY_COUNT,
  ) {}

  /**
   * Bound-check `id` and grow `out` to `id + 1`, filling any gap — and the slot
   * itself — with the element default.
   *
   * The check runs **before** the growth, which is the whole of §7.2 item 8's
   * "after a rejected id the container is not left partially extended": a
   * rejection leaves `out` exactly as it was, so a lower id delivered afterwards
   * still lands at its own index.
   */
  reserve(id: number): void {
    this.checkIndex(id);
    // Grow to at least id + 1 (ARCHITECTURE §9.5 shape B): `push` leaves the
    // geometry to the engine's own amortised doubling, so a sparse array does not
    // cost O(n²) copies.
    while (this.out.length <= id) this.out.push(this.def);
  }

  /**
   * The two index bounds, without growing: the schema `count` as validity
   * (`INVALID`) or, where the schema left the array open, the receiver cap as
   * capacity (`LIMIT_EXCEEDED`). Never both — §6.2.1 keeps a cap off a field the
   * schema already bounds.
   *
   * Split out from {@link reserve} because a leaf element is bound-checked at its
   * length word, before its payload has arrived and so before there is anything to
   * place ({@link StringSeq.begin}).
   */
  checkIndex(id: number): void {
    if (this.cap >= 0) {
      if (id >= this.cap) {
        throw invalidMsgError(`${this.name}: array index above schema capacity ${this.cap}`);
      }
    } else if (id >= this.receiverCap) {
      throw limitExceededError(
        `${this.name}: array index ${id} exceeds the receiver cap ${this.receiverCap}`,
      );
    }
  }

  /** {@link reserve} the slot, then write `value` into it. A repeat replaces (§7.4). */
  place(id: number, value: T): void {
    this.reserve(id);
    this.out[id] = value;
  }
}

/**
 * Collects the elements of a `string` wrapper-sequence array into `out`.
 *
 * @param out The destination, placed at `out[id]`; grown as elements arrive, with
 * gaps filled by the element default `""`.
 * @param acc The decoder's shared {@link PayloadAcc} — one per decode, since only
 * one payload is ever in flight.
 * @param cap The schema `count`, an index **capacity**: an element id at or above
 * it is `INVALID` (§7.1/§5.1) — a statement about validity. Leave it at `-1` for
 * an array the schema left unbounded, where `receiverCap` governs instead.
 * @param elemMax The element `maxlen` in bytes, or `-1` for an element the schema
 * left open, where `receiverElemMax` governs instead.
 * @param name The schema field name, used only in the rejection message.
 * @param receiverCap The receiver-side index cap that applies **only** when the
 * schema left the array unbounded (§6.2.1): exceeding it is `LIMIT_EXCEEDED`, a
 * policy rejection, not `INVALID`. There is no unlimited setting — a wrapper array
 * announces no count, so the index is the only place a receiver can bound it.
 * @param receiverElemMax The receiver-side `max_dyn_string_len` for an element the
 * schema left unbounded (§6.2.1), checked at the length word and answered with
 * `LIMIT_EXCEEDED`. A wrapper array's `string` elements never reach the generated
 * visitor — their length words come here — so this is where that cap belongs
 * (corelib-ts#164). Finite by default: §6.2.1 admits no unset state.
 */
export class StringSeq {
  /** The index rules and both index bounds, shared with every other element kind. */
  private readonly slots: ElementSeq<string>;

  constructor(
    readonly out: string[],
    readonly acc: PayloadAcc,
    readonly cap: number = UNBOUNDED,
    readonly elemMax: number = UNBOUNDED,
    readonly name: string = "array",
    readonly receiverCap: number = DEFAULT_MAX_DYN_ARRAY_COUNT,
    readonly receiverElemMax: number = DEFAULT_MAX_DYN_STRING_LEN,
  ) {
    this.slots = new ElementSeq(out, "", cap, name, receiverCap);
  }

  /**
   * The element's fixlen length word ({@link Visitor.fixlenBegin}).
   *
   * The bounds are decided by this word, so they are checked here — before any
   * payload byte — and again in {@link element} below.
   *
   * That is not redundancy for its own sake: a message that ends *inside* an
   * over-long element must still be `INVALID`, and only this event runs early
   * enough to say so. Without it the verdict would degrade to `INCOMPLETE`, which
   * §5.2.3 forbids for input already known to be malformed and which §6.4 forbids
   * a chunk boundary from changing.
   *
   * An element of the wrong fixlen subtype is left alone: §7.3 requires it to be
   * *skipped*, not rejected, and it is skipped by this class simply ignoring it.
   */
  begin(id: number, subtype: FixlenSubtype, total: number): void {
    if (subtype !== FixlenSubtype.String) return;
    this.check(id, total);
  }

  /** One payload piece of element `id` ({@link Visitor.string}). */
  element(
    id: number,
    total: number,
    offset: number,
    src: Uint8Array,
    start: number,
    end: number,
  ): void {
    this.check(id, total);
    // A payload that arrived whole is decoded straight out of the caller's chunk:
    // `decodeUtf8` produces a new string, so nothing aliases the input and the
    // accumulator's copy is not needed at all.
    const text =
      offset === 0 && end - start === total
        ? decodeUtf8(src, start, end)
        : decodeStringPiece(this.acc, total, offset, src, start, end);
    if (text === null) return;
    this.slots.place(id, text);
  }

  /** Every bound for one element. Rejects **before** the destination grows. */
  private check(id: number, total: number): void {
    this.slots.checkIndex(id);
    if (this.elemMax >= 0) {
      if (total > this.elemMax) {
        throw invalidMsgError(
          `${this.name} element: string byte length above schema maxlen ${this.elemMax}`,
        );
      }
    } else if (total > this.receiverElemMax) {
      throw limitExceededError(
        `${this.name} element: string byte length ${total} exceeds the receiver cap ` +
          `${this.receiverElemMax}`,
      );
    }
  }
}

/**
 * Collects the elements of a `blob` wrapper-sequence array into `out`. The
 * `string` twin above, with two differences: the payload is stored as bytes rather
 * than decoded, and gaps are filled with an empty {@link Uint8Array}.
 *
 * Each element is storage of its own — what {@link PayloadAcc} returns is a buffer
 * it allocated and handed over, never a view into the fed chunk (§6.7) — so a
 * stored element cannot rot when the caller reuses its input.
 *
 * @param out The destination, placed at `out[id]`.
 * @param acc The decoder's shared {@link PayloadAcc}.
 * @param cap The schema `count` as an index capacity, or `-1` for unbounded.
 * @param elemMax The element `maxlen` in bytes, or `-1` for an element the schema
 * left open, where `receiverElemMax` governs instead.
 * @param name The schema field name, used only in the rejection message.
 * @param receiverCap The receiver-side index cap for a schema-unbounded array
 * (§6.2.1) — see {@link StringSeq}.
 * @param receiverElemMax The receiver-side `max_dyn_blob_len` for a schema-unbounded
 * element (§6.2.1) — see {@link StringSeq}.
 */
export class BlobSeq {
  /** The index rules and both index bounds, shared with every other element kind. */
  private readonly slots: ElementSeq<Uint8Array>;

  constructor(
    readonly out: Uint8Array[],
    readonly acc: PayloadAcc,
    readonly cap: number = UNBOUNDED,
    readonly elemMax: number = UNBOUNDED,
    readonly name: string = "array",
    readonly receiverCap: number = DEFAULT_MAX_DYN_ARRAY_COUNT,
    readonly receiverElemMax: number = DEFAULT_MAX_DYN_BLOB_LEN,
  ) {
    this.slots = new ElementSeq(out, NO_BYTES, cap, name, receiverCap);
  }

  /** See {@link StringSeq.begin} — the early bound check, for subtype `blob`. */
  begin(id: number, subtype: FixlenSubtype, total: number): void {
    if (subtype !== FixlenSubtype.Blob) return;
    this.check(id, total);
  }

  /** One payload piece of element `id` ({@link Visitor.blob}). */
  element(
    id: number,
    total: number,
    offset: number,
    src: Uint8Array,
    start: number,
    end: number,
  ): void {
    this.check(id, total);
    const payload = this.acc.take(total, offset, src, start, end);
    if (payload === null) return;
    this.slots.place(id, payload);
  }

  /** Every bound for one element. Rejects **before** the destination grows. */
  private check(id: number, total: number): void {
    this.slots.checkIndex(id);
    if (this.elemMax >= 0) {
      if (total > this.elemMax) {
        throw invalidMsgError(
          `${this.name} element: blob byte length above schema maxlen ${this.elemMax}`,
        );
      }
    } else if (total > this.receiverElemMax) {
      throw limitExceededError(
        `${this.name} element: blob byte length ${total} exceeds the receiver cap ` +
          `${this.receiverElemMax}`,
      );
    }
  }
}

/** A split payload, joined and decoded once its last piece arrives; `null` before that. */
function decodeStringPiece(
  acc: PayloadAcc,
  total: number,
  offset: number,
  src: Uint8Array,
  start: number,
  end: number,
): string | null {
  const payload = acc.take(total, offset, src, start, end);
  return payload === null ? null : decodeUtf8(payload);
}
