/**
 * The **one** leaf the two header-ceiling blocks share.
 *
 * `header_limits` puts its field at the top level; `header_limits_nested` puts the
 * identical field one or two sequence frames deeper. They are required to differ in
 * *where the field arrives* and in nothing else, so the part that actually decides
 * the verdict — the ceiling comparison, at the header word, in the generated
 * layer's stand-in — lives here and is imported by both. A nested block with a leaf
 * of its own could pass by a mechanism the flat block never exercises, which would
 * make it assert the runner rather than the library (test_vectors_README.md, the
 * `header_limits_nested` section).
 *
 * **Where the ceiling lives in this port.** This codec holds no limit (§6.2.1): the
 * numbers are generated code's, and it compares them inside its own visitor — at
 * {@link Visitor.fixlenBegin} for a declared byte length and at
 * {@link Visitor.arrayBegin} for a declared element count. The library's half of the
 * contract is that those two events are raised **at the header word, with the length
 * / count consumed and the payload not yet entered**, at every depth, and that a
 * rejection thrown out of them is latched terminal by {@link IStream.feed}.
 */

import {
  ArrayKind,
  FixlenSubtype,
  SofabError,
  SofabErrorCode,
  type ArrayTarget,
  type Visitor,
} from "../../src/index.js";
import { hexToBytes } from "./hex.js";
import type { HeaderLimitCase } from "./vectors.js";

/** The error code each stated outcome must arrive under (§6.3 keeps the two apart). */
export const CODE = {
  limit_exceeded: SofabErrorCode.LimitExceeded,
  invalid: SofabErrorCode.InvalidMsg,
} as const;

/**
 * The ceiling a case configures, in the shape the generated layer would hold it:
 * a receiver cap on one declared quantity, or the schema's own bound.
 */
export type Ceiling =
  | { kind: "cap"; on: "string" | "blob" | "array"; limit: number }
  | { kind: "schema"; limit: number };

/** Read the case's stated ceiling — exactly one, which the loader already enforced. */
export function ceilingOf(c: HeaderLimitCase): Ceiling {
  if (c.schema !== undefined) return { kind: "schema", limit: c.schema.maxlen! };
  const l = c.limits!;
  if (l.max_dyn_string_len !== undefined) {
    return { kind: "cap", on: "string", limit: l.max_dyn_string_len };
  }
  if (l.max_dyn_blob_len !== undefined) return { kind: "cap", on: "blob", limit: l.max_dyn_blob_len };
  if (l.max_dyn_array_count !== undefined) {
    return { kind: "cap", on: "array", limit: l.max_dyn_array_count };
  }
  throw new Error(`${c.name}: limits states no cap this reader knows`);
}

/**
 * The value the negative control lifts a ceiling to: far above every `declared` in
 * these blocks, and small enough that lifting it cannot provoke an absurd
 * allocation.
 */
export const LIFTED = 65536;

/**
 * The same ceiling, raised out of the way — **the same kind**, which is the point.
 *
 * A control that lifted a *cap* while the case's `schema` bound stayed at 16 would
 * see the verdict not change and blame the enforcement point; one that lifted both
 * would let a schema case pass for the cap's reason. Neither proves what the
 * control exists to prove, so the kind is carried over and only the number moves.
 */
export function lifted(ceiling: Ceiling, to: number = LIFTED): Ceiling {
  return { ...ceiling, limit: to };
}

/** What the visitor was told, in order — the header word first, payload after it. */
export type Event =
  | { at: "fixlenBegin"; id: number; subtype: FixlenSubtype; declared: number }
  | { at: "arrayBegin"; id: number; declared: number }
  | { at: "payload" };

/**
 * The storage the generated layer would fill for the target field — and the thing
 * §6.2.1's "rejected, never clamped" is about.
 *
 * A port that truncates to the ceiling and reports the error anyway passes the
 * outcome assertion and is caught only here, by the destination still being empty
 * afterwards. Bytes land in {@link bytes} for a `string`/`blob` and elements in
 * {@link values} for an array, through the ordinary bulk hand-off.
 */
export interface Destination {
  bytes: number[];
  values: (number | bigint)[];
}

/** A fresh, empty destination for one case's run. */
export function emptyDestination(): Destination {
  return { bytes: [], values: [] };
}

/** True when the destination holds nothing at all — nothing was materialized. */
export function isEmpty(dest: Destination): boolean {
  return dest.bytes.length === 0 && dest.values.length === 0;
}

