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
 */

const f64 = new Float64Array(2);
const u32 = new Uint32Array(f64.buffer);

/**
 * Bit-pattern equality for two float arrays: same length, and at every index the
 * same IEEE-754 bits. `+0` and `-0` differ; a `NaN` equals another `NaN` only if
 * the bits are identical; there is no `===` verdict on its own.
 *
 * Both element widths use this one function. An `fp32` is held as a double in
 * this port, so the bits compared are those of the held double — and widening a
 * float32 to a double is injective on bit patterns, so that is the same verdict
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
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) {
      // Equal values: identical bits unless the pair is {+0, -0}.
      if (x === 0 && 1 / x !== 1 / y) return false;
    } else if (x === x || y === y) {
      // Unequal and not both NaN: different values, different bits.
      return false;
    } else {
      // Both NaN: only the payload and sign can differ.
      f64[0] = x;
      f64[1] = y;
      if (u32[0] !== u32[2] || u32[1] !== u32[3]) return false;
    }
  }
  return true;
}
