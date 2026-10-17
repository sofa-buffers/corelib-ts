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
 * const d = s !== null && s.length === count ? (s.fill(0), s) : new Uint16Array(count);
 * ```
 *
 * which is the same expression for every schema, so by §8 it belongs here. These
 * are the static helper layer (§6.6.1), not codec primitives: the codec never
 * calls them, and they allocate on the caller's behalf.
 *
 * **Why the zero.** The decoder fills a typed destination element by element and
 * stops where a decode stops: an element its bound rejects, a refusal later in the
 * array, bytes that end mid-element. A plain array destination survives that
 * because {@link ElementSeq.end} cuts it to the elements this decode wrote; a typed
 * array cannot be cut, so without the zero its tail would still be the *previous*
 * message's elements, read as this one's. The zero is what buys the same promise
 * one level down, and it follows the array: `0n` for the two 64-bit pairs, `0`
 * for everything else.
 *
 * **Why ten functions and not one taking the constructor.** `reuseTyped(kept,
 * count, Uint16Array)` was measured against the inline form above on a message of
 * seven arrays of seven widths (Callgrind Ir/op, both V8 tiers, #210): one shared
 * function costs **+274 Ir per array** on the optimizing tier and +292 on the
 * baseline one — a fixed cost no tier optimizes away, because the constructor
 * argument turns `new make(count)` into a generic construct and `kept.fill(0)` into
 * a store polymorphic over every typed-array map that reaches it. One function per
 * width keeps each call site monomorphic and costs **+20 Ir per array** (+0.6% on
 * that message, re-measured against these exported functions rather than a local
 * copy of them), which is what makes the move affordable. Hence the shape: ten
 * three-line functions, dull on purpose.
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

/** Reuse a `u8` destination, zeroed, when it is exactly `count` long. */
export function reuseU8(kept: Uint8Array | null, count: number): Uint8Array {
  if (kept !== null && kept.length === count) {
    kept.fill(0);
    return kept;
  }
  return new Uint8Array(count);
}

/** Reuse a `u16` destination, zeroed, when it is exactly `count` long. */
export function reuseU16(kept: Uint16Array | null, count: number): Uint16Array {
  if (kept !== null && kept.length === count) {
    kept.fill(0);
    return kept;
  }
  return new Uint16Array(count);
}

/** Reuse a `u32` destination, zeroed, when it is exactly `count` long. */
export function reuseU32(kept: Uint32Array | null, count: number): Uint32Array {
  if (kept !== null && kept.length === count) {
    kept.fill(0);
    return kept;
  }
  return new Uint32Array(count);
}

/** Reuse an `i8` destination, zeroed, when it is exactly `count` long. */
export function reuseI8(kept: Int8Array | null, count: number): Int8Array {
  if (kept !== null && kept.length === count) {
    kept.fill(0);
    return kept;
  }
  return new Int8Array(count);
}

/** Reuse an `i16` destination, zeroed, when it is exactly `count` long. */
export function reuseI16(kept: Int16Array | null, count: number): Int16Array {
  if (kept !== null && kept.length === count) {
    kept.fill(0);
    return kept;
  }
  return new Int16Array(count);
}

/** Reuse an `i32` destination, zeroed, when it is exactly `count` long. */
export function reuseI32(kept: Int32Array | null, count: number): Int32Array {
  if (kept !== null && kept.length === count) {
    kept.fill(0);
    return kept;
  }
  return new Int32Array(count);
}

/** Reuse a `u64` destination, zeroed with `0n`, when it is exactly `count` long. */
export function reuseU64(kept: BigUint64Array | null, count: number): BigUint64Array {
  if (kept !== null && kept.length === count) {
    kept.fill(0n);
    return kept;
  }
  return new BigUint64Array(count);
}

/** Reuse an `i64` destination, zeroed with `0n`, when it is exactly `count` long. */
export function reuseI64(kept: BigInt64Array | null, count: number): BigInt64Array {
  if (kept !== null && kept.length === count) {
    kept.fill(0n);
    return kept;
  }
  return new BigInt64Array(count);
}

/** Reuse an `fp32` destination, zeroed, when it is exactly `count` long. */
export function reuseFp32(kept: Float32Array | null, count: number): Float32Array {
  if (kept !== null && kept.length === count) {
    kept.fill(0);
    return kept;
  }
  return new Float32Array(count);
}

/** Reuse an `fp64` destination, zeroed, when it is exactly `count` long. */
export function reuseFp64(kept: Float64Array | null, count: number): Float64Array {
  if (kept !== null && kept.length === count) {
    kept.fill(0);
    return kept;
  }
  return new Float64Array(count);
}
