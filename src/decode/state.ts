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
  FIXLEN_MAX,
  FixlenSubtype,
  ID_MAX,
  VARINT_MAX_BYTES,
  WireType,
} from "../constants.js";
import { invalidMsgError } from "../errors.js";
import { unpackFp32, unpackFp64 } from "../varint/num64.js";
import { zigzagDecode } from "../varint/zigzag.js";
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

export class DecoderState {
  private state = S.Header;
  private stack: Visitor[] = [];

  // current field
  private id = 0;

  // Resumable varint accumulator, as two unsigned 32-bit halves (vLo / vHi)
  // plus the byte count so far. Number-only: a `bigint` is built once, at the
  // end, and only for full 64-bit *values* (not ids, lengths or counts).
  private vLo = 0;
  private vHi = 0;
  private vBytes = 0;
  private vComplete = false;

  // fixlen / fp scratch
  private scratch = new Uint8Array(8);
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

  /** Feed `input` to the machine, dispatching to `root` and its sub-visitors. */
  push(input: Uint8Array, root: Visitor): void {
    if (this.stack.length === 0) this.stack.push(root);
    let i = 0;
    const n = input.length;

    while (i < n) {
      switch (this.state) {
        case S.Header: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const type = this.vTag();
          if (type === WireType.SequenceEnd) {
            this.resetVarint();
            this.endSequence();
            break;
          }
          const id = this.vUpper();
          this.resetVarint();
          if (id > ID_MAX) throw invalidMsgError(`field id ${id} out of range`);
          this.id = id;
          this.dispatch(type);
          break;
        }

        case S.ScalarU: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const value = this.vBig();
          this.resetVarint();
          this.top().unsigned?.(this.id, value);
          this.state = S.Header;
          break;
        }

        case S.ScalarS: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const value = zigzagDecode(this.vBig());
          this.resetVarint();
          this.top().signed?.(this.id, value);
          this.state = S.Header;
          break;
        }

        case S.FixlenLen: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const sub = this.vTag();
          const len = this.vUpper();
          this.resetVarint();
          if (sub > FixlenSubtype.Blob) throw invalidMsgError(`invalid fixlen subtype ${sub}`);
          if (len > FIXLEN_MAX) throw invalidMsgError("fixlen length out of range");
          this.fixSub = sub as FixlenSubtype;
          this.fixLen = len;
          this.fixOff = 0;
          if (sub === FixlenSubtype.Fp32 || sub === FixlenSubtype.Fp64) {
            const want = sub === FixlenSubtype.Fp32 ? 4 : 8;
            if (this.fixLen !== want) throw invalidMsgError("fixlen float length mismatch");
            this.need = want;
            this.have = 0;
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
          const value =
            this.fixSub === FixlenSubtype.Fp32
              ? unpackFp32(this.scratch, 0)
              : unpackFp64(this.scratch, 0);
          if (this.fixSub === FixlenSubtype.Fp32) this.top().fp32?.(this.id, value);
          else this.top().fp64?.(this.id, value);
          this.state = S.Header;
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
          this.resetVarint();
          if (count < 1 || count > ARRAY_MAX) throw invalidMsgError("array count out of range");
          this.arrCount = count;
          this.arrIndex = 0;
          if (this.arrIsFixlen) {
            // element kind (fp32 vs fp64) is only known once the element-length
            // word arrives, so defer arrayBegin until then.
            this.state = S.ArrayElemLen;
          } else {
            this.top().arrayBegin?.(this.id, this.arrKind, this.arrCount);
            this.state = this.arrKind === ArrayKind.Unsigned ? S.ArrayUElem : S.ArraySElem;
          }
          break;
        }

