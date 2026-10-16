/**
 * Generated-layer support: the element collectors for a **wrapper-sequence array**
 * (MESSAGE_SPEC §5.1) — {@link ElementSeq} and {@link FramedSeq} for the index
 * rules of any element kind, {@link StringSeq} / {@link BlobSeq} for the two leaf
 * kinds whose payload arrives here as well.
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
 * **Reuse mode** ({@link ElementSeq.reuse} and its three twins), for a decode into
 * a destination that already holds an earlier message (ARCHITECTURE §8). Armed, a
 * collector claims the slots that are already there instead of building new ones —
 * `def` written over them, or the caller's `reset` run on them — and
 * {@link ElementSeq.end} cuts the array to the length *this* decode gave it, so a
 * shorter message cannot leave the previous one's tail behind to be read as
 * elements of this one.
 *
 * The rules above are untouched by it: the same two bounds, checked at the same
 * moment, the same gap fill, the same last-occurrence-wins. What changes is only
 * where a slot's storage comes from. One number keeps the three states of a slot
 * apart — the length this decode has claimed, which is also the length `end`
 * truncates to: below it the slot is this decode's own and is never reset twice (a
 * re-opened element still merges into what it already built, §7.4); at or above it
 * a slot an earlier decode filled is claimed in place; past that it is pushed,
 * exactly as a fresh collector does.
 *
 * **What the mode costs a caller who never asked for it**, since every line of it
 * sits on the per-element path: the claim-in-place loop is one comparison against
 * `0`, and {@link BlobSeq.element}'s arm is one field test. Measured against the
 * same collectors before the mode existed (Callgrind rep-subtraction, 2000 → 22000
 * reps, fresh collectors): a 64-element `string` wrapper array +0.6 % on the V8
 * optimizing tier and −0.4 % on the baseline tier, a 32-element framed array
 * +0.3 % / +0.2 %, and a 16-element `blob` array +0.4 % on the baseline tier but
 * **+4.5 %** on the optimizing tier (30,997 against 29,663 Ir/op). That last one
 * is `element`'s field test, not the loops: 70 % of it goes away if the arm is
 * removed, because the branch is what pushes `element` past what V8 will inline
 * into the visitor callback. It is the price of serving both modes from one
 * object; splitting `element` in two is what would buy it back, and that is the
 * generated layer's call to make, with its own numbers (sofa-buffers/generator#760).
 *
 * **Two bounds, never both** (§6.2.1). Index and element length each carry a
 * schema bound and a receiver cap, and exactly one of the pair applies: where the
 * schema declared a bound its violation is `INVALID` — a statement about validity
 * — and where it declared none the receiver's cap governs and its violation is
 * `LIMIT_EXCEEDED`, a policy rejection on well-formed bytes. "They **MUST NOT** be
 * applied to a field the schema already bounds", so the caps are exclusive with
 * the bounds and never additive.
 *
 * **Every bound is a required argument, and none of them has a default** (§6.2.1).
 * The comparison runs here; the *number* never originates here. A corelib "**MUST
 * NOT** hold a limit of its own, **MUST NOT** supply a default for one it was not
 * given, **MUST NOT** read an omitted argument as *unlimited*, and **MUST NOT**
 * clamp to one", and a format ceiling (§6.2) reached because no cap was stated "is
 * the **format's** bound, not a receiver cap, and a port **MUST NOT** present it as
 * one". These constructors used to default `receiverCap` to `ARRAY_MAX` and
 * `receiverElemMax` to `FIXLEN_MAX`, which did exactly that: they reported
 * `LIMIT_EXCEEDED` against a ceiling nobody configured. The defaults are gone and
 * the arguments are required — §6.2.1's "strictest form, and the recommended one".
 * The *schema* bounds beside them (`cap`, `elemMax`) are required too, with
 * {@link UNBOUNDED} as the explicit "the schema declared none" spelling: an absent
 * schema bound is a fact about the schema, which only the caller knows.
 *
 * **And an argument that states no cap is a caller mistake, not a policy
 * rejection.** A required argument can still arrive as `-1`, `undefined` or
 * `Infinity` from an untyped caller, and the same reasoning applies one level in:
 * no receiver policy was set, so there is no `LIMIT_EXCEEDED` to report and no
 * unlimited mode to fall back to. Such a bound is refused at construction with
 * `Argument` (§6.3's third row: "every remaining caller mistake is
 * `InvalidArgument`") — see {@link requireReceiverBound}.
 */

