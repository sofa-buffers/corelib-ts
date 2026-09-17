/**
 * The SofaBuffers decoder: `IStream`, and the visitor it drives.
 *
 * The **visitor is the only decode surface** (CORELIB_PLAN §5.3.1). There is no
 * pull parser, no iterator, no cursor and no convenience wrapper that decodes by
 * another route: a second surface is a second implementation of every rule in the
 * spec, and the divergences that produces are invisible to the shared vectors,
 * which exercise whichever surface the driver happened to pick.
 *
 * `IStream` is a push parser: bind a {@link Visitor} at construction, feed bytes
 * with {@link IStream.feed}, and it calls one method per decoded field. It is a
 * resumable state machine, so the chunks can be any size — a whole message, a
 * network packet, or a single byte — and a field that straddles a chunk boundary
 * is picked up seamlessly on the next call.
 *
 * The visitor is **flat**: one object receives the whole message, and nesting is
 * reported as {@link Visitor.sequenceBegin} / {@link Visitor.sequenceEnd} events
 * carrying the sequence's id and depth. A visitor per nested scope would make
 * every dispatch site here megamorphic — one hidden class per generated message
 * class in the tree — and would put a per-scope object on the decode path; one
 * flat visitor keeps the call sites (bi)morphic and the decoder allocation-free
 * (§6.6). Descending and skipping are unchanged by that choice: `sequenceBegin`
 * answers `false` to decline a subtree whole, and a field whose callback the
 * visitor does not implement is skipped.
 *
 * There is no finish / finalize step (§5.2.4) and no status accessor beside the
 * call: {@link IStream.feed} *returns* the outcome for the bytes consumed so far,
 * and that return value is the whole answer. A message that merely ends inside a
 * field is reported — never thrown — as {@link DecodeStatus.Incomplete}; only a
 * *malformed* message throws ({@link SofabErrorCode.InvalidMsg}), which is this
 * port's channel for {@link DecodeStatus.Invalid}. The caller owns end-of-input
 * and decides whether a trailing `Incomplete` is a truncation error.
 *
 * **One fact, one channel.** Each outcome leaves by exactly one route — two of
 * the three by the return value, the refusals by the throw — because a second way
 * to ask the same question is a second thing to keep in step, and this family
 * shipped the drift: a `status()` accessor answered `COMPLETE` for a message
 * `feed` had already refused. §5.3.1 makes the general form of the argument for
 * decode surfaces ("every additional surface is a second implementation of every
 * rule in this document"); the accessor was the same mistake one size down.
 */

import { DecodeStatus } from "../constants.js";
import type { ArrayKind, FeedStatus, FixlenSubtype, WireType } from "../constants.js";
import { incompleteError } from "../errors.js";
import type { Long } from "../long.js";
import { DecoderState } from "./state.js";

