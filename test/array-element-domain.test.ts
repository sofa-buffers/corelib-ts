/**
 * An array element outside the 64-bit value domain is a caller mistake
 * (`ARGUMENT`), in **both** encoder modes.
 *
 * CORELIB_PLAN §6.2 fixes the value domains at `0 .. 2^64 - 1` (unsigned) and
 * `-2^63 .. 2^63 - 1` (signed), and §6.3 makes an out-of-range argument an
 * `InvalidArgument` — never a silently reduced value. The in-memory (growable)
 * array writers dispatch into the bulk `Kernel` while the streaming ones write
 * element by element, so the same call had two different answers: the streaming
 * form threw and the growable one wrapped modulo 2^64 (corelib-ts#106). These
 * tests pin the two modes to the *same* answer.
 */

import { describe, expect, it } from "vitest";
import { OStream, SofabError, SofabErrorCode } from "../src/index.js";

/** A streaming encoder: fixed caller buffer plus a sink that drops the bytes. */
function streaming(): OStream {
  return new OStream(new Uint8Array(64), 0, () => {});
}

/** Values outside `uint64`, in both `bigint` and `number` shape. */
const badUnsigned: (number | bigint)[] = [
  -1n,
  -(2n ** 63n),
  1n << 64n,
  2n ** 64n + 1n,
  -1,
  -(2 ** 31),
  2 ** 64,
];

/** Values outside `int64`, in both `bigint` and `number` shape. */
const badSigned: (number | bigint)[] = [
  1n << 63n,
  2n ** 64n,
  -(2n ** 63n) - 1n,
  -(2n ** 64n),
  2 ** 64,
  -(2 ** 64),
];

function expectArgument(fn: () => void, what: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `${what} was accepted`).toBeInstanceOf(SofabError);
  expect((thrown as SofabError).code, what).toBe(SofabErrorCode.Argument);
}

describe("array elements outside the 64-bit domain are rejected (§6.2)", () => {
  it.each(badUnsigned.map((v) => [String(v), v] as const))(
    "unsigned %s is ARGUMENT in the in-memory mode",
    (label, v) => {
      expectArgument(() => new OStream().writeUnsignedArray(1, [v]), `unsigned ${label}`);
    },
  );

  it.each(badSigned.map((v) => [String(v), v] as const))(
    "signed %s is ARGUMENT in the in-memory mode",
    (label, v) => {
      expectArgument(() => new OStream().writeSignedArray(1, [v]), `signed ${label}`);
    },
  );

  it("both modes agree on every out-of-domain unsigned element", () => {
    for (const v of badUnsigned) {
      expectArgument(() => streaming().writeUnsignedArray(1, [v]), `streaming unsigned ${v}`);
      expectArgument(() => new OStream().writeUnsignedArray(1, [v]), `in-memory unsigned ${v}`);
    }
  });

  it("both modes agree on every out-of-domain signed element", () => {
    for (const v of badSigned) {
      expectArgument(() => streaming().writeSignedArray(1, [v]), `streaming signed ${v}`);
      expectArgument(() => new OStream().writeSignedArray(1, [v]), `in-memory signed ${v}`);
    }
  });

  it("rejects a bad element in the middle of an otherwise valid array", () => {
    expectArgument(
      () => new OStream().writeUnsignedArray(1, [1n, 2n, -1n, 4n]),
      "interior unsigned -1n",
    );
    expectArgument(
      () => new OStream().writeSignedArray(1, [1n, 2n, 1n << 63n, 4n]),
      "interior signed 2^63",
    );
  });

  it("the domain edges themselves still encode", () => {
    const os = new OStream();
    os.writeUnsignedArray(1, [0n, (1n << 64n) - 1n, 0, Number.MAX_SAFE_INTEGER]);
    os.writeSignedArray(2, [-(2n ** 63n), 2n ** 63n - 1n, -1, 0, 1]);
    expect(os.bytesUsed).toBeGreaterThan(0);
  });

  it("a rejected element never reaches the wire as a wrapped value", () => {
    const os = new OStream();
    expect(() => os.writeUnsignedArray(1, [2n ** 64n])).toThrow(SofabError);
    // Whatever the encoder kept, it must not contain the reduced value 0 as a
    // payload: only the header and count were written before the throw.
    expect(os.bytesUsed).toBeLessThanOrEqual(2);
  });
});