import { FixlenSubtype } from "../constants.js";
import { argumentError, invalidMsgError, limitExceededError } from "../errors.js";
import type { PayloadAcc } from "./acc.js";
import { decodeUtf8 } from "./text.js";

/** Shared placeholder for a gap in a {@link BlobSeq}; zero-length, so sharing one is safe. */
const NO_BYTES = new Uint8Array(0);

/**
 * No *schema* bound — what `cap` / `elemMax` take for an array or element the
 * schema left open (§7.2), so the receiver cap beside them governs instead.
 *
 * Exported because the schema bounds are required arguments with no default: an
 * absent one is a fact about the **schema**, which only generated code knows, and
 * §6.2.1's ban on a codec defaulting a bound is easiest to keep honest when every
 * bound has to be spelled. This is the spelling for "there is none".
 */
export const UNBOUNDED = -1;

/**
 * Reject a receiver bound that is not a bound, **before** it is ever compared
 * against (CORELIB_PLAN §6.2.1, §6.3).
 *
 * §6.2.1 lets this library perform the comparison but never own the number: a
 * codec "**MUST NOT** hold a limit of its own, **MUST NOT** supply a default for
 * one it was not given, **MUST NOT** read an omitted argument as *unlimited*, and
 * **MUST NOT** clamp to one". A caller that hands over `-1`, `undefined`/`NaN` or
 * `Infinity` for a bound that is about to **govern** has stated no cap at all, and
 * there are only two things this class could do about it — and both were wrong:
 *
 * - it used to **fail closed with `LIMIT_EXCEEDED`** for a negative bound, naming
 *   a receiver policy the deployment never set. `LimitExceeded` means "raise my
 *   limit or the sender must send less" (§6.3); there is no limit to raise;
 * - and it **failed open** for `undefined`/`NaN` — every comparison against `NaN`
 *   is `false`, so `id >= receiverCap` never fired and the array decoded
 *   uncapped. That is §6.2.1's "read an omitted argument as *unlimited*",
 *   verbatim.
 *
 * Neither is a property of the message or of the deployment: it is a mistake in
 * the **call**, which §6.3's third row makes `InvalidArgument` — "every remaining
 * caller mistake is `InvalidArgument`". Reported at construction, so it is still
 * fail-closed (no element is ever accepted) and the per-element comparison below
 * stays a single `>=` on a number already known to be finite and non-negative.
 *
 * Checked only where the receiver bound actually applies. §6.2.1: the caps "**MUST
 * NOT** be applied to a field the schema already bounds" — where `schemaBound` is
 * stated it governs alone, the receiver bound beside it is inert, and a number
 * that is forbidden to be applied cannot be required to be stated.
 */
function requireReceiverBound(
  schemaBound: number,
  receiver: number,
  what: string,
  name: string,
): void {
  if (schemaBound >= 0) return; // the schema bound governs; the cap never runs
  if (Number.isFinite(receiver) && receiver >= 0) return;
  throw argumentError(
    `${name}: ${what} is ${receiver}, which states no cap — the schema left this ` +
      `field unbounded, and §6.2.1 admits no unset state and no unlimited mode. ` +
      `The number is generated code's to supply.`,
  );
}

/**
 * **The** element-index rule, in one place — split into the number it compares
 * against and the verdict a breach of it gets.
 *
 * Never both (CORELIB_PLAN §6.2.1): where the schema declared a `count` its
 * violation is `INVALID`, a statement about the message, and the receiver cap
 * beside it is inert; where it declared none the cap governs alone and its
 * violation is `LIMIT_EXCEEDED`, a policy rejection of well-formed bytes.
 *
 * "Never both" means exactly one of the pair is ever compared against, so there
 * is exactly one number in force and it is known at construction. This picks it
 * once per collector and every check below is then the single `id >= this.bound`
 * that remains — the whole §6.2.1 choice, made once rather than re-made per
 * element. That matters beyond tidiness: the `ts` bench rows measure the V8
 * **baseline** tier, where nothing is inlined and a call is the expensive thing,
 * so a per-element call into a shared checker is a cost the shared checker does
 * not have to pay in order to stay shared.
 *
 * @param cap The schema `count` as an index capacity, or {@link UNBOUNDED} (`-1`).
 * @param receiverCap The receiver index cap, in force only when `cap` is
 * {@link UNBOUNDED}; already known to be finite and non-negative, because
 * {@link requireReceiverBound} refused anything else at construction — so the
 * bound this returns is always a finite non-negative number and the comparison
 * against it is exact, with no NaN to fall through.
 */
