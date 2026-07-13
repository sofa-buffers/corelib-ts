/**
 * Error handling for SofaBuffers.
 *
 * Both encoder and decoder report problems through a single {@link SofabError}
 * carrying a {@link SofabErrorCode}, mirroring the C reference's `sofab_ret_t`
 * return codes so the failure modes line up across the language family.
 *
 * The decoder distinguishes two *kinds* of decode failure (MESSAGE_SPEC §7):
 * {@link SofabErrorCode.InvalidMsg} for input that is malformed regardless of
 * what follows (`INVALID`), and {@link SofabErrorCode.Incomplete} for input that
 * merely ends inside a field (`INCOMPLETE`) — a truncation that more bytes could
 * complete, and so is *not* the same as a malformed message. A third code,
 * {@link SofabErrorCode.LimitExceeded}, is orthogonal to both: it reports a
 * receiver-configured decode limit being hit — *policy*, not a property of the
 * bytes — so it is kept distinct from `InvalidMsg`.
 */

/**
 * The cause of a {@link SofabError}. `Argument`, `Usage`, `BufferFull` and
 * `InvalidMsg` match the C reference's `sofab_ret_t` codes; `Incomplete` is the
 * finish-less INCOMPLETE decode outcome (MESSAGE_SPEC §7), a distinct,
 * more-bytes-could-complete-it signal split out from `InvalidMsg`.
 */
export const SofabErrorCode = {
  /** A caller argument was invalid (e.g. id out of range, empty array). */
  Argument: "ARGUMENT",
  /** The API was used incorrectly (e.g. unbalanced sequence end). */
  Usage: "USAGE",
  /** The output buffer is full and no flush sink was provided. */
  BufferFull: "BUFFER_FULL",
  /** The input being decoded is malformed regardless of what follows (`INVALID`). */
  InvalidMsg: "INVALID_MSG",
  /**
   * The input being decoded ends inside a field (`INCOMPLETE`, MESSAGE_SPEC §7):
   * an unterminated varint, a payload shorter than its declared length, an array
   * that runs off the end, or a nested sequence never closed. Not a malformed
   * message — more bytes could complete it, and the caller owns end-of-input.
   */
  Incomplete: "INCOMPLETE",
  /**
   * A receiver-configured decode limit was exceeded — a dynamic array, string or
   * blob on the wire claims more elements / bytes than the caller's
   * {@link DecodeLimits} (`maxArrayCount` / `maxStringLen` / `maxBlobLen`)
   * allows. Deliberately distinct from {@link SofabErrorCode.InvalidMsg}:
   * exceeding a limit is *policy*, not wire malformation — the identical bytes
   * decode fine under a looser limit — so differential fuzzing must not read it
   * as a conformance divergence. The decoder never clamps or truncates; it
   * rejects, before the offending field is materialized.
   */
  LimitExceeded: "LIMIT_EXCEEDED",
} as const;
/** A {@link SofabError}'s cause: one of the {@link SofabErrorCode} values. */
export type SofabErrorCode =
  (typeof SofabErrorCode)[keyof typeof SofabErrorCode];

/** The single error type thrown by the encoder and decoder. */
export class SofabError extends Error {
  /** The machine-readable cause. */
  readonly code: SofabErrorCode;

  constructor(code: SofabErrorCode, message: string) {
    super(message);
    this.name = "SofabError";
    this.code = code;
    // Restore the prototype chain for transpiled-to-ES5 consumers.
    Object.setPrototypeOf(this, SofabError.prototype);
  }
}

/** @internal A caller passed an invalid argument. */
export function argumentError(message: string): SofabError {
  return new SofabError(SofabErrorCode.Argument, message);
}

/** @internal The API was driven into an invalid state. */
export function usageError(message: string): SofabError {
  return new SofabError(SofabErrorCode.Usage, message);
}

/** @internal The output buffer filled with no flush sink to drain it. */
export function bufferFullError(message: string): SofabError {
  return new SofabError(SofabErrorCode.BufferFull, message);
}

/** @internal The input being decoded is malformed regardless of what follows. */
export function invalidMsgError(message: string): SofabError {
  return new SofabError(SofabErrorCode.InvalidMsg, message);
}

/**
 * @internal The input being decoded ended inside a field (truncation). A
 * distinct, non-malformed outcome (MESSAGE_SPEC §7): more bytes could complete
 * it, so it carries {@link SofabErrorCode.Incomplete}, never `InvalidMsg`.
 */
export function incompleteError(message: string): SofabError {
  return new SofabError(SofabErrorCode.Incomplete, message);
}

/**
 * @internal A receiver-configured decode limit ({@link DecodeLimits}) was
 * exceeded. Carries {@link SofabErrorCode.LimitExceeded}, never `InvalidMsg`:
 * it is a policy rejection, not a statement that the bytes are malformed.
 */
export function limitExceededError(message: string): SofabError {
  return new SofabError(SofabErrorCode.LimitExceeded, message);
}
