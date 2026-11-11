import { execFileSync } from "node:child_process";
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { connect as http2Connect, type OutgoingHttpHeaders as Http2Headers } from "node:http2";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createServer, resolveConfig, type InlineConfig, type Plugin, type ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMatchingDaemonFile } from "./daemon.js";
import { checkConfigRequest } from "./endpoint.js";
import { CLIENT_ID, iterbar } from "./index.js";
import { isLoadOfStore, isStoreFile, isStoreRequest, servedFiles, type PathLookups, type Store } from "./store.js";

// Every realpath the plugin makes, which a test can hold back to stand in for a slow file system.
const lookups = vi.hoisted(() => ({
  paths: [] as string[],
  hold: null as { match: (path: string) => boolean; held: Promise<void>; entered: string[] } | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const realpath = (async (path: string, options?: never) => {
    lookups.paths.push(String(path));
    // A held lookup answers with what the file system had when it was made, as a slow one answers late.
    const answer = actual.realpath(path, options).then((real) => ({ real }), (error: unknown) => ({ error }));
    const hold = lookups.hold;
    if (hold?.match(String(path))) {
      await answer;
      hold.entered.push(String(path));
      await hold.held;
    }
    const settled = await answer;
    if ("error" in settled) throw settled.error;
    return settled.real;
  }) as typeof actual.realpath;
  return { ...actual, realpath, default: { ...actual, realpath } };
});

let root: string;
let servers: ViteDevServer[] = [];

/**
 * A refusal: the store guard's `404`, the error the plugin's load hook throws, or Vite's own `server.fs` refusal of
 * the resolved path; never a page or another error.
 */
function isRefusal({ status, body }: { status: number; body: string }): boolean {
  return (status === 404 && body === "Not found") || (status === 500 && body.includes("which the dev server does not serve"))
    || (status === 403 && body.includes("<h1>403 Restricted</h1>"));
}

/** Vite's answer for a path it has no file or module for: the app's page (its SPA fallback), which holds no store bytes. */
function isAppPage({ status, body }: { status: number; body: string }): boolean {
  return status === 200 && body.startsWith("<!doctype html>") && body.includes("<p>App</p>");
}

/** Released by each test's end at the latest, so a failed test leaves no lookup held. */
let releaseHeld = (): void => undefined;

/**
 * Holds each realpath of a path that `match` accepts until `release` is called, and lists those that started, so a
 * test can wait until a decision is observed waiting on the file system.
 */
function holdLookups(match: (path: string) => boolean): { entered: string[]; release: () => void } {
  releaseHeld();
  let open = (): void => undefined;
  const hold = { match, held: new Promise<void>((resolve) => (open = resolve)), entered: [] as string[] };
  lookups.hold = hold;
  releaseHeld = () => {
    if (lookups.hold === hold) lookups.hold = null;
    open();
  };
  return { entered: hold.entered, release: () => releaseHeld() };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function devServer(config: InlineConfig = {}): Promise<{ server: ViteDevServer; port: number }> {
  const port = await freePort();
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [iterbar()],
    // No dependency scan, which a test that closes the server at once would cut short.
    optimizeDeps: { noDiscovery: true },
    ...config,
    server: { host: "127.0.0.1", port, strictPort: true, ...config.server },
  });
  servers.push(server);
  await server.listen();
  return { server, port };
}

/** A GET with exact headers (fetch would not let a test set `Host`). */
function get(port: number, path: string, headers: OutgoingHttpHeaders = {}, method = "GET"): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A GET over HTTP/2 with TLS, as a browser sends it to `vite dev` with `server.https`: no `Host`, only `:authority`. */
async function getHttp2(port: number, path: string, headers: Http2Headers = {}): Promise<{ status: number; body: string }> {
  const session = http2Connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false, servername: "localhost" });
  try {
    return await new Promise((resolve, reject) => {
      session.once("error", reject);
      const stream = session.request({ ":path": path, ...headers });
      let status = 0;
      let body = "";
      stream.setEncoding("utf8");
      stream.on("response", (head) => (status = Number(head[":status"])));
      stream.on("data", (chunk: string) => (body += chunk));
      stream.on("end", () => resolve({ status, body }));
      stream.on("error", reject);
      stream.end();
    });
  } finally {
    session.close();
  }
}