function indexBound(cap: number, receiverCap: number): number {
  return cap >= 0 ? cap : receiverCap;
}

/**
 * Which verdict an index that has already failed `indexBound` gets: the
 * schema `count` is validity, the receiver cap is policy (CORELIB_PLAN §6.2.1).
 *
 * Written once and shared by every collector in this file, because §6.2.1 is a
 * rule about *which* verdict a caller gets and a second copy is a second chance
 * to get it wrong. It always throws — the caller has already established that the
 * bound is breached — and it never touches a container, which is what lets a
 * caller run its check before allocating anything (§7.2 item 8).
 *
 * @param id The element index, which for a wrapper array is the child field's id.
 * @param cap The schema `count` as an index capacity, or {@link UNBOUNDED} (`-1`).
 * `cap >= 0` is what makes the breach `INVALID` rather than `LIMIT_EXCEEDED`.
 * @param receiverCap The receiver index cap, named in the rejection message when
 * it is the bound that was breached.
 * @param name The schema field name, used only in the rejection message.
 */
function rejectIndex(id: number, cap: number, receiverCap: number, name: string): never {
  if (cap >= 0) {
    throw invalidMsgError(`${name}: array index above schema capacity ${cap}`);
  }
  throw limitExceededError(`${name}: array index ${id} exceeds the receiver cap ${receiverCap}`);
}

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
 * (§7.1) — a statement about validity. Pass {@link UNBOUNDED} (`-1`) for an array
 * the schema left open, where `receiverCap` governs instead.
 * @param name The schema field name, used only in a rejection message.
 * @param receiverCap The receiver-side index cap for a schema-unbounded array
 * (§6.2.1): `id >= receiverCap` is `LIMIT_EXCEEDED`, a policy rejection. There is
 * no unlimited setting — a wrapper array announces no count, so the index is the
 * only place a receiver can bound it. **Required, with no default**: the number is
 * generated code's, and falling back to `ARRAY_MAX` would report a policy
 * rejection against a format ceiling nobody configured (§6.2.1). A value that
 * states no cap at all — negative, `NaN`, `Infinity` — is `Argument` at
 * construction, never `LIMIT_EXCEEDED` ({@link requireReceiverBound}).
 */
export class ElementSeq<T> {
  /**
   * The one index bound in force, picked once by `indexBound`: the schema
   * `count` where the schema stated one, the receiver cap where it did not. Which
   * of the two it is decides the verdict, which is `rejectIndex`'s job.
   */
  private readonly bound: number;

  /**
   * How many leading slots **this** decode has claimed: the highest id it placed
   * or reserved, plus one — the array's length as §5.1 defines it, and the length
   * {@link end} cuts `out` back to.
   *
   * Equal to `out.length` except in reuse mode, where the slots an earlier decode
   * left past this point are still there, waiting to be claimed or cut. It
   * therefore starts at `out.length`, not at zero: a collector that was *not*
   * armed treats a destination that already holds slots as its own, which is what
   * it did before reuse mode existed and what a re-opened wrapper sequence needs
   * (§7.4).
   */
  private len: number;

  /**
   * How many leading slots arrived already filled, by an **earlier** decode into
   * the same destination: `0` unless {@link reuse} armed this collector, which is
   * what makes every branch below inert in the fresh case.
   */
  private prev = 0;

  constructor(
    readonly out: T[],
    readonly def: T,
    readonly cap: number,
    readonly name: string,
    readonly receiverCap: number,
  ) {
    // §6.2.1: where the schema stated a bound, the receiver cap beside it is inert
    // — so an unbounded array is the only one that HAS a receiver cap to validate.
    if (cap < 0) requireReceiverBound(cap, receiverCap, "the receiver array-index cap", name);
    this.bound = indexBound(cap, receiverCap);
    this.len = out.length;
  }

