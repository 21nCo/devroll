import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HtmlTagDescriptor, Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { DaemonLink } from "./daemon.js";
import { checkConfigRequest, CONFIG_PATH, sendJson, type BarConfigResponse } from "./endpoint.js";
import { checkExtraOrigins, devServerOrigins, originOf } from "./origins.js";
import { STORE_DENY_PATTERN, storeGuard } from "./store.js";

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
/** Vite's own `server.fs.deny`, which a config that sets the option replaces rather than extends. */
const VITE_DEFAULT_FS_DENY = [".env", ".env.*", "*.{crt,pem}", "**/.git/**"];

/** A path below Vite's `base`, which in dev is an absolute path (`/`, `/app/`). */
function withBase(base: string, path: string): string {
  if (!base.startsWith("/")) return `/${path}`;
  const directory = base.endsWith("/") ? base : `${base}/`;
  return directory + path;
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

/** Origins set in the config rather than found by Vite: `server.origin` and the `origins` option. */
function configuredOrigins(server: ViteDevServer, extra: readonly string[]): string[] {
  const origin = server.config.server.origin ? originOf(server.config.server.origin) : null;
  return origin === null ? [...extra] : [origin, ...extra];
}

/** Origins of the dev server's pages as Vite currently knows them. */
function serverOrigins(server: ViteDevServer, extra: readonly string[]): string[] {
  const urls = [...(server.resolvedUrls?.local ?? []), ...(server.resolvedUrls?.network ?? [])];
  return devServerOrigins([...urls, ...configuredOrigins(server, extra)]);
}

/** One dev server's use of the daemon. A restart creates a new dev server, which gets its own. */
interface ServerState {
  readonly link: DaemonLink;
  closing: Promise<void> | null;
  lastProblem: string | null;
  lastDaemon: string | null;
}

/**
 * The Iterbar Vite plugin. In `vite dev` it shows the Iterbar bar on every page: it adds the bar's client module to
 * each HTML page Vite serves (`transformIndexHtml`), and resolves `@iterbar/vite/client` to that module for apps
 * that render their own HTML, such as SvelteKit. On the first page load it reuses the project's running daemon when
 * its `.iterbar/daemon.json` names the same project root, or starts one in the dev server's process, and registers
 * the dev server's origins with it. It never serves a `.iterbar/` store. `vite build` and `vite preview` do not use
 * it, so a build has no Iterbar runtime.
 */
export function iterbar(options: IterbarPluginOptions = {}): Plugin {
  const extraOrigins = checkExtraOrigins(options.origins ?? []);
  let config: ResolvedConfig;
  /**
   * Keyed by each dev server's resolved config. A plugin instance outlives a server restart with an inline config,
   * and Vite creates the new server before it closes the old one, so each close must release its own server's link.
   */
  const servers = new Map<ResolvedConfig, ServerState>();

  // Every close path of a server waits for the same shutdown: Vite exits the process once the awaited ones resolve.
  // The state stays findable until the shutdown ends, so a close path that comes second still waits for it.
  const closeServer = (key: ResolvedConfig, state: ServerState): Promise<void> => {
    state.closing ??= state.link.close().finally(() => {
      if (servers.get(key) === state) servers.delete(key);
    });
    return state.closing;
  };

  return {
    name: "iterbar",
    // Before Vite's resolver, which would resolve `@iterbar/vite/client` to the package's empty module.
    enforce: "pre",
    apply: (_config, env) => env.command === "serve" && !env.isPreview,

    // Vite refuses to read the store by its resolved path too; Vite's own denials stay. A config that sets
    // `server.fs.deny` keeps its list, and this pattern is added to it.
    config(user) {
      const deny = user.server?.fs?.deny ? [STORE_DENY_PATTERN] : [...VITE_DEFAULT_FS_DENY, STORE_DENY_PATTERN];
      return { server: { fs: { deny } } };
    },

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
      // `server` follows a restart to the next dev server, so this one's config and HTTP server are kept here.
      const key = server.config;
      const state: ServerState = {
        link: new DaemonLink(resolve(key.root, options.projectRoot ?? ".")),
        closing: null,
        lastProblem: null,
        lastDaemon: null,
      };
      servers.set(key, state);
      server.httpServer?.once("close", () => void closeServer(key, state));
      const configPath = withBase(key.base, CONFIG_PATH);
      const logger = key.logger;

      // Ahead of every middleware Vite adds to serve files, so none of them can serve the store.
      server.middlewares.use(storeGuard);
      server.middlewares.use((request, response, next) => {
        if ((request.url ?? "").split("?")[0] !== configPath) return next();
        const origins = serverOrigins(server, extraOrigins);
        const check = checkConfigRequest(request, {
          https: Boolean(key.server.https),
          allowedOrigins: origins,
          configuredOrigins: configuredOrigins(server, extraOrigins),
        });
        if (!check.allowed) return sendJson(response, check.status, { error: check.error }, check.headers);
        if (state.closing) return sendJson(response, 503, { error: "The dev server is closing" });
        state.link.connect(origins).then((access) => {
          const described = `${access.daemonUrl} (${access.started ? "started in this process" : "already running"})`;
          if (described !== state.lastDaemon) {
            state.lastDaemon = described;
            state.lastProblem = null;
            logger.info(`Iterbar daemon: ${described}`, { timestamp: true });
          }
          const body: BarConfigResponse = { daemonUrl: access.daemonUrl, token: access.token };
          sendJson(response, 200, body);
        }, (error: unknown) => {
          const problem = error instanceof Error ? error.message : String(error);
          if (problem !== state.lastProblem) {
            state.lastProblem = problem;
            state.lastDaemon = null;
            logger.warn(`Iterbar: no daemon for the bar: ${problem}`, { timestamp: true });
          }
          sendJson(response, 503, { error: problem });
        });
      });
    },

    // Middleware mode has no HTTP server to watch; Vite closes each environment's plugins when the server closes.
    async closeBundle() {
      const key = this.environment.getTopLevelConfig();
      const state = servers.get(key);
      if (state) await closeServer(key, state);
    },
  };
}

export default iterbar;
