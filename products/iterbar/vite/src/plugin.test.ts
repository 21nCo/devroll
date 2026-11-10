import { execFileSync } from "node:child_process";
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { connect as http2Connect, type OutgoingHttpHeaders as Http2Headers } from "node:http2";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createServer, type InlineConfig, type ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMatchingDaemonFile } from "./daemon.js";
import { checkConfigRequest } from "./endpoint.js";
import { CLIENT_ID, iterbar } from "./index.js";
import { isStoreRequest } from "./store.js";

let root: string;
let servers: ViteDevServer[] = [];

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

  it("never serves the Iterbar store, by any path, while the config endpoint keeps working", async () => {
    // The project root is the parent of Vite's root, as in a monorepo; the store is outside Vite's root.
    const app = join(root, "app");
    await mkdir(app);
    await writeFile(join(app, "index.html"), "<!doctype html><html><body></body></html>");
    const { port } = await devServer({ root: app, base: "/base/", plugins: [iterbar({ projectRoot: ".." })] });
    expect((await get(port, "/base/__iterbar/config")).status).toBe(200);
    const info = await readMatchingDaemonFile(root);
    expect(info?.projectRoot).toBe(root);
    const feedback = join(root, ".iterbar", "feedback", "fb_test");
    await mkdir(feedback, { recursive: true });
    await writeFile(join(feedback, "feedback.json"), '{"secret":"FEEDBACK-SECRET"}');
    // A store under Vite's own root, where its static middleware would serve it.
    await mkdir(join(app, ".iterbar"));
    await writeFile(join(app, ".iterbar", "daemon.json"), '{"token":"APP-STORE-SECRET"}');

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
    ];
    for (const path of paths) {
      const answer = await get(port, path, { origin: "http://localhost:3000", "sec-fetch-site": "cross-site" });
      expect(answer.status, path).toBe(404);
      for (const secret of [info?.token ?? "", "FEEDBACK-SECRET", "APP-STORE-SECRET"]) expect(answer.body, path).not.toContain(secret);
    }
    expect((await get(port, "/base/__iterbar/config")).status).toBe(200);
  });

  it("adds the store to Vite's server.fs.deny, next to Vite's own denials or the configured ones", async () => {
    const { server } = await devServer();
    expect(server.config.server.fs.deny).toEqual(expect.arrayContaining([".env", "**/.git/**", "**/.iterbar/**"]));
    const configured = await devServer({ server: { fs: { deny: ["secrets/**"] } } });
    expect(configured.server.config.server.fs.deny).toEqual(["secrets/**", "**/.iterbar/**"]);
  });

  it("recognizes a store path however it is written, and nothing else", () => {
    for (const url of [
      "/.iterbar/daemon.json", "/a/.Iterbar/x", "/%2Eiterbar/daemon.json", "/a%2F.iterbar%2Fdaemon.json",
      "/a\\.iterbar\\daemon.json", "http://host/.iterbar/daemon.json", "/.iterbar", "/%E0%A4%A.iterbar/x",
      "//.iterbar/daemon.json", "//.iterbar", "/.iterbar./x", "/.iterbar%20/x", "/.ITERBAR.. ./x", "/.iterbar:x/y",
      "/ITERBA~1/daemon.json", "/IT3F2A~2/x", "/@fs/C:/p/.iterbar./daemon.json", "/@fs/C:/p/iterba~1/daemon.json",
    ]) {
      expect(isStoreRequest(url), url).toBe(true);
    }
    for (const url of [
      "/", "/@id/@iterbar/vite/client", "/__iterbar/config", "/iterbar/.iterbarx/a", "/src/main.ts?iterbar",
      "/x.iterbar/a", "/iterba~x/a", "/@fs/C:/p/src/main.ts", "//host.example/app.js",
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
