/**
 * The SofaBuffers decoder.
 *
 * `IStream` is a push parser: feed it bytes with {@link IStream.feed} and it
 * drives a {@link Visitor}, calling one method per decoded field. It is a
 * resumable state machine, so the chunks you feed can be any size — a whole
 * message, a network packet, or a single byte — and a field that straddles a
 * chunk boundary is picked up seamlessly on the next call.
 *
 * Nesting is hierarchical: {@link Visitor.sequenceBegin} may return a child
 * visitor, and the decoder routes the nested fields to it until the matching
 * end. Generated message classes use this directly — a class implements
 * `Visitor`, and a nested-message field returns the child instance.
 *
 * There is no finish / finalize step (CORELIB_PLAN §5.2 / MESSAGE_SPEC §7):
 * {@link IStream.feed} *returns* the three-valued decode outcome for the bytes
 * consumed so far, and {@link IStream.status} re-reads it at any time. A message
 * that merely ends inside a field is reported — never thrown — as
 * {@link DecodeStatus.Incomplete}; only a *malformed* message throws
 * ({@link SofabErrorCode.InvalidMsg}), which is this port's channel for
 * {@link DecodeStatus.Invalid}. The caller owns end-of-input and decides whether
 * a trailing `Incomplete` is a truncation error.
 */

import type {
  ArrayKind,
  DecodeStatus,
  FixlenSubtype,
  WireType,
} from "../constants.js";
import { decodeContiguous } from "./fast.js";
import type { DecodeLimits } from "./limits.js";
import { DecoderState } from "./state.js";

/**
 * Receives decoded fields from an {@link IStream}. Every method is optional and
 * defaults to a no-op, so a visitor implements only the fields it cares about
 * and silently skips the rest.
 *
 * String and blob payloads arrive as one or more `chunk`s, each tagged with the
 * field's `total` length and the `offset` of the chunk within the field, so a
 * large payload never has to be held in one piece. Array elements arrive one at
 * a time between {@link Visitor.arrayBegin} and {@link Visitor.arrayEnd}.
 */
