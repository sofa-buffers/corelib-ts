/**
 * The contiguous-buffer fast path: "advance a pointer over a whole message".
 *
 * When the entire message is already in one {@link Uint8Array} (the common
 * non-streaming case) there is no need for the resumable, byte-at-a-time state
 * machine in {@link "./state"}. This decoder keeps a single read cursor and
 * walks it straight to the end, decoding each field inline — the technique
 * Protocol Buffers uses for its fast path.
 *
 * Two things make it much faster than the streaming decoder:
 *
 * - **No `bigint` in the varint hot loop.** Each varint is accumulated into two
 *   32-bit JavaScript *numbers* (`lo` / `hi`); a `bigint` is materialised only
 *   once per 64-bit *value* (and never at all for ids, lengths and counts,
 *   which stay numbers). The streaming reader, by contrast, does a `bigint`
 *   shift-and-or for every single byte.
 * - **No per-byte state reload.** The field type is dispatched once and the
 *   whole field is consumed in place, instead of re-entering a `switch` on a
 *   saved state enum for each byte.
 *
 * String / blob payloads are handed to the visitor as a single zero-copy
 * `subarray` view (one call, offset 0) rather than streamed in pieces. The
 * decoder validates exactly what the streaming path does and throws the same
 * {@link SofabError} (`INVALID_MSG`) on malformed input, including truncation
 * and unbalanced sequences detected at the end of the buffer.
 */

import {
  ARRAY_MAX,
  ArrayKind,
  FIXLEN_MAX,
  FixlenSubtype,
  ID_MAX,
  WireType,
} from "../constants.js";
import { invalidMsgError } from "../errors.js";
import { zigzagDecode } from "../varint/zigzag.js";
import type { Visitor } from "./istream.js";

const TWO32 = 0x1_0000_0000; // 2^32, for combining the 32-bit halves

/** Decode a complete message held in one contiguous buffer. */
export function decodeContiguous(buf: Uint8Array, root: Visitor): void {
  new FastDecoder(buf).run(root);
}

class FastDecoder {
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private readonly n: number;
  private p = 0;

