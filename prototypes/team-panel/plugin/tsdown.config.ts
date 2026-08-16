import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  clean: true,
  dts: true,
  sourcemap: true,
  external: ["react", "react-dom", "@whalepod/honeycomb"],
});
