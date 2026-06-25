import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  // ESM (.js), CommonJS (.cjs) and a browser global (.global.js for <script>).
  format: ["esm", "cjs", "iife"],
  globalName: "SofaBuffers",
  target: "es2020",
  platform: "neutral",
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  outExtension({ format }) {
    switch (format) {
      case "esm":
        return { js: ".js" };
      case "cjs":
        return { js: ".cjs" };
      case "iife":
        return { js: ".global.js" };
      default:
        return { js: ".js" };
    }
  },
});
