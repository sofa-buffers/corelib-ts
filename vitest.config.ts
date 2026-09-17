import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Vitest's default is 5s, and two cases here are sweeps rather than single
    // assertions: the destination-shape differential is ~6000 decodes (2.3-3.7s
    // idle) and the chunk-size sweeps are not far behind. At 5s they pass on a
    // quiet machine and fail on a busy one — which is a flake, not a signal. 20s
    // is ample headroom and still refuses a hang; the big-endian job raises it
    // from the command line, where everything runs ~20x slower.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/index.ts"],
      reporter: ["text", "html", "lcov"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