export interface Visitor {
  /**
   * A field **header**: its `id` and `wire` type, announced the moment the
   * header varint is complete — before the value, and before the value's own
   * header word (a fixlen length word, an array count word, the fields of a
   * nested sequence).
   *
   * The push twin of {@link Cursor.readHeader}, and it exists because the two
   * paths must agree. Whatever the header alone decides has to be decidable
   * here: a wrapper-array element whose id is past the schema `count`
   * (MESSAGE_SPEC §7.1/§5.1) is such a verdict — `id >= count` needs no length,
   * no count and no payload. Without this hook the earliest signal for a fixlen
   * element was {@link fixlenBegin}, which needs the *complete* fixlen word, so
   * a message ending inside that word delivered no event at all and degraded to
   * `INCOMPLETE` — while the same bytes through {@link Cursor.readHeader} are
   * `INVALID`. CORELIB_PLAN §5.2 gives INVALID precedence over INCOMPLETE for
   * input already known to be malformed, and §6.4 forbids a chunk boundary
   * changing the outcome (corelib-ts#97).
   *
   * Called exactly once per field, in every scope, for every wire type — the
   * sequence *end* marker excepted: it closes a scope rather than opening a
   * field and its id is discarded, which is the same answer the pull twin gives
   * by returning `false` from {@link Cursor.readHeader} instead of publishing a
   * header. For a nested sequence it fires on the *enclosing* visitor, before
   * {@link sequenceBegin}.
   *
   * Throwing from it rejects the field, exactly as from {@link fixlenBegin}.
   * Checks that need more than `id` and `wire` still belong on the later, more
   * informative hook: a fixlen *subtype* mismatch on {@link fixlenBegin}, a
   * declared length or element count on {@link fixlenBegin} / {@link arrayBegin}.
   */
  fieldBegin?(id: number, wire: WireType): void;
  /**
   * An unsigned integer field. Number-first: `value` is a `number` when it fits
   * exactly (`≤ 2^53-1`, covering ids, u8..u32 and small u64s) and a `bigint`
   * only beyond that, so the common case avoids a per-value bigint allocation.
   */
  unsigned?(id: number, value: number | bigint): void;
  /** A signed integer field. Number-first like {@link unsigned} (`|value| ≤ 2^53-1` ⇒ `number`). */
  signed?(id: number, value: number | bigint): void;
  /**
   * Opt in to the raw-bytes channel on {@link fp32} / {@link arrayFp32}. Off by
   * default so a value-only consumer pays nothing: when this is not `true` the
   * decoder never allocates the per-value little-endian view (which, per fp32
   * element, roughly quartered array-decode throughput in a microbenchmark). Set
   * it `true` only in a bit-exact consumer (transcode / raw-bits oracle) that
   * needs `raw` to preserve a signaling NaN.
   */
  readonly fp32Raw?: boolean;
  /**
   * An IEEE-754 32-bit float field. When you set {@link fp32Raw} to `true`,
   * `raw` is a zero-copy little-endian view of the exact 4 wire bytes; use it —
   * not `value` — when the bytes must round-trip bit-for-bit (§4.6). `value` is
   * a JS `number` (a 64-bit double), and widening a *signaling* NaN into a
   * double quiets it (sets the is-quiet bit), so `value` cannot represent an
   * fp32 sNaN faithfully. The view aliases the decoder's working buffer and is
   * valid only for the duration of the call — copy it if you retain it, exactly
   * as with a string/blob `chunk`. Without {@link fp32Raw}, `raw` is `undefined`
   * (no allocation). fp64 needs no such channel: a double holds all 64 bits
   * verbatim (see {@link fp64}).
   */
  fp32?(id: number, value: number, raw?: Uint8Array): void;
  /** An IEEE-754 64-bit double field. `value` is exact — a double is 64 bits wide. */
  fp64?(id: number, value: number): void;
  /**
   * Start of a `string`/`blob` field: `total` payload bytes follow, in one or
   * more {@link string}/{@link blob} calls.
   *
   * The counterpart of {@link arrayBegin}, and it exists for the same reason: a
   * receiver-side bound on the *declared length* is decided by this word, not by
   * the payload. Without it a visitor can only see `total` once payload bytes
   * arrive, so a message that ends right after an over-bound length word escapes
   * the check and degrades to `INCOMPLETE` — while the same bytes through
   * {@link Cursor.readString} are `INVALID`. §5.2 gives INVALID precedence over
   * INCOMPLETE for input already known to be malformed, so the two paths have to
   * agree, and this is where the verdict is available.
   *
   * Called exactly once per field, before any payload call — including for a
   * zero-length payload, which is still announced here and then delivered as one
   * empty chunk.
   */
  fixlenBegin?(id: number, subtype: FixlenSubtype, total: number): void;
  /**
   * A chunk of a UTF-8 string field: `chunk` are the raw wire bytes at `offset`
   * of a `total`-byte payload, as a zero-copy view valid only for this call.
   *
   * They are **not validated**. §6.4 puts the UTF-8 check where a string is
   * *materialized* — a chunk may end mid-code-point, and a skipped field is
   * never validated at all — so on this path the caller who materializes owns
   * the check and must use the **fatal** decoder,
   * `new TextDecoder("utf-8", { fatal: true })`, which is what
   * {@link Cursor.readString} uses to report invalid UTF-8 as `INVALID_MSG`.
   * JavaScript's default `TextDecoder` substitutes `U+FFFD`, and §6.4 forbids
   * that silent replacement in either direction. Decode `total`-sized reassembled
   * payloads, not individual chunks, unless a chunk is the whole payload.
   */
  string?(id: number, total: number, offset: number, chunk: Uint8Array): void;
  /** A chunk of a blob field. */
  blob?(id: number, total: number, offset: number, chunk: Uint8Array): void;
  /** Start of an array; `count` elements of `kind` follow. */
  arrayBegin?(id: number, kind: ArrayKind, count: number): void;
  /** One unsigned array element. Number-first like {@link unsigned}. */
  arrayUnsigned?(id: number, index: number, value: number | bigint): void;
  /** One signed array element. Number-first like {@link signed}. */
  arraySigned?(id: number, index: number, value: number | bigint): void;
  /** One fp32 array element. `raw` (the element's 4 wire bytes) is present only under {@link fp32Raw} — see {@link fp32}. */
  arrayFp32?(id: number, index: number, value: number, raw?: Uint8Array): void;
  /** One fp64 array element. `value` is exact — see {@link fp64}. */
  arrayFp64?(id: number, index: number, value: number): void;
  /** End of an array. */
  arrayEnd?(id: number): void;
  /**
   * Start of a nested sequence. Return a {@link Visitor} to route the nested
   * fields to it (its {@link Visitor.sequenceEnd} fires at the matching end);
   * return nothing to keep using the current visitor.
   */
  sequenceBegin?(id: number): Visitor | void;
  /** End of the nested sequence this visitor was handling. */
  sequenceEnd?(): void;
}

/**
 * Push parser for the SofaBuffers wire format. Feed it bytes in chunks of any
 * size with {@link IStream.feed} and it drives a {@link Visitor}, one call per
 * decoded field, resuming cleanly across chunk boundaries. Every `feed` returns
 * the decode outcome for the bytes so far — whether the message has finished on
 * a field boundary — so no end / finalize call is needed;
 * {@link IStream.status} re-reads that same outcome. When the whole message is
 * already in one buffer, prefer the faster {@link decode}.
 */
