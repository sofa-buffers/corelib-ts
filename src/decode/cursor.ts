/**
 * The pull / cursor decoder: a monomorphic companion to {@link "./fast"}.
 *
 * {@link "./fast"}'s {@link decodeContiguous} is a *push* decoder — it drives the
 * buffer and calls a {@link Visitor} method per field. That is the right shape
 * for streaming and skip-subtree callers, but the visitor call sites go
 * megamorphic once a single decode routes through several differently-shaped
 * visitor objects (one per nested message type), which a JIT cannot inline.
 *
 * {@link Cursor} inverts control: it keeps one read cursor over the contiguous
 * {@link Uint8Array} and exposes *pull* primitives — {@link Cursor.readHeader}
 * plus a typed `read*` per wire type — so **generated code drives the loop** with
 * a single `switch (cursor.id)` that reads straight into its own fields. Every
 * call site is then monomorphic (the generated per-type decoder is the only
 * caller), which is what lets V8 inline the whole decode into a flat loop — the
 * same technique protobuf's generated `decode(reader)` uses.
 *
 * It shares {@link "./fast"}'s number-first varint core — the same code, not a
 * copy of it: both extend {@link BufferReader} ({@link "./reader"},
 * corelib-ts#114). Each varint is accumulated into two 32-bit JS *numbers*
 * (`lo`/`hi`) and a `bigint` is materialised only for a 64-bit *value* that does
 * not fit in `2^53-1` (never for ids, lengths or counts). String / blob payloads
 * are returned as a single
 * zero-copy `subarray` view. It reports the same three-valued outcome as the
 * push path (MESSAGE_SPEC §7): malformed input throws a {@link SofabError} with
 * code `INVALID_MSG`, and a read that runs off the end of the buffer mid-field
 * throws `INCOMPLETE`.
 */

