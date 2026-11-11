import { lstat, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, parse, posix, resolve, sep } from "node:path";
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

/** The file system calls a decision makes: real paths, and `lstat` to tell a dangling link from a missing file. */
export interface PathLookups {
  readonly realpath: ResolvePath;
  readonly lstat: (path: string) => Promise<unknown>;
}

const FILE_SYSTEM: PathLookups = { realpath: (path) => realpath(path), lstat: (path) => lstat(path) };

/**
 * Whether a lookup failed because no file can be at that path, so that nothing can read it: it does not exist, its
 * name or the whole path is too long, or it has a NUL byte (as an SPA route can, which Vite answers with its page).
 */
function isMissing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR", "ENAMETOOLONG", "ERR_INVALID_ARG_VALUE"].includes((error as NodeJS.ErrnoException | null)?.code ?? "");
}

/** Whether a file is the directory or in it. */
function isWithin(file: string, directory: string): boolean {
  return file === directory || file.startsWith(directory.endsWith(sep) ? directory : directory + sep);
}

/** A project's store directory, `<projectRoot>/.iterbar`, and its real path once known: it may be a link. */
export interface Store {
  readonly path: string;
  real: string | null;
}

/** A path's real path, or `null` when it does not exist. */
async function realOrNull(path: string, resolvePath: ResolvePath): Promise<string | null> {
  return resolvePath(path).catch((error: unknown) => (isMissing(error) ? null : Promise.reject(error)));
}

/** Real paths for one decision: each path is looked up at most once, and nothing is kept for the next request. */
interface Lookup {
  (path: string): Promise<string | null>;
  readonly files: PathLookups;
}

function lookupOnce(files: PathLookups): Lookup {
  const seen = new Map<string, Promise<string | null>>();
  return Object.assign((path: string) => {
    const known = seen.get(path) ?? realOrNull(path, files.realpath);
    seen.set(path, known);
    return known;
  }, { files });
}

/** Whether a path that does not resolve is a link, whose target can appear (or be the store) once Vite reads it. */
async function isDanglingLink(path: string, files: PathLookups): Promise<boolean> {
  return files.lstat(path).then(() => true, (error: unknown) => (isMissing(error) ? false : Promise.reject(error)));
}

/**
 * Whether a file that does not exist yet would be created in the store: its deepest existing directory's real path,
 * joined with the names below it, lies within the store's real path. Those names have no stored case yet, so on
 * file systems that ignore case (macOS, Windows) they match the store's names in any case.
 */
function wouldBeInStore(ancestorReal: string, missing: readonly string[], storeReal: string | null): boolean {
  if (storeReal === null || !isWithin(storeReal, ancestorReal)) return false;
  const fold = (name: string | undefined): string | undefined => (process.platform === "darwin" || process.platform === "win32" ? name?.toLowerCase() : name);
  const below = storeReal.slice(ancestorReal.length).split(sep).filter(Boolean);
  return below.length <= missing.length && below.every((name, index) => fold(name) === fold(missing[index]));
}

/**
 * Whether a real path is in a store: it has a `.iterbar` segment, or it is within the store's real path. Real paths
 * have each name's case as stored, on file systems that ignore case too, so another case is another directory.
 */
function isInStore(real: string, storeReal: string | null): boolean {
  return hasStoreSegment(real) || (storeReal !== null && isWithin(real, storeReal));
}

/**
 * Whether reading `file` reads a store, by its real path: links and Windows short names lead wherever they lead.
 * The store's own real path is looked up in the same decision, so a store that is a link counts from the first
 * request on. A short name names an entry of its own directory, which may be a `.iterbar` that links elsewhere, so
 * each `~` segment is also compared with the `.iterbar` beside it. A file that does not exist yet is decided by
 * where it would be created ({@link wouldBeInStore}), from its directories looked up from the root down to the first
 * missing one; that one must not be a dangling link, which could lead to the store by the time Vite reads it. Any
 * other failed lookup rejects, which counts as the store.
 */
export async function isStoreFile(file: string, store: Store, files: PathLookups = FILE_SYSTEM, lookup = lookupOnce(files)): Promise<boolean> {
  if (hasStoreSegment(file)) return true;
  store.real = (await lookup(store.path)) ?? store.real;
  const storeReal = store.real;
  const real = await lookup(file);
  if (real !== null && isInStore(real, storeReal)) return true;
  const { root } = parse(file);
  const parts = file.slice(root.length).split(sep);
  let prefix = root;
  let prefixReal: string | null = root;
  for (const [index, part] of parts.entries()) {
    prefix = index === 0 ? root + part : prefix + sep + part;
    if (part === "" || (real !== null && !part.includes("~"))) continue;
    const parentReal = prefixReal;
    prefixReal = await lookup(prefix);
    if (prefixReal === null) {
      return real === null && (wouldBeInStore(parentReal, parts.slice(index), storeReal) || (await isDanglingLink(prefix, lookup.files)));
    }
    if (isInStore(prefixReal, storeReal) || (part.includes("~") && prefixReal === (await lookup(join(dirname(prefix), STORE_DIR))))) return true;
  }
  return false;
}

