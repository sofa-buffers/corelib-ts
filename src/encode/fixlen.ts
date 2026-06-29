/**
 * Encode-side text helper.
 *
 * A single shared {@link TextEncoder} turns strings into UTF-8 bytes. The fixlen
 * length word `(length << 3) | subtype` is now packed inline by the encoder on
 * its number fast path (see `OStream`), so no bigint helper is needed here.
 */

const UTF8 = new TextEncoder();

/** Encode `text` to UTF-8 bytes (no null terminator). */
export function encodeUtf8(text: string): Uint8Array {
  return UTF8.encode(text);
}
