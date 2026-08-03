/**
 * The resumable decode state machine.
 *
 * `DecoderState` consumes input one byte at a time and never needs to buffer
 * more than a single varint (≤10 bytes) or one fixlen element (≤8 bytes), so it
 * can be fed arbitrarily small chunks: every multi-byte construct saves its
 * progress in instance fields and continues on the next {@link push}. Large
 * string / blob payloads are streamed straight to the visitor in pieces, and
 * array elements are emitted as they arrive — nothing is materialised whole.
 */

import {
  ARRAY_MAX,
  ArrayKind,
  DecodeStatus,
  FIXLEN_MAX,
  FixlenSubtype,
  ID_MAX,
  MAX_DEPTH,
  VARINT_MAX_BYTES,
  WireType,
} from "../constants.js";
import { invalidMsgError, limitExceededError } from "../errors.js";
import { joinU64 } from "../varint/bits64.js";
import { fp32FromBits, fp64FromBits, rawFp32Bytes } from "../varint/num64.js";
import { zigzagDecodeLoHi } from "../varint/zigzag.js";
import type { DecodeLimits } from "./limits.js";
import type { Visitor } from "./istream.js";

const enum S {
  Header,
  ScalarU,
  ScalarS,
  FixlenLen,
  FixlenFp,
  FixlenBytes,
  ArrayCount,
  ArrayUElem,
  ArraySElem,
  ArrayElemLen,
  ArrayFp,
}

const TWO32 = 0x1_0000_0000; // 2^32, for combining the 32-bit halves

/** Placeholder for {@link DecoderState.cur} before the first {@link DecoderState.push}. */
const EMPTY_VISITOR: Visitor = {};

export class DecoderState {
  private state = S.Header;
  /**
   * The visitor every field of the current scope is dispatched to. Held as a
   * field rather than re-derived per field from a stack top, because that is two
   * loads and a bounds check at every one of the dozen dispatch sites below, on
   * a path that runs per array element.
   */
  private cur: Visitor = EMPTY_VISITOR;
  /** Set once the first {@link push} has installed its root visitor into {@link cur}. */
  private rooted = false;
  /**
   * Enclosing visitors, indexed by the depth they were suspended at — the
   * *parents* of {@link cur}, not including it. Allocated on the first nested
   * sequence, so a flat message (no sequence field at all) costs no array at
   * all; entries are overwritten in place rather than pushed and popped, so a
   * message that nests repeatedly allocates once.
   */
  private parents: Visitor[] | null = null;
  /** Number of nested sequences currently open — 0 at the root scope. */
  private depth = 0;

  // current field
  private id = 0;

  // Resumable varint accumulator, as two unsigned 32-bit halves (vLo / vHi)
  // plus the byte count so far. Number-only: a `bigint` is built once, at the
  // end, and only for full 64-bit *values* (not ids, lengths or counts).
  private vLo = 0;
  private vHi = 0;
  private vBytes = 0;
  private vComplete = false;

  /**
   * Resumable fp32 / fp64 accumulator, as two little-endian 32-bit words rather
   * than a per-decoder `Uint8Array(8)`. A typed array costs a backing-store
   * allocation (and later a free) per `IStream`, which on a short message is a
   * measurable share of the whole decode; two number fields cost nothing and
   * hold the same 8 bytes. Byte `k` lands in bits `8*k` of `fpLo` (k < 4) or of
   * `fpHi`, so the pair is already in wire (little-endian) order.
   */
  private fpLo = 0;
  private fpHi = 0;
  private need = 0;
  private have = 0;

  // fixlen string/blob streaming
  private fixSub: FixlenSubtype = FixlenSubtype.String;
  private fixLen = 0;
  private fixOff = 0;

  // array
  private arrKind: ArrayKind = ArrayKind.Unsigned;
  private arrIsFixlen = false;
  private arrCount = 0;
  private arrIndex = 0;

  // Opt-in decode limits (corelib-ts#38); an unset limit is Infinity (no cap).
  // Enforced at the count / length header, before any payload is streamed to
  // the visitor, so an over-limit string/blob is never fed chunk-by-chunk.
  private readonly maxArrayCount: number;
  private readonly maxStringLen: number;
  private readonly maxBlobLen: number;