/** Whether any of the files reads a store ({@link isStoreFile}), in one decision; a failed lookup counts as one. */
async function readsStore(paths: readonly string[], store: Store, files: PathLookups = FILE_SYSTEM): Promise<boolean> {
  const lookup = lookupOnce(files);
  return Promise.all(paths.map((file) => isStoreFile(file, store, files, lookup))).then((verdicts) => verdicts.includes(true), () => true);
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

/** `req.url` as Vite's static middleware hands it to sirv (under the root): after the first alias that matches. */
function staticUrl(url: string, { root, alias }: StoreLayout): string | undefined {
  const target = url.startsWith("//") ? undefined : parsedPath(url);
  if (target === undefined) return undefined;
  const match = alias.find(({ find }) => (typeof find === "string" ? target.pathname.startsWith(find) : find.test(target.pathname)));
  let redirected = match ? target.pathname.replace(match.find, match.replacement) : "";
  if (redirected.startsWith(root.endsWith("/") ? root : `${root}/`)) redirected = redirected.slice(root.length);
  return redirected ? withPath(target.parsed, redirected) : url;
}

/** `req.url` as Vite's `/@fs/` middleware hands it to sirv (under the root, on Windows the drive, Vite resolved). */
function rawFsUrl(url: string): string | undefined {
  const target = url.startsWith(FS_PREFIX) ? parsedPath(url) : undefined;
  if (target === undefined) return undefined;
  let path = target.pathname.slice(FS_PREFIX.length);
  if (process.platform === "win32") path = path.replace(/^[a-z]:/i, "");
  return withPath(target.parsed, path);
}

/** The absolute path of a `/@fs/` URL, as Vite's `fsPathFromId` reads it. */
function fsPathOf(url: string): string {
  const path = posix.normalize(url.slice(FS_PREFIX.length));
  return /^[a-z]:|^\//i.test(path) ? path : `/${path}`;
}

/** Vite's HTML middleware, after its fallback adds `.html` or `index.html`: an HTML file by root or `/@fs/` path. */
function htmlFiles(url: string, { root }: StoreLayout): string[] {
  const clean = url.replace(/[?#].*$/s, "");
  return [clean, `${clean}.html`, `${clean}index.html`].filter((each) => each.endsWith(".html")).flatMap((each) => {
    try {
      return [resolve(each.startsWith(FS_PREFIX) ? decodeURIComponent(fsPathOf(each)) : join(root, decodeURIComponent(each)))];
    } catch {
      return []; // Vite does not read it either.
    }
  });
}

/**
 * The files Vite's static, public, `/@fs/` and HTML middleware could open for a request URL, with `base` or without
 * it. What its transform pipeline reads (`/@id/`, `?import`, `?raw`) is checked by {@link isLoadOfStore}.
 */
export function servedFiles(url: string, layout: StoreLayout, fsRoot = resolve("/")): string[] {
  const directory = layout.base.endsWith("/") ? layout.base : `${layout.base}/`;
  const urls = [url, ...(layout.base !== "/" && url.startsWith(directory) ? [url.slice(directory.length - 1)] : [])];
  // A middleware that rewrites `req.url` for sirv passes the rewritten URL on when sirv has no such file.
  const rawUrls = urls.map(rawFsUrl).filter((each) => each !== undefined);
  const staticUrls = [...urls, ...rawUrls].map((each) => staticUrl(each, layout)).filter((each) => each !== undefined);
  const files = [
    ...rawUrls.flatMap((each) => sirvFiles(fsRoot, each)),
    ...staticUrls.flatMap((each) => sirvFiles(layout.root, each)),
    ...(layout.publicDir ? urls.flatMap((each) => sirvFiles(layout.publicDir, each)) : []),
    ...[...urls, ...rawUrls, ...staticUrls].flatMap((each) => htmlFiles(each, layout)),
  ];
  return [...new Set(files)];
}

/**
 * Whether a module id Vite's transform pipeline loads reads a store: as Vite's loader reads it (without the query,
 * from the working directory) or, for `/x`, as its asset loader reads a public file. A virtual `\0` id is no file.
 */
export async function isLoadOfStore(id: string, layout: Pick<StoreLayout, "publicDir" | "store">, files: PathLookups = FILE_SYSTEM): Promise<boolean> {
  if (id.startsWith("\0")) return false;
  const file = id.replace(/[?#].*$/s, "");
  return readsStore([resolve(file), ...(layout.publicDir && file.startsWith("/") ? [join(layout.publicDir, file)] : [])], layout.store, files);
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
    void readsStore(servedFiles(url, layout, fsRoot), layout.store).then((store) => (store ? refuse(response) : next()));
  };
}
