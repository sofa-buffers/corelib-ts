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
 *   short string cost ~700 ns almost entirely in `TextEncoder`). Both functions
 *   reproduce `TextEncoder` semantics exactly, including replacing an unpaired
 *   surrogate with U+FFFD (`EF BF BD`), so the bytes are identical.
 * - {@link encodeUtf8} — the shared {@link TextEncoder}, still used by the
 *   streaming path where the payload is drained in chunks through a small buffer.
 */

const UTF8 = new TextEncoder();

/** Encode `text` to UTF-8 bytes (no null terminator). */
export function encodeUtf8(text: string): Uint8Array {
  return UTF8.encode(text);
}

/**
 * Number of UTF-8 bytes {@link utf8Write} will emit for `text`. Matches
 * {@link TextEncoder} byte-for-byte: a paired surrogate is 4 bytes, any unpaired
 * surrogate collapses to U+FFFD (3 bytes).
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
      // High surrogate: a following low surrogate makes a 4-byte code point,
      // otherwise it is an unpaired surrogate → U+FFFD (3 bytes).
      const c2 = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i++;
        len += 4;
      } else {
        len += 3;
      }
    } else {
      // BMP ≥ 0x800 and unpaired low surrogates (→ U+FFFD) are all 3 bytes.
      len += 3;
    }
  }
  return len;
}

/**
 * Write `text` as UTF-8 into `out` at `pos`; returns the position past the last
 * byte. The caller must have ensured {@link utf8Length}(text) bytes of room.
 * Byte-for-byte identical to {@link TextEncoder}, unpaired surrogates included.
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
        // Unpaired high surrogate → U+FFFD.
        out[pos++] = 0xef;
        out[pos++] = 0xbf;
        out[pos++] = 0xbd;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // Unpaired low surrogate → U+FFFD.
      out[pos++] = 0xef;
      out[pos++] = 0xbf;
      out[pos++] = 0xbd;
    } else {
      out[pos++] = 0xe0 | (c >> 12);
      out[pos++] = 0x80 | ((c >> 6) & 0x3f);
      out[pos++] = 0x80 | (c & 0x3f);
    }
  }
  return pos;
}
