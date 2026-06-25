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
  /** An unsigned integer field. */
  unsigned?(id: number, value: bigint): void;
  /** A signed integer field. */
  signed?(id: number, value: bigint): void;
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
  /** One unsigned array element. */
  arrayUnsigned?(id: number, index: number, value: bigint): void;
  /** One signed array element. */
  arraySigned?(id: number, index: number, value: bigint): void;
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
 * Decode a complete message in one call: feeds `bytes` to a fresh {@link IStream}
 * and asserts clean completion. Convenience for the non-streaming case.
 */
export function decode(bytes: Uint8Array, visitor: Visitor): void {
  const is = new IStream();
  is.feed(bytes, visitor);
  is.end();
}
