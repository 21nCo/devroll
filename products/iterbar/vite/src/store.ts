import { realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, posix, resolve, sep } from "node:path";
import type { Alias } from "vite";

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
/** The URL prefix under which Vite serves a file by its absolute path. */
const FS_PREFIX = "/@fs/";
/** The base Vite's middleware parses a request path against. */
const URL_BASE = "http://example.com";

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
  return fileSystemName(segment).toLowerCase() === STORE_DIR;
}

/**
 * Whether a request URL names a path inside an Iterbar store. Any path segment the file system resolves to
 * `.iterbar` counts: in any case (macOS and Windows file systems ignore it), under `/` or `\`, encoded or not, with
 * trailing dots or spaces or a stream name. That covers each way Vite could serve the store: relative to its root
 * or `base`, from the public directory, under `/@fs/<absolute path>`, through `/@id/`, and with `?raw`, `?url` or
 * `?import`, wherever the project root is. A target that starts with `//` is a path, as Vite reads it, not a host.
 * Another name of the store, such as a Windows short name (`ITERBA~1`, the hashed `IT3F2A~1`) or a link, cannot be
 * told from a URL: {@link storeGuard} and {@link isLoadOfStore} ask the file system about the file Vite would read.
 */
export function isStoreRequest(url: string): boolean {
  const raw = pathOf(url);
  const decoded = decodedPath(raw);
  // A path that does not decode is checked as it is, so it cannot hide the store from this check only.
  const path = (decoded ?? raw).toLowerCase();
  return path.split(/[/\\]/).some(isStoreSegment) || (decoded === null && path.includes("iterbar"));
}

/** Whether a file path has a segment the file system resolves to `.iterbar`. */
function hasStoreSegment(file: string): boolean {
  return file.split(/[/\\]/).some(isStoreSegment);
}

/** Resolves a path to its real path, short names and links included, as `realpath` does. */
export type ResolvePath = (path: string) => Promise<string>;

/** Whether a lookup failed because the file does not exist, so that nothing can read it. */
function isMissing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException | null)?.code ?? "");
}

