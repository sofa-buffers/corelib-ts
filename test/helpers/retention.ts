/**
 * Does the pool still hold the caller's objects? — the one question
 * `DecoderState.release` exists to answer, and the only one about it an outside
 * observer can ask.
 *
 * `release()` drops references: the visitor, the chunk handle, the destination an
 * array hand-off installed. Nothing it drops is *readable* afterwards — `begin()`
 * re-points the visitor and clears `bulk` on the next decode, and a stale chunk
 * handle is rebuilt the moment a different buffer arrives — so a machine that
 * released nothing decodes exactly the same and every value assertion in the suite
 * passes. What it would do instead is keep the last caller's message alive in a
 * module-level singleton for the life of the process, which is CORELIB_PLAN §6.6 /
 * §6.7's "nothing outlives the call" read as liveness. Liveness is measured with a
 * `WeakRef`, so that is what this does.
 *
 * `WeakRef` is ES2021 and this project's `lib` is ES2020 — the floor the library
 * itself compiles against, which the tests have no business raising. Node has had
 * it since 14, so it is reached here through the runtime global, in the one place
 * that needs it.
 */

import v8 from "node:v8";
import vm from "node:vm";

interface Weak<T extends object> {
  deref(): T | undefined;
}
const WeakRef = (
  globalThis as unknown as { WeakRef: new <T extends object>(target: T) => Weak<T> }
).WeakRef;

/** A full collection, through the flag flip `heap-free-codec.test.ts` also uses. */
function collector(): () => void {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  v8.setFlagsFromString("--no-expose-gc");
  return gc;
}

/**
 * Run `call` — a decode, plus the objects it was handed — and report which of those
 * objects are **still reachable** afterwards, by name. `[]` is the answer a released
 * machine gives.
 *
 * `call` must be the only holder of what it returns: the strong reference handed
 * back is dropped here before anything is collected, so an object kept alive by the
 * test's own scope would be reported as a survivor and read as a leak.
 *
 * Collection is attempted on the far side of a turn, because a `WeakRef` made in
 * this one keeps its target alive until the end of it by specification, and it is
 * retried a few times rather than once: one `gc()` is enough in practice, and a
 * loop costs nothing when the answer is already `[]`.
 */
export async function survivors(call: () => Record<string, object>): Promise<string[]> {
  const gc = collector();
  let handed: Record<string, object> | null = call();
  const watched = Object.keys(handed).map((name) => [name, new WeakRef(handed![name]!)] as const);
  handed = null; // this frame's only strong reference, and it must not outlive the loop
  void handed;
  for (let round = 0; round < 10; round++) {
    if (watched.every(([, ref]) => ref.deref() === undefined)) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  }
  return watched.filter(([, ref]) => ref.deref() !== undefined).map(([name]) => name);
}
