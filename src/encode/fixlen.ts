/**
 * Encode-side text helper.
 *
 * Two paths turn strings into UTF-8:
 *
 * - {@link utf8Length} / {@link utf8Write} — an allocation-free, two-pass writer
 *   used by the encoder's in-memory fast path. `writeString` needs the byte
 *   length *before* the payload (it goes into the fixlen length word), so the
 *   length is scanned first and the bytes are then written straight into the
 *   output buffer. This avoids `TextEncoder.encode`'s per-call WHATWG setup cost
 *   plus the throwaway `Uint8Array` it allocates and the second copy into the
 *   buffer — which V8 profiling showed to be the encoder's dominant cost (a
 *   short string cost ~700 ns almost entirely in `TextEncoder`).
 * - {@link encodeUtf8} — a validated wrapper over the shared {@link TextEncoder},
 *   still used by the streaming path where the payload is drained in chunks
 *   through a small buffer.
 *
 * **Strict UTF-8 (MESSAGE_SPEC §8, CORELIB_PLAN §6.4).** A `string` is UTF-8
 * text; the encode side is always strict for this Unicode-string target. The
 * platform encoders are lossy — `TextEncoder`, and the hand-rolled fast path it
 * once mirrored, both replace an **unpaired surrogate** with `U+FFFD` — which is
 * the silent data mutation §8 forbids in every mode and direction. Both paths
 * here instead **reject** an unpaired surrogate with an `InvalidArgument`
 * {@link SofabError} (the encode-side image of the decode `INVALID` outcome), so
 * a producer can never emit bytes a strict decoder would refuse. Every *valid*
 * string — ASCII, multibyte BMP, correctly paired astral code points, embedded
 * `U+0000` — still encodes byte-for-byte as before.
 */

import { argumentError, type SofabError } from "../errors.js";

const UTF8 = new TextEncoder();

/** An unpaired surrogate at `index` cannot be encoded as valid UTF-8 (§8/§6.4). */
function unpairedSurrogate(index: number): SofabError {
  return argumentError(
    `unpaired surrogate at index ${index}: string value is not valid UTF-8`,
  );
}

/**
 * Encode `text` to UTF-8 bytes (no null terminator). Throws
 * {@link SofabError} (`ARGUMENT`) on an unpaired surrogate — `TextEncoder` alone
 * would silently substitute `U+FFFD`, the lossy mutation §8 forbids, so the
 * string is validated first and only well-formed input reaches the encoder.
 */
export function encodeUtf8(text: string): Uint8Array {
  // utf8Length is a full unpaired-surrogate scan that throws on the first one;
  // reuse it as the validator so both encode paths share one rule, then hand the
  // now-known-well-formed string to TextEncoder (byte-identical for valid input).
  utf8Length(text);
  return UTF8.encode(text);
}

/**
 * Number of UTF-8 bytes {@link utf8Write} will emit for `text`. For a
 * well-formed string this matches {@link TextEncoder} byte-for-byte (a paired
 * surrogate is 4 bytes). An **unpaired surrogate** is not encodable as UTF-8, so
 * it is **rejected** with {@link SofabError} (`ARGUMENT`), never counted as a
 * `U+FFFD` (3-byte) replacement (MESSAGE_SPEC §8).
 */
export function utf8Length(text: string): number {
  let len = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      len += 1;
    } else if (c < 0x800) {
      len += 2;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate: a following low surrogate makes a 4-byte code point;
      // otherwise it is an unpaired surrogate — reject, never collapse to U+FFFD.
      const c2 = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i++;
        len += 4;
      } else {
        throw unpairedSurrogate(i);
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // Lone low surrogate (a paired one was consumed with its high half above).
      throw unpairedSurrogate(i);
    } else {
      // BMP ≥ 0x800.
      len += 3;
    }
  }
  return len;
}

/**
 * Write `text` as UTF-8 into `out` at `pos`; returns the position past the last
 * byte. The caller must have ensured {@link utf8Length}(text) bytes of room.
 * Byte-for-byte identical to {@link TextEncoder} for well-formed input; an
 * **unpaired surrogate** is rejected with {@link SofabError} (`ARGUMENT`) rather
 * than written as `U+FFFD` (MESSAGE_SPEC §8). `writeString` runs
 * {@link utf8Length} first, so the fast path rejects before any byte is emitted.
 */
export function utf8Write(text: string, out: Uint8Array, pos: number): number {
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c < 0x80) {
      out[pos++] = c;
    } else if (c < 0x800) {
      out[pos++] = 0xc0 | (c >> 6);
      out[pos++] = 0x80 | (c & 0x3f);
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i++;
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out[pos++] = 0xf0 | (c >> 18);
        out[pos++] = 0x80 | ((c >> 12) & 0x3f);
        out[pos++] = 0x80 | ((c >> 6) & 0x3f);
        out[pos++] = 0x80 | (c & 0x3f);
      } else {
        // Unpaired high surrogate — reject, never write U+FFFD.
        throw unpairedSurrogate(i);
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // Unpaired low surrogate — reject, never write U+FFFD.
      throw unpairedSurrogate(i);
    } else {
      out[pos++] = 0xe0 | (c >> 12);
      out[pos++] = 0x80 | ((c >> 6) & 0x3f);
      out[pos++] = 0x80 | (c & 0x3f);
    }
  }
  return pos;
}