/** Whether a file is the directory or in it, ignoring case as Windows and macOS file systems do. */
function isWithin(file: string, directory: string): boolean {
  const [path, parent] = [file.toLowerCase(), directory.toLowerCase()];
  return path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** A project's store directory, `<projectRoot>/.iterbar`, and its real path once known: it may be a link. */
export interface Store {
  readonly path: string;
  real: string | null;
}

/** Looks up the store's real path, keeping the last one known while the store does not exist. */
export async function locateStore(store: Store, resolvePath: ResolvePath = realpath): Promise<string | null> {
  try {
    store.real = await resolvePath(store.path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return store.real;
}

/** Whether a path is in a store without a lookup: by a `.iterbar` segment, or under the store's real path. */
function isStorePath(file: string, store: Store): boolean {
  return hasStoreSegment(file) || (store.real !== null && isWithin(file, store.real));
}

/**
 * Whether reading `file` reads a store: {@link isStorePath}, or for a path with a `~` (as Windows short names have),
 * the same for its real path. Only such a path is looked up. A missing file cannot be read; any other failure counts.
 */
export async function isStoreFile(file: string, store: Store, resolvePath: ResolvePath = realpath): Promise<boolean> {
  if (isStorePath(file, store)) return true;
  if (!file.includes("~")) return false;
  try {
    const real = await resolvePath(file);
    if (hasStoreSegment(real)) return true;
    const storeReal = await locateStore(store, resolvePath);
    return storeReal !== null && isWithin(real, storeReal);
  } catch (error) {
    return !isMissing(error);
  }
}

/** The decoded request path, or `undefined` when Vite's middleware would pass the request on. */
function parsedPath(url: string): { parsed: URL; pathname: string } | undefined {
  try {
    const parsed = new URL(url, URL_BASE);
    return { parsed, pathname: decodeURI(parsed.pathname) };
  } catch {
    return undefined;
  }
}

/** The request URL with its path replaced, as Vite's middleware rewrites `req.url` for sirv. */
function withPath(parsed: URL, pathname: string): string {
  parsed.pathname = encodeURI(pathname);
  return parsed.href.slice(parsed.origin.length);
}

/** The files sirv (Vite's static file server, in dev mode) opens for a request URL under `dir`. */
function sirvFiles(dir: string, url: string): string[] {
  const query = url.length > 1 ? url.indexOf("?", 1) : -1;
  let pathname = query === -1 ? url : url.slice(0, query);
  try {
    pathname = decodeURI(pathname);
  } catch {
    // sirv looks a path that does not decode up as it is.
  }
  if (pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  const root = resolve(dir);
  return [...(pathname ? [join(root, pathname)] : []), join(root, `${pathname}/index`)];
}

/** Vite's resolved `root`, `base`, `publicDir` (empty for none) and `resolve.alias`, and the project's store. */
export interface StoreLayout {
  readonly root: string;
  readonly base: string;
  readonly publicDir: string;
  readonly alias: readonly Alias[];
  readonly store: Store;
}

/** Vite's static middleware: the path relative to the root, after the first alias that matches rewrites it. */
function staticFiles(url: string, { root, alias }: StoreLayout): string[] {
  const target = url.startsWith("//") ? undefined : parsedPath(url);
  if (target === undefined) return [];
  const match = alias.find(({ find }) => (typeof find === "string" ? target.pathname.startsWith(find) : find.test(target.pathname)));
  let redirected = match ? target.pathname.replace(match.find, match.replacement) : "";
  if (redirected.startsWith(root.endsWith("/") ? root : `${root}/`)) redirected = redirected.slice(root.length);
  return sirvFiles(root, redirected ? withPath(target.parsed, redirected) : url);
}

/** Vite's `/@fs/` middleware: the path after the prefix, under the root (on Windows, drive) Vite resolved at start. */
function rawFsFiles(url: string, fsRoot: string): string[] {
  const target = url.startsWith(FS_PREFIX) ? parsedPath(url) : undefined;
  if (target === undefined) return [];
  let path = target.pathname.slice(FS_PREFIX.length);
  if (process.platform === "win32") path = path.replace(/^[a-z]:/i, "");
  return sirvFiles(fsRoot, withPath(target.parsed, path));
}

/** The absolute path of a `/@fs/` URL, as Vite's `fsPathFromId` reads it. */
function fsPathOf(url: string): string {
  const path = posix.normalize(url.slice(FS_PREFIX.length));
  return /^[a-z]:|^\//i.test(path) ? path : `/${path}`;
}

/** Vite's HTML middleware, after its fallback adds `.html` or `index.html`: an HTML file by root or `/@fs/` path. */
function htmlFiles(url: string, { root }: StoreLayout): string[] {
  const clean = url.replace(/[?#].*$/s, "");
  const files: string[] = [];
  for (const candidate of [clean, `${clean}.html`, `${clean}index.html`]) {
    if (!candidate.endsWith(".html")) continue;
    try {
      files.push(resolve(candidate.startsWith(FS_PREFIX) ? decodeURIComponent(fsPathOf(candidate)) : join(root, decodeURIComponent(candidate))));
    } catch {
      // Vite does not read it either.
    }
  }
  return files;
}

/**
 * The files Vite's static, public, `/@fs/` and HTML middleware could open for a request URL, with `base` or without
 * it. What its transform pipeline reads (`/@id/`, `?import`, `?raw`) is checked by {@link isLoadOfStore}.
 */
export function servedFiles(url: string, layout: StoreLayout, fsRoot = resolve("/")): string[] {
  const directory = layout.base.endsWith("/") ? layout.base : `${layout.base}/`;
  const urls = [url];
  if (layout.base !== "/" && url.startsWith(directory)) urls.push(url.slice(directory.length - 1));
  const files = urls.flatMap((each) => [
    ...staticFiles(each, layout),
    ...rawFsFiles(each, fsRoot),
    ...(layout.publicDir ? sirvFiles(layout.publicDir, each) : []),
    ...htmlFiles(each, layout),
  ]);
  return [...new Set(files)];
}

async function anyStoreFile(files: readonly string[], store: Store): Promise<boolean> {
  return (await Promise.all(files.map((file) => isStoreFile(file, store)))).includes(true);
}

/**
 * Whether a module id Vite's transform pipeline loads reads a store: as Vite's loader reads it (without the query,
 * from the working directory) or, for `/x`, as its asset loader reads a public file. A virtual `\0` id is no file.
 */
export function isLoadOfStore(id: string, layout: Pick<StoreLayout, "publicDir" | "store">): Promise<boolean> | false {
  if (id.startsWith("\0")) return false;
  const file = id.replace(/[?#].*$/s, "");
  const files = [resolve(file), ...(layout.publicDir && file.startsWith("/") ? [join(layout.publicDir, file)] : [])];
  if (!files.some((each) => each.includes("~") || isStorePath(each, layout.store))) return false;
  return anyStoreFile(files, layout.store);
}

function refuse(response: ServerResponse): void {
  response.writeHead(404, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end("Not found");
}

/**
 * Connect middleware that answers `404`, before Vite's file serving middleware, for a request any of them would
 * answer from an Iterbar store: by the store's name in the URL, or by the file it would open ({@link isStoreFile}).
 * The store holds the daemon's token, which the bar only gets from the checked config endpoint. With
 * `server.fs.strict` off, Vite skips `server.fs.deny`, so this and {@link isLoadOfStore} are the only checks.
 */
export function storeGuard(layout: StoreLayout) {
  const fsRoot = resolve("/"); // As Vite resolves it for `/@fs/` when it makes its middleware, with this one.
  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const url = request.url ?? "";
    if (isStoreRequest(url)) return refuse(response);
    const files = servedFiles(url, layout, fsRoot).filter((file) => file.includes("~") || isStorePath(file, layout.store));
    if (files.length === 0) return next();
    anyStoreFile(files, layout.store).then((store) => (store ? refuse(response) : next()), () => refuse(response));
  };
}