import {
  ARRAY_MAX,
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
import type { DecodeLimits } from "./limits.js";
import { BufferReader } from "./reader.js";
import { decodeUtf8 } from "./text.js";

// Strict UTF-8 (MESSAGE_SPEC §8, CORELIB_PLAN §6.4): JavaScript strings are a
// Unicode string type, so this target is always strict — the decoder builds the
// string with the fatal TextDecoder, which throws on any invalid-UTF-8 payload
// (overlong forms, surrogate code points, out-of-range, truncated or stray
// bytes) rather than silently substituting U+FFFD. readString maps that throw to
// the INVALID decode outcome. A lossy decoder is never used.
// Strict decode lives in ./text, which reads the payload RANGE in place.

/**
 * A pull decoder over a complete message held in one contiguous buffer.
 *
 * Usage from generated code: loop on {@link readHeader}; for each field switch on
 * {@link id} and call the matching `read*` (which consumes that field's value and
 * advances the cursor); recurse into a child type's decoder on a nested sequence;
 * fall through to {@link skip} for an unknown id. See {@link readHeader}.
 *
 * Pass {@link DecodeLimits} to cap array counts and string / blob lengths; an
 * over-limit field throws {@link SofabError} (`LIMIT_EXCEEDED`) at its header,
 * before it is materialized. Omit for no caps (the default).
 */
export class Cursor extends BufferReader {
  /** Field id of the header last accepted by {@link readHeader}. */
  id = 0;
  /** Wire type of the header last accepted by {@link readHeader}. */
  wire = 0;
  /**
   * Fixlen subtype of the header last accepted by {@link readHeader} — one of
   * {@link FixlenSubtype} — when its {@link wire} is {@link WireType.Fixlen} or
   * {@link WireType.ArrayFixlen}; `-1` otherwise (a non-fixlen field, or a
   * fixlen field whose subtype word is truncated away).
   *
   * The four fixlen subtypes (`fp32`, `fp64`, `string`, `blob`) all share one
   * {@link wire} type, so {@link wire} alone cannot separate them. This is the
   * companion accessor that can: a generated guard reads it right after
   * {@link readHeader} to skip a field whose delivered subtype contradicts the
   * schema (MESSAGE_SPEC §7.3), exactly as it already does on {@link wire} for
   * the other kinds:
   *
   * ```ts
   * case 9: if (c.wire !== WireType.Fixlen || c.fixSub !== FixlenSubtype.Fp64) {
   *   c.skip(c.wire); break;
   * } o.somefp64 = c.readFp64(); break;
   * ```
   *
   * It is *peeked* — the subtype word is not consumed — so the matching typed
   * reader (or {@link skip}) still reads and validates it, and a malformed or
   * truncated word surfaces `INVALID` / `INCOMPLETE` there as before.
   */
  fixSub = -1;

  // Opt-in decode limits (corelib-ts#38). An unset limit is Infinity — no cap,
  // today's behavior. Enforced at the count / length header, before allocation.
  private readonly maxArrayCount: number;
  private readonly maxStringLen: number;
  private readonly maxBlobLen: number;

  // Number of nested sequences currently open (0 = root). Incremented when
  // readHeader accepts a SequenceStart, decremented when it consumes the matching
  // SequenceEnd (or when skip() discards a whole nested sequence). Lets the pull
  // parser tell a root-level dangling sequence-end (INVALID) and an unclosed
  // sequence at end-of-buffer (INCOMPLETE) apart from a clean boundary.
  private depth = 0;

  constructor(buf: Uint8Array, limits?: DecodeLimits) {
    super(buf);
    this.maxArrayCount = limits?.maxArrayCount ?? Infinity;
    this.maxStringLen = limits?.maxStringLen ?? Infinity;
    this.maxBlobLen = limits?.maxBlobLen ?? Infinity;
  }

  /**
   * Advance to the next field header. Returns `true` and sets {@link id} /
   * {@link wire} when a field follows; returns `false` — consuming the marker —
   * at the end of the buffer *or* at the sequence-end that closes the sequence
   * this decoder is reading. So a generated per-type decoder loops uniformly:
   *
   * ```ts
   * while (c.readHeader()) {
   *   switch (c.id) {
   *     case 4: this.u32 = Number(c.readUnsigned()); break;
   *     case 10: this.child = Child.decodeFrom(c); break; // nested sequence
   *     default: c.skip(c.wire); break;                   // unknown field
   *   }
   * }
   * ```
   *
   * At the root the loop ends at end-of-buffer; inside a nested sequence it ends
   * at the matching {@link WireType.SequenceEnd} (which is consumed). A field
   * whose id is out of range throws {@link SofabError} (`INVALID_MSG`).
   */
  readHeader(): boolean {
    if (this.p >= this.n) {
      // End of buffer. At the root (depth 0) this is a clean, complete boundary;
      // inside an open sequence it is a truncated, unclosed sequence → INCOMPLETE
      // (§7), matching the fast path (fast.ts) which throws on `stack.length > 1`.
      if (this.depth > 0) {
        throw incompleteError("truncated message: unbalanced sequence");
      }
      return false;
    }
    this.readVarint();
    const wire = this.lo & 7;
    // §4.9/§6.2: bound the id on every header before dispatching on the wire
    // type — a sequence end's id is discarded, not exempt (documentation#35,
    // and see fast.ts).
    const id = this.upper();
    if (id > ID_MAX) throw invalidMsgError(`field id ${id} out of range`);
    if (wire === WireType.SequenceEnd) {
      // A sequence-end closes the current nested scope. At the root (depth 0)
      // there is no open sequence to close, so it is a dangling marker → INVALID
      // (mirrors fast.ts `stack.length <= 1` → "unbalanced sequence end").
      if (this.depth === 0) {
        throw invalidMsgError("unbalanced sequence end");
      }
      this.depth--;
      return false;
    }
    if (wire === WireType.SequenceStart) {
      // §4.9/§6.2: reject nesting deeper than MAX_DEPTH. `depth` counts open
      // sequences (0 = root), so the (MAX_DEPTH + 1)-th open is the first to
      // exceed the ceiling — mirrors fast.ts:197 / state.ts:334. INVALID
      // dominates the unclosed-at-EOF INCOMPLETE (documentation#17).
      if (this.depth >= MAX_DEPTH) {
        throw invalidMsgError(`nesting exceeds MAX_DEPTH (${MAX_DEPTH})`);
      }
      this.depth++;
    }
    this.id = id;
    this.wire = wire;
    // Only a fixlen field has a subtype to peek, and peekFixSub is a scanning
    // call. Deciding that here rather than inside it keeps the call off every
    // other header — which on a typical message is most of them.
    this.fixSub =
      wire === WireType.Fixlen || wire === WireType.ArrayFixlen
        ? this.peekFixSub(wire)
        : -1;
    return true;
  }

  /** Read an unsigned scalar (wire {@link WireType.Unsigned}), number-first. */
  readUnsigned(): number | bigint {
    this.readVarint();
    return this.unsignedValue();
  }

  /** Read a signed scalar (wire {@link WireType.Signed}), zig-zag, number-first. */
  readSigned(): number | bigint {
    this.readVarint();
    return this.signedValue();
  }

  /** Read a 32-bit float scalar (wire {@link WireType.Fixlen}, subtype fp32). */
  readFp32(): number {
    this.fixlenHeader(FixlenSubtype.Fp32, 4);
    return this.rawFp32();
  }

  /**
   * Read a 32-bit float scalar as its raw 4 wire bytes (little-endian), zero-copy
   * — the bit-preserving companion to {@link readFp32}.
   *
   * {@link readFp32} returns a JS `number` (a 64-bit double), and widening an
   * fp32 *signaling* NaN into a double quiets it (0x7F800001 → 0x7FC00001), so a
   * value consumer can never round-trip one bit-for-bit (§4.6). Generated
   * bit-exact decode reads the bytes here instead and re-emits them verbatim with
   * {@link OStream.writeFixlen} (subtype fp32) — mirroring the visitor `raw`
   * channel on the push paths (fast.ts / state.ts), which the pull path was
   * missing (corelib-ts#66).
   *
   * The header (subtype fp32, length 4) is validated exactly as in
   * {@link readFp32}; the returned view aliases the source buffer, valid only
   * until it is reused, like {@link readBlob}.
   */
  readFp32Raw(): Uint8Array {
    this.fixlenHeader(FixlenSubtype.Fp32, 4);
    return this.take(4);
  }

  /** Read a 64-bit float scalar (wire {@link WireType.Fixlen}, subtype fp64). */
  readFp64(): number {
    this.fixlenHeader(FixlenSubtype.Fp64, 8);
    return this.rawFp64();
  }

  /**
   * Read a UTF-8 string scalar (wire {@link WireType.Fixlen}, subtype string).
   * Pass the schema `maxlen` (byte length) for a bounded string so an
   * over-length is rejected as `INVALID` at the header, before the payload is
   * taken (see {@link fixlenLen}); the wire length is exactly the UTF-8 byte
   * length, so the check is exact. Omit for an unbounded string.
   */
  readString(schemaMaxlen?: number): string {
    const len = this.fixlenLen(FixlenSubtype.String, schemaMaxlen);
    // The truncation check (→ INCOMPLETE) runs before the decode, so a short
    // payload stays INCOMPLETE; only genuinely malformed UTF-8 bytes reach the
    // fatal decoder. Its TypeError becomes the INVALID outcome (§8/§6.4/§5.2).
    //
    // takeRange, not take(): the payload is decoded straight out of the source
    // buffer. take() would build a `subarray` view over exactly these bytes for
    // the decoder to read, and that view is one of the most expensive parts of a
    // short string read — see ./text.
    // takeRange, not take(): ./text decodes straight out of the source buffer, so
    // the `subarray` take() would build for it is pure cost (see ./text).
    const start = this.takeRange(len);
    try {
      return decodeUtf8(this.buf, start, start + len);
    } catch {
      throw invalidMsgError("invalid UTF-8 in string");
    }
  }

  /**
   * Read a blob scalar (wire {@link WireType.Fixlen}, subtype blob) as a
   * zero-copy {@link Uint8Array} view into the source buffer.
   */
  readBlob(schemaMaxlen?: number): Uint8Array {
    const len = this.fixlenLen(FixlenSubtype.Blob, schemaMaxlen);
    return this.take(len);
  }

  /**
   * Read an unsigned array (wire {@link WireType.ArrayUnsigned}), number-first
   * per element. Pass the schema `count` for a bounded array so an over-count is
   * rejected as `INVALID` at the header (see {@link arrayCount}); omit it for an
   * unbounded array (today's behavior). Pass `elemMax` for a narrowed element
   * type (`u8`…`u32`) so an out-of-range element is rejected **at that element**,
   * which is what keeps the verdict INVALID when the message is truncated
   * immediately after it (CORELIB_PLAN §5.2, generator#267).
   */
  readUnsignedArray(schemaCount?: number, elemMax?: number | bigint): (number | bigint)[] {
    const count = this.arrayCount(schemaCount);
    const out: (number | bigint)[] = this.arrayAlloc(count);
    // The element loop drives a LOCAL cursor over a local `buf`, and reads the
    // one-byte element — what a narrow integer array almost always carries —
    // without leaving this frame. Going through readVarint()/unsignedValue() per
    // element instead put two calls plus a reload of `this.p`, `this.buf`,
    // `this.lo` and `this.hi` inside the innermost loop of the whole decode.
    const safe = this.n - Cursor.VARINT_SAFE;
    let p = this.p;
    for (let i = 0; i < count; i++) {
      let v: number | bigint;
      // Bounds hoisted out of the element read: with VARINT_SAFE bytes in hand
      // the ladder cannot run off the end. Near the end of the buffer the
      // checked reader takes over, so a truncated array still ends as INCOMPLETE
      // — decided by readVarint, exactly as before.
      let q = p <= safe ? this.ladder5(p) : -1;
      if (q < 0) {
        this.p = p;
        this.readVarint();
        q = this.p;
      }
      p = q;
      v = this.unsignedValue();
      // Checked HERE, on the element that carries the value — not after the whole
      // array. §5.2 makes INVALID dominate INCOMPLETE, so a message truncated
      // after an out-of-range element must stay INVALID; a caller that filtered
      // the returned array would never see one that never arrived (#267).
      if (elemMax !== undefined && v > elemMax) {
        this.p = p;
        throw invalidMsgError("array element above declared width");
      }
      out[i] = v;
    }
    this.p = p;
    return out;
  }

  /**
   * Read a signed array (wire {@link WireType.ArraySigned}), zig-zag,
   * number-first per element. `elemMin`/`elemMax` bound each element to its
   * declared width, rejected at that element — see {@link readUnsignedArray}.
   */
  readSignedArray(
    schemaCount?: number,
    elemMin?: number | bigint,
    elemMax?: number | bigint,
  ): (number | bigint)[] {
    const count = this.arrayCount(schemaCount);
    const out: (number | bigint)[] = this.arrayAlloc(count);
    // Local cursor, one-byte element inline — see readUnsignedArray.
    const safe = this.n - Cursor.VARINT_SAFE;
    let p = this.p;
    for (let i = 0; i < count; i++) {
      let v: number | bigint;
      // Bounds hoisted — see readUnsignedArray.
      let q = p <= safe ? this.ladder5(p) : -1;
      if (q < 0) {
        this.p = p;
        this.readVarint();
        q = this.p;
      }
      p = q;
      v = this.signedValue();
      if ((elemMin !== undefined && v < elemMin) || (elemMax !== undefined && v > elemMax)) {
        this.p = p;
        throw invalidMsgError("array element above declared width");
      }
      out[i] = v;
    }
    this.p = p;
    return out;
  }

  /**
   * Read an unsigned 64-bit array into {@link Long}[] — the `bigint`-free path.
   * Each element keeps the raw lo/hi halves; call {@link Long.toBigInt} to
   * materialise only the values the caller actually needs.
   */
  readUnsignedArrayLong(schemaCount?: number): Long[] {
    const count = this.arrayCount(schemaCount);
    const out = this.arrayAlloc<Long>(count);
    // Local cursor, one-byte element inline — see readUnsignedArray.
    const safe = this.n - Cursor.VARINT_SAFE;
    let p = this.p;
    for (let i = 0; i < count; i++) {
      // Bounds hoisted — see readUnsignedArray.
      let q = p <= safe ? this.ladder5(p) : -1;
      if (q < 0) {
        this.p = p;
        this.readVarint();
        q = this.p;
      }
      p = q;
      out[i] = new Long(this.lo, this.hi);
    }
    this.p = p;
    return out;
  }

  /** Read a signed 64-bit array (zig-zag) into {@link Long}[] — the `bigint`-free path. */
  readSignedArrayLong(schemaCount?: number): Long[] {
    const count = this.arrayCount(schemaCount);
    const out = this.arrayAlloc<Long>(count);
    // Local cursor, one-byte element inline — see readUnsignedArray.
    const safe = this.n - Cursor.VARINT_SAFE;
    let p = this.p;
    for (let i = 0; i < count; i++) {
      // Bounds hoisted — see readUnsignedArray.
      let q = p <= safe ? this.ladder5(p) : -1;
      if (q < 0) {
        this.p = p;
        this.readVarint();
        q = this.p;
      }
      p = q;
      const lo = this.lo >>> 0;
      const hi = this.hi >>> 0;
      const mask = (-(lo & 1)) >>> 0; // all ones when the zig-zag lsb is set
      out[i] = new Long((((lo >>> 1) | (hi << 31)) >>> 0) ^ mask, ((hi >>> 1) >>> 0) ^ mask);
    }
    this.p = p;
    return out;
  }

  /** Read an fp32 array (wire {@link WireType.ArrayFixlen}, element subtype fp32). */
  readFp32Array(schemaCount?: number): number[] {
    const count = this.arrayFixlenHeader(FixlenSubtype.Fp32, 4, schemaCount);
    const out: number[] = new Array(count);
    // The bound is settled for the whole payload by arrayFixlenHeader (it already
    // rejects a count claiming more than the buffer holds), so the element loop
    // needs neither a per-element bounds test nor a reload of `this.p` — it walks
    // one hoisted DataView with a local offset.
    const dv = this.floats();
    let p = this.p;
    for (let i = 0; i < count; i++, p += 4) out[i] = dv.getFloat32(p, true);
    this.p = p;
    return out;
  }

  /**
   * Read an fp32 array as its raw little-endian element payload (`count * 4`
   * bytes), zero-copy — the bit-preserving companion to {@link readFp32Array}.
   * Widening each element to a JS `number` quiets an fp32 *signaling* NaN just as
   * on the scalar path (§4.6; see {@link readFp32Raw}), so bit-exact decode reads
   * the whole payload here and re-emits it with {@link OStream.writeFp32ArrayRaw}
   * (corelib-ts#66). The header (element subtype fp32, size 4) is validated
   * exactly as in {@link readFp32Array}; the returned view aliases the source
   * buffer, like {@link readBlob}.
   */
  readFp32ArrayRaw(schemaCount?: number): Uint8Array {
    const count = this.arrayFixlenHeader(FixlenSubtype.Fp32, 4, schemaCount);
    return this.take(count * 4);
  }

  /** Read an fp64 array (wire {@link WireType.ArrayFixlen}, element subtype fp64). */
  readFp64Array(schemaCount?: number): number[] {
    const count = this.arrayFixlenHeader(FixlenSubtype.Fp64, 8, schemaCount);
    const out: number[] = new Array(count);
    // See readFp32Array: the payload is bounds-checked whole, so the loop is a
    // hoisted DataView plus a local offset.
    const dv = this.floats();
    let p = this.p;
    for (let i = 0; i < count; i++, p += 8) out[i] = dv.getFloat64(p, true);
    this.p = p;
    return out;
  }

  /**
   * Consume the value of the field whose header {@link readHeader} just accepted,
   * discarding it — for a `default:` branch that keeps the cursor in sync on an
   * unknown id. Pass {@link wire}. A {@link WireType.SequenceStart} skips the
   * whole nested sequence.
   */
  skip(wire: number): void {
    if (wire === WireType.SequenceStart) {
      // readHeader already counted this SequenceStart (depth++); skipSequence
      // consumes its whole balanced body incl. the matching end without going
      // through readHeader, so balance the count here.
      this.skipSequence();
      this.depth--;
      return;
    }
    this.skipValue(wire);
  }

  // --- value skipping -----------------------------------------------------

  private skipValue(wire: number): void {
    switch (wire) {
      case WireType.Unsigned:
      case WireType.Signed:
        this.readVarint();
        return;
      case WireType.Fixlen: {
        this.readVarint();
        const sub = this.lo & 7;
        const len = this.upper();
        // §4.6/§5.2: validate the fixlen word at the header, before the payload,
        // so a malformed word — a reserved subtype (0x4..0x7), or an fp32/fp64
        // whose declared length ≠ 4/8 — is INVALID even when the payload is also
        // truncated (INVALID takes precedence over INCOMPLETE). Mirrors the
        // known-field path ({@link fixlenHeader}) and fast.ts. A skip never
        // materializes the value, so string/blob keep only the len ≤ FIXLEN_MAX
        // bound — no opt-in length limit is enforced here (corelib-ts#49).
        if (sub > FixlenSubtype.Blob) throw invalidMsgError(`invalid fixlen subtype ${sub}`);
        if (sub === FixlenSubtype.Fp32 || sub === FixlenSubtype.Fp64) {
          if (len !== (sub === FixlenSubtype.Fp32 ? 4 : 8)) {
            throw invalidMsgError("fixlen float length mismatch");
          }
        } else if (len > FIXLEN_MAX) {
          throw invalidMsgError("fixlen length out of range");
        }
        this.take(len);
        return;
      }
      case WireType.ArrayUnsigned:
      case WireType.ArraySigned: {
        // {@link skipArrayCount}, not {@link arrayCount}: the elements are parsed
        // below, and a varint already in hand that is provably malformed must
        // surface as INVALID rather than being pre-empted by the count ≤
        // remaining-bytes truncation guard (corelib-ts#82).
        const count = this.skipArrayCount();
        for (let i = 0; i < count; i++) this.readVarint();
        return;
      }
      case WireType.ArrayFixlen: {
        // Read count and the element word, then validate the element type at the
        // header before taking the payload — a fixlen array carries only fp32
        // (size 4) or fp64 (size 8) elements (§4.8), so any other element word is
        // INVALID even when the payload is truncated (§5.2 precedence). Uses
        // {@link skipArrayCount} for the same reason (corelib-ts#49).
        const count = this.skipArrayCount();
        this.readVarint();
        const sub = this.lo & 7;
        const size = this.upper();
        const ok =
          (sub === FixlenSubtype.Fp32 && size === 4) ||
          (sub === FixlenSubtype.Fp64 && size === 8);
        if (!ok) throw invalidMsgError("invalid fixlen array element type");
        this.take(count * size);
        return;
      }
      default:
        throw invalidMsgError(`invalid wire type ${wire}`);
    }
  }

  private skipSequence(): void {
    let depth = 1;
    while (depth > 0) {
      if (this.p >= this.n) throw incompleteError("truncated message: unbalanced sequence");
      this.readVarint();
      const wire = this.lo & 7;
      // §4.9/§6.2: the skip path bounds the id on every header too, sequence
      // ends included — same guard, same position as {@link readHeader}.
      const id = this.upper();
      if (id > ID_MAX) throw invalidMsgError(`field id ${id} out of range`);
      if (wire === WireType.SequenceEnd) {
        depth--;
        continue;
      }
      if (wire === WireType.SequenceStart) {
        // §4.9/§6.2: the skip path must honour the same MAX_DEPTH ceiling as the
        // read path ({@link readHeader}), else a subtree skipped on a wire-type
        // mismatch could nest past MAX_DEPTH and fall through to the unbalanced-
        // at-EOF INCOMPLETE above instead of INVALID — the F-0029 divergence the
        // readHeader-only fix left in this path (corelib-ts#65). `this.depth`
        // counts the opens *above* this skip (readHeader already accepted the
        // entry sequence, which the local `depth == 1` aliases), so the true
        // nesting is `this.depth + depth - 1`; the next open must not exceed it.
        if (this.depth + depth - 1 >= MAX_DEPTH) {
          throw invalidMsgError(`nesting exceeds MAX_DEPTH (${MAX_DEPTH})`);
        }
        depth++;
      } else {
        this.skipValue(wire);
      }
    }
  }

  // --- field helpers ------------------------------------------------------

  /**
   * Peek the delivered fixlen subtype of the field {@link readHeader} just
   * accepted, **without advancing the cursor** — the readers / {@link skip}
   * still re-read and validate the word. Returns one of {@link FixlenSubtype}
   * (0..3), a reserved value (4..7), or `-1` when the wire is not a fixlen kind
   * or the subtype word is truncated away.
   *
   * The subtype is the low 3 bits of the fixlen sub-header word. Those bits are
   * settled by the word's **first** byte — every further byte contributes a
   * multiple of 128, which is divisible by 8 — but CORELIB_PLAN §4.1 forbids
   * acting on that: a varint yields no value until the byte with a clear
   * continuation flag arrives, and no packed sub-field may influence a decode
   * outcome before then, *even when those bits are already fixed*. So a word cut
   * short reports -1 (INCOMPLETE) rather than a subtype it arithmetically knows.
   *
   * Without that, one implementation reached two verdicts for the same bytes: a
   * caller driving this cursor tested the peeked subtype, passed, and applied a
   * schema bound to a field whose framing had not arrived — while the visitor
   * surface, which cannot fire before the complete word, answered INCOMPLETE
   * (generator#300 `r3`, corelib-ts#38's read-path twin).
   */
  private peekFixSub(wire: number): number {
    // Scalar fixlen: the sub-header is the word right after the field header.
    if (wire === WireType.Fixlen) {
      return this.subOfCompleteWord(this.p);
    }
    // Fixlen array: the element sub-header sits after the count varint (§4.8:
    // always present, even for count 0), so step over the count's bytes first —
    // a varint's last byte is the first one with the high bit clear. A count
    // that is itself cut short leaves nothing to step over, and -1 follows.
    if (wire === WireType.ArrayFixlen) {
      let p = this.p;
      while (p < this.n && this.buf[p]! >= 0x80) p++;
      if (p >= this.n) return -1; // the count word never ended
      return this.subOfCompleteWord(p + 1);
    }
    return -1; // not a fixlen field
  }

  /**
   * The subtype of the fixlen word starting at `at`, or -1 when that word is not
   * wholly present. Scans to the varint's terminating byte before reading the
   * low bits, which is what makes the answer a value rather than a guess.
   */
  private subOfCompleteWord(at: number): number {
    let p = at;
    while (p < this.n && this.buf[p]! >= 0x80) p++;
    if (p >= this.n) return -1; // truncated inside the word
    return this.buf[at]! & 7;
  }

  /**
   * Read and validate an array count word (0..ARRAY_MAX; §4.7/§4.8). When a
   * `schemaCount` is given, a count above it is a schema-bound violation and is
   * rejected as `INVALID` — see the check below.
   */
  private arrayCount(schemaCount?: number): number {
    this.readVarint();
    const count = this.num();
    if (count > ARRAY_MAX) throw invalidMsgError("array count out of range");
    // §5.2/§7 (corelib-ts#69): a count above the field's schema capacity is a
    // malformed message (INVALID) and MUST dominate the truncated-array
    // INCOMPLETE below — so the deciding count word is bound-checked here, at
    // the header, before the `count > remaining` guard a truncated over-count
    // would otherwise trip first (anti-folding: INVALID over INCOMPLETE). It
    // also precedes the LIMIT_EXCEEDED cap, keeping the precedence INVALID >
    // LIMIT_EXCEEDED > INCOMPLETE. An unset bound (skip paths, unbounded
    // arrays) preserves today's behavior; when the generator passes the schema
    // count this is a predicted-false integer compare on valid data — no hot-
    // path cost.
    if (schemaCount !== undefined && count > schemaCount) {
      throw invalidMsgError("array count above schema capacity");
    }
    // §6.2.1: a receiver cap governs SCHEMA-UNBOUNDED fields only. There the
    // sender alone dictates the receiver's allocation, which is exactly what
    // the cap exists to bound. A schema-bounded field has no such freedom: the
    // check above already decided its validity, and layering a capacity policy
    // on top would let two receivers with the same schema and different caps
    // disagree about it (§6.3: LimitExceeded is "never raised for a field the
    // schema bounds"). Costs one `undefined` test on an already-loaded argument.
    if (schemaCount === undefined && count > this.maxArrayCount) {
      throw limitExceededError(
        `array count ${count} exceeds maxArrayCount ${this.maxArrayCount}`,
      );
    }
    return count;
  }

  /**
   * Size the destination for `count` varint elements without trusting `count`.
   *
   * Part A hardening (corelib-ts#38) started from the same observation this
   * does: a varint element needs at least one wire byte, so a count larger than
   * the bytes left in the buffer cannot be real, and `new Array(count)` must
   * never be sized from it. It drew the wrong conclusion from it — it *rejected*
   * such a count as `INCOMPLETE`, from {@link arrayCount}, which decides the
   * outcome before a single element byte is examined. §5.2 gives INVALID
   * precedence over INCOMPLETE, so an element that is already out of its
   * declared width and fully on the wire must still be INVALID when the array
   * behind it is cut short — and it never was, because the read stopped at the
   * count (corelib-ts#99, generator#267/#300, Crucible F-0043).
   *
   * {@link skipArrayCount} reached the same conclusion one path over and states
   * it there; this is the read-path half. Capping the *allocation* keeps all of
   * #38's protection — a hostile count can still never drive an allocation
   * larger than the input — while leaving the verdict to the elements: the
   * caller's loop consumes at least one buffer byte per iteration and
   * {@link readVarint} throws at end of buffer, so a short array still ends as
   * INCOMPLETE, just decided by the bytes rather than by the count word.
   *
   * Assigning past the initial length would grow the array, and cannot happen:
   * that needs more elements than there are bytes to carry them. On valid input
   * `count <= remaining`, so this allocates exactly `count` as before.
   *
   * The tighter fixlen bound (count * elemSize) still rejects at the header, in
   * {@link arrayFixlenHeader} — an fp element has no declared-width bound to
   * decide, so there is nothing for it to preempt.
   */
  private arrayAlloc<T>(count: number): T[] {
    return new Array<T>(Math.min(count, this.n - this.p));
  }

  /**
   * Read and validate an array count word on the **skip** path (§4.7/§4.8):
   * range- and limit-checked exactly as {@link arrayCount}, but *without* its
   * `count ≤ remaining-bytes` guard.
   *
   * That guard exists solely to bound `new Array(count)` against a hostile count
   * on the read paths. A skip materializes nothing, so it buys no safety here —
   * and it is not free: it decides the outcome from the count alone, *before* a
   * single element byte is examined. §5.2 gives INVALID precedence over
   * INCOMPLETE, so input that is both malformed and truncated must be reported
   * as INVALID; letting the guard fire first reports an already-provably-bad
   * element varint as mere truncation (corelib-ts#82 / #49, Crucible F-0053).
   *
   * Dropping the guard cannot cost unbounded work: the caller's element loop
   * consumes at least one buffer byte per iteration and {@link readVarint}
   * throws at end of buffer, so it still terminates within `n` iterations
   * regardless of how large the declared count is.
   */
  private skipArrayCount(): number {
    this.readVarint();
    const count = this.num();
    if (count > ARRAY_MAX) throw invalidMsgError("array count out of range");
    if (count > this.maxArrayCount) {
      throw limitExceededError(
        `array count ${count} exceeds maxArrayCount ${this.maxArrayCount}`,
      );
    }
    return count;
  }

  /** Read a scalar fixlen sub-header, asserting subtype and exact byte length (floats). */
  private fixlenHeader(wantSub: number, wantLen: number): void {
    this.readVarint();
    const sub = this.lo & 7;
    const len = this.upper();
    if (sub !== wantSub) throw invalidMsgError(`invalid fixlen subtype ${sub}`);
    if (len !== wantLen) throw invalidMsgError("fixlen float length mismatch");
  }

  /**
   * Read a scalar fixlen sub-header for a string/blob, asserting subtype;
   * returns the byte length. When a `schemaMaxlen` is given, a length above it
   * is a schema-bound violation and is rejected as `INVALID` — see below.
   */
  private fixlenLen(wantSub: number, schemaMaxlen?: number): number {
    this.readVarint();
    const sub = this.lo & 7;
    const len = this.upper();
    if (sub !== wantSub) throw invalidMsgError(`invalid fixlen subtype ${sub}`);
    if (len > FIXLEN_MAX) throw invalidMsgError("fixlen length out of range");
    // §5.2/§7.1 (corelib-ts#69): a declared length above the field's schema
    // maxlen is a malformed message (INVALID) and MUST dominate the truncated-
    // payload INCOMPLETE that take() raises below — so the deciding length word
    // is bound-checked here, before the payload is taken (anti-folding: INVALID
    // over INCOMPLETE), and before the LIMIT_EXCEEDED cap (INVALID > LIMIT_
    // EXCEEDED > INCOMPLETE). For a string the wire len is exactly its UTF-8
    // byte length, so this header check is exact. An unset bound preserves
    // today's behavior; a predicted-false compare on valid data.
    if (schemaMaxlen !== undefined && len > schemaMaxlen) {
      throw invalidMsgError("fixlen length above schema maxlen");
    }
    // Opt-in length cap (corelib-ts#38), enforced at the header before the
    // payload is taken. wantSub tells string from blob, so the right limit
    // applies to each — and §6.2.1 confines it to a schema-UNBOUNDED field: a
    // `maxlen` in the schema already governs this length, and a receiver-local
    // capacity policy must not overrule it (see arrayCount, corelib-ts#105).
    const limit =
      wantSub === FixlenSubtype.String ? this.maxStringLen : this.maxBlobLen;
    if (schemaMaxlen === undefined && len > limit) {
      const what = wantSub === FixlenSubtype.String ? "string" : "blob";
      const name =
        wantSub === FixlenSubtype.String ? "maxStringLen" : "maxBlobLen";
      throw limitExceededError(
        `${what} length ${len} exceeds ${name} ${limit}`,
      );
    }
    return len;
  }

  /**
   * Read an array fixlen element header (count + element type); returns the
   * count. When a `schemaCount` is given, a count above it is a schema-bound
   * violation and is rejected as `INVALID` — but only once the element word has
   * arrived and agreed, per the §4.8 decode order below.
   */
  private arrayFixlenHeader(
    wantSub: number,
    wantSize: number,
    schemaCount?: number,
  ): number {
    // §4.8: a fixlen array always carries its element-length word — even when
    // empty — so the element kind stays known. count may then be 0.
    //
    // Read the count and validate the element word *before* the count ≤
    // remaining-bytes truncation guard, so a malformed element word on a
    // truncated array is INVALID, not INCOMPLETE (§5.2 precedence). This
    // deliberately inlines the count parse rather than calling {@link
    // arrayCount}, whose own `count > remaining` guard would otherwise fire
    // first — the same trap #49 sidestepped in skipValue's ArrayFixlen case
    // (corelib-ts#51, follow-up to #49).
    this.readVarint();
    const count = this.num();
    // The format ceiling belongs to the count word and fires there "whatever the
    // subtype turns out to be" (§4.8) — it bounds the *format*, not this field.
    if (count > ARRAY_MAX) throw invalidMsgError("array count out of range");
    // Likewise the receiver cap: §6.2.1 requires it at the count header, before
    // the allocation it exists to prevent — but only for a schema-UNBOUNDED
    // array. When the schema bounds this field the cap does not apply at all
    // (corelib-ts#105), so it must not fire here either: it sits before the
    // element word while the schema check must sit after it (§4.8, below), and
    // an unconditional cap would pre-empt that INVALID with a LIMIT_EXCEEDED.
    if (schemaCount === undefined && count > this.maxArrayCount) {
      throw limitExceededError(
        `array count ${count} exceeds maxArrayCount ${this.maxArrayCount}`,
      );
    }
    this.readVarint();
    const sub = this.lo & 7;
    const size = this.upper();
    if (sub !== wantSub || size !== wantSize) {
      throw invalidMsgError("invalid fixlen array element type");
    }
    // §4.8 normative decode order — both words, then the subtype, then the
    // *schema* bound (MESSAGE_SPEC §7.1). It cannot move any earlier: the two
    // words answer to different authorities, and until the element word has
    // shown the subtype the decoder does not yet know the field is this array at
    // all — a contradicting subtype means the bytes were never this field's
    // value, so their element count is not this field's count. §4.8 calls the
    // consequence intended: a message ending *between* the two words is
    // INCOMPLETE, not INVALID, even when the count already exceeds the schema
    // capacity, because those bytes are not malformed regardless of what follows
    // (§5.2). Checking here keeps that, and still dominates the truncated-array
    // INCOMPLETE guard below, which is what corelib-ts#69 was about
    // (corelib-ts#104).
    if (schemaCount !== undefined && count > schemaCount) {
      throw invalidMsgError("array count above schema capacity");
    }
    // Part A hardening (corelib-ts#38): now the element size is known, a fixlen
    // array needs count * size payload bytes; a count claiming more than the
    // buffer holds is truncation — reject before sizing `new Array(count)`.
    // This tighter bound subsumes arrayCount's `count > remaining` guard.
    if (count > (this.n - this.p) / wantSize) {
      throw incompleteError("truncated fixlen array");
    }
    return count;
  }
}
