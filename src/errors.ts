/**
 * Error handling for SofaBuffers.
 *
 * Both encoder and decoder report problems through a single {@link SofabError}
 * carrying a {@link SofabErrorCode}, mirroring the C reference's `sofab_ret_t`
 * return codes so the failure modes line up across the language family.
 */

/** The cause of a {@link SofabError}, matching the C `sofab_ret_t` codes. */
export const SofabErrorCode = {
  /** A caller argument was invalid (e.g. id out of range, empty array). */
  Argument: "ARGUMENT",
  /** The API was used incorrectly (e.g. unbalanced sequence end). */
  Usage: "USAGE",
  /** The output buffer is full and no flush sink was provided. */
  BufferFull: "BUFFER_FULL",
  /** The input being decoded is malformed. */
  InvalidMsg: "INVALID_MSG",
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

/** @internal The input being decoded is malformed. */
export function invalidMsgError(message: string): SofabError {
  return new SofabError(SofabErrorCode.InvalidMsg, message);
}
