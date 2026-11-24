import { defineConfig } from "tsup";

// The contracts (@iterbar/core) are bundled into the CLI, types included, so the published `iterbar` package installs
// on its own: no workspace dependency is left in its manifest.
export default defineConfig({
  entry: { store: "src/store/index.ts", daemon: "src/daemon/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  dts: { resolve: [/^@iterbar\/core(\/|$)/] },
  sourcemap: true,
  clean: true,
  noExternal: [/^@iterbar\/core(\/|$)/],
});
