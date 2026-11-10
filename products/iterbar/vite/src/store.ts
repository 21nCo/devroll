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
/** The length of a Windows 8.3 name with its dot and extension, the longest a short name can be. */
const SHORT_NAME_MAX_LENGTH = 12;

/**
 * Whether a lower-case segment could be a Windows 8.3 short name of `.iterbar`. Windows drops the leading dot and
 * keeps the name's first characters before a `~` and a number: `ITERBA~1`, then `ITERB~10` and `ITER~100` as the
 * number grows, or `IT` with four hex digits (`IT3F2A~1`) once many similar names exist. Each form starts with `it`
 * and ends in `~` and digits, so any such segment of up to 12 characters is refused rather than only the forms
 * seen so far, with room to spare over the 8-character base; a URL segment like `it~1` costs a false positive. A
 * name with a 1 to 3 character extension counts too. Checked without a regular expression, in linear time.
 */
function isShortNameOfStore(name: string): boolean {
  if (name.length > SHORT_NAME_MAX_LENGTH || !name.startsWith("it")) return false;
  const dot = name.indexOf(".");
  const base = dot === -1 ? name : name.slice(0, dot);
  const extension = dot === -1 ? "" : name.slice(dot + 1);
  if (dot !== -1 && (extension.length === 0 || extension.length > 3 || extension.includes("."))) return false;
  const tilde = base.lastIndexOf("~");
  if (tilde < 2 || tilde === base.length - 1) return false;
  for (let index = tilde + 1; index < base.length; index += 1) {
    const code = base.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

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
 * starts a stream name (`.iterbar::$INDEX_ALLOCATION` is the directory itself). A scan, not a regular expression,
 * so a long run of dots in a request costs linear time.
 */
function fileSystemName(segment: string): string {
  const colon = segment.indexOf(":");
  let end = colon === -1 ? segment.length : colon;
  while (end > 0 && (segment[end - 1] === "." || segment[end - 1] === " ")) end -= 1;
  return segment.slice(0, end);
}

function isStoreSegment(segment: string): boolean {
  const name = fileSystemName(segment);
  return name === STORE_DIR || isShortNameOfStore(name);
}

/**
 * Whether a request URL names a path inside an Iterbar store. Any path segment the file system resolves to
 * `.iterbar` counts: in any case (macOS and Windows file systems ignore it), under `/` or `\`, encoded or not, with
 * trailing dots or spaces or a stream name, or as anything shaped like its Windows short name. That covers each way
 * Vite could serve the store: relative to its root or `base`, from the public directory, under `/@fs/<absolute
 * path>`, through `/@id/`, and with `?raw`, `?url` or `?import`, wherever the project root is. A target that starts with `//` is a path, as
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
