/**
 * Encode-side text and fixlen helpers.
 *
 * A single shared {@link TextEncoder} turns strings into UTF-8 bytes; the fixlen
 * length header packs `(length << 3) | subtype` for the on-wire length word.
 */

import type { FixlenSubtype } from "../constants.js";

const UTF8 = new TextEncoder();

/** Encode `text` to UTF-8 bytes (no null terminator). */
export function encodeUtf8(text: string): Uint8Array {
  return UTF8.encode(text);
}

/** Build the fixlen length word `(length << 3) | subtype` as a `bigint`. */
export function fixlenHeader(length: number, subtype: FixlenSubtype): bigint {
  return (BigInt(length) << 3n) | BigInt(subtype);
}
