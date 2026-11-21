import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  platform: "browser",
  target: "es2020",
  sourcemap: false,
  clean: true,
  treeshake: true,
});