  /**
   * Arm **reuse mode**: the slots `out` already holds are this decode's to claim
   * in place, and {@link end} will cut the array back to the length this decode
   * gives it.
   *
   * For a destination that already holds an earlier decode (ARCHITECTURE §8) — a
   * receive loop decoding message after message into one object. The only state it
   * takes is how many slots were already there, so it belongs before the first
   * element, which is where generated code builds its collectors anyway. Nothing
   * else about the collector changes: the same bounds, the same verdicts, the same
   * `out`.
   *
   * **Once per destination, not once per opening.** A wrapper sequence may be
   * opened twice in one message, and the second opening continues the array the
   * first one built (§7.4) — so {@link end} is the per-opening hook and this is
   * not: arming again at the second opening would file the first opening's own
   * elements as an earlier decode's, and `end()` would then cut them off. One
   * collector, armed once, for the whole decode.
   *
   * A gap is still the element default, so a slot an earlier decode filled and
   * this one does not mention is **overwritten** with `def`, never kept: the value
   * of an absent element is its default, whatever the destination happened to hold.
   *
   * @returns this collector, so it can be armed where it is built.
   */
  reuse(): this {
    this.prev = this.out.length;
    this.len = 0;
    return this;
  }

  /**
   * The array has ended: cut `out` to the length *this* decode gave it.
   *
   * A wrapper array's length is its highest present id + 1 (§5.1), and in reuse
   * mode that can be **shorter** than what the destination already held — so
   * without this cut the previous message's tail would read as elements of this
   * one. It is the same cut the decoder itself makes for a plain bulk destination
   * at `arrayEnd`, for the same reason.
   *
   * A no-op on a fresh collector, whose array is that length already, so generated
   * code can call it unconditionally at the wrapper sequence's end. Afterwards the
   * array and this collector agree again: a further element appends, and a second
   * `end()` changes nothing.
   */
  end(): void {
    if (this.out.length > this.len) this.out.length = this.len;
    this.prev = 0;
  }

  /**
   * What an **earlier** decode left at `out[id]`, or `null` if there is nothing
   * there this decode may take over — the slot is already this decode's own, or
   * past the end of the array, or this collector is not in reuse mode at all.
   *
   * The hook for reusing an **element's** storage, one level below the slot's: a
   * `Uint8Array` that is the right size for the payload now arriving
   * ({@link PayloadAcc.takeInto}, which is what {@link BlobSeq} does with this), a
   * typed matrix row that still holds the right element count, a nested row's
   * array. Whether the old storage fits is the caller's test, since what "fits"
   * means belongs to the type; this hands over the candidate and nothing else.
   *
   * It reports a slot **before** it is claimed, and claiming it is what replaces
   * the contents — so the value is taken from here first and placed afterwards.
   */
  staleAt(id: number): T | null {
    return id >= this.len && id < this.prev ? this.out[id]! : null;
  }

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
    if (id >= this.bound) rejectIndex(id, this.cap, this.receiverCap, this.name);
    const out = this.out;
    const stale = this.prev;
    let i = this.len;
    // Reuse mode's half: a slot an earlier decode filled is already there, so it
    // is written rather than pushed. `stale` is `0` on a fresh collector, which is
    // what keeps this loop to one comparison for every other caller.
    while (i < stale && i <= id) out[i++] = this.def;
    // Grow to at least id + 1 (ARCHITECTURE §9.5 shape B): `push` leaves the
    // geometry to the engine's own amortised doubling, so a sparse array does not
    // cost O(n²) copies.
    while (i <= id) {
      out.push(this.def);
      i++;
    }
    this.len = i;
  }

  /**
   * The two index bounds, without growing: the schema `count` as validity
   * (`INVALID`) or, where the schema left the array open, the receiver cap as
   * capacity (`LIMIT_EXCEEDED`). Never both — §6.2.1 keeps a cap off a field the
   * schema already bounds, which is why one `bound` can stand for both.
   *
   * Split out from {@link reserve} because a leaf element is bound-checked at its
   * length word, before its payload has arrived and so before there is anything to
   * place ({@link StringSeq.begin}).
   */
  checkIndex(id: number): void {
    if (id >= this.bound) rejectIndex(id, this.cap, this.receiverCap, this.name);
  }

  /**
   * What {@link reserve} does, then `value` written into the slot. A repeat
   * replaces (§7.4).
   *
   * Written out rather than delegating to {@link reserve}: on the baseline tier a
   * call is not free, and this is the per-element path. The check still precedes
   * the growth, which is the property §7.2 item 8 asks for.
   */
  place(id: number, value: T): void {
    if (id >= this.bound) rejectIndex(id, this.cap, this.receiverCap, this.name);
    const out = this.out;
    const stale = this.prev;
    let i = this.len;
    while (i < stale && i <= id) out[i++] = this.def;
    while (i <= id) {
      out.push(this.def);
      i++;
    }
    this.len = i;
    out[id] = value;
  }
}

