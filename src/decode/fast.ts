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
 *   shift-and-or for every single byte. That varint reader — with the cursor,
 *   the zero-copy `take` and the float readers — lives on {@link BufferReader}
 *   ({@link "./reader"}), shared with the pull decoder {@link "./cursor"}
 *   instead of copied into it (corelib-ts#114).
 * - **No per-byte state reload.** The field type is dispatched once and the
 *   whole field is consumed in place, instead of re-entering a `switch` on a
 *   saved state enum for each byte.
 *
 * String / blob payloads are handed to the visitor as a single zero-copy
 * `subarray` view (one call, offset 0) rather than streamed in pieces. The
 * decoder validates exactly what the streaming path does and reports the same
 * three-valued outcome (MESSAGE_SPEC §7): it throws a {@link SofabError} with
 * code `INVALID_MSG` on malformed input, and `INCOMPLETE` when the buffer ends
 * inside a field — a truncated varint / payload / array, or an unclosed
 * sequence detected at the end of the buffer.
 */

import {
  ARRAY_MAX,
  ArrayKind,
  FIXLEN_MAX,
  FixlenSubtype,
  ID_MAX,
  MAX_DEPTH,
  WireType,
} from "../constants.js";
import {
  incompleteError,
  invalidMsgError,
  limitExceededError,
} from "../errors.js";
import { Long } from "../long.js";
import { zigzagDecodeLong } from "../varint/zigzag.js";
import type { DecodeLimits } from "./limits.js";
import type { AnyVisitor } from "./istream.js";
import { BufferReader } from "./reader.js";

/** Decode a complete message held in one contiguous buffer. */
export function decodeContiguous(
  buf: Uint8Array,
  root: AnyVisitor,
  limits?: DecodeLimits,
): void {
  new FastDecoder(buf, limits).run(root);
}

class FastDecoder extends BufferReader {
  // Opt-in decode limits (corelib-ts#38); an unset limit is Infinity (no cap).
  private readonly maxArrayCount: number;
  private readonly maxStringLen: number;
  private readonly maxBlobLen: number;

  constructor(buf: Uint8Array, limits?: DecodeLimits) {
    super(buf);
    this.maxArrayCount = limits?.maxArrayCount ?? Infinity;
    this.maxStringLen = limits?.maxStringLen ?? Infinity;
    this.maxBlobLen = limits?.maxBlobLen ?? Infinity;
  }

  run(root: AnyVisitor): void {
    // A null slot is a skipped scope (Visitor.sequenceBegin returned null).
    // Every dispatch below goes through `top?.`, so a null slot short-circuits
    // the call AND its arguments — no value is decoded into existence for a
    // visitor that does not exist. The stack still grows, so MAX_DEPTH and the
    // balance check cover skipped scopes exactly as they cover live ones.
    const stack: (AnyVisitor | null)[] = [root];
    let top: AnyVisitor | null = root;
    // Visitor.longs, read ONCE — from the root visitor, for the whole decode.
    // Not per field, and deliberately not per scope either: re-reading an
    // optional property off a differently-shaped visitor object is the
    // megamorphic load this decoder is shaped to avoid, and doing it at the two
    // sequence transitions cost +1.1% Ir/op on `decode: typical message` — one
    // nested sequence, so three such loads — to buy a flexibility no caller
    // wants, a generated message tree being uniformly one channel or the other.
    // See Visitor.longs: the ROOT decides, and a child's own flag is ignored.
    const longs = root.longs === true;

    while (this.p < this.n) {
      this.readVarint();
      const type = this.lo & 7;

      // §4.9/§6.2: the ceiling binds *every* field header, the sequence end
      // included — a sequence end's id is discarded, but discarded is not
      // unvalidated. Splitting and checking the id before dispatching on the
      // wire type keeps this one unconditional guard on the header path with no
      // per-wire-type exception (documentation#35).
      const id = this.upper();
      if (id > ID_MAX) throw invalidMsgError(`field id ${id} out of range`);

      if (type === WireType.SequenceEnd) {
        if (stack.length <= 1) throw invalidMsgError("unbalanced sequence end");
        top?.sequenceEnd?.();
        stack.pop();
        top = stack[stack.length - 1]!;
        continue;
      }

      // Announce the header before the value — and before the value's own
      // header word — so an observing visitor sees the field stream in wire
      // order. It carries no verdict of its own: a schema bound waits for the
      // word behind it (CORELIB_PLAN §4.1; see Visitor.fieldBegin).
      top?.fieldBegin?.(id, type as WireType);

      switch (type) {
        case WireType.Unsigned: {
          this.readVarint();
          top?.unsigned?.(id, longs ? new Long(this.lo, this.hi) : this.unsignedValue());
          break;
        }

        case WireType.Signed: {
          this.readVarint();
          top?.signed?.(id, longs ? zigzagDecodeLong(this.lo, this.hi) : this.signedValue());
          break;
        }

        case WireType.Fixlen: {
          this.readVarint();
          const sub = this.lo & 7;
          const len = this.upper();
          if (sub > FixlenSubtype.Blob) throw invalidMsgError(`invalid fixlen subtype ${sub}`);
          if (len > FIXLEN_MAX) throw invalidMsgError("fixlen length out of range");
          // §6.2.1 confines a receiver cap to a schema-UNBOUNDED field, and the
          // pull Cursor honors that by taking the schema bound as an argument
          // (corelib-ts#105). This push surface is driven by wire type alone —
          // it never learns the schema — so it cannot tell the two categories
          // apart and applies the cap to every field. A caller that needs the
          // §6.2.1 distinction on a bounded field decodes it through Cursor, or
          // leaves the cap unset here and enforces the schema bound itself from
          // Visitor.fixlenBegin / arrayBegin, which carry the declared size.
          if (top !== null && sub === FixlenSubtype.String && len > this.maxStringLen) {
            throw limitExceededError(`string length ${len} exceeds maxStringLen ${this.maxStringLen}`);
          }
          if (top !== null && sub === FixlenSubtype.Blob && len > this.maxBlobLen) {
            throw limitExceededError(`blob length ${len} exceeds maxBlobLen ${this.maxBlobLen}`);
          }
          if (sub === FixlenSubtype.Fp32 || sub === FixlenSubtype.Fp64) {
            const want = sub === FixlenSubtype.Fp32 ? 4 : 8;
            if (len !== want) throw invalidMsgError("fixlen float length mismatch");
            if (sub === FixlenSubtype.Fp32) {
              // Hand the visitor the raw 4 wire bytes only when it opts in
              // (Visitor.fp32Raw): `value` (a double) cannot carry an fp32
              // signaling NaN faithfully (§4.6), but the per-value view is pure
              // waste for the common value-only consumer, so it is not allocated.
              const p = this.p;
              const value = this.rawFp32();
              top?.fp32?.(id, value, top.fp32Raw ? this.buf.subarray(p, p + 4) : undefined);
            } else {
              // Read into a local *before* the optional call: `v?.m(read())`
              // would short-circuit and never advance when fp64 is absent.
              const value = this.rawFp64();
              top?.fp64?.(id, value);
            }
          } else if (top === null) {
            // Skipped scope: consume the payload without the `subarray` view
            // take() would allocate for a visitor that is not there.
            this.takeRange(len);
          } else {
            // Announce at the length word first, so a visitor sees `total` at the
            // same point on both paths (see Visitor.fixlenBegin).
            top.fixlenBegin?.(id, sub as FixlenSubtype, len);
            const chunk = this.take(len);
            if (sub === FixlenSubtype.String) top.string?.(id, len, 0, chunk);
            else top.blob?.(id, len, 0, chunk);
          }
          break;
        }

        case WireType.ArrayUnsigned: {
          const count = this.arrayCount(top !== null);
          top?.arrayBegin?.(id, ArrayKind.Unsigned, count);
          for (let i = 0; i < count; i++) {
            this.readVarint();
            top?.arrayUnsigned?.(id, i, longs ? new Long(this.lo, this.hi) : this.unsignedValue());
          }
          top?.arrayEnd?.(id);
          break;
        }

        case WireType.ArraySigned: {
          const count = this.arrayCount(top !== null);
          top?.arrayBegin?.(id, ArrayKind.Signed, count);
          for (let i = 0; i < count; i++) {
            this.readVarint();
            top?.arraySigned?.(id, i, longs ? zigzagDecodeLong(this.lo, this.hi) : this.signedValue());
          }
          top?.arrayEnd?.(id);
          break;
        }

        case WireType.ArrayFixlen: {
          const count = this.arrayCount(top !== null);
          // §4.8: a fixlen array always carries its element-length word — even
          // when empty — so the true element kind (fp32 vs fp64) stays known.
          // When count == 0 the payload loops below simply run zero times.
          this.readVarint();
          const sub = this.lo & 7;
          const size = this.upper();
          let kind: ArrayKind;
          if (sub === FixlenSubtype.Fp32 && size === 4) kind = ArrayKind.Fp32;
          else if (sub === FixlenSubtype.Fp64 && size === 8) kind = ArrayKind.Fp64;
          else throw invalidMsgError("invalid fixlen array element type");
          top?.arrayBegin?.(id, kind, count);
          // Read each element into a local *before* the optional call: with an
          // absent handler, `v?.m(read())` would short-circuit and never advance.
          if (kind === ArrayKind.Fp32) {
            // Hoist the opt-in check out of the loop: a value-only consumer
            // (Visitor.fp32Raw unset) allocates no per-element views.
            const wantRaw = top?.fp32Raw === true;
            for (let i = 0; i < count; i++) {
              const p = this.p;
              const value = this.rawFp32();
              top?.arrayFp32?.(id, i, value, wantRaw ? this.buf.subarray(p, p + 4) : undefined);
            }
          } else {
            for (let i = 0; i < count; i++) {
              const value = this.rawFp64();
              top?.arrayFp64?.(id, i, value);
            }
          }
          top?.arrayEnd?.(id);
          break;
        }

        case WireType.SequenceStart: {
          // §4.9/§6.2: reject nesting deeper than MAX_DEPTH. The stack holds the
          // root plus one entry per open sequence, so depth is stack.length - 1.
          if (stack.length - 1 >= MAX_DEPTH) {
            throw invalidMsgError(`nesting exceeds MAX_DEPTH (${MAX_DEPTH})`);
          }
          // null = skip this subtree; undefined = keep the current visitor.
          // A scope already skipped stays skipped: its children are not offered
          // to anyone, so nesting cannot climb back out of a discarded subtree.
          if (top !== null) {
            const child: AnyVisitor | null | void = top.sequenceBegin?.(id);
            top = child === null ? null : (child ?? top);
          }
          stack.push(top);
          break;
        }

        default:
          throw invalidMsgError(`invalid wire type ${type}`);
      }
    }

    if (stack.length > 1) throw incompleteError("truncated message: unbalanced sequence");
  }

  // --- field helpers ------------------------------------------------------

  /**
   * Read and validate an array count word (0..ARRAY_MAX; §4.7/§4.8).
   *
   * The cap is applied to every array here: this push surface takes no schema
   * count, so it cannot make the §6.2.1 schema-bounded/unbounded distinction the
   * pull {@link Cursor} makes — see the Fixlen case above (corelib-ts#105).
   */
  /**
   * The element-count word, with the format ceiling always applied and the
   * receiver cap only for a scope someone is reading: ARRAY_MAX bounds what the
   * format can express, `maxArrayCount` bounds what this reader is willing to
   * be handed, and a skipped scope hands it nothing.
   */
  private arrayCount(live: boolean): number {
    this.readVarint();
    const count = this.num();
    if (count > ARRAY_MAX) throw invalidMsgError("array count out of range");
    if (live && count > this.maxArrayCount) {
      throw limitExceededError(`array count ${count} exceeds maxArrayCount ${this.maxArrayCount}`);
    }
    return count;
  }
}
