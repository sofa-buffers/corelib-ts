/**
 * Reuse an exact-width destination, one function per width: the choice a decode
 * into a destination that already holds a message makes at every native array's
 * header (corelib-ts#210, generator ARCHITECTURE §8).
 *
 * A generated message decoded a second time already holds a typed array for its
 * `u16[]` field. Where the count on the wire is that array's length, it is the
 * right place to put this message's elements, and a receive loop that reuses it
 * allocates no array storage at all. Where it is not, there is nothing to trim it
 * with — a typed array's `length` is read-only — so a new one is the answer.
 *
 * The generated layer spelled that per array field and per matrix row:
 *
 * ```ts
 * const d = s !== null && s.length === count ? s : new Uint16Array(count);
 * ```
 *
 * which is the same expression for every schema, so by §8 it belongs here. These
 * are the static helper layer (§6.6.1), not codec primitives: the codec never
 * calls them, and they allocate on the caller's behalf.
 *
 * **Why there is no zero here, and where that guarantee lives instead.** A reused
 * destination must not show the *previous* message's elements as this one's. These
 * functions used to buy that by zeroing the array they hand back, which is the
 * whole promise in one line — and the wrong line to put it on. An array the decode
 * completes has every slot of it written, so the zero only ever mattered for an
 * array the decode did *not* complete, and it was paid on every array of every
 * message either way: measured on ten `u16[]` fields of five elements, one
 * destination per field kept across decodes, **198 Ir per array** on the
 * optimizing tier and 243 on the baseline one — 11.5% of that decode.
 *
 * So the decoder carries it now, where the information is. It fills ascending from
 * index 0, and the slots it never reached are zeroed when the decode that
 * abandoned them is over: on the terminal refusal that stopped it, and when a
 * pooled machine is released — which is what `decode` and `tryDecode` do in a
 * `finally`, success or not. A plain-array destination is cut to the prefix
 * instead, as it always was. The guarantee is unchanged; what changed is that an
 * array nobody refused and nobody truncated no longer pays for it.
 *
 * **Why ten functions and not one taking the constructor.** `reuseTyped(kept,
 * count, Uint16Array)` was measured against the inline form above on a message of
 * seven arrays of seven widths (Callgrind Ir/op, both V8 tiers, #210): one shared
 * function costs **+274 Ir per array** on the optimizing tier and +292 on the
 * baseline one — a fixed cost no tier optimizes away, because the constructor
 * argument turns `new make(count)` into a generic construct. One function per
 * width keeps each call site monomorphic. Hence the shape: ten one-line functions,
 * dull on purpose.
 *
 * **What each one is for.** The eight integer widths are
 * {@link IntegerArrayTarget.typed}'s, exactly as the schema declares them. The two
 * float ones are {@link FloatArrayTarget.f32} / {@link FloatArrayTarget.f64}. The
 * destinations with no width of their own borrow: a `bool` array's `Uint8Array` is
 * {@link reuseU8}, and `bits` or an `lo`/`hi` pair is {@link reuseU32}.
 *
 * `count` is the element count the decoder just reported at `arrayBegin`, already
 * bounded by {@link ARRAY_MAX} and by whatever receiver cap compared it, so none of
 * these spends a check on it. The length test is `===` for the reason
 * {@link PayloadAcc.takeInto}'s is: a destination longer than the array would
 * overstate it, and nothing here may hand back a view of a caller's storage.
 */

/** Reuse a `u8` destination when it is exactly `count` long. */
export function reuseU8(kept: Uint8Array | null, count: number): Uint8Array {
  return kept !== null && kept.length === count ? kept : new Uint8Array(count);
}

/** Reuse a `u16` destination when it is exactly `count` long. */
export function reuseU16(kept: Uint16Array | null, count: number): Uint16Array {
  return kept !== null && kept.length === count ? kept : new Uint16Array(count);
}

/** Reuse a `u32` destination when it is exactly `count` long. */
export function reuseU32(kept: Uint32Array | null, count: number): Uint32Array {
  return kept !== null && kept.length === count ? kept : new Uint32Array(count);
}

/** Reuse an `i8` destination when it is exactly `count` long. */
export function reuseI8(kept: Int8Array | null, count: number): Int8Array {
  return kept !== null && kept.length === count ? kept : new Int8Array(count);
}

/** Reuse an `i16` destination when it is exactly `count` long. */
export function reuseI16(kept: Int16Array | null, count: number): Int16Array {
  return kept !== null && kept.length === count ? kept : new Int16Array(count);
}

/** Reuse an `i32` destination when it is exactly `count` long. */
export function reuseI32(kept: Int32Array | null, count: number): Int32Array {
  return kept !== null && kept.length === count ? kept : new Int32Array(count);
}

/** Reuse a `u64` destination when it is exactly `count` long. */
export function reuseU64(kept: BigUint64Array | null, count: number): BigUint64Array {
  return kept !== null && kept.length === count ? kept : new BigUint64Array(count);
}

/** Reuse an `i64` destination when it is exactly `count` long. */
export function reuseI64(kept: BigInt64Array | null, count: number): BigInt64Array {
  return kept !== null && kept.length === count ? kept : new BigInt64Array(count);
}

/** Reuse an `fp32` destination when it is exactly `count` long. */
export function reuseFp32(kept: Float32Array | null, count: number): Float32Array {
  return kept !== null && kept.length === count ? kept : new Float32Array(count);
}

/** Reuse an `fp64` destination when it is exactly `count` long. */
export function reuseFp64(kept: Float64Array | null, count: number): Float64Array {
  return kept !== null && kept.length === count ? kept : new Float64Array(count);
}
