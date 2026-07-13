/**
 * Wire-format constants for SofaBuffers.
 *
 * The format is specified, language-neutrally, in the
 * {@link https://github.com/sofa-buffers/documentation | SofaBuffers documentation}.
 * Every field on the wire begins with a varint header `(id << 3) | wireType`,
 * so the wire type lives in the low three bits and the field id in the rest.
 */

/**
 * The SofaBuffers API version this library implements. The generator and other
 * tooling read it to verify compatibility. Bumped only on a breaking API change.
 */
export const API_VERSION = 1;

/** The three low bits of a field header: what kind of field follows. */
export const WireType = {
  /** Unsigned varint scalar. */
  Unsigned: 0,
  /** Signed varint scalar (zig-zag encoded). */
  Signed: 1,
  /** Fixed-length value: fp32, fp64, string or blob (see {@link FixlenSubtype}). */
  Fixlen: 2,
  /** Array of unsigned varints. */
  ArrayUnsigned: 3,
  /** Array of signed (zig-zag) varints. */
  ArraySigned: 4,
  /** Array of fixed-length values (fp32 / fp64 only). */
  ArrayFixlen: 5,
  /** Opens a nested sequence (new id scope). */
  SequenceStart: 6,
  /** Closes the current sequence. Encoded as the single byte `0x07`. */
  SequenceEnd: 7,
} as const;
/** A field's wire type: one of the {@link WireType} values. */
export type WireType = (typeof WireType)[keyof typeof WireType];

/** The three low bits of a fixlen length header: which fixed-length type. */
export const FixlenSubtype = {
  /** IEEE-754 32-bit float, little-endian. */
  Fp32: 0,
  /** IEEE-754 64-bit double, little-endian. */
  Fp64: 1,
  /** UTF-8 string (no null terminator). */
  String: 2,
  /** Arbitrary binary data. */
  Blob: 3,
} as const;
/** A fixed-length value's type: one of the {@link FixlenSubtype} values. */
export type FixlenSubtype = (typeof FixlenSubtype)[keyof typeof FixlenSubtype];

/** Which element kind an array field carries (reported to {@link Visitor.arrayBegin}). */
export const ArrayKind = {
  /** Unsigned-integer elements. */
  Unsigned: 0,
  /** Signed-integer (zig-zag) elements. */
  Signed: 1,
  /** IEEE-754 32-bit float elements. */
  Fp32: 2,
  /** IEEE-754 64-bit double elements. */
  Fp64: 3,
} as const;
/** An array field's element kind: one of the {@link ArrayKind} values. */
export type ArrayKind = (typeof ArrayKind)[keyof typeof ArrayKind];

/** Largest permitted field id and fixlen length / array count: `INT32_MAX`. */
export const ID_MAX = 0x7fff_ffff;
/** Largest permitted fixlen byte length: `INT32_MAX`. */
export const FIXLEN_MAX = 0x7fff_ffff;
/** Largest permitted array element count: `INT32_MAX`. */
export const ARRAY_MAX = 0x7fff_ffff;

/** Largest unsigned 64-bit value (`2^64 - 1`). */
export const U64_MAX = 0xffff_ffff_ffff_ffffn;
/** Smallest signed 64-bit value (`-2^63`). */
export const I64_MIN = -0x8000_0000_0000_0000n;
/** Largest signed 64-bit value (`2^63 - 1`). */
export const I64_MAX = 0x7fff_ffff_ffff_ffffn;

/** A varint encodes at most this many bytes for a 64-bit value. */
export const VARINT_MAX_BYTES = 10;

/**
 * Maximum nested-sequence depth (§4.9 / §6.2). An encoder must not open more
 * than this many nested sequences, and a decoder must reject a message that
 * nests deeper with an `InvalidMessage` error rather than risk unbounded
 * recursion / stack growth.
 */
export const MAX_DEPTH = 255;

/**
 * The terminal outcome of a decode (MESSAGE_SPEC §7), reported identically for
 * one-shot and streaming decode with **no** finish / finalize / end promotion
 * step:
 *
 * - `Complete` — the bytes ended exactly at a field boundary: a valid message.
 * - `Incomplete` — the bytes ended *inside* a field (an unterminated varint, a
 *   payload shorter than its declared length, an array that runs off the end, or
 *   a nested sequence never closed). **Not an error** — more bytes could
 *   complete it, and the caller owns end-of-input.
 * - `Invalid` — the bytes are malformed regardless of what follows.
 *
 * {@link IStream.end} returns `Complete` or `Incomplete` (an `Invalid` message
 * has already thrown from {@link IStream.feed}); the one-shot {@link decode} /
 * {@link Cursor} path signals `Incomplete` and `Invalid` by throwing a
 * {@link SofabError} whose `code` is {@link SofabErrorCode.Incomplete} or
 * {@link SofabErrorCode.InvalidMsg}, and `Complete` by returning normally.
 */
export const DecodeStatus = {
  /** The bytes ended exactly at a field boundary — a valid message. */
  Complete: "COMPLETE",
  /** The bytes ended inside a field; more bytes could complete it (not an error). */
  Incomplete: "INCOMPLETE",
  /** The bytes are malformed regardless of what follows. */
  Invalid: "INVALID",
} as const;
/** A decode's terminal outcome: one of the {@link DecodeStatus} values. */
export type DecodeStatus = (typeof DecodeStatus)[keyof typeof DecodeStatus];
