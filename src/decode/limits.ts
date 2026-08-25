/**
 * Receiver-side technical limits (CORELIB_PLAN §6.2.1).
 *
 * A field the schema leaves unbounded (`maxlen` / `count` omitted — MESSAGE_SPEC
 * §7.2) declares no ceiling on the wire, which would let the **sender** dictate
 * the **receiver's** memory. So every receiver carries these caps, and §6.2.1 is
 * explicit that **there is no unset state and no unlimited mode**: an omitted
 * option here takes the format-wide ceiling it bounds ({@link ARRAY_MAX},
 * {@link FIXLEN_MAX}), not "off". `Infinity` is rejected for the same reason,
 * and so is any value above the ceiling.
 *
 * **The numbers are not the codec's to choose, and this port invents none.**
 * §6.2.1: "The limits come from generated code, which knows the schema and the
 * target … the codec never invents a limit of its own and never clamps to one",
 * and SofaBuffers ARCHITECTURE §9.5 says the value comes "from generated code,
 * never from a default the corelib invented". So an omitted cap falls back to
 * the widest value that is still a limit — the format ceiling above which the
 * count or length is already `INVALID` (§6.2) — rather than to a number this
 * port picked. A decoder built without limits is therefore bounded exactly as
 * the format bounds it, and one built by generated code is bounded by the
 * deployment's own numbers. Pass yours.
 *
 * They are **configuration, not schema**:
 *
 * - exceeding one is a **policy rejection**, a category distinct from `INVALID`:
 *   it throws {@link SofabErrorCode.LimitExceeded}, never `InvalidMsg`, because
 *   the identical bytes decode fine under a looser limit — so differential
 *   fuzzing must not read it as a conformance divergence;
 * - two receivers configured differently reaching different outcomes on the same
 *   message is neither an interop failure nor a conformance defect, which is why
 *   conformance testing compares implementations configured **identically**;
 * - they are never applied to a field the *schema* bounds — there the schema bound
 *   governs and its violation is `INVALID` (MESSAGE_SPEC §7, §7.1). This surface
 *   is driven by wire type and never learns the schema, so generated code applies
 *   that distinction: it passes the schema bound to the helper it decodes with
 *   (see {@link StringSeq}) and leaves these caps for what the schema left open.
 *
 * Enforcement is at the count / length header — before the allocation it exists to
 * prevent, and for a sequence array at the element **index**, which is where a
 * wrapper array's length is decided (MESSAGE_SPEC §5.1). A limit is **rejected,
 * never clamped**: materializing `limit` elements where the wire said more is data
 * corruption wearing a safety jacket.
 */

import { ARRAY_MAX, FIXLEN_MAX } from "../constants.js";
import { argumentError } from "../errors.js";

/**
 * Receiver-side caps, all optional at the surface and all finite in effect: an
 * omitted one takes the format ceiling it bounds, and there is no way to ask for
 * none (§6.2.1).
 */
export interface DecodeLimits {
  /**
   * Reject an array whose element `count` exceeds this, before the array is
   * materialized. Defaults to {@link ARRAY_MAX}, above which the count is
   * already `INVALID`.
   */
  maxArrayCount?: number;
  /**
   * Reject a UTF-8 string whose declared byte length exceeds this, before the
   * payload is decoded or streamed. Defaults to {@link FIXLEN_MAX}, above which
   * the length is already `INVALID`.
   */
  maxStringLen?: number;
  /**
   * Reject a blob whose declared byte length exceeds this, before the payload is
   * accepted or streamed. Defaults to {@link FIXLEN_MAX}, above which the length
   * is already `INVALID`.
   */
  maxBlobLen?: number;
}

// Three accessors rather than one resolved object: the decoder holds the caps as
// plain number fields, and a one-shot decode re-binds them per message — so an
// object here would be an allocation per message on a path that has none (§6.6).

/** @internal The array-count cap in effect: the caller's, or the format ceiling. */
export function capArrayCount(limits?: DecodeLimits): number {
  return cap(limits?.maxArrayCount, ARRAY_MAX, "maxArrayCount");
}

/** @internal The string-length cap in effect. */
export function capStringLen(limits?: DecodeLimits): number {
  return cap(limits?.maxStringLen, FIXLEN_MAX, "maxStringLen");
}

/** @internal The blob-length cap in effect. */
export function capBlobLen(limits?: DecodeLimits): number {
  return cap(limits?.maxBlobLen, FIXLEN_MAX, "maxBlobLen");
}

/**
 * One cap: the format ceiling when omitted, otherwise a finite non-negative
 * integer no larger than that ceiling. `Infinity` is not an accepted value —
 * "unlimited" is exactly what §6.2.1 removed — and a cap above the ceiling would
 * be one the format can never reach.
 */
function cap(value: number | undefined, ceiling: number, name: string): number {
  if (value === undefined) return ceiling;
  if (!Number.isInteger(value) || value < 0 || value > ceiling) {
    throw argumentError(
      `${name} must be an integer in 0..${ceiling} (got ${value}); ` +
        "there is no unlimited mode (CORELIB_PLAN §6.2.1)",
    );
  }
  return value;
}
