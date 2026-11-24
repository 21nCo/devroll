import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** The attribute each stamped element carries: `<project-relative path>:<line>:<column>`, both 1-based. */
export { SOURCE_ATTRIBUTE } from "iterbar";

/** Where a project's source files are, so a file's stamp names it relative to the project root. */
export interface SourceRoot {
  /** The project root as configured (absolute). */
  readonly path: string;
  /** Its real path, which Vite's module ids use when the configured root goes through a symbolic link. */
  readonly real: string;
}

export function sourceRoot(path: string): SourceRoot {
  const absolute = resolve(path);
  let real = absolute;
  try {
    real = realpathSync(absolute);
  } catch {
    // A root that does not exist yet has no other name.
  }
  return { path: absolute, real };
}

/** `path` below `root`, or null when it is the root itself or outside it. */
function below(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return rel;
}

/**
 * The project-relative path (with `/` separators) of the source file a module id names, or null when its elements
 * get no stamp: a virtual or query module, a file outside the project root, or one in a `node_modules` directory,
 * the project root's own ancestors included.
 */
export function sourcePath(root: SourceRoot, id: string): string | null {
  if (id.includes("?") || id.includes("\0") || !isAbsolute(id)) return null;
  if (id.split(/[\\/]/).includes("node_modules")) return null;
  const rel = below(root.real, id) ?? below(root.path, id);
  return rel === null ? null : rel.split(sep).join("/");
}

/** The stamp of an element written at a 1-based line and a 0-based column (as compilers count) of `path`. */
export function stampValue(path: string, line: number, column: number): string {
  return `${path}:${line}:${column + 1}`;
}