/** A throwaway self-signed certificate for an HTTPS dev server. */
function selfSignedCertificate(directory: string): { key: string; cert: string } {
  const key = join(directory, "dev-key.pem");
  const cert = join(directory, "dev-cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  return { key, cert };
}

beforeEach(async () => {
  servers = [];
  root = await realpath(await mkdtemp(join(tmpdir(), "iterbar-vite-plugin-")));
  await writeFile(join(root, "index.html"), "<!doctype html><html><head></head><body><p>App</p></body></html>");
});

afterEach(async () => {
  releaseHeld();
  await Promise.all(servers.map((server) => server.close()));
  await rm(root, { recursive: true, force: true });
});

describe("iterbar() in vite dev", () => {
  it("adds the client module to every HTML page and serves the bar's mount code in it", async () => {
    const { port } = await devServer();
    const page = await get(port, "/");
    expect(page.body).toContain(`<script type="module" src="/@id/${CLIENT_ID}"></script>`);
    expect(page.body.indexOf(CLIENT_ID)).toBeLessThan(page.body.indexOf("</body>"));

    const client = await get(port, `/@id/${CLIENT_ID}`);
    expect(client.status).toBe(200);
    expect(client.body).toMatch(/import \{ mountIterbarBar \} from "[^"]*bar\/dist\/index\.js"/);
    expect(client.body).toContain('fetch("/__iterbar/config"');
  });

  it("serves the token to the dev server's own pages only, under Vite's base", async () => {
    const { port } = await devServer({ base: "/app/" });
    expect((await get(port, "/app/")).body).toContain(`src="/app/@id/${CLIENT_ID}"`);
    expect((await get(port, `/app/@id/${CLIENT_ID}`)).body).toContain('fetch("/app/__iterbar/config"');

    const own = await get(port, "/app/__iterbar/config", { "sec-fetch-site": "same-origin" });
    expect(own.status).toBe(200);
    expect(own.headers["cache-control"]).toBe("no-store");
    const info = await readMatchingDaemonFile(root);
    expect(JSON.parse(own.body)).toEqual({ daemonUrl: `http://127.0.0.1:${info?.port}`, token: info?.token });

    const refused = [
      await get(port, "/app/__iterbar/config", { "sec-fetch-site": "cross-site" }),
      await get(port, "/app/__iterbar/config", { "sec-fetch-site": "same-site" }),
      await get(port, "/app/__iterbar/config", { origin: "http://localhost:3000" }),
      await get(port, "/app/__iterbar/config", {}, "POST"),
    ];
    expect(refused.map(({ status }) => status)).toEqual([403, 403, 403, 405]);
    expect(refused[3]?.headers.allow).toBe("GET");
    for (const { body } of refused) expect(body).not.toContain(info?.token);
  });

  it("refuses a Host that is not a bare host and port, such as one with user info or a path", async () => {
    // With every host allowed, the endpoint's own check is all that stands between such a Host and the token.
    const { port } = await devServer({ server: { allowedHosts: true } });
    for (const host of [`user@127.0.0.1:${port}`, `user:pass@localhost:${port}`, `127.0.0.1:${port}/x`, `127.0.0.1:${port}\\x`]) {
      const answer = await get(port, "/__iterbar/config", { host, "sec-fetch-site": "same-origin" });
      expect(answer.status, host).toBe(403);
    }
    expect(await readMatchingDaemonFile(root)).toBeNull();
    expect((await get(port, "/__iterbar/config", { "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  it("refuses a page reached under a host name that is not the dev server's, even when Vite allows every host", async () => {
    const { port } = await devServer({ server: { allowedHosts: true } });
    // A DNS-rebound name passes Vite's host check here, but the bar only gets the token on the server's own origins.
    const rebound = await get(port, "/__iterbar/config", { host: `attacker.test:${port}`, "sec-fetch-site": "same-origin" });
    expect(rebound.status).toBe(403);
    expect(JSON.parse(rebound.body).error).toContain(`http://attacker.test:${port} is not an origin of this dev server`);
    expect(await readMatchingDaemonFile(root)).toBeNull();

    // Every loopback name of the server is one of its origins.
    expect((await get(port, "/__iterbar/config", { host: `localhost:${port}` })).status).toBe(200);
  });

  it("registers the extra origins it is given and rejects one that is not an origin", async () => {
    expect(() => iterbar({ origins: ["https://tunnel.example/app"] })).toThrow(/not an http\(s\) origin/);
    const { port } = await devServer({ plugins: [iterbar({ origins: ["https://tunnel.example"] })] });
    const answer = await get(port, "/__iterbar/config");
    expect(answer.status).toBe(200);
    const { daemonUrl, token } = JSON.parse(answer.body) as { daemonUrl: string; token: string };
    const registered = await fetch(`${daemonUrl}/origins`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, origins: ["https://tunnel.example"] }),
    });
    expect(((await registered.json()) as { origins: string[] }).origins).toEqual(expect.arrayContaining([
      "https://tunnel.example", `http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`,
    ]));
  });

  it.each([true, false])("never serves the Iterbar store, by any path, while the config endpoint keeps working (fs.strict %s)", async (strict) => {
    // The project root is the parent of Vite's root, as in a monorepo; the store is outside Vite's root.
    const app = join(root, "app");
    await mkdir(app);
    await writeFile(join(app, "index.html"), "<!doctype html><html><body></body></html>");
    const { port } = await devServer({ root: app, base: "/base/", plugins: [iterbar({ projectRoot: ".." })], server: { fs: { strict } } });
    expect((await get(port, "/base/__iterbar/config")).status).toBe(200);
    const info = await readMatchingDaemonFile(root);
    expect(info?.projectRoot).toBe(root);
    const feedback = join(root, ".iterbar", "feedback", "fb_test");
    await mkdir(feedback, { recursive: true });
    await writeFile(join(feedback, "feedback.json"), '{"secret":"FEEDBACK-SECRET"}');
    // A store under Vite's own root, where its static middleware would serve it, which is a link to another name.
    await mkdir(join(app, "vault"));
    await symlink(join(app, "vault"), join(app, ".iterbar"), "dir");
    await writeFile(join(app, ".iterbar", "daemon.json"), '{"token":"APP-STORE-SECRET"}');
    // Other names of the stores, as a Windows short name or a link gives one: the guard asks the file system.
    for (const alias of ["ITERBA~1", "ITERB~10", "ITER~100", "IT1A2B~1", "it5f2~12"]) await symlink(join(app, ".iterbar"), join(app, alias));
    await symlink(join(root, ".iterbar"), join(root, "ITERB~10"));

    const paths = [
      "/base/.iterbar/daemon.json",
      "/base/.iterbar/daemon.json?raw",
      "/base/.iterbar/daemon.json?import&raw",
      "/base/%2eiterbar/daemon.json",
      "/base/%252eiterbar/daemon.json",
      "/base/.ITERBAR/daemon.json",
      `/base/@fs${root}/.iterbar/daemon.json`,
      `/base/@fs${root}/.iterbar/daemon.json?raw`,
      `/base/@fs${root}/.iterbar/feedback/fb_test/feedback.json`,
      `/base/@fs${root}/app/../.iterbar/daemon.json`,
      `/base/@id/${root}/.iterbar/daemon.json?raw`,
      `/@fs${root}/.iterbar/daemon.json`,
      // A leading `//` is still a path to Vite, and Windows resolves trailing dots and spaces, streams and short names.
      "//.iterbar/daemon.json",
      "///.iterbar/daemon.json",
      "/base//.iterbar/daemon.json",
      "/base/.iterbar./daemon.json",
      "/base/.iterbar%20/daemon.json",
      "/base/.iterbar.%20./daemon.json",
      "/base/.iterbar::$INDEX_ALLOCATION/daemon.json",
      "/base/ITERBA~1/daemon.json",
      `/base/@fs${root}/.iterbar./daemon.json`,
      `/base/@fs/${root}/.iterbar/daemon.json`,
      // Every shape of a Windows short name of the store, not just the first one Windows hands out.
      "/base/ITERB~10/daemon.json",
      "/base/ITER~100/daemon.json",
      "/base/IT1A2B~1/daemon.json",
      "/base/it5f2~12/daemon.json",
      "/base/%49TER~100/daemon.json",
      `/base/@fs${root}/ITERB~10/daemon.json`,
    ];
    for (const path of paths) {
      const answer = await get(port, path, { origin: "http://localhost:3000", "sec-fetch-site": "cross-site" });
      expect(answer.status, path).toBe(404);
      for (const secret of [info?.token ?? "", "FEEDBACK-SECRET", "APP-STORE-SECRET"]) expect(answer.body, path).not.toContain(secret);
    }
    expect((await get(port, "/base/__iterbar/config")).status).toBe(200);
  });

  it("serves directories and virtual modules whose names have a `~` but do not lead to the store", async () => {
    // As under a Windows profile such as C:\Users\ITADMI~1, which every path of the project passes through. Vite's
    // fs.strict refuses every Windows path with a `~`, so this runs without it, where the plugin alone decides.
    const project = join(root, "itadmi~1");
    for (const directory of ["src", "it3f2a~1", "itface~1"]) await mkdir(join(project, directory), { recursive: true });
    await writeFile(join(project, "index.html"), "<!doctype html><html><body></body></html>");
    for (const file of ["src/a.js", "it3f2a~1/a.js", "itface~1/a.js"]) await writeFile(join(project, file), 'export const marker = "MODULE-UNDER-ITADMI";');
    await writeFile(join(project, "itface~1", "a.txt"), "MODULE-UNDER-ITADMI");
    // Virtual modules with a `~`, as unplugin-icons (`~icons/...`) and others name theirs.
    const ids = ["~icons/x", "\0~demo"];
    const virtual: Plugin = { name: "virtual-tilde", resolveId: (id) => (ids.includes(id) ? id : null), load: (id) => (ids.includes(id) ? 'export const marker = "MODULE-UNDER-ITADMI";' : null) };
    const alias = [{ find: "/lib", replacement: join(project, "itface~1") }];
    const { port } = await devServer({ root: project, plugins: [iterbar(), virtual], resolve: { alias }, server: { fs: { strict: false } } });
    for (const path of [
      "/src/a.js", `/@fs${project}/src/a.js`, "/it3f2a~1/a.js", `/@fs${project}/it3f2a~1/a.js`, "/itface~1/a.js",
      `/@fs${project}/itface~1/a.js?raw`, "/itface~1/a.txt", "/lib/a.js", "/lib/a.txt", "/@id/~icons/x", "/@id/__x00__~demo",
    ]) {
      const answer = await get(port, path);
      expect(answer.status, path).toBe(200);
      expect(answer.body, path).toContain("MODULE-UNDER-ITADMI");
    }
    expect((await get(port, "/__iterbar/config")).status).toBe(200);
    const info = await readMatchingDaemonFile(project);
    expect(info).not.toBeNull();
    const store = await get(port, `/@fs${project}/.iterbar/daemon.json?raw`);
    expect(store.status).toBe(404);
    expect(store.body).not.toContain(String(info?.token));
  });

  it.each([true, false])("refuses every other name of the store by the file it leads to, on each way Vite reads one (fs.strict %s)", async (strict) => {
    // POSIX links stand in for Windows short names. The store itself is a link too, to a directory with another name.
    const publicDir = join(root, "public");
    for (const directory of ["vault", "public"]) await mkdir(join(root, directory));
    await symlink(join(root, "vault"), join(root, ".iterbar"), "dir");
    await symlink(join(root, ".iterbar"), join(publicDir, "PUBLIC~1"), "dir");
    for (const alias of ["ITERBA~1", "IT3F2A~1", "LINK~1.", "LINK~2 ", "LINK~3:x"]) await symlink(join(root, ".iterbar"), join(root, alias), "dir");
    // An alias whose replacement consumes the short name, and one that leads to a directory holding one.
    const alias = [{ find: "/ALIAS~1", replacement: join(root, ".iterbar") }, { find: "/up", replacement: root }];
    const { port } = await devServer({ base: "/base/", publicDir, resolve: { alias }, server: { fs: { strict } } });
    expect((await get(port, "/base/__iterbar/config")).status).toBe(200);
    const info = await readMatchingDaemonFile(root);
    expect(await readFile(join(root, "ITERBA~1", "daemon.json"), "utf8")).toContain(String(info?.token ?? "no daemon"));
    const secrets = [String(info?.token), (JSON.parse(await readFile(join(root, "vault", "store.lock"), "utf8")) as { startedAt: string }).startedAt];
    const cwd = process.cwd();
    // Vite reads an id it cannot resolve relative to the working directory.
    process.chdir(root);
    const fallbacks: string[] = [];
    try {
      for (const path of [
        "/base/ITERBA~1/daemon.json", "/base/ITERBA~1/daemon.json?raw", "/base/ITERBA~1/daemon.json?url",
        "/base/ITERBA~1/daemon.json?inline", "/base/ITERBA~1/daemon.json?import", "/base/IT3F2A~1/store.lock?raw",
        `/base/@fs${root}/ITERBA~1/daemon.json`, `/base/@fs/${root}/ITERBA~1/daemon.json?raw`, `/@fs${root}/IT3F2A~1/daemon.json`,
        `/base/@id/${root}/IT3F2A~1/daemon.json?raw`, `/base/@id//@fs${root}/ITERBA~1/daemon.json?import&raw`,
        "/base/@id/./ITERBA~1/daemon.json?import&raw", "/base/@id/ITERBA~1/daemon.json?raw",
        "/base/ALIAS~1/daemon.json", "/base/ALIAS~1/daemon.json?import&raw", "/base/up/ITERBA~1/daemon.json", "/base/up/ITERBA~1/daemon.json?raw",
        "/base/PUBLIC~1/daemon.json", "/base/@id//PUBLIC~1/daemon.json?raw", "/base/@id/PUBLIC~1/daemon.json?raw",
        "/base/LINK~1./daemon.json", "/base/LINK~2%20/daemon.json?raw", "/base/LINK~3:x/daemon.json?raw",
        "/base/ITERBA%7E1/%25E0/../daemon.json", "/base/ITERBA%7E1/daemon.json?raw", "/base/@fs/ITERBA~1/daemon.json",
        // The directory the store links to, by its own name.
        "/base/vault/daemon.json", "/base/vault/daemon.json?raw", `/base/@fs${root}/vault/daemon.json`,
      ]) {
        const answer = await get(port, path);
        if (isAppPage(answer)) fallbacks.push(path.replace(root, "<root>"));
        else expect(isRefusal(answer), `${path}: ${answer.status} ${answer.body.slice(0, 200)}`).toBe(true);
        for (const secret of secrets) expect(answer.body, path).not.toContain(secret);
      }
    } finally {
      process.chdir(cwd);
    }
    // `/@id/` without `?import` is no module request: Vite answers it with the app's page.
    expect(fallbacks).toEqual([
      "/base/@id/<root>/IT3F2A~1/daemon.json?raw", "/base/@id/ITERBA~1/daemon.json?raw", "/base/@id//PUBLIC~1/daemon.json?raw", "/base/@id/PUBLIC~1/daemon.json?raw",
    ]);
    expect((await get(port, "/base/__iterbar/config")).status).toBe(200);
  });

  it.each([true, false])("refuses a plain link to the store, on each way Vite reads one (fs.strict %s)", async (strict) => {
    const publicDir = join(root, "public");
    for (const directory of [".iterbar", "public"]) await mkdir(join(root, directory));
    await symlink(join(root, ".iterbar"), join(publicDir, "store"), "dir");
    await symlink(join(root, ".iterbar"), join(root, "docs"), "dir");
    await symlink(root, join(root, "up"), "dir");
    const alias = [{ find: "/s", replacement: join(root, "docs") }];
    const { server, port } = await devServer({ publicDir, resolve: { alias }, server: { fs: { strict } } });
    expect((await get(port, "/__iterbar/config")).status).toBe(200);
    const token = String((await readMatchingDaemonFile(root))?.token);
    const fallbacks: string[] = [];
    for (const path of [
      "/store/daemon.json", "/store/daemon.json?raw", "/docs/daemon.json", "/docs/daemon.json?raw", "/docs/daemon.json?import&raw",
      `/@fs${root}/docs/daemon.json`, `/@fs${root}/docs/daemon.json?raw`, `/@id/${root}/docs/daemon.json?import&raw`,
      "/s/daemon.json", "/s/daemon.json?raw", "/up/.iterbar/daemon.json", `/@fs${root}/up/docs/daemon.json`,
    ]) {
      const answer = await get(port, path);
      if (isAppPage(answer)) fallbacks.push(path.replace(root, "<root>"));
      else expect(isRefusal(answer), `${path}: ${answer.status} ${answer.body.slice(0, 200)}`).toBe(true);
      expect(answer.body, path).not.toContain(token);
    }
    expect(fallbacks).toEqual([]);
    // A module that imports the store through a link, as `import config from "./docs/daemon.json?raw"` would. With
    // fs.strict, Vite denies the real path it resolved first; without it, only the plugin stands in the way.
    await expect(server.environments.client.transformRequest("/docs/daemon.json?raw")).rejects.toThrow(strict ? /Denied ID/ : /Iterbar store/);
    expect(isAppPage(await get(port, "/index.html"))).toBe(true);
    // Routes no file can have, by a segment or a whole path too long or a NUL byte, reach Vite past the guard.
    for (const path of [`/${"t".repeat(300)}`, `/${"r/".repeat(2100)}x`, "/a%00b"]) {
      const answer = await get(port, path);
      expect(answer.status === 404 && answer.body === "Not found", path.slice(0, 40)).toBe(false);
    }
  });

  it.each([true, false])("refuses a linked store's real name before its first lookup has answered (fs.strict %s)", async (strict) => {
    await mkdir(join(root, "vault"));
    await symlink(join(root, "vault"), join(root, ".iterbar"), "dir");
    await writeFile(join(root, "vault", "secret.json"), '"LINKED-STORE-SECRET"');
    // Held from the start, so no lookup of the store the plugin could make while Vite starts has answered.
    const store = join(root, ".iterbar");
    const { entered, release } = holdLookups((path) => path === store);
    const { server, port } = await devServer({ server: { fs: { strict } } });
    const answers = Promise.all([get(port, "/vault/secret.json"), get(port, "/vault/secret.json?raw")]);
    const loaded = server.environments.client.transformRequest(join(root, "vault", "secret.json?raw")).then(String, String);
    // Both requests and the transform are each waiting on their own lookup of the store.
    await vi.waitFor(() => expect(entered.length).toBeGreaterThanOrEqual(3));
    release();
    for (const answer of await answers) {
      expect(isRefusal(answer), `${answer.status} ${answer.body.slice(0, 200)}`).toBe(true);
      expect(answer.body).not.toContain("LINKED-STORE-SECRET");
    }
    expect(await loaded).toMatch(/Iterbar store/);
    const config = await get(port, "/__iterbar/config");
    expect(JSON.parse(config.body).token).toBe((await readMatchingDaemonFile(root))?.token);
  });

  it.each([true, false])("refuses a store file the daemon writes while the request waits on its lookup (fs.strict %s)", async (strict) => {
    // The store is a link to `vault`, which has no daemon.json yet; a plain link and a public link lead to it too.
    const publicDir = join(root, "public");
    for (const directory of ["vault", "public"]) await mkdir(join(root, directory));
    await symlink(join(root, "vault"), join(root, ".iterbar"), "dir");
    await symlink(join(root, ".iterbar"), join(root, "docs"), "dir");
    await symlink(join(root, ".iterbar"), join(publicDir, "store"), "dir");
    const { port } = await devServer({ publicDir, server: { fs: { strict } } });
    const daemonFile = join(root, "vault", "daemon.json");
    const away = join(root, "daemon.json.away");
    let token: string | null = null;
    for (const path of [
      "/vault/daemon.json", "/vault/daemon.json?raw", `/@fs${root}/vault/daemon.json`, "/docs/daemon.json", "/docs/daemon.json?raw",
      `/@fs${root}/docs/daemon.json`, "/store/daemon.json",
    ]) {
      const { entered, release } = holdLookups((each) => each.endsWith("daemon.json"));
      const answer = get(port, path);
      // The decision has found no daemon.json; it appears before Vite opens the file, the first time by a daemon start.
      await vi.waitFor(() => expect(entered.length).toBeGreaterThan(0));
      if (token === null) {
        expect((await get(port, "/__iterbar/config")).status).toBe(200);
        token = String((await readMatchingDaemonFile(root))?.token);
      } else await rename(away, daemonFile);
      release();
      const result = await answer;
      expect(isRefusal(result), `${path}: ${result.status} ${result.body.slice(0, 200)}`).toBe(true);
      expect(result.body, path).not.toContain(token);
      await rename(daemonFile, away);
    }
    await rename(away, daemonFile);
  });

  it("serves the app when the public directory or another directory is a link to nothing yet", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.js"), 'export const marker = "MODULE-BESIDE-DANGLING";');
    await symlink(join(root, "assets-not-built"), join(root, "public"), "dir");
    await symlink(join(root, "gone"), join(root, "docs"), "dir");
    const { server, port } = await devServer({ publicDir: join(root, "public") });
    for (const path of ["/", "/index.html", "/docs/intro"]) expect(isAppPage(await get(port, path)), path).toBe(true);
    expect((await get(port, "/src/a.js")).body).toContain("MODULE-BESIDE-DANGLING");
    expect(String((await server.environments.client.transformRequest("/src/a.js"))?.code)).toContain("MODULE-BESIDE-DANGLING");
  });

  it("keeps each dev server to its own store when one plugin serves two projects at once", async () => {
    const plugin = iterbar();
    const projects = [join(root, "a"), join(root, "b")];
    const started = [];
    for (const project of projects) {
      await mkdir(join(project, "vault"), { recursive: true });
      await writeFile(join(project, "index.html"), "<!doctype html><html><body></body></html>");
      await symlink(join(project, "vault"), join(project, ".iterbar"), "dir");
      await writeFile(join(project, "vault", "secret.json"), `"SECRET-OF-${project}"`);
      // The second server starts before the first closes, as a restart with a changed root does.
      started.push(await devServer({ root: project, plugins: [plugin] }));
    }
    for (const [index, { server, port }] of started.entries()) {
      const project = projects[index] ?? "";
      lookups.paths = [];
      const answer = await get(port, "/vault/secret.json?raw");
      expect(isRefusal(answer), `${project}: ${answer.status}`).toBe(true);
      await expect(server.environments.client.transformRequest(join(project, "vault", "secret.json?raw"))).rejects.toThrow(/Iterbar store/);
      expect((await get(port, "/__iterbar/config")).status).toBe(200);
      expect(lookups.paths).toContain(join(project, ".iterbar"));
      expect(lookups.paths).not.toContain(join(projects[1 - index] ?? "", ".iterbar"));
    }
    // Closing the first server leaves the second its own daemon and token.
    await started[0]?.server.close();
    const second = await get(started[1]?.port ?? 0, "/__iterbar/config");
    expect(JSON.parse(second.body).token).toBe((await readMatchingDaemonFile(projects[1] ?? ""))?.token);
    expect(await readMatchingDaemonFile(projects[0] ?? "")).toBeNull();
  });

  it("looks each path up once per decision, decides a missing file by where it would be created, and counts a failed lookup as the store", async () => {
    const store: Store = { path: "/srv/app/.iterbar", real: null };
    const looked: string[] = [];
    const failure = (code: string): Promise<never> => Promise.reject(Object.assign(new Error(code), { code }));
    // The project's directories exist; `real` adds files and links, and `links` adds dangling links and their targets.
    const tree = { "/srv": "/srv", "/srv/app": "/srv/app", "/srv/app/sub": "/srv/app/sub" };
    const disk = (real: Record<string, string>, code = "ENOENT", links: Record<string, string> = {}): PathLookups => ({
      realpath: async (path) => {
        looked.push(path);
        return { ...tree, ...real }[path] ?? failure(code);
      },
      readlink: async (path) => links[path] ?? failure("ENOENT"),
    });
    expect(await isStoreFile("/srv/app/.ITERBAR./x", store, disk({}))).toBe(true);
    expect(looked).toEqual([]);
    expect(await isStoreFile("/srv/app/src/a.js", store, disk({ "/srv/app/src/a.js": "/srv/app/src/a.js" }))).toBe(false);
    expect(await isStoreFile("/srv/app/ITEMSA~1/a.js", store, disk({}))).toBe(false);
    expect(looked).toEqual(["/srv/app/.iterbar", "/srv/app/src/a.js", "/srv/app/.iterbar", "/srv/app/ITEMSA~1/a.js", "/srv", "/srv/app", "/srv/app/ITEMSA~1"]);
    // A link with a plain name leads to the store, its own or another project's.
    expect(await isStoreFile("/srv/app/docs/x", store, disk({ "/srv/app/docs/x": "/srv/other/.iterbar/x" }))).toBe(true);
    await expect(isStoreFile("/srv/app/X~1/a", store, disk({}, "EACCES"))).rejects.toThrow("EACCES");
    const linked = { "/srv/app/.iterbar": "/srv/vault", "/srv/app/X~1": "/srv/vaultx" };
    expect(await isStoreFile("/srv/app/docs/daemon.json", store, disk({ ...linked, "/srv/app/docs/daemon.json": "/srv/vault/daemon.json" }))).toBe(true);
    expect(await isStoreFile("/srv/app/X~1/a", store, disk({ ...linked, "/srv/app/X~1/a": "/srv/vaultx/a" }))).toBe(false);
    // A short name beside a store names it, whether the file exists yet or the store is another project's link.
    expect(await isStoreFile("/srv/app/ITERBA~1/daemon.json", store, disk({ ...linked, "/srv/app/ITERBA~1": "/srv/vault" }))).toBe(true);
    const nested = { "/srv/app/sub/ITERBA~1": "/d", "/srv/app/sub/.iterbar": "/d" };
    expect(await isStoreFile("/srv/app/sub/ITERBA~1/x", store, disk(nested))).toBe(true);
    expect(await isStoreFile("/srv/app/sub/ITERBA~1/x", store, disk({ ...nested, "/srv/app/sub/ITERBA~1/x": "/d/x" }))).toBe(true);
    // A real path has each name's case as stored: another case is another directory, which stays served.
    expect(await isStoreFile("/srv/VAULT/a", store, disk({ ...linked, "/srv/VAULT/a": "/srv/VAULT/a" }))).toBe(false);
    expect(await isStoreFile("/srv/VAULT/a", store, disk({ ...linked, "/srv/VAULT/a": "/srv/vault/a" }))).toBe(true);
    // A path no file can have, by a name too long or a NUL byte, cannot be read.
    expect(await isStoreFile("/srv/app/x", store, disk(linked, "ENAMETOOLONG"))).toBe(false);
    // A file that does not exist yet counts where it would be created: in the store by its own name or a link, in
    // any case where the file system ignores case, or where a dangling link leads, which may be the store by then.
    const kept: Store = { path: "/srv/app/.iterbar", real: "/srv/vault" };
    expect(await isStoreFile("/srv/vault/daemon.json", kept, disk({ ...linked, "/srv/vault": "/srv/vault" }))).toBe(true);
    expect(await isStoreFile("/srv/app/docs/daemon.json", kept, disk({ ...linked, "/srv/app/docs": "/srv/vault" }))).toBe(true);
    expect(await isStoreFile("/srv/VAULT/daemon.json", kept, disk({ ...linked, "/srv/VAULT": "/srv/vault" }))).toBe(true);
    expect(await isStoreFile("/srv/vault/sub/daemon.json", kept, disk({}))).toBe(true);
    expect(await isStoreFile("/srv/VAULT/daemon.json", kept, disk({}))).toBe(["darwin", "win32"].includes(process.platform));
    const leads: Record<string, string>[] = [{ "/srv/app/docs": "/srv/app/.iterbar" }, { "/srv/app/docs": "../vault" }, { "/srv/app/docs": "next", "/srv/app/next": "/srv/vault/x" }];
    for (const links of leads) {
      expect(await isStoreFile("/srv/app/docs/daemon.json", kept, disk({}, "ENOENT", links)), JSON.stringify(links)).toBe(true);
    }
    expect(await isStoreFile("/srv/app/docs/daemon.json", kept, disk({}, "ENOENT", { "/srv/app/docs": "docs" }))).toBe(true);
    // Other missing files stay Vite's to answer: SPA routes, and files behind a dangling link that leads elsewhere.
    for (const file of ["/srv/app/about/team", "/srv/vaultx/a.js", "/srv/app/vault/daemon.json", "/srv/app/docs/a", "/srv/app/public/index"]) {
      expect(await isStoreFile(file, kept, disk({ ...linked, "/srv/vault": "/srv/vault" }, "ENOENT", { "/srv/app/public": "../assets" })), file).toBe(false);
    }
    await expect(isStoreFile("/srv/app/docs/a", kept, { ...disk({}), readlink: () => failure("EACCES") })).rejects.toThrow("EACCES");
    await mkdir(join(root, "vault"));
    await symlink(join(root, "vault"), join(root, ".iterbar"), "dir");
    await symlink(join(root, "gone"), join(root, "docs"), "dir");
    await symlink(join(root, "vault", "later"), join(root, "later"), "dir");
    const onDisk: Store = { path: join(root, ".iterbar"), real: null };
    expect(await isStoreFile(join(root, "vault", "daemon.json"), onDisk)).toBe(true);
    expect(await isStoreFile(join(root, "later", "daemon.json"), onDisk)).toBe(true);
    expect(await isStoreFile(join(root, "docs", "daemon.json"), onDisk)).toBe(false);
    expect(await isStoreFile(join(root, "about", "team"), onDisk)).toBe(false);
    expect(await isLoadOfStore("/srv/vault/daemon.json", { publicDir: "", store }, disk({}, "EIO"))).toBe(true);
    // A missing path with a hundred directories costs a lookup of the file and of each directory down to the first
    // missing one.
    looked.length = 0;
    const deep = `/srv/app/${Array.from({ length: 100 }, (_, index) => `D~${index}`).join("/")}/a.js`;
    expect(await isStoreFile(deep, store, disk(linked))).toBe(false);
    expect(looked).toEqual(["/srv/app/.iterbar", deep, "/srv", "/srv/app", "/srv/app/D~0"]);
    // One decision over several files looks each path up once.
    looked.length = 0;
    const layout = { root: "/srv/app", base: "/base/", publicDir: "/srv/app/public", alias: [], store };
    expect(await isLoadOfStore("/X~1/a.js?raw", layout, disk({ ...linked, "/X~1": "/X~1" }))).toBe(false);
    const expected = ["/srv/app/.iterbar", "/X~1/a.js", "/srv/app/public/X~1/a.js", "/X~1", "/.iterbar", "/srv", "/srv/app", "/srv/app/public"];
    expect([...looked].sort((a, b) => a.localeCompare(b))).toEqual(expected.sort((a, b) => a.localeCompare(b)));
    expect(servedFiles("/base/src/a.js?raw", layout)).toEqual(expect.arrayContaining(["/srv/app/src/a.js", "/srv/app/public/src/a.js"]));
    expect(servedFiles("/base/@fs/srv/p/x%2541.txt", layout)).toContain("/srv/p/x%41.txt");
    expect(servedFiles("/base/a%2F..%2F/x.html", layout)).toContain("/srv/app/x.html");
    expect(await isLoadOfStore("\0/srv/app/.iterbar/daemon.json", layout)).toBe(false);
    expect(await isLoadOfStore("/srv/app/.iterbar/daemon.json?raw", layout)).toBe(true);
  });

  it("adds the store to Vite's server.fs.deny, next to Vite's own denials or the configured ones", async () => {
    // Vite's defaults as this Vite resolves them, so a new default the plugin's copy lacks fails here.
    const viteDefaults = (await resolveConfig({ root, configFile: false, logLevel: "silent" }, "serve")).server.fs.deny;
    expect(viteDefaults.length).toBeGreaterThan(0);
    const { server, port } = await devServer();
    expect(server.config.server.fs.deny).toEqual([...viteDefaults, "**/.iterbar/**"]);
    const configured = await devServer({ server: { fs: { deny: ["secrets/**"] } } });
    expect(configured.server.config.server.fs.deny).toEqual(["secrets/**", "**/.iterbar/**"]);

    // Vite's own denials still hold with the plugin installed.
    await writeFile(join(root, ".env"), "SECRET=ENV-SECRET");
    await writeFile(join(root, "dev-cert.pem"), "PEM-SECRET");
    for (const path of [
      `/@fs${root}/.env`, `/@fs${root}/.env?raw`, "/.env?import", "/.env?raw",
      `/@fs${root}/dev-cert.pem?raw`, "/dev-cert.pem?import", "/dev-cert.pem?raw",
    ]) {
      const answer = await get(port, path);
      expect(answer.status, path).not.toBe(200);
      for (const secret of ["ENV-SECRET", "PEM-SECRET"]) expect(answer.body, path).not.toContain(secret);
    }
  });

  it("checks a request path in time linear in its length, however many trailing dots or spaces a segment has", () => {
    const timed = (length: number): number => {
      const segments = [".".repeat(length) + "x", ". ".repeat(length / 2) + "x", ".iterbar" + ". ".repeat(length / 2) + "x"];
      const started = performance.now();
      for (const segment of segments) for (let round = 0; round < 5; round += 1) isStoreRequest(`/${segment}/daemon.json`);
      return performance.now() - started;
    };
    // The fastest of several runs, so a pause of the test process does not count as the check's own time.
    const fastest = (length: number): number => Math.min(...Array.from({ length: 5 }, () => timed(length)));
    timed(16_000);
    const small = Math.max(fastest(4_000), 0.5);
    const large = fastest(16_000);
    // A quadratic check takes about 16 times as long for 4 times the length; a linear one about 4 times.
    expect(large / 15).toBeLessThan(20);
    expect(large / small).toBeLessThan(10);
  });

  it("recognizes a store path by its own name however it is written, and leaves other names to the file system", () => {
    for (const url of [
      "/.iterbar/daemon.json", "/a/.Iterbar/x", "/%2Eiterbar/daemon.json", "/a%2F.iterbar%2Fdaemon.json",
      "/a\\.iterbar\\daemon.json", "http://host/.iterbar/daemon.json", "/.iterbar", "/%E0%A4%A.iterbar/x",
      "//.iterbar/daemon.json", "//.iterbar", "/.iterbar./x", "/.iterbar%20/x", "/.ITERBAR.. ./x", "/.iterbar:x/y",
      "/@fs/C:/p/.iterbar./daemon.json", "/@fs/C:/Users/ITADMI~1/p/.iterbar/daemon.json",
    ]) {
      expect(isStoreRequest(url), url).toBe(true);
    }
    for (const url of [
      "/", "/@id/@iterbar/vite/client", "/__iterbar/config", "/iterbar/.iterbarx/a", "/src/main.ts?iterbar",
      "/x.iterbar/a", "/iterba~x/a", "/@fs/C:/p/src/main.ts", "//host.example/app.js", "/PROGRA~1/x", "/it~/x",
      "/itemlist~12345/x", "/iterba~1.json5/x", "/item~1x/a",
      // A short name, the store's or another directory's, cannot be told from the URL: the guard looks it up.
      "/ITERBA~1/daemon.json", "/IT3F2A~1/x", "/%49TERBA~1/x", "/@fs/C:/p/iterba~1/daemon.json",
      "/@fs/C:/Users/ITADMI~1/proj/node_modules/.vite/deps/react.js", "/@fs/C:/Users/ITEMS~2/app/src/main.tsx",
      "/@fs/home/u/it~1x/src/a.ts", "/itadmi~1/a.js", "/items~2/a.js", "/it3g2a~1/a.js", "/ITEMSA~1/a.js",
      "/iterbarx~1/a.js", "/it5f2a~12/a.js", "/itez~1/a.js", "/i~1/a.js",
    ]) {
      expect(isStoreRequest(url), url).toBe(false);
    }
  });

  it("gives each dev server of a restart its own daemon link, released when that server closes", async () => {
    const { server, port } = await devServer();
    expect((await get(port, "/__iterbar/config")).status).toBe(200);
    await server.restart();
    const after = await get(port, "/__iterbar/config");
    expect(after.status).toBe(200);
    const info = await readMatchingDaemonFile(root);
    expect(JSON.parse(after.body)).toEqual({ daemonUrl: `http://127.0.0.1:${info?.port}`, token: info?.token });
    await server.close();
    // Neither the first server's daemon nor the restarted server's is left running.
    expect(await readMatchingDaemonFile(root)).toBeNull();
  });

  it("serves the config over HTTP/2 on an HTTPS dev server, where requests carry :authority instead of Host", async () => {
    const certificate = selfSignedCertificate(root);
    const https = { key: await readFile(certificate.key), cert: await readFile(certificate.cert) };
    const { port } = await devServer({ server: { https } });
    const own = await getHttp2(port, "/__iterbar/config", { "sec-fetch-site": "same-origin" });
    expect(own.status).toBe(200);
    expect(JSON.parse(own.body).token).toBe((await readMatchingDaemonFile(root))?.token);
    const loopback = { ":authority": `localhost:${port}`, origin: `https://localhost:${port}` };
    expect((await getHttp2(port, "/__iterbar/config", loopback)).status).toBe(200);

    // Vite does not check the host on an HTTPS server; the endpoint still refuses rebound and foreign requests.
    const refused = [
      await getHttp2(port, "/__iterbar/config", { ":authority": `attacker.test:${port}`, "sec-fetch-site": "same-origin" }),
      await getHttp2(port, "/__iterbar/config", { origin: `http://127.0.0.1:${port}` }),
      await getHttp2(port, "/__iterbar/config", { "sec-fetch-site": "cross-site" }),
    ];
    expect(refused.map(({ status }) => status)).toEqual([403, 403, 403]);

    // HTTP/2 stacks refuse user info in :authority themselves; the endpoint refuses it too.
    const context = { https: true, allowedOrigins: [`https://127.0.0.1:${port}`], configuredOrigins: [] };
    const request = (authority: string) => ({ method: "GET", headers: { ":authority": authority } }) as unknown as IncomingMessage;
    expect(checkConfigRequest(request(`127.0.0.1:${port}`), context)).toMatchObject({ allowed: true });
    expect(checkConfigRequest(request(`user@127.0.0.1:${port}`), context)).toMatchObject({ allowed: false, status: 403 });
  });

  it("accepts a configured HTTPS origin whose TLS ends at a proxy in front of the HTTP dev server", async () => {
    const { port } = await devServer({
      plugins: [iterbar({ origins: ["https://tunnel.example"] })],
      server: { allowedHosts: ["tunnel.example", "other.example"] },
    });
    const proxied = { host: "tunnel.example", "sec-fetch-site": "same-origin" };
    expect((await get(port, "/__iterbar/config", { ...proxied, origin: "https://tunnel.example" })).status).toBe(200);
    expect((await get(port, "/__iterbar/config", proxied)).status).toBe(200);

    const refused = [
      // Only the configured scheme: http://tunnel.example is not an origin of this dev server.
      await get(port, "/__iterbar/config", { ...proxied, origin: "http://tunnel.example" }),
      await get(port, "/__iterbar/config", { ...proxied, origin: "https://other.example" }),
      await get(port, "/__iterbar/config", { ...proxied, "sec-fetch-site": "cross-site" }),
      await get(port, "/__iterbar/config", { host: "other.example", origin: "https://other.example" }),
    ];
    expect(refused.map(({ status }) => status)).toEqual([403, 403, 403, 403]);
  });

  it("stops the daemon it started when the dev server closes", async () => {
    const { server, port } = await devServer();
    expect((await get(port, "/__iterbar/config")).status).toBe(200);
    expect(await readMatchingDaemonFile(root)).toMatchObject({ pid: process.pid, projectRoot: root });
    await server.close();
    expect(await readMatchingDaemonFile(root)).toBeNull();
  });
});

describe("iterbar() in vite build", () => {
  it("leaves no Iterbar code in the bundle, and the client import resolves to an empty module", async () => {
    // The app depends on @iterbar/vite, as an installed app would.
    await mkdir(join(root, "node_modules", "@iterbar"), { recursive: true });
    await symlink(join(import.meta.dirname, ".."), join(root, "node_modules", "@iterbar", "vite"), "dir");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "main.js"), `import "${CLIENT_ID}";\ndocument.body.dataset.app = "ready";\n`);
    await writeFile(join(root, "index.html"), '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>');
    await build({ root, configFile: false, logLevel: "silent", plugins: [iterbar()] });

    const files = await readdir(join(root, "dist"), { recursive: true, withFileTypes: true });
    const texts = await Promise.all(files.filter((file) => file.isFile())
      .map((file) => readFile(join(file.parentPath, file.name), "utf8")));
    expect(texts.join("\n")).toContain('dataset.app="ready"');
    for (const marker of ["iterbar", "__iterbar/config", "mountIterbarBar"]) {
      expect(texts.join("\n")).not.toContain(marker);
    }
    expect(await readMatchingDaemonFile(root)).toBeNull();
  });
});