/**
 * Where an array's elements are written when the visitor takes the **bulk
 * hand-off** ({@link Visitor.arrayBulk}): the destination it already owns, handed
 * over once, instead of one callback per element.
 *
 * **Why this replaced the per-element callbacks.** There used to be an
 * `arrayUnsigned` / `arraySigned` / `arrayFp32` / `arrayFp64` beside this, one call
 * per element. Measured with `bench/run_callgrind.sh`'s method over 1000-element
 * arrays (Ir/op for a message that is one array), against this hand-off filling
 * the same destination:
 *
 * | array | per element (removed) | hand-off | |
 * |---|---:|---:|---:|
 * | `array<u16>` into a `number[]` | 235 433 | 184 025 | −21.8% |
 * | `array<u64>` into a `Long[]` | 576 206 | 429 113 | −25.5% |
 * | `array<u64>` into {@link IntegerArrayTarget.lo}/`hi` | 498 618 | 299 180 | −40.0% |
 * | `array<fp64>` into a `Float64Array` | 93 520 | 36 890 | −60.6% |
 * | `array<fp32>` into a `Float32Array` | 94 497 | 35 259 | −62.7% |
 *
 * Floats gain most because their *reading* was already bulk (the §6.6.2 handle in
 * the element drain), so the callback was very nearly all that was left.
 *
 * **A short array is not the exception.** The fixed cost — the offer, the
 * target's resolution, the bound's validation — is about 600 Ir, but the hand-off
 * takes a whole array in one call, tail elements included, so it is paid once:
 * four elements at the end of a 37-byte message cost 578 Ir against the 563 the
 * removed callbacks cost, and everything longer is the table above.
 *
 * **What did move is the consumer's side, for a consumer that folds.** An element
 * callback let a reader sum, hash or convert *inside* the delivery; reading a
 * filled destination is a second pass. A reader that wants the values where they
 * are — which is what generated code wants — has no second pass and gets the
 * table. A reader that folds pays one: the same four-element array costs 1 063 Ir
 * if it sums the destination at `arrayEnd`, against 563 folding per element.
 * It is a cheaper pass than the calls it replaced on any array long enough to
 * matter, and on a four-element one it is not.
 *
 * **Declining costs nothing at all.** An array no visitor takes is walked over
 * rather than decoded: `array<fp64>` 36 890 → 9 383 Ir/op, `array<u16>` 184 025 →
 * 152 082.
 *
 * **This is how array elements are delivered — the only way.** There is no
 * callback per element beside it: §5.3.1 allows a rule one implementation, and
 * two delivery routes for the same elements were two places for the element bound
 * to be compared, two resume paths to keep in step, and a standing invitation for
 * generated code to take the slower one. `arrayBegin` and `arrayEnd` still fire
 * for every array; returning `null` declines delivery, and the elements are then
 * walked over without being decoded into existence — the `skip` half of §6.7.2's
 * two intents, which is what a visitor that declares no `arrayBulk` gets for
 * every array.
 *
 * **The destination is filled ascending from index 0**, one write per element,
 * and it must stay valid — same object, same length — until `arrayEnd`, which for
 * a chunked decode is several {@link IStream.feed} calls later. A plain-array
 * destination (`values` / `longs`) is **cut to the elements written when the array
 * ends** — including to zero for an array that is empty on the wire, and to the
 * prefix when an element is refused — so reusing one across arrays or messages can
 * never leave the previous array's tail behind, and after `arrayEnd` its `length`
 * is exactly this array's element count. (Cutting at the end rather than emptying
 * up front is measured: emptying first makes every element write a grow, which
 * cost `array<u16>` 181 583 → 231 815 Ir/op.) A typed destination is neither cut
 * nor emptied — it cannot be — and must already hold `count` elements.
 *
 * A decode that fails *inside* an array for any other reason — malformed bytes, or
 * input that simply ends — leaves the destination holding what had been written
 * when it stopped. `length` is a statement about the array only once `arrayEnd`
 * has been raised or an element has been refused. This is the one
 * place the codec holds a reference to the caller's storage between calls (§6.6
 * otherwise holds nothing past a callback), and the reference is dropped at
 * `arrayEnd` and whenever a pooled machine is released.
 *
 * **A refused element leaves the destination holding the prefix**: everything
 * before it is written, the offending element and everything after it is not, and
 * a plain-array destination is cut to exactly that length. Like every `INVALID`
 * verdict it is terminal (§5.2.1).
 */
export type ArrayTarget = IntegerArrayTarget | FloatArrayTarget | BoolArrayTarget;

/**
 * A `boolean` array's destination: one byte per element, `0` or `1`.
 *
 * It carries **no bound**, and that is the whole reason it is a shape of its own
 * rather than a {@link IntegerArrayTarget.typed} `Uint8Array`. §4.4 gives a boolean
 * no width bound — every non-zero wire value is `true` — so there is no interval to
 * state and nothing for the width check to compare. A raw store would be wrong
 * twice over: 256 would mask to `0` and turn `true` into `false`. The decoder
 * NORMALIZES instead, writing `1` for any non-zero, which is also the only value
 * §4.4 lets an encoder emit back — so a filled destination re-encodes canonically
 * with no conversion step in between.
 */
export interface BoolArrayTarget {
  bool: Uint8Array;
}

