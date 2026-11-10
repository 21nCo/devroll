import { request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createServer, type InlineConfig, type ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMatchingDaemonFile } from "./daemon.js";
import { CLIENT_ID, iterbar } from "./index.js";

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
    for (const { body } of refused) expect(body).not.toContain(info?.token);
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