/**
 * The slots of a wrapper-sequence array whose element default is a **fresh
 * object**: a framed element (`struct` / `union`) or a nested row.
 *
 * {@link ElementSeq}'s twin, and it differs in exactly one thing — the gap value
 * comes from a **factory** instead of being shared. That single axis is why it is
 * a second class rather than a second argument: a framed element's default is
 * `new Elem()` and a row's is `[]`, both mutable and both reachable by the
 * caller, so one shared instance would alias every gap of the array onto it and —
 * since an arriving element decodes into the slot the reservation placed — would
 * alias every *element* onto it too, which is not a near miss but a flatly wrong
 * decode. {@link ElementSeq}'s `""` and zero-length `Uint8Array` have no state to
 * share, which is what makes sharing right there and wrong here.
 *
 * Everything else is {@link ElementSeq}, deliberately: the same argument order
 * with `make` in `def`'s slot, the same two exclusive index bounds through the
 * same `indexBound` / `rejectIndex` pair, the same growth geometry, the same
 * construction-time refusal of a receiver cap that states no cap.
 *
 * Generated code calls {@link reserve} at the element's own `sequenceBegin` and
 * then keeps routing the child's fields into `out[id]` itself. This class owns
 * the bound and the growth; it never owns the routing, which is the part that has
 * a different shape for every schema (ARCHITECTURE §8).
 *
 * @param out The destination array; grown to `id + 1` as elements arrive.
 * @param make Builds one element default. Called once per gap slot, and once for
 * the reserved slot itself in {@link reserve} — never for a slot already present,
 * so a re-opened element keeps the object earlier fields decoded into.
 * @param cap The schema `count` as an index capacity: `id >= cap` is `INVALID`
 * (§7.1) — a statement about validity. Pass {@link UNBOUNDED} (`-1`) for an array
 * the schema left open, where `receiverCap` governs instead.
 * @param name The schema field name, used only in a rejection message.
 * @param receiverCap The receiver-side index cap for a schema-unbounded array
 * (§6.2.1): `id >= receiverCap` is `LIMIT_EXCEEDED`, a policy rejection, never
 * `INVALID`, and never applied beside a `cap` the schema stated. **Required, with
 * no default**; a value that states no cap at all is `Argument` at construction
 * ({@link requireReceiverBound}).
 */
export class FramedSeq<T> {
  /** The one index bound in force, picked once by `indexBound` — see {@link ElementSeq}. */
  private readonly bound: number;

  /** The length this decode has claimed, as in {@link ElementSeq} — `out.length` until armed. */
  private len: number;

  /** The slots an earlier decode left behind, as in {@link ElementSeq}. */
  private prev = 0;

  /**
   * How a slot an earlier decode built is brought back to the element default,
   * set by {@link reuse}: `make`'s counterpart for storage that already exists,
   * returning the value the slot should hold. `null` on a fresh collector, which
   * never reaches it.
   */
  private resetSlot: ((slot: T) => T) | null = null;

  constructor(
    readonly out: T[],
    readonly make: () => T,
    readonly cap: number,
    readonly name: string,
    readonly receiverCap: number,
  ) {
    if (cap < 0) requireReceiverBound(cap, receiverCap, "the receiver array-index cap", name);
    this.bound = indexBound(cap, receiverCap);
    this.len = out.length;
  }

