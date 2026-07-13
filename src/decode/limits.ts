/**
 * Opt-in decode resource limits (corelib-ts#38).
 *
 * SofaBuffers' `count` (arrays) and `maxlen` (strings / blobs) schema bounds are
 * optional; when a schema omits them the decoder accepts whatever count / length
 * the received message claims, with no upper bound. That leaves a receiver no way
 * to cap memory against a hostile, oversized field. {@link DecodeLimits} is that
 * cap: an optional options object accepted by every decode entry point
 * ({@link decode}, the {@link IStream} constructor, and the {@link Cursor}
 * constructor).
 *
 * The limits are a **receiver-side policy**, not part of the wire format or the
 * message schema. The normative source of the values is the sofabgen config
 * (see sofa-buffers/generator#102): the generator bakes them into generated code
 * as constants and passes them here at decoder construction. This corelib only
 * provides the mechanism — **an omitted limit means no cap (today's behavior);
 * there is no corelib-side default.**
 *
 * Enforcement happens at header time — where the count / length is first decoded,
 * before any array is sized or any payload is accepted or streamed — so a claimed
 * oversize is rejected even if the payload never arrives. Exceeding a limit is
 * never clamped or truncated: it throws a {@link SofabError} with code
 * {@link SofabErrorCode.LimitExceeded}, which is deliberately distinct from
 * `InvalidMsg` (policy, not malformation).
 */
export interface DecodeLimits {
  /**
   * Reject a dynamic (`u*` / `i*`, `fp32` / `fp64`) array whose element `count`
   * exceeds this, before the array is materialized. Omit for no cap.
   */
  maxArrayCount?: number;
  /**
   * Reject a UTF-8 string whose declared byte length exceeds this, before the
   * payload is decoded or streamed. Omit for no cap.
   */
  maxStringLen?: number;
  /**
   * Reject a blob whose declared byte length exceeds this, before the payload is
   * accepted or streamed. Omit for no cap.
   */
  maxBlobLen?: number;
}