/**
 * The element bound the bulk hand-off requires beside the destination — the
 * *schema's* interval, which is not the subject here, so it is the widest the
 * element kind can express and never fires.
 */
const WIDEST = {
  [ArrayKind.Unsigned]: { minLo: 0, minHi: 0, maxLo: 0xffff_ffff, maxHi: 0xffff_ffff },
  [ArrayKind.Signed]: { minLo: 0, minHi: 0x8000_0000, maxLo: 0xffff_ffff, maxHi: 0x7fff_ffff },
} as const;

/**
 * The generated layer's stand-in: the case's ceiling, compared where §6.2.1 puts
 * the comparison — inside the visitor, at the header word.
 *
 * `ceiling` is `null` to run the identical bytes with no ceiling configured at all.
 * A schema bound is applied only to a subtype that carries a byte length (§7.3: a
 * field whose subtype contradicts the schema is skipped, not rejected), and a
 * receiver cap only to the quantity it names — a port can wire the string cap and
 * miss the blob one, which is why §6.2.1 keeps them separate and why the blocks
 * assert both.
 *
 * `inScope` is how the nested block reuses this unchanged: the flat block's field
 * is always in scope, while the nested one answers "am I inside the frame chain
 * this case names?". Everything the verdict depends on is below this line and is
 * the same code for both.
 */
export function ceilingLeaf(
  c: HeaderLimitCase,
  log: Event[],
  ceiling: Ceiling | null,
  dest: Destination,
  inScope: () => boolean = () => true,
): Visitor {
  const payload = (): void => void log.push({ at: "payload" });
  return {
    fixlenBegin(id, subtype, total) {
      log.push({ at: "fixlenBegin", id, subtype, declared: total });
      if (id !== c.field_id || ceiling === null || !inScope()) return;
      const isBytes = subtype === FixlenSubtype.String || subtype === FixlenSubtype.Blob;
      if (ceiling.kind === "schema") {
        if (isBytes && total > ceiling.limit) {
          throw new SofabError(
            SofabErrorCode.InvalidMsg,
            `field ${id}: declared length ${total} above schema maxlen ${ceiling.limit}`,
          );
        }
        return;
      }
      const capped =
        (ceiling.on === "string" && subtype === FixlenSubtype.String) ||
        (ceiling.on === "blob" && subtype === FixlenSubtype.Blob);
      if (capped && total > ceiling.limit) {
        throw new SofabError(
          SofabErrorCode.LimitExceeded,
          `field ${id}: declared length ${total} exceeds the receiver cap ${ceiling.limit}`,
        );
      }
    },
    arrayBegin(id, _kind, count) {
      log.push({ at: "arrayBegin", id, declared: count });
      if (id !== c.field_id || ceiling === null || !inScope()) return;
      if (ceiling.kind === "cap" && ceiling.on === "array" && count > ceiling.limit) {
        throw new SofabError(
          SofabErrorCode.LimitExceeded,
          `field ${id}: declared count ${count} exceeds the receiver cap ${ceiling.limit}`,
        );
      }
    },
    string(_id, _total, _offset, src, start, end) {
      payload();
      for (let i = start; i < end; i++) dest.bytes.push(src[i]!);
    },
    blob(_id, _total, _offset, src, start, end) {
      payload();
      for (let i = start; i < end; i++) dest.bytes.push(src[i]!);
    },
    // An array's elements reach a visitor only through the hand-off, which is
    // offered *after* `arrayBegin` — so being offered it at all is this log's
    // "the payload was entered", and a cap that fired above must prevent it.
    arrayBulk: (_id, kind): ArrayTarget | null => {
      payload();
      if (kind !== ArrayKind.Unsigned && kind !== ArrayKind.Signed) return null;
      return { values: dest.values, ...WIDEST[kind] };
    },
  };
}

/** The case's bytes, as the chunks it asks to be fed in (one chunk by default). */
export function chunksOf(c: HeaderLimitCase): Uint8Array[] {
  return (c.chunks ?? [c.serialized]).map(hexToBytes);
}

/** The payload the header promised, for the further feed a terminal rejection must refuse. */
export function promisedPayload(c: HeaderLimitCase): Uint8Array {
  // Capped: `header_string_amplification` claims a gibibyte, and the assertion is
  // that not one byte of it is consumed — a few of them prove that as well as 2^30.
  return new Uint8Array(Math.min(c.declared, 64)).fill(0x61);
}