  constructor(limits?: DecodeLimits) {
    this.maxArrayCount = limits?.maxArrayCount ?? Infinity;
    this.maxStringLen = limits?.maxStringLen ?? Infinity;
    this.maxBlobLen = limits?.maxBlobLen ?? Infinity;
  }

  /** Feed `input` to the machine, dispatching to `root` and its sub-visitors. */
  push(input: Uint8Array, root: Visitor): void {
    // The root is bound by the first feed; later feeds continue with it, so a
    // caller cannot swap visitors mid-message.
    if (!this.rooted) {
      this.rooted = true;
      this.cur = root;
    }
    let i = 0;
    const n = input.length;

    while (i < n) {
      switch (this.state) {
        case S.Header: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const type = this.vTag();
          if (type === WireType.SequenceEnd) {
            this.endSequence();
            break;
          }
          const id = this.vUpper();
          if (id > ID_MAX) throw invalidMsgError(`field id ${id} out of range`);
          this.id = id;
          this.dispatch(type);
          break;
        }

        case S.ScalarU: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const value = this.vUnsigned();
          this.state = S.Header;
          this.cur.unsigned?.(this.id, value);
          break;
        }

        case S.ScalarS: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const value = this.vSigned();
          this.state = S.Header;
          this.cur.signed?.(this.id, value);
          break;
        }

