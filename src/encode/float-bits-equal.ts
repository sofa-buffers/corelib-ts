/**
 * Generated-layer support: the float half of the ≠-default test for arrays
 * (MESSAGE_SPEC §2, CORELIB_PLAN §4.6).
 *
 * Floats round-trip bit for bit, so "equals its default" has to mean "has the
 * same bits as its default". The IEEE `===` of {@link elementsEqual} gets two
 * cases wrong for a float array: `-0` equals `+0` (a `[-0, 1.5]` value would be
 * omitted as the default `[0, 1.5]` and come back as `+0`), and `NaN` differs
 * from itself (a NaN default would never be recognised). The comparison has no
 * schema in it, so it lives here and not in every generated package
 * (ARCHITECTURE §8).
 *
 * Three entry points share one rule. {@link fp32ArrayBitsEqual} and
 * {@link fp64ArrayBitsEqual} are what generated code calls: each takes exactly
 * one typed-array type, so the element loads in its loop see one container
 * layout. {@link floatArrayBitsEqual} accepts any `ArrayLike<number>`.
 */

const f64 = new Float64Array(2);
const u32 = new Uint32Array(f64.buffer);

/** Both NaN: only the sign and payload can differ, so compare the two words. */
function sameNaNBits(x: number, y: number): boolean {
  f64[0] = x;
  f64[1] = y;
  return u32[0] === u32[2] && u32[1] === u32[3];
}

/**
 * Bit-pattern equality for two float arrays: same length, and at every index the
 * same IEEE-754 bits. `+0` and `-0` differ; a `NaN` equals another `NaN` only if
 * the bits are identical; there is no `===` verdict on its own.
 *
 * Both element widths give the same verdict here. An `fp32` is held as a double
 * in this port, so the bits compared are those of the held double — and widening
 * a float32 to a double is injective on bit patterns, so that is the same verdict
 * as comparing the 32-bit patterns. The signaling-NaN raw-bytes path
 * ({@link fp32RawBytes}) is separate and untouched.
 *
 * The NaN payload comparison is only as exact as the container: a plain
 * `number[]` may canonicalise a NaN when it is stored (V8 does, to keep its hole
 * pattern free), so payloads are only distinguishable in a `Float64Array` /
 * `Float32Array`; for a plain array every NaN of one sign compares equal. The
 * comparison itself reads each element once and computes nothing on it.
 *
 * Accepts `number[]`, typed arrays and a literal default alike. No allocation
 * per call, no mutation, no identity short-circuit (`x` against `x` gives the
 * same answer as against a copy).
 */
export function floatArrayBitsEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  const n = a.length;
  if (n !== b.length) return false;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) {
      // Equal values: identical bits unless the pair is {+0, -0}.
      if (x === 0 && !Object.is(x, y)) return false;
    } else if (x === x || y === y) {
      // Unequal and not both NaN: different values, different bits.
      return false;
    } else if (!sameNaNBits(x, y)) {
      return false;
    }
  }
  return true;
}

// The next two functions are `floatArrayBitsEqual` with the parameter types
// narrowed, and the bodies are deliberately written out twice instead of shared.
// V8 keeps one set of type feedback per function, so a loop that has seen both a
// `Float32Array` and a `Float64Array` compiles polymorphic element loads; measured
// on the generated omit test at a 16-element default, the shared form took the
// same time as the old IEEE compare only when it never met the second type, and
// was up to 3x slower once it had. One type per function keeps every loop
// monomorphic whatever else the program compares.

/** {@link floatArrayBitsEqual} for two `Float32Array`s: what an fp32 array member is compared with. */
export function fp32ArrayBitsEqual(a: Float32Array, b: Float32Array): boolean {
  const n = a.length;
  if (n !== b.length) return false;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) {
      if (x === 0 && !Object.is(x, y)) return false;
    } else if (x === x || y === y) {
      return false;
    } else if (!sameNaNBits(x, y)) {
      return false;
    }
  }
  return true;
}

/** {@link floatArrayBitsEqual} for two `Float64Array`s: what an fp64 array member is compared with. */
export function fp64ArrayBitsEqual(a: Float64Array, b: Float64Array): boolean {
  const n = a.length;
  if (n !== b.length) return false;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) {
      if (x === 0 && !Object.is(x, y)) return false;
    } else if (x === x || y === y) {
      return false;
    } else if (!sameNaNBits(x, y)) {
      return false;
    }
  }
  return true;
}
