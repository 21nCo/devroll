import type { SourceMap } from "magic-string";
import { sourcePath, type SourceRoot } from "./location.js";
import { reactSourcePlugin } from "./react.js";
import { svelteSourcePreprocessor, type SvelteCompiler } from "./svelte.js";

export { SOURCE_ATTRIBUTE, sourceRoot, type SourceRoot } from "./location.js";

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

let svelteCompiler: Promise<SvelteCompiler | null> | null = null;

/** The app's `svelte/compiler`, or null without one: a module named `.svelte` is then not a Svelte component here. */
function loadSvelteCompiler(): Promise<SvelteCompiler | null> {
  svelteCompiler ??= import("svelte/compiler").then((compiler) => compiler as SvelteCompiler, () => null);
  return svelteCompiler;
}

/**
 * A Svelte component module with its regular elements stamped, or null to leave it as it is. Run before any other
 * transform of the module, `vite-plugin-svelte`'s preprocessors included, so the stamps name the file as written.
 */
export async function stampSvelteModule(code: string, id: string, root: SourceRoot): Promise<{ code: string; map: SourceMap } | null> {
  if (sourcePath(root, id) === null) return null;
  const compiler = await loadSvelteCompiler();
  if (compiler === null) return null;
  const result = await svelteSourcePreprocessor(root, compiler).markup?.({ content: code, filename: id });
  if (!result) return null;
  return { code: result.code, map: result.map as SourceMap };
}
