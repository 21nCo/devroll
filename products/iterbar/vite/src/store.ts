import type { IncomingMessage, ServerResponse } from "node:http";

/** The name of a project's Iterbar store directory, which holds `daemon.json` (with the token) and the feedback. */
const STORE_DIR = ".iterbar";
/**
 * A pattern for Vite's `server.fs.deny`, so Vite itself refuses to read the store by its resolved path too
 * (`/@fs`, transforms), whatever the URL looked like. Vite matches it ignoring case.
 */
export const STORE_DENY_PATTERN = `**/${STORE_DIR}/**`;
/** Enough rounds to undo any encoding a later middleware could still decode. */
const MAX_DECODE_ROUNDS = 4;
/** An absolute-form request target (`http://host/path`); anything else, `//x` included, is a path. */
const ABSOLUTE_FORM = /^[a-z][a-z\d+.-]*:\/\//i;
/**
 * Windows 8.3 short names the store directory can have: `ITERBA~1`, or `IT` with a hash after several similar names.
 * Lower case, as segments are compared.
 */
const STORE_SHORT_NAME = /^it(?:erba|[\da-f]{4})~\d+$/;

/** The path of a request URL, in origin form (`/a/b`) or absolute form (`http://host/a/b`), without query or hash. */
function pathOf(url: string): string {
  if (ABSOLUTE_FORM.test(url)) {
    try {
      return new URL(url).pathname;
    } catch {
      // Checked as a path below.
    }
  }
  return url.split(/[?#]/, 1)[0] ?? "";
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
 * A lower-case path segment as the file system resolves it: Windows ignores trailing dots and spaces, and a `:`
 * starts a stream name (`.iterbar::$INDEX_ALLOCATION` is the directory itself).
 */
function fileSystemName(segment: string): string {
  return (segment.split(":", 1)[0] ?? "").replace(/[. ]+$/, "");
}

function isStoreSegment(segment: string): boolean {
  const name = fileSystemName(segment);
  return name === STORE_DIR || STORE_SHORT_NAME.test(name);
}

/**
 * Whether a request URL names a path inside an Iterbar store. Any path segment the file system resolves to
 * `.iterbar` counts: in any case (macOS and Windows file systems ignore it), under `/` or `\`, encoded or not, with
 * trailing dots or spaces or a stream name, or as its Windows short name. That covers each way Vite could serve the
 * store: relative to its root or `base`, from the public directory, under `/@fs/<absolute path>`, through `/@id/`,
 * and with `?raw`, `?url` or `?import`, wherever the project root is. A target that starts with `//` is a path, as
 * Vite reads it, not a host.
 */
export function isStoreRequest(url: string): boolean {
  const raw = pathOf(url);
  const decoded = decodedPath(raw);
  // A path that does not decode is checked as it is, so it cannot hide the store from this check only.
  const path = (decoded ?? raw).toLowerCase();
  return path.split(/[/\\]/).some(isStoreSegment) || (decoded === null && path.includes("iterbar"));
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
