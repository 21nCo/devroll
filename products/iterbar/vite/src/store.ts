import type { IncomingMessage, ServerResponse } from "node:http";

/** The name of a project's Iterbar store directory, which holds `daemon.json` (with the token) and the feedback. */
const STORE_DIR = ".iterbar";
/** Enough rounds to undo any encoding a later middleware could still decode. */
const MAX_DECODE_ROUNDS = 4;

/** The path of a request URL, in origin form (`/a/b`) or absolute form (`http://host/a/b`), without query or hash. */
function pathOf(url: string): string {
  try {
    return new URL(url, "http://dev.invalid").pathname;
  } catch {
    return url.split(/[?#]/, 1)[0] ?? "";
  }
}

/** The path with percent-encoding undone until it is stable, or `null` when it does not decode. */
function decodedPath(path: string): string | null {
  let current = path;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Whether a request URL names a path inside an Iterbar store. Any path segment named `.iterbar` counts, in any case
 * (macOS and Windows file systems ignore it), under `/` or `\`, encoded or not. That covers each way Vite could
 * serve the store: relative to its root or `base`, from the public directory, under `/@fs/<absolute path>`, through
 * `/@id/`, and with `?raw`, `?url` or `?import`, wherever the project root is.
 */
export function isStoreRequest(url: string): boolean {
  const raw = pathOf(url);
  const decoded = decodedPath(raw);
  // A path that does not decode is checked as it is, so it cannot hide the store from this check only.
  const path = (decoded ?? raw).toLowerCase();
  return path.split(/[/\\]/).includes(STORE_DIR) || (decoded === null && path.includes("iterbar"));
}

/**
 * Connect middleware that answers `404` for every request into an Iterbar store, before any of Vite's serving
 * middleware sees it. The store holds the daemon's token, which the bar only gets from the checked config endpoint.
 */
export function storeGuard(request: IncomingMessage, response: ServerResponse, next: () => void): void {
  if (!isStoreRequest(request.url ?? "")) return next();
  response.writeHead(404, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end("Not found");
}