/**
 * An integer array's destination and the **element bound** to enforce while
 * filling it — for an `ArrayKind.Unsigned` or `ArrayKind.Signed` array.
 *
 * Exactly one destination must be set (`values`, `longs`, or `lo` *and* `hi`);
 * any other combination is a caller mistake and is refused with
 * {@link SofabErrorCode.Argument} before a single element is written.
 *
 * **The bound is four halves, and it is never optional.** The interval is the
 * schema's — `0..65535` for a `u16`, `-2^63..2^63-1` for an `i64` — so its
 * violation is `INVALID`, a statement about the message (§6.2.1 keeps a
 * *receiver* cap off a field the schema already bounds; a receiver cap on the
 * element *count* is compared by the visitor in `arrayBegin`, as before, and this
 * hand-off happens after it).
 *
 * Halves rather than a `number` pair because a `number` cannot express the
 * 64-bit domain: `u64`'s bound is `2^64-1` and `Number.MAX_SAFE_INTEGER` is
 * `2^53-1`, so a `number` bound both *rejects valid messages* at the top of the
 * range and makes the comparison a mixed `bigint`/`number` one, which measured
 * +35% on `array<u64>` — worse than the per-element path it replaces. Two
 * unsigned 32-bit comparisons are exact and cost nothing.
 *
 * For a **signed** array the halves are the two's-complement ones (an `i16`
 * minimum of `-32768` is `minLo = 0xffff8000`, `minHi = 0xffffffff`).
 * {@link Long.fromBigInt} is the ready-made way to compute them from the schema's
 * bound once.
 *
 * The codec **compares** the bound; it never owns one (§6.2.1). There is no
 * default and no "unbounded" spelling, because an integer element always has a
 * declared width: the widest `u64` interval is `0 .. 0xffffffff_ffffffff` and is
 * stated as such.
 */
export interface IntegerArrayTarget {
  /**
   * Number-first destination: each element as the `value` its per-element
   * callback would have received — a `number` when it fits exactly (`≤ 2^53-1`,
   * every `u8`..`u32` and small 64-bit values) and a `bigint` beyond that. The
   * right destination for `u8`..`u32` / `i8`..`i32` arrays, where no `bigint` is
   * ever built.
   *
   * A real `Array` — grown as it fills and cut to length when the array ends, so
   * it need not be pre-sized and never carries a previous array's tail. A typed
   * array here is refused with {@link SofabErrorCode.Argument}: it would take the
   * writes and silently drop everything past its own length.
   */
  values?: (number | bigint)[];
  /**
   * Destination taking each element as a {@link Long} — no `bigint` is
   * materialised at all, which is most of why this is a quarter cheaper than the
   * per-element path for a 64-bit array (see {@link ArrayTarget}). A real
   * `Array`, cut to length at the array's end, exactly like {@link values}.
   */
  longs?: Long[];
  /**
   * Allocation-free destination: the element's low half at `lo[index]` and its
   * high half at `hi[index]` (for a signed array, the two's-complement halves).
   * Both must be set and both must hold at least `count` elements. The fastest
   * shape there is — nothing is allocated per element, not even a `Long`.
   */
  /**
   * Exact-width destination: one typed array whose element width IS the schema's
   * declared width — a `Uint16Array` for a `u16` array, an `Int8Array` for an
   * `i8` one. Must hold at least `count` elements.
   *
   * **The bound is still compared, and that is not negotiable.** A typed array
   * *masks* on store (`a[0] = 70000` in a `Uint16Array` is 4464), and
   * MESSAGE_SPEC §7.1 makes an element outside the declared width INVALID —
   * neither masked to the width nor kept. So this destination buys the storage,
   * never the verdict: the fill loop compares exactly as {@link values} does and
   * refuses the same elements.
   *
   * What it does buy is the store (unboxed, and no element-kind transition the
   * way a `number[]` takes when a value leaves the small-integer range), the
   * memory (2 bytes for a `u16`, against a tagged slot), and the *encoder's*
   * side, where the width is then statically known.
   *
   * The bound must fit the array's own width: a destination narrower than the
   * interval could not represent every legal element, and is refused with
   * {@link SofabErrorCode.Argument} rather than silently masking.
   */
  typed?:
    | Uint8Array
    | Uint16Array
    | Uint32Array
    | Int8Array
    | Int16Array
    | Int32Array
    | BigUint64Array
    | BigInt64Array;
  lo?: Uint32Array;
  /** The high halves; see {@link lo}. */
  hi?: Uint32Array;
  /** Low half of the smallest element the schema allows. */
  minLo: number;
  /** High half of the smallest element the schema allows. */
  minHi: number;
  /** Low half of the largest element the schema allows. */
  maxLo: number;
  /** High half of the largest element the schema allows. */
  maxHi: number;
}

