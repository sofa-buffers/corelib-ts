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
import { DecoderState } from "./state.js";

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
  /** One unsigned array element — `value` / `lo` / `hi` as in {@link unsigned}. */
  arrayUnsigned?(
    id: number,
    index: number,
    value: number | bigint,
    lo: number,
    hi: number,
  ): void;
  /** One signed array element — `value` / `lo` / `hi` as in {@link signed}. */
  arraySigned?(
    id: number,
    index: number,
    value: number | bigint,
    lo: number,
    hi: number,
  ): void;
  /** One fp32 array element — `bits` is the element's 4 wire bytes, see {@link fp32}. */
  arrayFp32?(id: number, index: number, value: number, bits: number): void;
  /** One fp64 array element. `value` is exact — see {@link fp64}. */
  arrayFp64?(id: number, index: number, value: number): void;
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
