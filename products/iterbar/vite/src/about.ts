import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The package that carries the `iterbar` command (the daemon, the MCP server and `iterbar init`). */
export const CLI_PACKAGE = "iterbar";
const PLUGIN_PACKAGE = "@iterbar/vite";

/** An installed Iterbar package and its version. */
export interface InstalledPackage {
  readonly name: string;
  readonly version: string;
}

/** What the dev server tells the bar about the Iterbar it runs: for the settings and the setup steps. */
export interface IterbarAbout {
  readonly packages: readonly InstalledPackage[];
  /** The CLI the dev server runs the daemon from; `node <path>` runs its commands (`init`, `mcp`). */
  readonly cli: { readonly path: string; readonly version: string } | null;
}

/** A package's newest published version as the npm registry has it; `latest` is `null` when it is not published. */
export interface PackageUpdate {
  readonly name: string;
  readonly installed: string;
  readonly latest: string | null;
  /** Why the registry could not be asked, when it could not. */
  readonly error?: string;
}

export interface UpdatesResponse {
  readonly packages: readonly PackageUpdate[];
}

/** The `package.json` of the package that holds `file`: the nearest one up the tree with a `name`. */
function owningManifest(file: string): { dir: string; name: string; version: string } | null {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const path = join(dir, "package.json");
    if (existsSync(path)) {
      try {
        const manifest = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
        if (typeof manifest.name === "string") {
          return { dir, name: manifest.name, version: typeof manifest.version === "string" ? manifest.version : "unknown" };
        }
      } catch {
        // Not readable: keep looking up.
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

/** The versions of the plugin and the CLI it depends on, and the CLI's entry file, as installed next to `pluginFile`. */
export function readAbout(pluginFile: string): IterbarAbout {
  const packages: InstalledPackage[] = [];
  const plugin = owningManifest(pluginFile);
  if (plugin?.name === PLUGIN_PACKAGE) packages.push({ name: plugin.name, version: plugin.version });
  let cli: IterbarAbout["cli"] = null;
  try {
    // The package's export map has no package.json, so its daemon entry is resolved and the manifest found from there.
    const daemonEntry = createRequire(pluginFile).resolve(`${CLI_PACKAGE}/daemon`);
    const manifest = owningManifest(daemonEntry);
    if (manifest?.name === CLI_PACKAGE) {
      packages.push({ name: manifest.name, version: manifest.version });
      const path = join(manifest.dir, "dist", "cli.js");
      if (existsSync(path)) cli = { path, version: manifest.version };
    }
  } catch {
    // Not resolvable from the plugin: the settings show what they know.
  }
  return { packages, cli };
}

/** How long the update check waits for the registry. */
const REGISTRY_TIMEOUT_MS = 5000;

/** Asks the npm registry for each installed package's latest version. Only runs when the user asks for it. */
export async function checkUpdates(about: IterbarAbout, fetchImpl: typeof fetch = fetch): Promise<UpdatesResponse> {
  const packages = await Promise.all(about.packages.map(async ({ name, version }): Promise<PackageUpdate> => {
    try {
      // The whole name encoded, the scope's @ kept as the registry writes it.
      const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name).replace(/^%40/u, "@")}/latest`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });
      if (response.status === 404) return { name, installed: version, latest: null };
      if (!response.ok) return { name, installed: version, latest: null, error: `the registry answered HTTP ${response.status}` };
      const body = (await response.json()) as { version?: unknown };
      return { name, installed: version, latest: typeof body.version === "string" ? body.version : null };
    } catch (error) {
      return { name, installed: version, latest: null, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return { packages };
}
