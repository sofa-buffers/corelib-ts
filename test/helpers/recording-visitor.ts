/**
 * Visitors used by the decode tests.
 *
 * {@link TranscodeVisitor} re-encodes everything it decodes into a fresh
 * {@link OStream}; if the re-encoded bytes equal the input, the decoder read
 * every field, value and length correctly. {@link RecordingVisitor} instead
 * collects a flat event log for direct value assertions.
 */

import { ArrayKind, FixlenSubtype, OStream, type Visitor } from "../../src/index.js";

/** Decodes into an OStream so the round-tripped bytes can be compared to input. */
export class TranscodeVisitor implements Visitor {
  private array: {
    kind: ArrayKind;
    id: number;
    vals: (bigint | number)[];
    raw: Uint8Array[];
  } | null = null;
  private fix: { sub: FixlenSubtype; id: number; buf: Uint8Array; got: number } | null = null;

  constructor(private readonly out: OStream) {}

  unsigned(id: number, value: number | bigint): void {
    this.out.writeUnsigned(id, value);
  }
  signed(id: number, value: number | bigint): void {
    this.out.writeSigned(id, value);
  }
  fp32(id: number, value: number, raw?: Uint8Array): void {
    // Re-emit the raw wire bytes verbatim: writeFp32(value) would re-quantize a
    // signaling NaN through setFloat32 and quiet it (§4.6). writeFixlen copies
    // `raw` synchronously, so the transient view is safe to pass through.
    if (raw) this.out.writeFixlen(id, raw, FixlenSubtype.Fp32);
    else this.out.writeFp32(id, value);
  }
  fp64(id: number, value: number): void {
    this.out.writeFp64(id, value);
  }

  string(id: number, total: number, offset: number, chunk: Uint8Array): void {
    this.fixChunk(FixlenSubtype.String, id, total, offset, chunk);
  }
  blob(id: number, total: number, offset: number, chunk: Uint8Array): void {
    this.fixChunk(FixlenSubtype.Blob, id, total, offset, chunk);
  }

