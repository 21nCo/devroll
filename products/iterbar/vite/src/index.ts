import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HtmlTagDescriptor, Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { DaemonLink } from "./daemon.js";
import { checkConfigRequest, CONFIG_PATH, sendJson, type BarConfigResponse } from "./endpoint.js";
import { checkExtraOrigins, devServerOrigins } from "./origins.js";

export type { BarConfigResponse } from "./endpoint.js";

export interface IterbarPluginOptions {
  /**
   * The project whose `.iterbar/` store the daemon serves; relative to Vite's root. Defaults to Vite's root. Use the
   * directory your coding agent runs `iterbar mcp` in, so both reach the same daemon.
   */
  readonly projectRoot?: string;
  /**
   * More origins the dev server's pages are opened from, such as a tunnel or a port-forwarded address, in addition
   * to the URLs Vite prints and `server.origin`.
   */
  readonly origins?: readonly string[];
}

/** What a page imports to show the bar where Vite does not serve the HTML (SvelteKit's `src/hooks.client.ts`). */
export const CLIENT_ID = "@iterbar/vite/client";
const RESOLVED_CLIENT_ID = "\0iterbar:client";
const BAR_ID = "@iterbar/bar";
/** This file, so the bar resolves from the plugin's own dependencies rather than the app's. */
const PLUGIN_FILE = fileURLToPath(import.meta.url);

/** A path below Vite's `base`, which in dev is an absolute path (`/`, `/app/`). */
function withBase(base: string, path: string): string {
  if (!base.startsWith("/")) return `/${path}`;
  return `${base.endsWith("/") ? base : `${base}/`}${path}`;
}

/** The client module: mounts the bar once the dev server has answered with the daemon's URL and token. */
function clientModule(configUrl: string): string {
  return `import { mountIterbarBar } from ${JSON.stringify(BAR_ID)};

async function readConfig() {
  try {
    const response = await fetch(${JSON.stringify(configUrl)}, { cache: "no-store", credentials: "same-origin" });
    const body = await response.json().catch(() => null);
    if (response.ok && typeof body?.daemonUrl === "string" && typeof body?.token === "string") return body;
    console.warn("[iterbar] The bar works without feedback: " + (body?.error ?? "HTTP " + response.status));
  } catch (error) {
    console.warn("[iterbar] The bar works without feedback: the dev server did not answer", error);
  }
  return { daemonUrl: null, token: null };
}

if (typeof document !== "undefined") {
  // Not awaited at the top level, so an app that imports this module never waits on it to start.
  void readConfig().then(({ daemonUrl, token }) => mountIterbarBar({ daemonUrl, token }));
}
`;
}

/** Origins of the dev server's pages as Vite currently knows them. */
function serverOrigins(server: ViteDevServer, extra: readonly string[]): string[] {
  const urls = [...(server.resolvedUrls?.local ?? []), ...(server.resolvedUrls?.network ?? [])];
  if (server.config.server.origin) urls.push(server.config.server.origin);
  return devServerOrigins([...urls, ...extra]);
}

/**
 * The Iterbar Vite plugin. In `vite dev` it shows the Iterbar bar on every page: it adds the bar's client module to
 * each HTML page Vite serves (`transformIndexHtml`), and resolves `@iterbar/vite/client` to that module for apps
 * that render their own HTML, such as SvelteKit. On the first page load it reuses the project's running daemon when
 * its `.iterbar/daemon.json` names the same project root, or starts one in the dev server's process, and registers
 * the dev server's origins with it. `vite build` and `vite preview` do not use it, so a build has no Iterbar
 * runtime.
 */
export function iterbar(options: IterbarPluginOptions = {}): Plugin {
  const extraOrigins = checkExtraOrigins(options.origins ?? []);
  let config: ResolvedConfig;
  let link: DaemonLink | null = null;
  let lastProblem: string | null = null;
  let lastDaemon: string | null = null;

  let closing: Promise<void> | null = null;
  // Every close path waits for the same shutdown: Vite exits the process once the awaited ones resolve.
  const closeLink = (): Promise<void> => {
    closing ??= (async () => {
      const current = link;
      link = null;
      await current?.close();
    })();
    return closing;
  };

  return {
    name: "iterbar",
    // Before Vite's resolver, which would resolve `@iterbar/vite/client` to the package's empty module.
    enforce: "pre",
    apply: (_config, env) => env.command === "serve" && !env.isPreview,

    configResolved(resolved) {
      config = resolved;
    },

    resolveId(source, importer, resolveOptions) {
      if (source === CLIENT_ID || source === RESOLVED_CLIENT_ID) {
        // A server render gets the package's empty module: the bar lives in the browser only.
        return resolveOptions?.ssr ? null : RESOLVED_CLIENT_ID;
      }
      if (source === BAR_ID && importer === RESOLVED_CLIENT_ID) {
        return this.resolve(source, PLUGIN_FILE, { ...resolveOptions, skipSelf: true });
      }
      return null;
    },

    load(id) {
      return id === RESOLVED_CLIENT_ID ? clientModule(withBase(config.base, CONFIG_PATH)) : null;
    },

    transformIndexHtml() {
      const tag: HtmlTagDescriptor = {
        tag: "script",
        attrs: { type: "module", src: withBase(config.base, `@id/${CLIENT_ID}`) },
        injectTo: "body",
      };
      return [tag];
    },

    configureServer(server) {
      const current = new DaemonLink(resolve(server.config.root, options.projectRoot ?? "."));
      link = current;
      closing = null;
      server.httpServer?.once("close", () => void closeLink());
      const configPath = withBase(server.config.base, CONFIG_PATH);
      const logger = server.config.logger;

      server.middlewares.use((request, response, next) => {
        if ((request.url ?? "").split("?")[0] !== configPath) return next();
        const origins = serverOrigins(server, extraOrigins);
        const check = checkConfigRequest(request, Boolean(server.config.server.https), origins);
        if (!check.allowed) return sendJson(response, check.status, { error: check.error });
        if (link !== current) return sendJson(response, 503, { error: "The dev server is closing" });
        current.connect(origins).then((access) => {
          const described = `${access.daemonUrl} (${access.started ? "started in this process" : "already running"})`;
          if (described !== lastDaemon) {
            lastDaemon = described;
            lastProblem = null;
            logger.info(`Iterbar daemon: ${described}`, { timestamp: true });
          }
          const body: BarConfigResponse = { daemonUrl: access.daemonUrl, token: access.token };
          sendJson(response, 200, body);
        }, (error: unknown) => {
          const problem = error instanceof Error ? error.message : String(error);
          if (problem !== lastProblem) {
            lastProblem = problem;
            lastDaemon = null;
            logger.warn(`Iterbar: no daemon for the bar: ${problem}`, { timestamp: true });
          }
          sendJson(response, 503, { error: problem });
        });
      });
    },

    // Middleware mode has no HTTP server to watch; Vite closes the plugin container when the server closes.
    async closeBundle() {
      await closeLink();
    },
  };
}

export default iterbar;
