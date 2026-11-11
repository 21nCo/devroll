import { createRequire } from "node:module";
import { join } from "node:path";
import type { SourceMap } from "magic-string";
import type { ResolvedConfig } from "vite";
import { sourcePath, type SourceRoot } from "./location.js";
import { reactSourcePlugin } from "./react.js";
import { svelteSourcePreprocessor, type SvelteCompiler } from "./svelte.js";

export { SOURCE_ATTRIBUTE, sourceRoot, type SourceRoot } from "./location.js";

/**
 * Whether a dev server stamps source locations: not under Vitest, which runs its tests on a Vite dev server, so that
 * a component test's DOM stays as the component renders it. Vitest's server resolves the `test` mode by default and
 * carries Vitest's own plugins whatever mode a run picks.
 */
export function stampsSources(config: ResolvedConfig): boolean {
  if (config.mode === "test") return false;
  return !config.plugins.some((plugin) => plugin.name === "vitest" || plugin.name.startsWith("vitest:"));
}

/** The Babel options `@vitejs/plugin-react` passes each `api.reactBabel` hook for one module, which it may extend. */
export interface ReactBabelOptions {
  plugins: unknown[];
}

/** One Babel plugin per project root, so Babel's cache of instantiated plugins keeps it across modules. */
const reactPlugins = new WeakMap<SourceRoot, ReturnType<typeof reactSourcePlugin>>();

/**
 * Adds the stamping Babel plugin to `@vitejs/plugin-react`'s `babel.plugins` for a module that can hold JSX and is
 * a project source file. A `.ts` module cannot hold JSX, and leaving it alone spares it a Babel pass.
 */
export function addReactSourcePlugin(babel: ReactBabelOptions, id: string, root: SourceRoot): void {
  if (/\.[cm]?ts$/.test(id) || sourcePath(root, id) === null) return;
  let plugin = reactPlugins.get(root);
  if (!plugin) {
    plugin = reactSourcePlugin(root);
    reactPlugins.set(root, plugin);
  }
  babel.plugins.push(plugin);
}

/** Each `svelte/compiler` loaded, by the file an app resolves it to. */
const svelteCompilers = new Map<string, SvelteCompiler>();

/**
 * The `svelte/compiler` the app at `appRoot` resolves, or null without one: a module named `.svelte` is then not a
 * Svelte component there.
 */
function svelteCompilerOf(appRoot: string): SvelteCompiler | null {
  const require = createRequire(join(appRoot, "package.json"));
  let file: string;
  try {
    file = require.resolve("svelte/compiler");
  } catch {
    return null;
  }
  let compiler = svelteCompilers.get(file);
  if (!compiler) {
    compiler = require(file) as SvelteCompiler;
    svelteCompilers.set(file, compiler);
  }
  return compiler;
}

/**
 * A Svelte component module with its regular elements stamped, or null to leave it as it is. `appRoot` is Vite's
 * root, whose `svelte/compiler` parses the module. Run before any other transform of the module,
 * `vite-plugin-svelte`'s preprocessors included, so the stamps name the file as written.
 */
export async function stampSvelteModule(
  code: string,
  id: string,
  root: SourceRoot,
  appRoot: string,
): Promise<{ code: string; map: SourceMap } | null> {
  if (sourcePath(root, id) === null) return null;
  const compiler = svelteCompilerOf(appRoot);
  if (compiler === null) return null;
  const result = await svelteSourcePreprocessor(root, compiler).markup?.({ content: code, filename: id });
  if (!result) return null;
  return { code: result.code, map: result.map as SourceMap };
}