/**
 * A float array's destination — for an `ArrayKind.Fp32` or `ArrayKind.Fp64`
 * array. Exactly one of the two must be set, it must match the element width the
 * array's own `fixlen_word` declared (§4.8), and it must hold at least `count`
 * elements; anything else is refused with {@link SofabErrorCode.Argument} before
 * a single element is written.
 *
 * There is no bound here: §4.6 gives a float no schema interval to violate, so
 * there is nothing to compare and nothing for the caller to state.
 *
 * An `fp32` array chooses between the two: {@link f32} takes values, {@link bits}
 * takes the wire words. The choice is real, not stylistic — reading an `fp32`
 * through a double quiets a *signaling* NaN (`0x7fa00001` comes back
 * `0x7fe00001`), so a reader that must reproduce `fp32` payloads bit-for-bit
 * (§4.6/§6.5) takes {@link bits}. `fp64` needs no such choice: a `Float64Array`
 * carries all 64 bits, payload NaNs included.
 */
export interface FloatArrayTarget {
  /** Value destination for an `ArrayKind.Fp32` array. */
  f32?: Float32Array;
  /**
   * Bit destination for an `ArrayKind.Fp32` array: each element as its 4 wire
   * bytes in one little-endian 32-bit word — the same number `OStream.writeFp32Bits`
   * takes, so a payload read through this and written back reproduces the wire
   * exactly, signaling NaNs included.
   */
  bits?: Uint32Array;
  /** Destination for an `ArrayKind.Fp64` array. */
  f64?: Float64Array;
}

/**
 * Receives decoded fields from an {@link IStream} — the one decode surface
 * (§5.3.1). Every method is optional and defaults to a no-op, so a visitor
 * implements only the fields it cares about and silently skips the rest, which is
 * the `skip` half of the two per-field intents §6.7.2 allows (the other being
 * `read`: take the value, in the call).
 *
 * **One visitor per message, not per scope.** Nested sequences arrive as
 * {@link sequenceBegin} / {@link sequenceEnd} events on this same object, each
 * carrying the sequence's `id` and its `depth` (1 for a sequence opened at the
 * root). Generated code routes on those two numbers, which it knows statically
 * from the schema.
 *
 * **Nothing handed to a visitor outlives the call.** A `string` / `blob` payload
 * is reported in pieces as a range of the caller's *own* fed chunk (§6.6.3): the
 * decoder creates no view over it and holds no storage of its own (§6.6, §6.7),
 * so a consumer that wants the value copies it out — during the call — into
 * storage it owns. {@link PayloadAcc} and {@link decodeUtf8} are the ready-made
 * way to do that.
 */
