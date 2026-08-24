/**
 * Visitors used by the decode tests — all **flat** (one visitor per message,
 * nesting reported as `sequenceBegin`/`sequenceEnd` events), which is the only
 * decode surface the library has (CORELIB_PLAN §5.3.1).
 *
 * {@link TranscodeVisitor} re-encodes everything it decodes into a fresh
 * {@link OStream}; if the re-encoded bytes equal the input, the decoder read every
 * field, value and length correctly. {@link RecordingVisitor} instead collects a
 * flat event log for direct value assertions.
 */

import { ArrayKind, FixlenSubtype, OStream, type Visitor } from "../../src/index.js";

/** Decodes into an OStream so the round-tripped bytes can be compared to input. */
export class TranscodeVisitor implements Visitor {
  private array: {
    kind: ArrayKind;
    id: number;
    vals: (bigint | number)[];
    bits: number[];
  } | null = null;
  private fix: { sub: FixlenSubtype; id: number; buf: Uint8Array; got: number } | null = null;

  constructor(private readonly out: OStream) {}

  unsigned(id: number, value: number | bigint): void {
    this.out.writeUnsigned(id, value);
  }
  signed(id: number, value: number | bigint): void {
    this.out.writeSigned(id, value);
  }
  fp32(id: number, _value: number, bits: number): void {
    // Re-emit the raw wire bits verbatim: writeFp32(value) would re-quantize a
    // signaling NaN through setFloat32 and quiet it (§4.6/§6.5).
    this.out.writeFp32Bits(id, bits);
  }
  fp64(id: number, value: number): void {
    this.out.writeFp64(id, value);
  }

  string(id: number, total: number, offset: number, src: Uint8Array, start: number, end: number): void {
    this.fixPiece(FixlenSubtype.String, id, total, offset, src, start, end);
  }
  blob(id: number, total: number, offset: number, src: Uint8Array, start: number, end: number): void {
    this.fixPiece(FixlenSubtype.Blob, id, total, offset, src, start, end);
  }

  arrayBegin(id: number, kind: ArrayKind, _count: number): void {
    this.array = { kind, id, vals: [], bits: [] };
  }
  arrayUnsigned(_id: number, _index: number, value: number | bigint): void {
    this.array!.vals.push(value);
  }
  arraySigned(_id: number, _index: number, value: number | bigint): void {
    this.array!.vals.push(value);
  }
  arrayFp32(_id: number, _index: number, value: number, bits: number): void {
    this.array!.vals.push(value);
    this.array!.bits.push(bits);
  }
  arrayFp64(_id: number, _index: number, value: number): void {
    this.array!.vals.push(value);
  }
  arrayEnd(id: number): void {
    const a = this.array!;
    this.array = null;
    if (a.kind === ArrayKind.Unsigned) this.out.writeUnsignedArray(id, a.vals);
    else if (a.kind === ArrayKind.Signed) this.out.writeSignedArray(id, a.vals);
    else if (a.kind === ArrayKind.Fp32) {
      // Bit-exact re-emit from the raw element bits (preserves an sNaN element).
      const payload = new Uint8Array(a.bits.length * 4);
      const dv = new DataView(payload.buffer);
      a.bits.forEach((b, k) => dv.setUint32(k * 4, b >>> 0, true));
      this.out.writeFp32ArrayRaw(id, payload);
    } else this.out.writeFp64Array(id, a.vals as number[]);
  }

  sequenceBegin(id: number): void {
    this.out.writeSequenceBeginLazy(id);
  }
  sequenceEnd(): void {
    // Frame-preserving close: a transcode must reproduce its input byte for byte,
    // and the input may legitimately contain an empty frame (an array element, or
    // an explicitly-empty array — MESSAGE_SPEC §2/§5.1). `end` would silently drop
    // it and change the decoded array's *length*.
    this.out.writeSequenceEndKeep();
  }

  private fixPiece(
    sub: FixlenSubtype,
    id: number,
    total: number,
    offset: number,
    src: Uint8Array,
    start: number,
    end: number,
  ): void {
    if (this.fix === null || this.fix.id !== id || this.fix.sub !== sub || offset === 0) {
      this.fix = { sub, id, buf: new Uint8Array(total), got: 0 };
    }
    this.fix.buf.set(src.subarray(start, end), offset);
    this.fix.got += end - start;
    if (this.fix.got >= total) {
      this.out.writeFixlen(id, this.fix.buf, sub);
      this.fix = null;
    }
  }
}

/** One decoded event, for direct assertions. */
export type Event =
  | { kind: "unsigned"; id: number; value: number | bigint }
  | { kind: "signed"; id: number; value: number | bigint }
  | { kind: "fp32"; id: number; value: number }
  | { kind: "fp64"; id: number; value: number }
  | { kind: "string"; id: number; text: string }
  | { kind: "blob"; id: number; bytes: Uint8Array }
  | { kind: "array"; id: number; arrayKind: ArrayKind; values: (bigint | number)[] }
  | { kind: "sequenceBegin"; id: number }
  | { kind: "sequenceEnd" };

/** Collects a flat event log; string/blob pieces are joined. */
export class RecordingVisitor implements Visitor {
  readonly events: Event[] = [];
  protected array: { id: number; arrayKind: ArrayKind; values: (bigint | number)[] } | null = null;
  private fix: { id: number; isString: boolean; buf: Uint8Array; got: number } | null = null;

