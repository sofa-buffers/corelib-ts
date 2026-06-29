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
 */

import type { ArrayKind } from "../constants.js";
import { decodeContiguous } from "./fast.js";
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
   * An unsigned integer field. Number-first: `value` is a `number` when it fits
   * exactly (`≤ 2^53-1`, covering ids, u8..u32 and small u64s) and a `bigint`
   * only beyond that, so the common case avoids a per-value bigint allocation.
   */
  unsigned?(id: number, value: number | bigint): void;
  /** A signed integer field. Number-first like {@link unsigned} (`|value| ≤ 2^53-1` ⇒ `number`). */
  signed?(id: number, value: number | bigint): void;
  /** An IEEE-754 32-bit float field. */
  fp32?(id: number, value: number): void;
  /** An IEEE-754 64-bit double field. */
  fp64?(id: number, value: number): void;
  /** A chunk of a UTF-8 string field. */
  string?(id: number, total: number, offset: number, chunk: Uint8Array): void;
  /** A chunk of a blob field. */
  blob?(id: number, total: number, offset: number, chunk: Uint8Array): void;
  /** Start of an array; `count` elements of `kind` follow. */
  arrayBegin?(id: number, kind: ArrayKind, count: number): void;
  /** One unsigned array element. Number-first like {@link unsigned}. */
  arrayUnsigned?(id: number, index: number, value: number | bigint): void;
  /** One signed array element. Number-first like {@link signed}. */
  arraySigned?(id: number, index: number, value: number | bigint): void;
  /** One fp32 array element. */
  arrayFp32?(id: number, index: number, value: number): void;
  /** One fp64 array element. */
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
 * decoded field, resuming cleanly across chunk boundaries. Call
 * {@link IStream.end} after the final chunk to assert the message finished on a
 * field boundary. When the whole message is already in one buffer, prefer the
 * faster {@link decode}.
 */
export class IStream {
  private readonly state = new DecoderState();

  /** Feed a chunk of bytes, dispatching decoded fields to `visitor`. */
  feed(chunk: Uint8Array, visitor: Visitor): void {
    this.state.push(chunk, visitor);
  }

  /**
   * Assert the stream ended cleanly at a field boundary (no truncated field or
   * unbalanced sequence). Call after the final {@link feed} of a complete
   * message; throws {@link SofabError} (`INVALID_MSG`) if incomplete.
   */
  end(): void {
    this.state.finish();
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
 * this when you already have it whole. Malformed input — including truncation
 * or an unclosed sequence — throws {@link SofabError} (`INVALID_MSG`).
 */
export function decode(bytes: Uint8Array, visitor: Visitor): void {
  decodeContiguous(bytes, visitor);
}
