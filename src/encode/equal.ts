/**
 * Generated-layer support: the array half of the ≠-default test that decides
 * whether a field is written at all (MESSAGE_SPEC §2).
 *
 * SofaBuffers omits a field whose value equals its schema default, so every
 * generated `serialize` compares before it writes. For a scalar that is `!==`;
 * for an array it is element-wise, because two distinct `Uint8Array` /
 * `number[]` instances holding the same values are the same *value* and must
 * encode the same way — `a !== b` would emit the field whenever the destination
 * happened to be a fresh object, and the wire is supposed to be canonical.
 *
 * The comparison has no schema in it: the declared type only decides which
 * arrays are handed over. So it is written once here instead of being emitted
 * into every generated package (ARCHITECTURE §8).
 */

/**
 * Element-wise equality for two array-likes: same length, and `===` at every
 * index. Covers what a leaf array field can hold — `Uint8Array` (blob), and
 * `number[]` / `bigint[]` / `boolean[]` / `string[]` — including a mixed pair
 * such as a `Uint8Array` value against a plain-array default from the schema.
 *
 * Deliberately **not** deep: a nested (wrapper) array of messages is compared by
 * the generated `isDefault()` of its element type, which is the only code that
 * knows what a default element is. Equally deliberately `===`, which makes `NaN`
 * unequal to itself — matching the scalar `!==` test, the IEEE-754 rule the rest
 * of the encoder follows, and the only reading under which an `fp32`/`fp64`
 * `NaN` element survives the round trip rather than being omitted as "default".
 * There is no identity short-circuit for the same reason: `elementsEqual(x, x)`
 * has to give the same answer as `elementsEqual(x, x.slice())`.
 */
export function elementsEqual(a: ArrayLike<unknown>, b: ArrayLike<unknown>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