export interface Visitor {
  /**
   * A field **header**: its `id` and `wire` type, announced the moment the header
   * varint is complete — before the value, and before the value's own header word
   * (a fixlen length word, an array count word, the fields of a nested sequence).
   *
   * An observation point for a reader that wants the field stream as it arrives —
   * which id, in which scope, in which order — without implementing the value
   * callbacks it would otherwise take to see the same thing.
   *
   * **A schema bound does not belong here.** The header settles `id` and `wire`,
   * and nothing else. An element id past the schema `count` (MESSAGE_SPEC
   * §7.1/§5.1) looks decidable from the id alone, and it is not: §7.3 applies that
   * bound only to a field whose *subtype* has confirmed it is the declared one,
   * and a contradicting subtype is skipped rather than rejected. The subtype
   * arrives in the fixlen word, so the verdict is due at {@link fixlenBegin}.
   * CORELIB_PLAN §4.1.1 makes the timing normative: a message ending inside that
   * word is `INCOMPLETE` even when the id would violate a schema bound, because
   * the low 3 bits of an unfinished varint must not influence an outcome even
   * though they are already arithmetically fixed.
   *
   * Called exactly once per field, in every scope, for every wire type — the
   * sequence *end* marker excepted: it closes a scope rather than opening a field
   * and its id is discarded (§4.9). For a nested sequence it fires before
   * {@link sequenceBegin}.
   *
   * Throwing from it rejects the field — for a verdict the header really does
   * settle on its own, such as an id this reader will not accept in any shape.
   */
  fieldBegin?(id: number, wire: WireType): void;
  /**
   * An unsigned integer field.
   *
   * `value` is number-first: a `number` when the value fits exactly
   * (`≤ 2^53-1`, covering ids, u8..u32 and small u64s) and a `bigint` only beyond
   * that. `lo` / `hi` are the exact 64 bits as two unsigned 32-bit halves — the
   * ones the varint reader already holds — for a consumer that wants the value
   * bit-exactly without going through `bigint` arithmetic ({@link Long.fromBits}
   * builds a `Long` from them). Both describe the same value; use whichever fits.
   */
  unsigned?(id: number, value: number | bigint, lo: number, hi: number): void;
  /**
   * A signed integer field. `value` is number-first like {@link unsigned}
   * (`|value| ≤ 2^53-1` ⇒ `number`); `lo` / `hi` are the **decoded**
   * (zig-zag-undone) two's-complement halves.
   */
  signed?(id: number, value: number | bigint, lo: number, hi: number): void;
  /**
   * An IEEE-754 32-bit float field.
   *
   * `value` is a JS `number` — a 64-bit double — and widening a *signaling* NaN
   * into a double quiets it (sets the is-quiet bit), so `value` cannot represent
   * an fp32 sNaN faithfully. `bits` is the exact 4 wire bytes as one little-endian
   * 32-bit word, which can: re-encode from it with
   * {@link OStream.writeFp32Bits} and the payload round-trips bit-for-bit
   * (§4.6/§6.5). It is the "32-bit bits accessor" §6.5 names, and it is always
   * present — a number costs nothing to pass and needs no opt-in flag, where the
   * byte view it replaces was an allocation per value and a borrowed slice §6.7
   * forbids.
   */
  fp32?(id: number, value: number, bits: number): void;
  /** An IEEE-754 64-bit double field. `value` is exact — a double is 64 bits wide. */
  fp64?(id: number, value: number): void;
  /**
   * Start of a `string`/`blob` field: `total` payload bytes follow, in one or more
   * {@link string}/{@link blob} calls.
   *
   * The counterpart of {@link arrayBegin}, and it exists for the same reason: a
   * receiver-side bound on the *declared length* is decided by this word, not by
   * the payload. Without it a visitor could only see `total` once payload bytes
   * arrive, so a message that ends right after an over-bound length word would
   * escape the check and degrade to `INCOMPLETE`, where §5.2.3 requires `INVALID`.
   *
   * Called exactly once per field, before any payload call — including for a
   * zero-length payload, which is still announced here and then delivered as one
   * empty range.
   */
  fixlenBegin?(id: number, subtype: FixlenSubtype, total: number): void;
  /**
   * A piece of a UTF-8 string field: the bytes `src[start..end)`, at `offset` of
   * a `total`-byte payload.
   *
   * `src` is the **caller's own chunk** — the exact array passed to
   * {@link IStream.feed} (or to {@link decode}) — handed back with the piece's
   * coordinates (§6.6.3). The decoder builds no view over it, keeps no storage,
   * and hands out no borrowed slice of its own (§6.6, §6.7). Once `feed` returns,
   * the caller may reuse that memory, so a consumer that wants the value copies it
   * out **during the call**: {@link PayloadAcc} joins pieces into a buffer it
   * owns, and {@link decodeUtf8} turns a range straight into a string.
   *
   * The bytes are **not validated**. §6.4.5 puts the UTF-8 check where a string is
   * *materialized* — a piece may end mid-code-point, and a skipped field is never
   * validated at all — so on this surface the caller who materializes owns the
   * check. {@link decodeUtf8} is it, and a hand-rolled one must be built **fatal**
   * (`new TextDecoder("utf-8", { fatal: true })`): JavaScript's default
   * `TextDecoder` substitutes `U+FFFD`, which §6.4 forbids in either direction.
   */
  string?(
    id: number,
    total: number,
    offset: number,
    src: Uint8Array,
    start: number,
    end: number,
  ): void;
  /** A piece of a blob field — see {@link string} for the `src`/`start`/`end` contract. */
  blob?(
    id: number,
    total: number,
    offset: number,
    src: Uint8Array,
    start: number,
    end: number,
  ): void;
  /** Start of an array; `count` elements of `kind` follow. */
  arrayBegin?(id: number, kind: ArrayKind, count: number): void;
  /**
   * Offer of the **bulk hand-off**: return the destination this visitor has
   * already allocated for array `id` and the decoder fills it directly, one write
   * per element and no callback at all; return `null` (or leave this method
   * unimplemented) to be served element by element as before.
   *
   * Called once per array, after {@link arrayBegin} and before the first element —
   * so a receiver cap on `count` is still compared where it always was, in
   * `arrayBegin`, and a rejected array is never offered. **An array that is empty
   * on the wire is offered too**, with `count` of 0: there is nothing to write,
   * but a destination held across fields would otherwise still hold the previous
   * array's elements, and its length is the only place this array's emptiness
   * could show.
   *
   * `kind` is the element kind and it decides which destination is legal
   * ({@link IntegerArrayTarget} for `Unsigned` / `Signed`,
   * {@link FloatArrayTarget} for `Fp32` / `Fp64`); a destination that contradicts
   * it, or that is shorter than `count`, is a caller mistake and is refused with
   * {@link SofabErrorCode.Argument} before any element is written. Declining on
   * a kind this visitor did not expect is always available — and is the right
   * answer, since `null` costs nothing but the call.
   *
   * See {@link ArrayTarget} for what the decoder then guarantees: ascending
   * writes, the element bound enforced here and only here, the destination held
   * until `arrayEnd` across as many `feed` calls as the chunking takes, and a
   * partially filled destination if an element is refused.
   */
  arrayBulk?(id: number, kind: ArrayKind, count: number): ArrayTarget | null;
  /** End of an array. */
  arrayEnd?(id: number): void;
  /**
   * Start of a nested sequence — a fresh id scope (§4.9) — opened by field `id`
   * at `depth` (1 at the root).
   *
   * Return **`false`** to decline the whole subtree: no callback of any kind fires
   * inside it, nesting included, its own {@link sequenceEnd} included, and a scope
   * opened within it is never offered either. Return anything else (or nothing) to
   * descend, and the nested fields arrive on this same visitor with their own ids
   * and `depth + 1`.
   *
   * A declined subtree is still *parsed* — a sequence is framed by markers, not by
   * a length, so its end has to be found — but nothing in it is decoded into
   * existence: no piece is reported and no value is built. No receiver cap fires
   * inside one either (§6.2.1's "a skipped field is never capped"), and that falls
   * out of the structure rather than needing a rule: a cap is compared by the
   * handler this stream would have called, and a declined scope calls none. Format
   * ceilings (`ARRAY_MAX`, `FIXLEN_MAX`, `MAX_DEPTH`, the varint bound) still apply
   * everywhere: they bound what the wire may express.
   */
  sequenceBegin?(id: number, depth: number): boolean | void;
  /** End of the nested sequence opened by field `id` at `depth`. */
  sequenceEnd?(id: number, depth: number): void;
}