        case S.ArrayUElem: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const value = this.vBig();
          this.resetVarint();
          this.top().arrayUnsigned?.(this.id, this.arrIndex, value);
          this.advanceArray();
          break;
        }

        case S.ArraySElem: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const value = zigzagDecode(this.vBig());
          this.resetVarint();
          this.top().arraySigned?.(this.id, this.arrIndex, value);
          this.advanceArray();
          break;
        }

        case S.ArrayElemLen: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const sub = this.vTag();
          const size = this.vUpper();
          this.resetVarint();
          if (sub === FixlenSubtype.Fp32 && size === 4) {
            this.arrKind = ArrayKind.Fp32;
            this.need = 4;
          } else if (sub === FixlenSubtype.Fp64 && size === 8) {
            this.arrKind = ArrayKind.Fp64;
            this.need = 8;
          } else {
            throw invalidMsgError("invalid fixlen array element type");
          }
          this.top().arrayBegin?.(this.id, this.arrKind, this.arrCount);
          this.have = 0;
          this.state = S.ArrayFp;
          break;
        }

        case S.ArrayFp: {
          i = this.fpStep(input, i);
          if (this.have < this.need) return;
          const value =
            this.arrKind === ArrayKind.Fp32
              ? unpackFp32(this.scratch, 0)
              : unpackFp64(this.scratch, 0);
          if (this.arrKind === ArrayKind.Fp32) this.top().arrayFp32?.(this.id, this.arrIndex, value);
          else this.top().arrayFp64?.(this.id, this.arrIndex, value);
          this.have = 0;
          this.advanceArray();
          break;
        }
      }
    }
  }

  /** Assert the stream ended cleanly at a field boundary; throws otherwise. */
  finish(): void {
    if (this.state !== S.Header || this.vBytes !== 0) {
      throw invalidMsgError("truncated message: ended mid-field");
    }
    if (this.stack.length > 1) {
      throw invalidMsgError("truncated message: unbalanced sequence");
    }
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
        const child = this.top().sequenceBegin?.(this.id);
        this.stack.push(child ?? this.top());
        this.state = S.Header;
        break;
      }
      default:
        throw invalidMsgError(`invalid wire type ${type}`);
    }
  }

  private endSequence(): void {
    if (this.stack.length <= 1) throw invalidMsgError("unbalanced sequence end");
    this.top().sequenceEnd?.();
    this.stack.pop();
    this.state = S.Header;
  }

  private advanceArray(): void {
    this.arrIndex++;
    if (this.arrIndex === this.arrCount) {
      this.top().arrayEnd?.(this.id);
      this.state = S.Header;
    }
  }

  private emitBytes(chunk: Uint8Array): void {
    const v = this.top();
    if (this.fixSub === FixlenSubtype.String) v.string?.(this.id, this.fixLen, this.fixOff, chunk);
    else v.blob?.(this.id, this.fixLen, this.fixOff, chunk);
  }

  private top(): Visitor {
    return this.stack[this.stack.length - 1]!;
  }

  /**
   * Consume varint bytes from `input` at `i` into the {@link vLo} / {@link vHi}
   * accumulator, resuming across chunk boundaries; sets {@link vComplete} when a
   * terminator byte arrives. Number-only — no per-byte `bigint`.
   */
  private varintStep(input: Uint8Array, i: number): number {
    let lo = this.vLo;
    let hi = this.vHi;
    let k = this.vBytes;
    const n = input.length;
    while (i < n) {
      if (k >= VARINT_MAX_BYTES) throw invalidMsgError("varint overflow");
      const b = input[i++]!;
      if (k < 4) lo |= (b & 0x7f) << (7 * k);
      else if (k === 4) {
        lo |= (b & 0x0f) << 28;
        hi |= (b >> 4) & 0x07;
      } else hi |= (b & 0x7f) << (7 * k - 32);
      k++;
      if ((b & 0x80) === 0) {
        this.vLo = lo;
        this.vHi = hi;
        this.vBytes = k;
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

  private resetVarint(): void {
    this.vLo = 0;
    this.vHi = 0;
    this.vBytes = 0;
    this.vComplete = false;
  }

  /** The accumulated varint as a `bigint` (full 64-bit fidelity). */
  private vBig(): bigint {
    return this.vHi === 0
      ? BigInt(this.vLo >>> 0)
      : (BigInt(this.vHi >>> 0) << 32n) | BigInt(this.vLo >>> 0);
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

  /** Accumulate `need` raw bytes into {@link scratch}. */
  private fpStep(input: Uint8Array, i: number): number {
    while (this.have < this.need && i < input.length) {
      this.scratch[this.have++] = input[i++]!;
    }
    return i;
  }
}
