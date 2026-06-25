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

const FIXLEN_MAX_BIG = BigInt(FIXLEN_MAX);
const ARRAY_MAX_BIG = BigInt(ARRAY_MAX);
const ID_MAX_BIG = BigInt(ID_MAX);

export class DecoderState {
  private state = S.Header;
  private stack: Visitor[] = [];

  // current field
  private id = 0;

  // resumable varint accumulator
  private vAcc = 0n;
  private vShift = 0n;
  private vBytes = 0;
  private vValue = 0n;
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
          const header = this.vValue;
          this.resetVarint();
          const type = Number(header & 7n);
          if (type === WireType.SequenceEnd) {
            this.endSequence();
            break;
          }
          const idBig = header >> 3n;
          if (idBig > ID_MAX_BIG) throw invalidMsgError(`field id ${idBig} out of range`);
          this.id = Number(idBig);
          this.dispatch(type);
          break;
        }

        case S.ScalarU: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          this.top().unsigned?.(this.id, this.vValue);
          this.resetVarint();
          this.state = S.Header;
          break;
        }

        case S.ScalarS: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          this.top().signed?.(this.id, zigzagDecode(this.vValue));
          this.resetVarint();
          this.state = S.Header;
          break;
        }

        case S.FixlenLen: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const word = this.vValue;
          this.resetVarint();
          const sub = Number(word & 7n);
          const lenBig = word >> 3n;
          if (sub > FixlenSubtype.Blob) throw invalidMsgError(`invalid fixlen subtype ${sub}`);
          if (lenBig > FIXLEN_MAX_BIG) throw invalidMsgError("fixlen length out of range");
          this.fixSub = sub as FixlenSubtype;
          this.fixLen = Number(lenBig);
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
          const cBig = this.vValue;
          this.resetVarint();
          if (cBig < 1n || cBig > ARRAY_MAX_BIG) throw invalidMsgError("array count out of range");
          this.arrCount = Number(cBig);
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
          this.top().arrayUnsigned?.(this.id, this.arrIndex, this.vValue);
          this.resetVarint();
          this.advanceArray();
          break;
        }

        case S.ArraySElem: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          this.top().arraySigned?.(this.id, this.arrIndex, zigzagDecode(this.vValue));
          this.resetVarint();
          this.advanceArray();
          break;
        }

        case S.ArrayElemLen: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const word = this.vValue;
          this.resetVarint();
          const sub = Number(word & 7n);
          const size = Number(word >> 3n);
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

  /** Consume varint bytes from `input` at `i`; sets {@link vComplete}. */
  private varintStep(input: Uint8Array, i: number): number {
    while (i < input.length) {
      if (this.vBytes >= VARINT_MAX_BYTES) throw invalidMsgError("varint overflow");
      const b = input[i++]!;
      this.vAcc |= BigInt(b & 0x7f) << this.vShift;
      this.vBytes++;
      if ((b & 0x80) === 0) {
        this.vValue = this.vAcc;
        this.vComplete = true;
        return i;
      }
      this.vShift += 7n;
    }
    this.vComplete = false;
    return i;
  }

  private resetVarint(): void {
    this.vAcc = 0n;
    this.vShift = 0n;
    this.vBytes = 0;
    this.vComplete = false;
  }

  /** Accumulate `need` raw bytes into {@link scratch}. */
  private fpStep(input: Uint8Array, i: number): number {
    while (this.have < this.need && i < input.length) {
      this.scratch[this.have++] = input[i++]!;
    }
    return i;
  }
}