/**
 * Push parser for the SofaBuffers wire format, and the library's only decode
 * surface (§5.3.1).
 *
 * Bind a {@link Visitor} at construction, then feed bytes in chunks of any size
 * with {@link feed}: it calls one visitor method per decoded field and resumes
 * cleanly across chunk boundaries. Every `feed` returns the decode outcome for the
 * bytes so far, so no end / finalize call is needed — and there is nothing else to
 * ask: `feed` is the only way to learn where a stream stands, by what it returns
 * or by what it throws.
 *
 * **No receiver limit is configured here, because this codec holds none**
 * (§6.2.1). A `max_dyn_*` cap is the receiving *application's* number, stated by
 * generated code, which knows the schema and the target; it is compared inside the
 * visitor's own `arrayBegin` / `fixlenBegin` — raised by this stream at the count
 * or length header, before any payload is delivered and only for a field the
 * visitor reads — and, for a wrapper array's `string` / `blob` elements, inside
 * the `StringSeq` / `BlobSeq` collector those bounds were passed to.
 * This class used to take a `DecodeLimits` and default every absent cap to the
 * format ceiling, which §6.2.1 forbids twice over: a codec must not supply a
 * default for a limit it was not given, and a format ceiling reached because no
 * cap was stated is the format's bound and must not be presented as a receiver
 * cap.
 *
 * Constructing one is the only allocating step (§6.6): `feed` itself allocates
 * nothing at all. The one-shot {@link decode} is exactly this class fed once.
 */
export class IStream {
  private readonly state: DecoderState;

  /**
   * @param visitor The field handler this stream drives, for its whole life — and
   * the layer that holds the receiver caps, if any (§6.2.1; see the class doc).
   */
  constructor(visitor: Visitor) {
    this.state = new DecoderState(visitor);
  }

