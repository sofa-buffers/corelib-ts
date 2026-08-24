/**
 * Encode-side text helper.
 *
 * Two paths turn strings into UTF-8:
 *
 * - {@link utf8Length} / {@link utf8Write} — an allocation-free, two-pass writer
 *   used by the encoder's contiguous-write fast path. `writeString` needs the byte
 *   length *before* the payload (it goes into the fixlen length word), so the
 *   length is scanned first and the bytes are then written straight into the
 *   output buffer. This avoids `TextEncoder.encode`'s per-call WHATWG setup cost
 *   plus the throwaway `Uint8Array` it allocates and the second copy into the
 *   buffer — which V8 profiling showed to be the encoder's dominant cost (a
 *   short string cost ~700 ns almost entirely in `TextEncoder`).
 * - {@link utf8WriteSink} — the same walk, emitting one byte at a time into a
 *   {@link ByteSink}, for the streaming path where the output buffer is narrower
 *   than the payload and the encoder drains between bytes. It replaces a
 *   `TextEncoder.encode` into a throwaway array, which was an allocation on a
 *   codec path and so is not available to it (CORELIB_PLAN §6.6).
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

/** An unpaired surrogate at `index` cannot be encoded as valid UTF-8 (§8/§6.4). */
function unpairedSurrogate(index: number): SofabError {
  return argumentError(
    `unpaired surrogate at index ${index}: string value is not valid UTF-8`,
  );
}

/** Anything that takes UTF-8 one byte at a time — in practice, the encoder itself. */
export interface ByteSink {
  /** @internal Append one byte, draining to the flush sink when the buffer is full. */
  putByte(b: number): void;
}

/**
 * Number of UTF-8 bytes {@link utf8Write} will emit for `text`. For a
 * well-formed string this matches {@link TextEncoder} byte-for-byte (a paired
 * surrogate is 4 bytes). An **unpaired surrogate** is not encodable as UTF-8, so
 * it is **rejected** with {@link SofabError} (`ARGUMENT`), never counted as a
 * `U+FFFD` (3-byte) replacement (MESSAGE_SPEC §8).
 */
export function utf8Length(text: string): number {
  const n = text.length;
  // ASCII pre-scan: one compare per character, no branch tree and no running
  // sum. Identifiers, keys and most short strings are pure ASCII, where this
  // returns immediately with `len === n`; anything else resumes the general
  // walk below at the first non-ASCII character, so nothing is scanned twice.
  let a = 0;
  while (a < n && text.charCodeAt(a) < 0x80) a++;
  if (a === n) return n;

  let len = a;
  for (let i = a; i < n; i++) {
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
  const n = text.length;
  // ASCII fast copy, mirroring utf8Length's pre-scan: one compare and one store
  // per character until the first non-ASCII one, then the general walk resumes
  // from there.
  let a = 0;
  while (a < n) {
    const c = text.charCodeAt(a);
    if (c >= 0x80) break;
    out[pos + a] = c;
    a++;
  }
  pos += a;
  if (a === n) return pos;

  for (let i = a; i < n; i++) {
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

/**
 * Write `text` as UTF-8 one byte at a time into `sink` — {@link utf8Write}'s walk
 * for an output buffer that cannot take the payload contiguously, where the
 * encoder flushes between bytes (§5.1.3: a payload run is divisible at any byte).
 *
 * Byte-for-byte identical to {@link utf8Write}, unpaired-surrogate rejection
 * included; it differs only in where the bytes go. `writeString` has already run
 * {@link utf8Length}, so a string that cannot be encoded was rejected before the
 * header went out and this walk never meets one.
 */
export function utf8WriteSink(text: string, sink: ByteSink): void {
  const n = text.length;
  for (let i = 0; i < n; i++) {
    let c = text.charCodeAt(i);
    if (c < 0x80) {
      sink.putByte(c);
    } else if (c < 0x800) {
      sink.putByte(0xc0 | (c >> 6));
      sink.putByte(0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = i + 1 < n ? text.charCodeAt(i + 1) : 0;
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i++;
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        sink.putByte(0xf0 | (c >> 18));
        sink.putByte(0x80 | ((c >> 12) & 0x3f));
        sink.putByte(0x80 | ((c >> 6) & 0x3f));
        sink.putByte(0x80 | (c & 0x3f));
      } else {
        throw unpairedSurrogate(i);
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw unpairedSurrogate(i);
    } else {
      sink.putByte(0xe0 | (c >> 12));
      sink.putByte(0x80 | ((c >> 6) & 0x3f));
      sink.putByte(0x80 | (c & 0x3f));
    }
  }
}