  unsigned(id: number, value: number | bigint): void {
    this.events.push({ kind: "unsigned", id, value });
  }
  signed(id: number, value: number | bigint): void {
    this.events.push({ kind: "signed", id, value });
  }
  fp32(id: number, value: number): void {
    this.events.push({ kind: "fp32", id, value });
  }
  fp64(id: number, value: number): void {
    this.events.push({ kind: "fp64", id, value });
  }
  string(id: number, total: number, offset: number, src: Uint8Array, start: number, end: number): void {
    this.fixPiece(true, id, total, offset, src, start, end);
  }
  blob(id: number, total: number, offset: number, src: Uint8Array, start: number, end: number): void {
    this.fixPiece(false, id, total, offset, src, start, end);
  }
  arrayBegin(id: number, kind: ArrayKind): void {
    this.array = { id, arrayKind: kind, values: [] };
  }
  arrayUnsigned(_id: number, _i: number, value: number | bigint): void {
    this.array!.values.push(value);
  }
  arraySigned(_id: number, _i: number, value: number | bigint): void {
    this.array!.values.push(value);
  }
  arrayFp32(_id: number, _i: number, value: number): void {
    this.array!.values.push(value);
  }
  arrayFp64(_id: number, _i: number, value: number): void {
    this.array!.values.push(value);
  }
  arrayEnd(id: number): void {
    this.events.push({ kind: "array", id, arrayKind: this.array!.arrayKind, values: this.array!.values });
    this.array = null;
  }
  sequenceBegin(id: number): void {
    this.events.push({ kind: "sequenceBegin", id });
  }
  sequenceEnd(): void {
    this.events.push({ kind: "sequenceEnd" });
  }

  protected fixPiece(
    isString: boolean,
    id: number,
    total: number,
    offset: number,
    src: Uint8Array,
    start: number,
    end: number,
  ): void {
    if (this.fix === null || this.fix.id !== id || this.fix.isString !== isString || offset === 0) {
      this.fix = { id, isString, buf: new Uint8Array(total), got: 0 };
    }
    this.fix.buf.set(src.subarray(start, end), offset);
    this.fix.got += end - start;
    if (this.fix.got >= total) {
      if (isString) this.events.push({ kind: "string", id, text: new TextDecoder().decode(this.fix.buf) });
      else this.events.push({ kind: "blob", id, bytes: this.fix.buf });
      this.fix = null;
    }
  }
}

/**
 * Like {@link RecordingVisitor}, but skips every field whose id is in `skip`, at
 * every nesting level — modelling a receiver that ignores optional fields. A
 * skipped *scalar/array* field is dropped (the decoder still consumes its bytes);
 * a skipped *sequence* is declined by answering `false` from `sequenceBegin`, so
 * its entire sub-tree, at any depth, is consumed and never offered again.
 */
export class SkipVisitor extends RecordingVisitor {
  constructor(private readonly skip: Set<number>) {
    super();
  }

  override unsigned(id: number, value: number | bigint): void {
    if (!this.skip.has(id)) super.unsigned(id, value);
  }
  override signed(id: number, value: number | bigint): void {
    if (!this.skip.has(id)) super.signed(id, value);
  }
  override fp32(id: number, value: number): void {
    if (!this.skip.has(id)) super.fp32(id, value);
  }
  override fp64(id: number, value: number): void {
    if (!this.skip.has(id)) super.fp64(id, value);
  }
  override string(id: number, total: number, offset: number, src: Uint8Array, start: number, end: number): void {
    if (!this.skip.has(id)) super.string(id, total, offset, src, start, end);
  }
  override blob(id: number, total: number, offset: number, src: Uint8Array, start: number, end: number): void {
    if (!this.skip.has(id)) super.blob(id, total, offset, src, start, end);
  }
  override arrayBegin(id: number, kind: ArrayKind): void {
    if (!this.skip.has(id)) super.arrayBegin(id, kind);
  }
  override arrayUnsigned(id: number, i: number, value: number | bigint): void {
    if (!this.skip.has(id)) super.arrayUnsigned(id, i, value);
  }
  override arraySigned(id: number, i: number, value: number | bigint): void {
    if (!this.skip.has(id)) super.arraySigned(id, i, value);
  }
  override arrayFp32(id: number, i: number, value: number): void {
    if (!this.skip.has(id)) super.arrayFp32(id, i, value);
  }
  override arrayFp64(id: number, i: number, value: number): void {
    if (!this.skip.has(id)) super.arrayFp64(id, i, value);
  }
  override arrayEnd(id: number): void {
    if (!this.skip.has(id)) super.arrayEnd(id);
  }
  override sequenceBegin(id: number): boolean | void {
    if (this.skip.has(id)) return false; // decline the whole sub-tree
    super.sequenceBegin(id);
  }
}

/**
 * Independently compute the events a {@link SkipVisitor} should keep, by filtering
 * a full event log: drop any field whose id is skipped, and drop a skipped
 * sequence's `begin`/`end` markers together with everything between them (at any
 * nesting depth).
 */
export function filterSkipped(events: Event[], skip: Set<number>): Event[] {
  const out: Event[] = [];
  let depth = 0;
  let skipFrom = -1; // depth at which the active skipped sequence sits (-1 = none)
  for (const ev of events) {
    if (ev.kind === "sequenceBegin") {
      if (skipFrom >= 0) {
        depth++;
        continue; // already inside a skipped sub-tree
      }
      if (skip.has(ev.id)) {
        skipFrom = depth;
        depth++;
        continue; // start skipping this sub-tree (drop the begin)
      }
      out.push(ev);
      depth++;
    } else if (ev.kind === "sequenceEnd") {
      depth--;
      if (skipFrom >= 0) {
        if (depth === skipFrom) skipFrom = -1; // matching end of the skipped sub-tree
        continue;
      }
      out.push(ev);
    } else {
      if (skipFrom < 0 && !skip.has(ev.id)) out.push(ev);
    }
  }
  return out;
}