  /**
   * Arm **reuse mode** — {@link ElementSeq.reuse}, including its once-per-destination
   * rule, plus the one thing a framed element needs that a shared `def` does not:
   * how a slot that already holds an object gets back to the element default.
   *
   * `reset` is `make`'s counterpart for storage that already exists. Handed the
   * object the last decode left in a slot, it returns **the value that slot should
   * now hold**, which must be what `make()` would have built — because that value
   * becomes either a gap, whose value is the element default, or the destination an
   * arriving element decodes into, which starts from the default and merges.
   *
   * Returning the object it was handed is the point of the mode and the common
   * case: a generated element's own field-clearing step, `(e) => { e.clear();
   * return e; }`, or a nested row's `(row) => { row.length = 0; return row; }`.
   * It **returns** a value rather than mutating in place because not every element
   * type can be emptied in place — a `Float32Array` row's length is read-only, so
   * its only honest reset is `() => new Float32Array(0)`, and a `reset` that could
   * not say so would leave the previous message's row standing in a gap, which is
   * exactly what §5.1 says a gap is not. (For that shape {@link ElementSeq} with
   * one shared zero-length default is the lighter answer: an empty typed array has
   * no state to share. {@link FramedSeq} is for the elements that do.)
   *
   * It runs once per slot per decode, on the slots an earlier decode filled, and
   * never on a slot this decode has already claimed — a re-opened element keeps
   * what its first opening decoded (§7.4) — and never on a slot {@link place} is
   * about to overwrite.
   *
   * A `reset` that is not a function is refused here, with `Argument`, rather than
   * from inside the first element's `reserve`: §6.3's third row, and the same
   * reasoning as {@link requireReceiverBound}'s — a caller mistake is reported
   * before anything is decoded, not half way through a destination.
   *
   * @returns this collector, so it can be armed where it is built.
   */
  reuse(reset: (slot: T) => T): this {
    if (typeof reset !== "function") {
      throw argumentError(
        `${this.name}: reuse() needs a reset function that returns the slot's ` +
          `value, got ${typeof reset}`,
      );
    }
    this.prev = this.out.length;
    this.len = 0;
    this.resetSlot = reset;
    return this;
  }

  /** The array has ended: cut `out` to this decode's length — {@link ElementSeq.end}. */
  end(): void {
    if (this.out.length > this.len) this.out.length = this.len;
    this.prev = 0;
  }

  /**
   * The object an **earlier** decode left at `out[id]`, or `null` — see
   * {@link ElementSeq.staleAt}.
   *
   * {@link reuse}'s `reset` is what a slot's **own** value goes through, gap or
   * not. This is for the slot whose element is *replaced* rather than decoded into
   * — a row, which {@link place} assigns: the generated code builds the row's
   * storage itself, so it asks here for the array the last decode left and keeps it
   * when it is still the right length (a typed matrix row with the same element
   * count), or allocates when it is not. A slot `place` overwrites is never passed
   * to `reset`, so this is the only way to see what was there.
   */
  staleAt(id: number): T | null {
    return id >= this.len && id < this.prev ? this.out[id]! : null;
  }

  /**
   * The two index bounds, without growing — see {@link ElementSeq.checkIndex}.
   *
   * Split out for the same reason it is there: a caller may have a second bound
   * to take before anything is allocated. A native matrix row is that case in this
   * port — its element `count` is rejected at the array header, and §7.2 item 8
   * wants that rejection to leave the row container exactly as it was.
   */
  checkIndex(id: number): void {
    if (id >= this.bound) rejectIndex(id, this.cap, this.receiverCap, this.name);
  }

  /**
   * Bound-check `id`, **then** grow `out` to `id + 1`, each new slot its own
   * `make()`.
   *
   * The order is §7.2 item 8's "after a rejected id the container is not left
   * partially extended": a rejection leaves `out` exactly as it was, so a lower id
   * delivered afterwards still lands at its own index. A slot already present is
   * left alone — a re-opened `struct` / `union` element merges into the object it
   * already built, which is what §7.4's last-occurrence-wins means for a scope
   * whose value *is* the scope.
   */
  reserve(id: number): void {
    if (id >= this.bound) rejectIndex(id, this.cap, this.receiverCap, this.name);
    const out = this.out;
    const stale = this.prev;
    let i = this.len;
    // Reuse mode's half: the object an earlier decode built here is reset and kept,
    // which is the allocation this mode exists to avoid. `stale` is `0` on a fresh
    // collector, so this costs one comparison there.
    while (i < stale && i <= id) {
      out[i] = this.resetSlot!(out[i]!);
      i++;
    }
    // Grow to at least id + 1 (ARCHITECTURE §9.5 shape B): `push` leaves the
    // geometry to the engine's own amortised doubling, so a sparse array does not
    // cost O(n²) copies.
    while (i <= id) {
      out.push(this.make());
      i++;
    }
    this.len = i;
  }

