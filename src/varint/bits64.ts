/**
 * 64-bit ⇄ (lo, hi) bit punning through one shared 8-byte scratch buffer.
 *
 * Every hot path in the codec needs the same two conversions: a `bigint` split
 * into two unsigned 32-bit *number* halves (encode), and two halves joined back
 * into a `bigint` (decode). Doing that with `bigint` arithmetic —
 * `Number(v & 0xffff_ffffn)` / `(BigInt(hi) << 32n) | BigInt(lo)` — allocates a
 * fresh heap `bigint` per intermediate, and profiling under Callgrind showed
 * that split alone accounting for ~74% of the `u64 array` encode workload
 * (≈900 instructions per element).
 *
 * Aliasing one `ArrayBuffer` with a {@link BigUint64Array} and a
 * {@link Uint32Array} turns both conversions into raw loads and stores: the
 * engine converts a `bigint` to two machine words on the typed-array store and
 * back on the load, with **no intermediate allocation**. Measured on V8 the
 * split drops from ~900 to ~32 instructions per element (28×) and the join from
 * ~360 to ~81 (4.5×).
 *
 * **Truncation is identical to the masking it replaces.** Storing into a
 * `BigUint64Array` applies `ToBigUint64` — reduction modulo 2^64 — which is
 * exactly what `value & 0xffff_ffffn` plus `(value >> 32n) & 0xffff_ffffn`
 * computed, including for negative and over-wide inputs. `BigInt64Array`
 * applies `ToBigInt64`, the signed counterpart.
 *
 * **The scratch is shared, so read both halves immediately.** Every use must be
 * a straight-line store-then-load with no intervening call that could itself
 * reach this module — in particular no `ensure()` (which may invoke a
 * caller-supplied flush sink) between the split and the reads. Callers here
 * copy `lo`/`hi` into locals first, which is why that ordering is spelled out
 * at each call site.
 */

const SCRATCH = new ArrayBuffer(8);

/** Unsigned 64-bit view of the scratch — the `ToBigUint64` conversion seam. */
export const S_U64 = new BigUint64Array(SCRATCH);
/** Signed 64-bit view of the scratch — the `ToBigInt64` conversion seam. */
export const S_I64 = new BigInt64Array(SCRATCH);
/** Two 32-bit halves of the scratch, in host byte order (see {@link LO}). */
export const S_U32 = new Uint32Array(SCRATCH);

// Typed arrays use *host* byte order, so which Uint32Array slot holds the low
// half depends on the platform. Probe it once: write 1 into slot 0 and see
// whether the 64-bit view reads it as the value 1 (little-endian) or as
// 2^32 (big-endian). Every real target is little-endian, so the branches below
// fold away, but the format itself is little-endian on every host (§4) and this
// keeps that true without a per-value byte swap.
S_U64[0] = 0n;
S_U32[0] = 1;
/** Index of the low 32-bit half in {@link S_U32} on this host. */
export const LO = S_U64[0] === 1n ? 0 : 1;
/** Index of the high 32-bit half in {@link S_U32} on this host. */
export const HI = LO ^ 1;

/**
 * True when `value` fits an unsigned 64-bit integer — and, as a side effect,
 * leaves its two halves in {@link S_U32} for the caller to read.
 *
 * The round-trip *is* the range check: the store reduces modulo 2^64, so the
 * reloaded value differs from the original exactly when the original was
 * negative or ≥ 2^64. That fuses the `0n <= v <= U64_MAX` test (two `bigint`
 * comparisons) and the split (three `bigint` allocations) into one store, one
 * load and one compare.
 */
export function splitU64(value: bigint): boolean {
  S_U64[0] = value;
  return S_U64[0] === value;
}

/**
 * True when `value` fits a signed 64-bit integer, leaving its two's-complement
 * halves in {@link S_U32}. The signed twin of {@link splitU64}.
 */
export function splitI64(value: bigint): boolean {
  S_I64[0] = value;
  return S_I64[0] === value;
}

/** Join two unsigned 32-bit halves into an unsigned 64-bit `bigint`. */
export function joinU64(lo: number, hi: number): bigint {
  S_U32[LO] = lo;
  S_U32[HI] = hi;
  return S_U64[0]!;
}

/** Join two 32-bit halves into a *signed* 64-bit `bigint` (two's complement). */
export function joinI64(lo: number, hi: number): bigint {
  S_U32[LO] = lo;
  S_U32[HI] = hi;
  return S_I64[0]!;
}