export class IStream {
  private readonly state: DecoderState;

  /**
   * @param limits Optional opt-in decode caps ({@link DecodeLimits}). An
   * over-limit array count or string / blob length throws {@link SofabError}
   * (`LIMIT_EXCEEDED`) from {@link feed}, at the offending field's header and
   * before any of its payload is streamed to the visitor. Omit for no caps.
   */
  constructor(limits?: DecodeLimits) {
    this.state = new DecoderState(limits);
  }

  /**
   * Feed a chunk of bytes, dispatching decoded fields to `visitor`, and
   * **return** the decode outcome for the bytes consumed so far (CORELIB_PLAN
   * §6): {@link DecodeStatus.Complete} when they end exactly at a field
   * boundary, {@link DecodeStatus.Incomplete} when they end *inside* a field (a
   * partial varint, an unfinished payload / array, or a still-open nested
   * sequence). Running out of bytes mid-field is not an error — the decode
   * merely suspends until the next chunk, and the caller owns end-of-input.
   *
   * There is no finish / finalize step (§5.2): the status returned here *is* the
   * answer at that byte boundary, and {@link status} re-reads the same value
   * without consuming anything.
   *
   * `INVALID` travels on the error channel — this port's idiomatic surfacing of
   * it: *malformed* bytes throw {@link SofabError} (`INVALID_MSG`) instead of
   * returning a status. That verdict is **terminal** (§5.2): the stream latches
   * it, so a caller that catches the throw and feeds on gets the same error
   * again from every later call — no further byte is consumed and no visitor
   * method is invoked — and {@link status} answers {@link DecodeStatus.Invalid}
   * from then on. A receiver-limit rejection (`LIMIT_EXCEEDED`,
   * {@link DecodeLimits}) does *not* latch: the bytes are well-formed, and it is
   * a policy rejection rather than the `INVALID` outcome.
   */
  feed(chunk: Uint8Array, visitor: Visitor): DecodeStatus {
    this.state.push(chunk, visitor);
    return this.state.finish();
  }

  /**
   * Re-read the outcome for the bytes fed so far — the same value the last
   * {@link feed} returned: {@link DecodeStatus.Complete} at a clean field
   * boundary, {@link DecodeStatus.Incomplete} if the input ends inside a field,
   * or {@link DecodeStatus.Invalid} once it has been proved malformed —
   * permanently, since `INVALID` is terminal and outranks `INCOMPLETE` (§5.2).
   * `Invalid` is the one outcome {@link feed} never returns (it throws it), so
   * this is how a caller that caught the `INVALID_MSG` reads the verdict as a
   * status.
   *
   * A convenience, never an obligation: the finish-less spec (§5.2 / MESSAGE_SPEC
   * §7) requires no end step, and this is a pure accessor — it never throws,
   * consumes nothing, and never promotes an incomplete decode to an error.
   */
  status(): DecodeStatus {
    return this.state.finish();
  }

  /**
   * Deprecated alias for {@link status}, kept so existing callers compile
   * unchanged.
   *
   * The name is a misnomer under the finish-less spec (CORELIB_PLAN §5.2): the
   * decoder needs no "end" step — {@link feed} already returns the outcome and
   * {@link status} re-reads it. Behaviourally identical to {@link status}: a
   * pure accessor that never throws.
   *
   * @deprecated Use {@link status} — or the value {@link feed} returns.
   */
  end(): DecodeStatus {
    return this.state.finish();
  }
}

/**
 * Decode a complete message held in one contiguous buffer, in a single call.
 *
 * This is the non-streaming convenience — and the fast path: with the whole
 * message in hand it advances one cursor over the buffer instead of running the
 * resumable per-byte state machine, so it is markedly faster than feeding the
 * same bytes through
 * {@link IStream}. Use {@link IStream} when the message arrives in chunks; use
 * this when you already have it whole.
 *
 * The whole buffer *is* the end of input, so the two failure outcomes both
 * throw a {@link SofabError} the caller tells apart by `code` (MESSAGE_SPEC §7):
 * malformed input throws `INVALID_MSG`, while input that ends inside a field —
 * truncation or an unclosed sequence — throws `INCOMPLETE`. A complete message
 * returns normally.
 *
 * Pass `limits` ({@link DecodeLimits}) to cap array counts and string / blob
 * lengths; an over-limit field throws `LIMIT_EXCEEDED` at its header, before it
 * is materialized. Omit for no caps (the default).
 */
export function decode(
  bytes: Uint8Array,
  visitor: Visitor,
  limits?: DecodeLimits,
): void {
  decodeContiguous(bytes, visitor, limits);
}
