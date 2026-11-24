import { isHttpOrigin } from "iterbar";

/** Host names that all reach this machine's loopback interface; a page may use any of them for the same server. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The origin of an http(s) URL, or `null` for anything else, a URL with user info included. */
export function originOf(url: string): string | null {
  try {
    const { origin, username, password } = new URL(url);
    return isHttpOrigin(origin) && username === "" && password === "" ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Checks the extra origins given to the plugin: each must already be an origin (`http://host:port`, no path), so a
 * typo fails when the config loads rather than as a bar that cannot connect.
 */
export function checkExtraOrigins(origins: readonly string[]): string[] {
  for (const origin of origins) {
    if (!isHttpOrigin(origin)) {
      throw new TypeError(`iterbar(): ${JSON.stringify(origin)} is not an http(s) origin such as http://localhost:5173`);
    }
  }
  return [...origins];
}

/**
 * The origins the dev server's pages are served from: the URLs Vite prints, `server.origin`, and the extra origins,
 * with every loopback name added for a loopback URL (a server Vite prints as `localhost` is also opened as
 * `127.0.0.1`). Sorted, without duplicates.
 */
export function devServerOrigins(urls: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const url of urls) {
    const origin = originOf(url);
    if (origin === null) continue;
    origins.add(origin);
    const parsed = new URL(origin);
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) continue;
    for (const host of LOOPBACK_HOSTS) {
      parsed.hostname = host;
      origins.add(parsed.origin);
    }
  }
  return [...origins].sort((a, b) => a.localeCompare(b));
}