  /**
   * Feed a chunk of bytes, dispatching decoded fields to the bound visitor, and
   * **return** where the decode stands after them (§5.2.1):
   * {@link DecodeStatus.Complete} when they end exactly at a field boundary,
   * {@link DecodeStatus.Incomplete} when they end *inside* a field (a partial
   * varint, an unfinished payload / array, or a still-open nested sequence).
   * Running out of bytes mid-field is not an error — the decode merely suspends
   * until the next chunk, and the caller owns end-of-input.
   *
   * **This call is the only place the answer is.** There is no finish / finalize
   * step (§5.2.4) and no status accessor: what this returns, or throws, is the
   * whole of what the stream has to say, so a caller is never one question short
   * after it and never has two answers to reconcile. Feeding an empty chunk
   * re-reads the same value without consuming anything, for a caller that wants
   * the outcome again without holding on to it.
   *
   * The chunk is borrowed **only for the duration of this call** (§6.0): once it
   * returns, the caller may reuse, overwrite or free that memory, and the decoded
   * message is unaffected — the decoder retains nothing that points into it.
   *
   * `INVALID` travels on the error channel — this port's idiomatic surfacing of
   * it: *malformed* bytes throw {@link SofabError} (`INVALID_MSG`) instead of
   * returning a status, which is why the return type names only the other two.
   * That verdict is **terminal** (§5.2.1): the stream latches it, so a caller that
   * catches the throw and feeds on gets the same error again from every later
   * call — no further byte is consumed and no visitor method is invoked. A caller
   * that caught it already holds the verdict, in the code on the error it caught.
   *
   * A receiver-limit rejection (`LIMIT_EXCEEDED`, §6.2.1) travels the same
   * channel — thrown out of the visitor callback that compared the cap — but it
   * is **not** the `INVALID` outcome and never becomes one: the bytes are
   * well-formed and the same message decodes under a looser cap, so it is a
   * policy rejection (§6.2.1, §6.3). The two stay distinguishable by their code,
   * which is what §6.3 requires; §6.3 leaves the surfacing open between "a fourth
   * decode outcome" and "a terminal failure carrying the `LimitExceeded` code on
   * the error channel", and this port takes the second. **Terminal** is the other
   * half of that sentence and holds exactly as it does for `INVALID`: the stream
   * latches the rejection, so every later call re-throws it under the same code,
   * consumes no byte and drives no visitor method. It is *only* on the error
   * channel — the three-valued outcome has no value for "valid, but more than I am
   * configured to accept", so there is nothing about it to read back as a status,
   * and nothing that has to be kept in step with the throw.
   */
  feed(chunk: Uint8Array): FeedStatus {
    this.state.push(chunk);
    return this.state.outcome();
  }
}

/**
 * Decode a complete message held in one contiguous buffer, in a single call.
 *
 * The non-streaming convenience, and **not** a second decoder: it is one
 * {@link IStream.feed} of the whole buffer, so it runs the same code, applies the
 * same rules and has the same memory behaviour as a chunked decode — §6.7.1
 * forbids the one-shot path from differing, right down to holding no view into
 * the buffer it was handed. Feeding a whole message is also the case the decoder's
 * fast lane is built for, so nothing is given up by having one implementation.
 *
 * The whole buffer *is* the end of input, so the two failure outcomes both throw a
 * {@link SofabError} the caller tells apart by `code` (MESSAGE_SPEC §7): malformed
 * input throws `INVALID_MSG`, while input that ends inside a field — truncation or
 * an unclosed sequence — throws `INCOMPLETE`. A complete message returns normally.
 *
 * The receiver caps of §6.2.1 are the `visitor`'s, not this function's: it takes
 * no limits argument because this codec holds none. See {@link IStream}.
 */
export function decode(bytes: Uint8Array, visitor: Visitor): void {
  // One machine, re-bound per call. Constructing a decoder is the only allocating
  // step there is (§6.6) — and on a small message it is most of the cost — so the
  // one-shot path keeps one and rebinds it. A decode started *inside* a visitor
  // callback finds the pool empty and builds its own, so nesting stays safe, and
  // the machine goes back to the pool even when the decode throws.
  const state = pooled ?? new DecoderState();
  pooled = null;
  try {
    state.begin(visitor);
    state.push(bytes);
    // A malformed message has already thrown `INVALID_MSG`; what is left to report
    // is truncation, which streaming leaves to the caller's framing (§5.2.4) and
    // which a one-shot caller has, by construction, already decided is an error —
    // the whole buffer *is* the end of input.
    if (state.outcome() !== DecodeStatus.Complete) {
      throw incompleteError("truncated message: input ends inside a field");
    }
  } finally {
    state.release(); // keep nothing of the caller's alive in the pool
    pooled = state;
  }
}

/** The machine {@link decode} reuses; `null` while a decode is running on it. */
let pooled: DecoderState | null = null;