        case S.FixlenLen: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const sub = this.vTag();
          const len = this.vUpper();
          if (sub > FixlenSubtype.Blob) throw invalidMsgError(`invalid fixlen subtype ${sub}`);
          if (len > FIXLEN_MAX) throw invalidMsgError("fixlen length out of range");
          if (sub === FixlenSubtype.String && len > this.maxStringLen) {
            throw limitExceededError(`string length ${len} exceeds maxStringLen ${this.maxStringLen}`);
          }
          if (sub === FixlenSubtype.Blob && len > this.maxBlobLen) {
            throw limitExceededError(`blob length ${len} exceeds maxBlobLen ${this.maxBlobLen}`);
          }
          this.fixSub = sub as FixlenSubtype;
          this.fixLen = len;
          this.fixOff = 0;
          if (sub === FixlenSubtype.Fp32 || sub === FixlenSubtype.Fp64) {
            const want = sub === FixlenSubtype.Fp32 ? 4 : 8;
            if (this.fixLen !== want) throw invalidMsgError("fixlen float length mismatch");
            this.fpBegin(want);
            this.state = S.FixlenFp;
          } else {
            // string / blob: emit empties immediately, otherwise stream below
            if (this.fixLen === 0) {
              this.emitBytes(input.subarray(0, 0));
              this.state = S.Header;
            } else {
              this.state = S.FixlenBytes;
            }
          }
          break;
        }

        case S.FixlenFp: {
          i = this.fpStep(input, i);
          if (this.have < this.need) return;
          const isFp32 = this.fixSub === FixlenSubtype.Fp32;
          const value = isFp32
            ? fp32FromBits(this.fpLo)
            : fp64FromBits(this.fpLo, this.fpHi);
          this.state = S.Header;
          if (isFp32) {
            // Pass the raw 4 LE bytes only when the visitor opts in
            // (Visitor.fp32Raw): `value` (a double) would have quieted a
            // signaling NaN (§4.6), but the view is waste for a value consumer.
            const top = this.cur;
            top.fp32?.(this.id, value, top.fp32Raw ? rawFp32Bytes(this.fpLo) : undefined);
          } else this.cur.fp64?.(this.id, value);
          break;
        }

        case S.FixlenBytes: {
          const take = Math.min(n - i, this.fixLen - this.fixOff);
          this.emitBytes(input.subarray(i, i + take));
          i += take;
          this.fixOff += take;
          if (this.fixOff === this.fixLen) this.state = S.Header;
          break;
        }

        case S.ArrayCount: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const count = this.vNum();
          if (count > ARRAY_MAX) throw invalidMsgError("array count out of range");
          if (count > this.maxArrayCount) {
            throw limitExceededError(`array count ${count} exceeds maxArrayCount ${this.maxArrayCount}`);
          }
          this.arrCount = count;
          this.arrIndex = 0;
          if (this.arrIsFixlen) {
            // §4.8: a fixlen array always carries its element-length word — even
            // when empty — so the true element kind (fp32 vs fp64) stays known.
            // The element kind is only knowable once that word arrives, so defer
            // arrayBegin until then; a zero-count array reads the word then ends
            // with no payload (handled in S.ArrayElemLen).
            this.state = S.ArrayElemLen;
          } else if (count === 0) {
            // §4.7: a zero-count integer array is empty — no payload follows and
            // no element-length word exists (element width is API-only).
            this.state = S.Header;
            this.cur.arrayBegin?.(this.id, this.arrKind, 0);
            this.cur.arrayEnd?.(this.id);
          } else {
            this.state = this.arrKind === ArrayKind.Unsigned ? S.ArrayUElem : S.ArraySElem;
            this.cur.arrayBegin?.(this.id, this.arrKind, this.arrCount);
          }
          break;
        }

        case S.ArrayUElem: {
          // Bulk drain: while a whole element varint is known to be present,
          // decode elements back to back without re-entering the outer state
          // switch or the resumable accumulator once per element. The tail —
          // the last few bytes of the chunk, where an element may straddle the
          // boundary — falls through to the single-element path below, which is
          // the one that suspends and resumes.
          const cur = this.cur;
          const id = this.id;
          const count = this.arrCount;
          // Hoisted bound: past `safeEnd` an element could straddle the chunk,
          // so the bulk loop stops and the resumable tail below takes over.
          const safeEnd = n - VARINT_MAX_BYTES;
          let idx = this.arrIndex;
          // Only enter the bulk path at a clean element boundary: a varint left
          // half-read by the previous chunk lives in the accumulator, and
          // `varintFull` would start a fresh one and drop it. Testing `vBytes`
          // once is enough — every `varintFull` completes, leaving it 0, so the
          // invariant holds for the rest of the loop.
          if (this.vBytes === 0) {
            while (idx < count && i <= safeEnd) {
              i = this.varintFull(input, i);
              // vUnsigned() inlined: on this path the halves are already in
              // hand, and the call is a per-element cost the loop need not pay.
              const vhi = this.vHi >>> 0;
              const v =
                vhi <= 0x1fffff ? vhi * TWO32 + (this.vLo >>> 0) : joinU64(this.vLo >>> 0, vhi);
              cur.arrayUnsigned?.(id, idx, v);
              this.arrIndex = ++idx;
            }
          }
          if (idx === count) {
            this.state = S.Header;
            cur.arrayEnd?.(id);
            break;
          }
          if (i >= n) break;
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const value = this.vUnsigned();
          cur.arrayUnsigned?.(id, idx, value);
          this.advanceArray();
          break;
        }

        case S.ArraySElem: {
          const cur = this.cur;
          const id = this.id;
          const count = this.arrCount;
          const safeEnd = n - VARINT_MAX_BYTES;
          let idx = this.arrIndex;
          // See the unsigned arm: never bulk-decode over a pending partial varint.
          if (this.vBytes === 0) {
            while (idx < count && i <= safeEnd) {
              i = this.varintFull(input, i);
              const vhi = this.vHi >>> 0;
              const vlo = this.vLo >>> 0;
              let v: number | bigint;
              if (vhi <= 0x1fffff) {
                const r = vhi * TWO32 + vlo; // raw zig-zag, ≤ 2^53-1
                v = r % 2 === 0 ? r / 2 : -(r + 1) / 2;
              } else {
                v = zigzagDecodeLoHi(vlo, vhi);
              }
              cur.arraySigned?.(id, idx, v);
              this.arrIndex = ++idx;
            }
          }
          if (idx === count) {
            this.state = S.Header;
            cur.arrayEnd?.(id);
            break;
          }
          if (i >= n) break;
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const value = this.vSigned();
          cur.arraySigned?.(id, idx, value);
          this.advanceArray();
          break;
        }

        case S.ArrayElemLen: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const sub = this.vTag();
          const size = this.vUpper();
          if (sub === FixlenSubtype.Fp32 && size === 4) {
            this.arrKind = ArrayKind.Fp32;
            this.fpBegin(4);
          } else if (sub === FixlenSubtype.Fp64 && size === 8) {
            this.arrKind = ArrayKind.Fp64;
            this.fpBegin(8);
          } else {
            throw invalidMsgError("invalid fixlen array element type");
          }
          if (this.arrCount === 0) {
            // §4.8: an empty fixlen array is [ header ][ count = 0 ][ fixlen_word ]
            // with no payload — the word above yielded the true element kind.
            this.state = S.Header;
            this.cur.arrayBegin?.(this.id, this.arrKind, this.arrCount);
            this.cur.arrayEnd?.(this.id);
          } else {
            this.state = S.ArrayFp;
            this.cur.arrayBegin?.(this.id, this.arrKind, this.arrCount);
          }
          break;
        }

        case S.ArrayFp: {
          i = this.fpStep(input, i);
          if (this.have < this.need) return;
          const isFp32 = this.arrKind === ArrayKind.Fp32;
          const value = isFp32
            ? fp32FromBits(this.fpLo)
            : fp64FromBits(this.fpLo, this.fpHi);
          const bits = this.fpLo;
          this.fpBegin(this.need); // next element starts from a clear accumulator
          if (isFp32) {
            const top = this.cur;
            top.arrayFp32?.(this.id, this.arrIndex, value, top.fp32Raw ? rawFp32Bytes(bits) : undefined);
          } else this.cur.arrayFp64?.(this.id, this.arrIndex, value);
          this.advanceArray();
          break;
        }
      }
    }
  }

  /**
   * Report the terminal decode outcome (MESSAGE_SPEC §7) *without* promoting it
   * to an error. Returns {@link DecodeStatus.Complete} when the stream ended
   * exactly at a field boundary, or {@link DecodeStatus.Incomplete} when it
   * ended inside a field (a partial varint, an unfinished payload / array, or a
   * still-open nested sequence). This is a pure accessor — the finish-less spec
   * has no finalize step, and a trailing `Incomplete` is a truncation the caller
   * decides how to treat, not an error this machine raises. A genuinely
   * malformed message has already thrown from {@link push}.
   */
  finish(): DecodeStatus {
    const atBoundary =
      this.state === S.Header && this.vBytes === 0 && this.depth === 0;
    return atBoundary ? DecodeStatus.Complete : DecodeStatus.Incomplete;
  }

  // --- helpers ------------------------------------------------------------

  private dispatch(type: number): void {
    switch (type) {
      case WireType.Unsigned:
        this.state = S.ScalarU;
        break;
      case WireType.Signed:
        this.state = S.ScalarS;
        break;
      case WireType.Fixlen:
        this.state = S.FixlenLen;
        break;
      case WireType.ArrayUnsigned:
        this.arrKind = ArrayKind.Unsigned;
        this.arrIsFixlen = false;
        this.state = S.ArrayCount;
        break;
      case WireType.ArraySigned:
        this.arrKind = ArrayKind.Signed;
        this.arrIsFixlen = false;
        this.state = S.ArrayCount;
        break;
      case WireType.ArrayFixlen:
        this.arrIsFixlen = true; // element kind resolved at the element-length word
        this.state = S.ArrayCount;
        break;
      case WireType.SequenceStart: {
        // §4.9/§6.2: reject nesting deeper than MAX_DEPTH.
        const d = this.depth;
        if (d >= MAX_DEPTH) {
          throw invalidMsgError(`nesting exceeds MAX_DEPTH (${MAX_DEPTH})`);
        }
        const parent = this.cur;
        const child = parent.sequenceBegin?.(this.id) ?? parent;
        (this.parents ??= [])[d] = parent;
        this.depth = d + 1;
        this.cur = child;
        this.state = S.Header;
        break;
      }
      default:
        throw invalidMsgError(`invalid wire type ${type}`);
    }
  }

  private endSequence(): void {
    const d = this.depth;
    if (d === 0) throw invalidMsgError("unbalanced sequence end");
    this.state = S.Header;
    this.cur.sequenceEnd?.();
    this.depth = d - 1;
    this.cur = this.parents![d - 1]!;
  }

  private advanceArray(): void {
    if (++this.arrIndex === this.arrCount) {
      this.state = S.Header;
      this.cur.arrayEnd?.(this.id);
    }
  }

  private emitBytes(chunk: Uint8Array): void {
    const v = this.cur;
    if (this.fixSub === FixlenSubtype.String) v.string?.(this.id, this.fixLen, this.fixOff, chunk);
    else v.blob?.(this.id, this.fixLen, this.fixOff, chunk);
  }

  /**
   * Consume varint bytes from `input` at `i` into the {@link vLo} / {@link vHi}
   * accumulator, resuming across chunk boundaries; sets {@link vComplete} when a
   * terminator byte arrives. Number-only — no per-byte `bigint`.
   */
  private varintStep(input: Uint8Array, i: number): number {
    // Fast path: a one-byte varint, which is what every small id, length, count
    // and scalar is. Resolved with a single load and no resume bookkeeping.
    if (this.vBytes === 0) {
      const n0 = input.length;
      const b0 = input[i]!;
      if (b0 < 0x80) {
        this.vLo = b0;
        this.vHi = 0;
        this.vComplete = true;
        return i + 1;
      }
      // Two- and three-byte varints resolved inline — that is every id past 15,
      // every mid-sized length or count, and the zig-zag of a small signed
      // scalar. Handling them here rather than in `varintFull` keeps a short
      // message off the call entirely.
      if (i + 1 < n0) {
        const b1 = input[i + 1]!;
        if (b1 < 0x80) {
          this.vLo = (b0 & 0x7f) | (b1 << 7);
          this.vHi = 0;
          this.vComplete = true;
          return i + 2;
        }
        if (i + 2 < n0) {
          const b2 = input[i + 2]!;
          if (b2 < 0x80) {
            this.vLo = (b0 & 0x7f) | ((b1 & 0x7f) << 7) | (b2 << 14);
            this.vHi = 0;
            this.vComplete = true;
            return i + 3;
          }
        }
      }
      // Longer, and the whole of it is in this chunk: take the unrolled reader,
      // which needs no per-byte resume state at all.
      if (n0 - i >= VARINT_MAX_BYTES) return this.varintFull(input, i);
    }

    // A completed varint leaves `vBytes` at 0 and `vLo`/`vHi` stale, so a fresh
    // accumulation must start from zero rather than from those dead halves.
    const k0 = this.vBytes;
    let lo = k0 === 0 ? 0 : this.vLo;
    let hi = k0 === 0 ? 0 : this.vHi;
    let k = k0;
    const n = input.length;
    while (i < n) {
      if (k >= VARINT_MAX_BYTES) throw invalidMsgError("varint overflow");
      const b = input[i++]!;
      if (k < 4) lo |= (b & 0x7f) << (7 * k);
      else if (k === 4) {
        lo |= (b & 0x0f) << 28;
        hi |= (b >> 4) & 0x07;
      } else {
        // 10th byte (k === 9) has only bit 63 below 64; any higher payload
        // bit would spill past bit 63 and is a >64-bit overflow.
        if (k === 9 && ((b & 0x7f) >> 1) !== 0) throw invalidMsgError("varint overflow");
        hi |= (b & 0x7f) << (7 * k - 32);
      }
      k++;
      if ((b & 0x80) === 0) {
        this.vLo = lo;
        this.vHi = hi;
        // Zero the byte count on completion rather than in a separate reset
        // pass: the accumulator is consumed by the caller in the same switch
        // arm, and starting the *next* varint from `vBytes === 0` is what makes
        // `vLo`/`vHi` dead — so they need no clearing either. `finish()` still
        // reads `vBytes === 0` as "not mid-varint", which is exactly right here.
        this.vBytes = 0;
        this.vComplete = true;
        return i;
      }
    }
    this.vLo = lo;
    this.vHi = hi;
    this.vBytes = k;
    this.vComplete = false;
    return i;
  }

  /**
   * Decode one varint that is **guaranteed** to lie wholly within `input` —
   * the caller has checked that {@link VARINT_MAX_BYTES} bytes remain — into
   * {@link vLo} / {@link vHi}, returning the index past it.
   *
   * Unrolled and branch-per-byte like the contiguous decoder's reader: with the
   * bytes known to be present there is no bounds check, no resume counter and no
   * `k`-dispatch per byte, which is the whole per-byte cost of the resumable
   * loop above. Reports the same `>64-bit` overflow as that loop.
   */
  private varintFull(input: Uint8Array, i: number): number {
    let b = input[i]!;
    let lo = b & 0x7f;
    let hi = 0;
    if (b < 0x80) return this.setVarint(lo, 0, i + 1);

    b = input[i + 1]!;
    lo |= (b & 0x7f) << 7;
    if (b < 0x80) return this.setVarint(lo, 0, i + 2);

    b = input[i + 2]!;
    lo |= (b & 0x7f) << 14;
    if (b < 0x80) return this.setVarint(lo, 0, i + 3);

    b = input[i + 3]!;
    lo |= (b & 0x7f) << 21;
    if (b < 0x80) return this.setVarint(lo, 0, i + 4);

    // 5th byte straddles the 32-bit boundary: 4 bits to lo, 3 bits to hi.
    b = input[i + 4]!;
    lo |= (b & 0x0f) << 28;
    hi = (b >> 4) & 0x07;
    if (b < 0x80) return this.setVarint(lo, hi, i + 5);

    b = input[i + 5]!;
    hi |= (b & 0x7f) << 3;
    if (b < 0x80) return this.setVarint(lo, hi, i + 6);

    b = input[i + 6]!;
    hi |= (b & 0x7f) << 10;
    if (b < 0x80) return this.setVarint(lo, hi, i + 7);

    b = input[i + 7]!;
    hi |= (b & 0x7f) << 17;
    if (b < 0x80) return this.setVarint(lo, hi, i + 8);

    b = input[i + 8]!;
    hi |= (b & 0x7f) << 24;
    if (b < 0x80) return this.setVarint(lo, hi, i + 9);

    // 10th byte: only bit 63 (1 payload bit) remains below 64; any higher
    // payload bit, or a continuation into an 11th byte, is a >64-bit overflow.
    b = input[i + 9]!;
    if (((b & 0x7f) >> 1) !== 0) throw invalidMsgError("varint overflow");
    hi |= (b & 0x7f) << 31;
    if (b < 0x80) return this.setVarint(lo, hi, i + 10);

    throw invalidMsgError("varint overflow");
  }

  /** Publish a fully-decoded varint and the cursor past it (see {@link varintFull}). */
  private setVarint(lo: number, hi: number, i: number): number {
    this.vLo = lo;
    this.vHi = hi;
    this.vBytes = 0;
    this.vComplete = true;
    return i;
  }

  /**
   * The accumulated varint as an unsigned value, number-first: a `number` when
   * it fits exactly (`≤ 2^53-1`, which covers all ids, u8..u32 and small u64s),
   * a `bigint` only beyond that. Avoids a bigint allocation on the common path.
   */
  private vUnsigned(): number | bigint {
    // Unsigned: vHi's bit 31 must not read as negative. vHi ≤ 0x1fffff (2^21-1)
    // ⇔ vHi*2^32 + lo ≤ 2^53-1.
    const hi = this.vHi >>> 0;
    return hi <= 0x1fffff
      ? hi * TWO32 + (this.vLo >>> 0)
      : joinU64(this.vLo >>> 0, hi); // one bigint, not four (bits64)
  }

  /** The accumulated zig-zag varint as a signed value, number-first (see {@link vUnsigned}). */
  private vSigned(): number | bigint {
    const hi = this.vHi >>> 0;
    if (hi <= 0x1fffff) {
      const r = hi * TWO32 + (this.vLo >>> 0); // raw zig-zag, ≤ 2^53-1
      return r % 2 === 0 ? r / 2 : -(r + 1) / 2;
    }
    return zigzagDecodeLoHi(this.vLo >>> 0, hi);
  }

  /** The accumulated varint as a JS number — exact for ids/lengths/counts. */
  private vNum(): number {
    return this.vHi * TWO32 + (this.vLo >>> 0);
  }

  /** The accumulated varint's low 3 tag bits (the wire type / fixlen subtype). */
  private vTag(): number {
    return this.vLo & 7;
  }

  /** The accumulated varint with its low 3 tag bits stripped (`value >> 3`). */
  private vUpper(): number {
    return (this.vHi >>> 0) * (TWO32 / 8) + (this.vLo >>> 3);
  }

  /** Accumulate `need` raw bytes into {@link fpLo} / {@link fpHi}. */
  private fpStep(input: Uint8Array, i: number): number {
    const n = input.length;
    let have = this.have;
    const need = this.need;
    while (have < need && i < n) {
      const b = input[i++]!;
      if (have < 4) this.fpLo |= b << (have << 3);
      else this.fpHi |= b << ((have - 4) << 3);
      have++;
    }
    this.have = have;
    return i;
  }

  /** Start a fresh fp accumulation of `need` bytes. */
  private fpBegin(need: number): void {
    this.need = need;
    this.have = 0;
    this.fpLo = 0;
    this.fpHi = 0;
  }
}