  // Last varint, as two unsigned 32-bit halves (see readVarint).
  private lo = 0;
  private hi = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.n = buf.length;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.length);
  }

  run(root: Visitor): void {
    const stack: Visitor[] = [root];
    let top = root;

    while (this.p < this.n) {
      this.readVarint();
      const type = this.lo & 7;

      if (type === WireType.SequenceEnd) {
        if (stack.length <= 1) throw invalidMsgError("unbalanced sequence end");
        top.sequenceEnd?.();
        stack.pop();
        top = stack[stack.length - 1]!;
        continue;
      }

      const id = this.upper();
      if (id > ID_MAX) throw invalidMsgError(`field id ${id} out of range`);

      switch (type) {
        case WireType.Unsigned: {
          this.readVarint();
          top.unsigned?.(id, this.unsignedValue());
          break;
        }

        case WireType.Signed: {
          this.readVarint();
          top.signed?.(id, this.signedValue());
          break;
        }

        case WireType.Fixlen: {
          this.readVarint();
          const sub = this.lo & 7;
          const len = this.upper();
          if (sub > FixlenSubtype.Blob) throw invalidMsgError(`invalid fixlen subtype ${sub}`);
          if (len > FIXLEN_MAX) throw invalidMsgError("fixlen length out of range");
          if (sub === FixlenSubtype.Fp32 || sub === FixlenSubtype.Fp64) {
            const want = sub === FixlenSubtype.Fp32 ? 4 : 8;
            if (len !== want) throw invalidMsgError("fixlen float length mismatch");
            const value =
              sub === FixlenSubtype.Fp32 ? this.readFp32() : this.readFp64();
            if (sub === FixlenSubtype.Fp32) top.fp32?.(id, value);
            else top.fp64?.(id, value);
          } else {
            const chunk = this.take(len);
            if (sub === FixlenSubtype.String) top.string?.(id, len, 0, chunk);
            else top.blob?.(id, len, 0, chunk);
          }
          break;
        }

        case WireType.ArrayUnsigned: {
          const count = this.arrayCount();
          top.arrayBegin?.(id, ArrayKind.Unsigned, count);
          for (let i = 0; i < count; i++) {
            this.readVarint();
            top.arrayUnsigned?.(id, i, this.unsignedValue());
          }
          top.arrayEnd?.(id);
          break;
        }

        case WireType.ArraySigned: {
          const count = this.arrayCount();
          top.arrayBegin?.(id, ArrayKind.Signed, count);
          for (let i = 0; i < count; i++) {
            this.readVarint();
            top.arraySigned?.(id, i, this.signedValue());
          }
          top.arrayEnd?.(id);
          break;
        }

        case WireType.ArrayFixlen: {
          const count = this.arrayCount();
          this.readVarint();
          const sub = this.lo & 7;
          const size = this.upper();
          let kind: ArrayKind;
          if (sub === FixlenSubtype.Fp32 && size === 4) kind = ArrayKind.Fp32;
          else if (sub === FixlenSubtype.Fp64 && size === 8) kind = ArrayKind.Fp64;
          else throw invalidMsgError("invalid fixlen array element type");
          top.arrayBegin?.(id, kind, count);
          // Read each element into a local *before* the optional call: with an
          // absent handler, `v?.m(read())` would short-circuit and never advance.
          if (kind === ArrayKind.Fp32) {
            for (let i = 0; i < count; i++) {
              const value = this.readFp32();
              top.arrayFp32?.(id, i, value);
            }
          } else {
            for (let i = 0; i < count; i++) {
              const value = this.readFp64();
              top.arrayFp64?.(id, i, value);
            }
          }
          top.arrayEnd?.(id);
          break;
        }

        case WireType.SequenceStart: {
          const child = top.sequenceBegin?.(id);
          top = child ?? top;
          stack.push(top);
          break;
        }

        default:
          throw invalidMsgError(`invalid wire type ${type}`);
      }
    }

    if (stack.length > 1) throw invalidMsgError("truncated message: unbalanced sequence");
  }

  // --- field helpers ------------------------------------------------------

  /** Read and validate an array count word (1..ARRAY_MAX). */
  private arrayCount(): number {
    this.readVarint();
    const count = this.num();
    if (count < 1 || count > ARRAY_MAX) throw invalidMsgError("array count out of range");
    return count;
  }

  /** Hand back a zero-copy view of the next `len` bytes, advancing the cursor. */
  private take(len: number): Uint8Array {
    const start = this.p;
    const end = start + len;
    if (end > this.n) throw invalidMsgError("truncated fixlen payload");
    this.p = end;
    return this.buf.subarray(start, end);
  }

  private readFp32(): number {
    const p = this.p;
    if (p + 4 > this.n) throw invalidMsgError("truncated fp32");
    this.p = p + 4;
    return this.view.getFloat32(p, true);
  }

  private readFp64(): number {
    const p = this.p;
    if (p + 8 > this.n) throw invalidMsgError("truncated fp64");
    this.p = p + 8;
    return this.view.getFloat64(p, true);
  }

  // --- varint reading -----------------------------------------------------

  /** The last varint's full value as a `bigint` (64-bit fidelity). */
  private big(): bigint {
    return this.hi === 0
      ? BigInt(this.lo >>> 0)
      : (BigInt(this.hi >>> 0) << 32n) | BigInt(this.lo >>> 0);
  }

  /**
   * The last varint as an unsigned value, number-first: a `number` when it fits
   * exactly (`≤ 2^53-1` — all ids, u8..u32 and small u64s), a `bigint` only
   * beyond that. Skips the per-value bigint allocation on the common path.
   */
  private unsignedValue(): number | bigint {
    const hi = this.hi >>> 0; // unsigned: hi's bit 31 must not read as negative
    return hi <= 0x1fffff ? hi * TWO32 + (this.lo >>> 0) : this.big();
  }

  /** The last zig-zag varint as a signed value, number-first (see {@link unsignedValue}). */
  private signedValue(): number | bigint {
    const hi = this.hi >>> 0;
    if (hi <= 0x1fffff) {
      const r = hi * TWO32 + (this.lo >>> 0); // raw zig-zag, ≤ 2^53-1
      return r % 2 === 0 ? r / 2 : -(r + 1) / 2;
    }
    return zigzagDecode(this.big());
  }

  /** The last varint's value as a JS number — exact for ids/lengths/counts. */
  private num(): number {
    return this.hi * TWO32 + (this.lo >>> 0);
  }

  /** The last varint with its low 3 tag bits stripped (`value >> 3`). */
  private upper(): number {
    // value >> 3 without losing the high bits: drop 3 bits, carry hi's low 3.
    return (this.hi >>> 0) * (TWO32 / 8) + (this.lo >>> 3);
  }

  /**
   * Decode one LEB128 varint at the cursor into {@link lo} / {@link hi} (each an
   * unsigned 32-bit half), advancing {@link p}. Throws on truncation or a value
   * spilling past 64 bits (>10 bytes). Unrolled, number-only — no `bigint`.
   */
  private readVarint(): void {
    const buf = this.buf;
    const n = this.n;
    let p = this.p;
    let b: number;
    let lo: number;
    let hi = 0;

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    lo = b & 0x7f;
    if (b < 0x80) return this.set(lo, 0, p);

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    lo |= (b & 0x7f) << 7;
    if (b < 0x80) return this.set(lo, 0, p);

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    lo |= (b & 0x7f) << 14;
    if (b < 0x80) return this.set(lo, 0, p);

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    lo |= (b & 0x7f) << 21;
    if (b < 0x80) return this.set(lo, 0, p);

    // 5th byte straddles the 32-bit boundary: 4 bits to lo, 3 bits to hi.
    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    lo |= (b & 0x0f) << 28;
    hi = (b >> 4) & 0x07;
    if (b < 0x80) return this.set(lo, hi, p);

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    hi |= (b & 0x7f) << 3;
    if (b < 0x80) return this.set(lo, hi, p);

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    hi |= (b & 0x7f) << 10;
    if (b < 0x80) return this.set(lo, hi, p);

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    hi |= (b & 0x7f) << 17;
    if (b < 0x80) return this.set(lo, hi, p);

    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    hi |= (b & 0x7f) << 24;
    if (b < 0x80) return this.set(lo, hi, p);

    // 10th byte: only bit 63 remains; any continuation here is a >64-bit overflow.
    if (p >= n) throw invalidMsgError("truncated varint");
    b = buf[p++]!;
    hi |= (b & 0x7f) << 31;
    if (b < 0x80) return this.set(lo, hi, p);

    throw invalidMsgError("varint overflow");
  }

  private set(lo: number, hi: number, p: number): void {
    this.lo = lo;
    this.hi = hi;
    this.p = p;
  }
}
