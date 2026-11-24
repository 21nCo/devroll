import { defineConfig } from "tsup";

// The contracts (@iterbar/core) are bundled into the CLI, types included, so the published `iterbar` package installs
// on its own: no workspace dependency is left in its manifest.
export default defineConfig({
  entry: { store: "src/store/index.ts", daemon: "src/daemon/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  // Declarations are built from core's sources, so the whole graph is inlined: core's built declarations share a
  // chunk file that would not be in this package.
  dts: {
    resolve: [/^@iterbar\/core(\/|$)/],
    compilerOptions: {
      rootDir: "..",
      paths: { "@iterbar/core": ["../core/src/index.ts"], "@iterbar/core/node": ["../core/src/node.ts"] },
    },
  },
  sourcemap: true,
  clean: true,
  noExternal: [/^@iterbar\/core(\/|$)/],
});
