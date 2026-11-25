import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's version, from its package.json: the nearest one above this file, built (dist/) or not (src/). */
export function packageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version?: unknown };
      if (typeof manifest.version === "string") return manifest.version;
    } catch {
      // Not here; look further up.
    }
    const parent = dirname(directory);
    if (parent === directory) return "0.0.0";
    directory = parent;
  }
}

