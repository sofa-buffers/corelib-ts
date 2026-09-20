/**
 * A per-file counter that makes a vector suite say, in its own output, how much
 * of the shared suite it actually ran.
 *
 * CORELIB_PLAN §7.2 wants the vector scenarios *run*, and the acceptance
 * criterion upstream (corelib-c-cpp#160) is that the run states **how many
 * vectors and how many checks** executed — the number is what catches a suite
 * that silently shrank, whether because vectors were gated out by `requires` or
 * because a loader dropped them. Vitest reports test cases, not vectors, and a
 * data-driven `describe.each` hides the difference: one `it` can assert once or
 * two hundred times. So each vector suite keeps its own tally and prints one
 * line after the file's last test.
 *
 * Per file, deliberately: vitest runs test files in separate workers, so a
 * shared module-level counter would only ever see part of the run.
 */

import { writeSync } from "node:fs";
import { afterAll } from "vitest";

/** One vector suite's run counters. */
export class Tally {
  private readonly ran = new Set<string>();
  private readonly rejected = new Set<string>();
  private readonly gated = new Map<string, string[]>();
  private checks = 0;
  private total: number | undefined;

  /**
   * Record how many cases the file carried, so the line can say how many of them
   * ran rather than only how many did.
   *
   * The difference is the whole point of the count: a loader that dropped cases, a
   * stale copy that never had them, or a runner filtering on the wrong shape all
   * produce a green suite, and only `ran of found` shows it.
   */
  found(n: number): void {
    this.total = n;
  }

  /** Record that `name` was exercised (idempotent — a vector has many checks). */
  vector(name: string): void {
    this.ran.add(name);
  }

  /** Record that `name` was excluded because this build cannot represent `missing`. */
  gatedOut(name: string, missing: string[]): void {
    this.gated.set(name, missing);
  }

  /**
   * Record that `name` ran as a **negative** case: this build does not satisfy its
   * `requires`, so the block asserts the message is rejected rather than skipping
   * it — `boolean_tolerant`'s narrowing of the rule, documented on
   * `missingBlockCapabilities` in `vectors.ts`.
   *
   * It still counts as a vector that ran, and the summary names how many of them
   * ran that way: a reduced build shows a non-zero count here, a full build shows
   * none, and neither can be mistaken for a case that was silently dropped.
   */
  rejectedCase(name: string): void {
    this.ran.add(name);
    this.rejected.add(name);
  }

  /** Record `n` asserted checks — one decode-and-compare each. */
  check(n = 1): void {
    this.checks += n;
  }

  /** The summary line, also useful to assert on. */
  line(label: string): string {
    const gated =
      this.gated.size === 0
        ? "none gated out by requires"
        : `${this.gated.size} gated out by requires (${[...this.gated]
            .map(([name, missing]) => `${name}: ${missing.join("+")}`)
            .join(", ")})`;
    // The split is printed only where it can be anything but zero, so the line
    // every other suite emits is unchanged.
    const split =
      this.rejected.size === 0
        ? ""
        : ` (${this.ran.size - this.rejected.size} decoded, ${this.rejected.size} rejected)`;
    const of = this.total === undefined ? "" : ` of ${this.total}`;
    return `[${label}] ${this.ran.size}${of} vectors${split}, ${gated}, ${this.checks} checks`;
  }
}

/**
 * A {@link Tally} that prints its summary once the file's tests are done.
 *
 * The line goes to **file descriptor 1 directly**, not through `console.log`.
 * Vitest 4's default reporter keeps the console output of *passing* tests to
 * itself (`silent: "passed-only"`), which is right for stray debug prints and
 * wrong for this one: the count is the deliverable — a CI log that does not
 * state how many vectors ran cannot show that the suite shrank. Writing to the
 * descriptor bypasses the interception without making every other run verbose.
 */
export function reportingTally(label: string): Tally {
  const t = new Tally();
  afterAll(() => {
    writeSync(1, `${t.line(label)}\n`);
  });
  return t;
}