  arrayBegin(id: number, kind: ArrayKind, _count: number): void {
    this.array = { kind, id, vals: [], raw: [] };
  }
  arrayUnsigned(_id: number, _index: number, value: number | bigint): void {
    this.array!.vals.push(value);
  }
  arraySigned(_id: number, _index: number, value: number | bigint): void {
    this.array!.vals.push(value);
  }
  arrayFp32(_id: number, _index: number, value: number, raw?: Uint8Array): void {
    this.array!.vals.push(value);
    // Copy: on the streaming path `raw` aliases a scratch buffer reused per element.
    if (raw) this.array!.raw.push(raw.slice());
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
      // Bit-exact re-emit from the raw element bytes (preserves an sNaN element);
      // fall back to values only if the decoder gave no raw channel.
      if (a.raw.length === a.vals.length) {
        const payload = new Uint8Array(a.raw.length * 4);
        a.raw.forEach((b, k) => payload.set(b, k * 4));
        this.out.writeFp32ArrayRaw(id, payload);
      } else this.out.writeFp32Array(id, a.vals as number[]);
    } else this.out.writeFp64Array(id, a.vals as number[]);
  }

  sequenceBegin(id: number): Visitor {
    this.out.writeSequenceBegin(id);
    return this; // single shared OStream — nesting is encoded by begin/end calls
  }
  sequenceEnd(): void {
    this.out.writeSequenceEnd();
  }

  private fixChunk(sub: FixlenSubtype, id: number, total: number, offset: number, chunk: Uint8Array): void {
    if (this.fix === null || this.fix.id !== id || this.fix.sub !== sub) {
      this.fix = { sub, id, buf: new Uint8Array(total), got: 0 };
    }
    this.fix.buf.set(chunk, offset);
    this.fix.got += chunk.length;
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

/** A drain that silently consumes a whole skipped sub-tree, recording nothing. */
const DRAIN: Visitor = { sequenceBegin: () => DRAIN };

/**
 * Like {@link RecordingVisitor}, but skips every field whose id is in `skip` at
 * the current nesting level — modelling a receiver that ignores optional fields.
 * A skipped *scalar/array* field is dropped (the decoder still consumes its
 * bytes); a skipped *sequence* returns {@link DRAIN}, so its entire sub-tree, at
 * any depth, is consumed and ignored. Nested levels share one `events` log and
 * the same `skip` set, so the same id is skipped at every depth.
 */
export class SkipVisitor implements Visitor {
  private array: { id: number; arrayKind: ArrayKind; values: (bigint | number)[] } | null = null;
  private fix: { id: number; isString: boolean; buf: Uint8Array; got: number } | null = null;

  constructor(
    private readonly skip: Set<number>,
    readonly events: Event[] = [],
  ) {}

  unsigned(id: number, value: number | bigint): void {
    if (!this.skip.has(id)) this.events.push({ kind: "unsigned", id, value });
  }
  signed(id: number, value: number | bigint): void {
    if (!this.skip.has(id)) this.events.push({ kind: "signed", id, value });
  }
  fp32(id: number, value: number): void {
    if (!this.skip.has(id)) this.events.push({ kind: "fp32", id, value });
  }
  fp64(id: number, value: number): void {
    if (!this.skip.has(id)) this.events.push({ kind: "fp64", id, value });
  }
  string(id: number, total: number, offset: number, chunk: Uint8Array): void {
    if (!this.skip.has(id)) this.fixChunk(true, id, total, offset, chunk);
  }
  blob(id: number, total: number, offset: number, chunk: Uint8Array): void {
    if (!this.skip.has(id)) this.fixChunk(false, id, total, offset, chunk);
  }
  arrayBegin(id: number, kind: ArrayKind): void {
    if (!this.skip.has(id)) this.array = { id, arrayKind: kind, values: [] };
  }
  arrayUnsigned(id: number, _i: number, value: number | bigint): void {
    if (!this.skip.has(id)) this.array!.values.push(value);
  }
  arraySigned(id: number, _i: number, value: number | bigint): void {
    if (!this.skip.has(id)) this.array!.values.push(value);
  }
  arrayFp32(id: number, _i: number, value: number): void {
    if (!this.skip.has(id)) this.array!.values.push(value);
  }
  arrayFp64(id: number, _i: number, value: number): void {
    if (!this.skip.has(id)) this.array!.values.push(value);
  }
  arrayEnd(id: number): void {
    if (this.skip.has(id)) return;
    this.events.push({ kind: "array", id, arrayKind: this.array!.arrayKind, values: this.array!.values });
    this.array = null;
  }
  sequenceBegin(id: number): Visitor {
    if (this.skip.has(id)) return DRAIN; // consume the whole sub-tree, record nothing
    this.events.push({ kind: "sequenceBegin", id });
    return new SkipVisitor(this.skip, this.events);
  }
  sequenceEnd(): void {
    this.events.push({ kind: "sequenceEnd" });
  }

  private fixChunk(isString: boolean, id: number, total: number, offset: number, chunk: Uint8Array): void {
    if (this.fix === null || this.fix.id !== id || this.fix.isString !== isString) {
      this.fix = { id, isString, buf: new Uint8Array(total), got: 0 };
    }
    this.fix.buf.set(chunk, offset);
    this.fix.got += chunk.length;
    if (this.fix.got >= total) {
      if (isString) this.events.push({ kind: "string", id, text: new TextDecoder().decode(this.fix.buf) });
      else this.events.push({ kind: "blob", id, bytes: this.fix.buf });
      this.fix = null;
    }
  }
}

/**
 * Independently compute the events a {@link SkipVisitor} should keep, by
 * filtering a full event log: drop any field whose id is skipped, and drop a
 * skipped sequence's `begin`/`end` markers together with everything between them
 * (at any nesting depth).
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

/** Collects a flat event log; string/blob chunks are concatenated. */
export class RecordingVisitor implements Visitor {
  readonly events: Event[] = [];
  private array: { id: number; arrayKind: ArrayKind; values: (bigint | number)[] } | null = null;
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
  string(id: number, total: number, offset: number, chunk: Uint8Array): void {
    this.fixChunk(true, id, total, offset, chunk);
  }
  blob(id: number, total: number, offset: number, chunk: Uint8Array): void {
    this.fixChunk(false, id, total, offset, chunk);
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
  sequenceBegin(id: number): Visitor {
    this.events.push({ kind: "sequenceBegin", id });
    return this;
  }
  sequenceEnd(): void {
    this.events.push({ kind: "sequenceEnd" });
  }

  private fixChunk(isString: boolean, id: number, total: number, offset: number, chunk: Uint8Array): void {
    if (this.fix === null || this.fix.id !== id || this.fix.isString !== isString) {
      this.fix = { id, isString, buf: new Uint8Array(total), got: 0 };
    }
    this.fix.buf.set(chunk, offset);
    this.fix.got += chunk.length;
    if (this.fix.got >= total) {
      if (isString) this.events.push({ kind: "string", id, text: new TextDecoder().decode(this.fix.buf) });
      else this.events.push({ kind: "blob", id, bytes: this.fix.buf });
      this.fix = null;
    }
  }
}