  /**
   * Bound-check `id`, fill the gap below it, then write `value` into the slot —
   * what a nested **row** needs, an array wrapper *replacing* whatever an earlier
   * opening built at that index (§7.4) rather than merging into it.
   *
   * The gap fill stops one short of `id` on purpose: the slot is about to be
   * overwritten, so calling `make()` for it would allocate an element default
   * nobody ever reads. Assigning at `out.length` extends the array by exactly one,
   * which is the same array a {@link reserve} would have left.
   */
  place(id: number, value: T): void {
    if (id >= this.bound) rejectIndex(id, this.cap, this.receiverCap, this.name);
    const out = this.out;
    const stale = this.prev;
    let i = this.len;
    while (i < stale && i < id) {
      out[i] = this.resetSlot!(out[i]!);
      i++;
    }
    while (i < id) {
      out.push(this.make());
      i++;
    }
    out[id] = value;
    if (id >= this.len) this.len = id + 1;
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
 * it is `INVALID` (§7.1/§5.1) — a statement about validity. Pass
 * {@link UNBOUNDED} (`-1`) for an array the schema left unbounded, where
 * `receiverCap` governs instead.
 * @param elemMax The element `maxlen` in bytes, or {@link UNBOUNDED} (`-1`) for an
 * element the schema left open, where `receiverElemMax` governs instead.
 * @param name The schema field name, used only in the rejection message.
 * @param receiverCap The receiver-side index cap that applies **only** when the
 * schema left the array unbounded (§6.2.1): exceeding it is `LIMIT_EXCEEDED`, a
 * policy rejection, not `INVALID`. There is no unlimited setting — a wrapper array
 * announces no count, so the index is the only place a receiver can bound it.
 * **Required, with no default** (§6.2.1).
 * @param receiverElemMax The receiver-side `max_dyn_string_len` for an element the
 * schema left unbounded (§6.2.1), checked at the length word and answered with
 * `LIMIT_EXCEEDED`. A wrapper array's `string` elements never reach the generated
 * visitor — their length words come here — so this is where that cap belongs, and
 * it is why the decoder needs no module-wide limit object at all. **Required, with
 * no default**: `FIXLEN_MAX` is the format's bound, not a receiver cap, and §6.2.1
 * forbids presenting it as one.
 */
export class StringSeq {
  /** The index rules and both index bounds, shared with every other element kind. */
  private readonly slots: ElementSeq<string>;

  constructor(
    readonly out: string[],
    readonly acc: PayloadAcc,
    readonly cap: number,
    readonly elemMax: number,
    readonly name: string,
    readonly receiverCap: number,
    readonly receiverElemMax: number,
  ) {
    // The index bound is validated by `ElementSeq`; this is the length bound's half.
    requireReceiverBound(elemMax, receiverElemMax, "the receiver element-length cap", name);
    this.slots = new ElementSeq(out, "", cap, name, receiverCap);
  }

  /**
   * Arm **reuse mode** — see {@link ElementSeq.reuse}. A `string` is immutable, so
   * an element has no storage of its own to take over and this is the slots' half
   * alone: a gap written back to `""`, and {@link end}'s cut.
   *
   * @returns this collector, so it can be armed where it is built.
   */
  reuse(): this {
    this.slots.reuse();
    return this;
  }

  /** The array has ended: cut `out` to this decode's length — {@link ElementSeq.end}. */
  end(): void {
    this.slots.end();
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
 * it allocated and handed over, or in reuse mode one the destination already held,
 * never a view into the fed chunk (§6.7) — so a stored element cannot rot when the
 * caller reuses its input.
 *
 * @param out The destination, placed at `out[id]`.
 * @param acc The decoder's shared {@link PayloadAcc}.
 * @param cap The schema `count` as an index capacity, or {@link UNBOUNDED} (`-1`)
 * for unbounded.
 * @param elemMax The element `maxlen` in bytes, or {@link UNBOUNDED} (`-1`) for an
 * element the schema left open, where `receiverElemMax` governs instead.
 * @param name The schema field name, used only in the rejection message.
 * @param receiverCap The receiver-side index cap for a schema-unbounded array
 * (§6.2.1) — see {@link StringSeq}. Required, with no default.
 * @param receiverElemMax The receiver-side `max_dyn_blob_len` for a schema-unbounded
 * element (§6.2.1) — see {@link StringSeq}. Required, with no default.
 */
export class BlobSeq {
  /** The index rules and both index bounds, shared with every other element kind. */
  private readonly slots: ElementSeq<Uint8Array>;

  /**
   * Whether {@link reuse} armed this collector — the one thing {@link element}
   * has to know, since a fresh decode must not pay for the lookup that finds the
   * previous decode's buffer.
   */
  private reusing = false;

  constructor(
    readonly out: Uint8Array[],
    readonly acc: PayloadAcc,
    readonly cap: number,
    readonly elemMax: number,
    readonly name: string,
    readonly receiverCap: number,
    readonly receiverElemMax: number,
  ) {
    // The index bound is validated by `ElementSeq`; this is the length bound's half.
    requireReceiverBound(elemMax, receiverElemMax, "the receiver element-length cap", name);
    this.slots = new ElementSeq(out, NO_BYTES, cap, name, receiverCap);
  }

  /**
   * Arm **reuse mode** — see {@link ElementSeq.reuse}, and here it reaches the
   * element's own storage too: where the previous decode left a `Uint8Array` at
   * this index and the payload now arriving is exactly its length, the payload is
   * written into that buffer ({@link PayloadAcc.takeInto}) instead of into a new
   * one. A length that does not match allocates, as always — the buffer's length
   * *is* the element's length, so there is nothing to trim it with.
   *
   * The buffer the previous decode handed out is therefore **overwritten**: a
   * caller that kept a reference to an element of an earlier message sees it
   * change. That is what decoding into a reused destination means, one level down.
   *
   * And it is overwritten **as the pieces arrive**, which is what buys the chunked
   * path. So a decode abandoned part-way through an element's payload — a chunk
   * boundary that never gets its continuation, an `INVALID` later in the message —
   * leaves that one element holding a *mix* of the new payload's leading bytes and
   * the old one's tail: not the value that was there, and not a value that was ever
   * on the wire. Every other element of the retained message is untouched, and the
   * ones this decode completed are complete. A caller that falls back to the last
   * good message on a refusal cannot rely on the element a refused decode had
   * already started; nothing short of buffering the payload elsewhere would change
   * that, and buffering it is the allocation this mode exists to remove.
   *
   * @returns this collector, so it can be armed where it is built.
   */
  reuse(): this {
    this.slots.reuse();
    this.reusing = true;
    return this;
  }

  /**
   * The array has ended: cut `out` to this decode's length — {@link ElementSeq.end}
   * — and disarm, so an element after it costs nothing for a window that is gone.
   */
  end(): void {
    this.slots.end();
    this.reusing = false;
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
    const payload = this.reusing
      ? this.takeReusing(id, total, offset, src, start, end)
      : this.acc.take(total, offset, src, start, end);
    if (payload === null) return;
    this.slots.place(id, payload);
  }

  /**
   * The reuse arm of {@link element}, one level below the slot: the buffer the
   * previous decode left at this index is this payload's destination when it is
   * exactly the right size, so a steady-state receive loop allocates no payload
   * storage at all.
   *
   * A method of its own rather than a branch spliced into `element`, because
   * `element` is the per-piece path and its *size* is a budget there —
   * `DecoderState.fpDrain`'s lever. It does not buy the field test above back
   * (measured: the two shapes read the same), it keeps the body that every caller
   * runs from growing by the body only reuse callers run.
   *
   * The slot is read **before** it is claimed — `place` overwrites it — and the
   * same buffer is found again for every piece of a split payload, because nothing
   * claims the slot until the last piece completes.
   */
  private takeReusing(
    id: number,
    total: number,
    offset: number,
    src: Uint8Array,
    start: number,
    end: number,
  ): Uint8Array | null {
    return this.acc.takeReusing(this.slots.staleAt(id), total, offset, src, start, end);
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
