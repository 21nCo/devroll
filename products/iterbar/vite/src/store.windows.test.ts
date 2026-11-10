import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { readMatchingDaemonFile } from "./daemon.js";
import { iterbar } from "./index.js";

/** The Windows short name `dir /x` lists for an entry of a directory, or `null` when it has none. */
function shortNameOf(directory: string, name: string): string | null {
  const listing = execFileSync("cmd.exe", ["/d", "/c", "dir", "/x", "/a", directory], { encoding: "utf8" });
  for (const line of listing.split(/\r?\n/)) {
    if (!line.trimEnd().endsWith(` ${name}`)) continue;
    const columns = line.trimEnd().split(/\s+/);
    const short = columns.at(-2) ?? "";
    return short.includes("~") ? short : null;
  }
  return null;
}

let server: ViteDevServer | undefined;
let root: string | undefined;

afterEach(async () => {
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
  server = undefined;
  root = undefined;
});

// The Windows process lifecycle workflow runs this file on windows-latest with 8.3 names enabled.
describe.runIf(process.platform === "win32")("the store guard on Windows", () => {
  it("never serves the store by its real 8.3 short name, but serves other short-named directories and the config", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "iterbar-vite-win-")));
    await writeFile(join(root, "index.html"), "<!doctype html><html><body></body></html>");
    // A directory whose short name also starts with IT (ITEMSA~1) but cannot be the store's.
    await mkdir(join(root, "itemsarchive"));
    await writeFile(join(root, "itemsarchive", "a.js"), 'export const marker = "MODULE-IN-ITEMSARCHIVE";');
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [iterbar()],
      optimizeDeps: { noDiscovery: true },
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer?.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    const config = await fetch(`${base}/__iterbar/config`, { headers: { "sec-fetch-site": "same-origin" } });
    expect(config.status).toBe(200);
    const info = await readMatchingDaemonFile(root);
    expect(info).not.toBeNull();
    expect(((await config.json()) as { token: string }).token).toBe(info?.token);

    // Fails, never skips, when the volume gives the store no short name: the guard must be tested against one.
    const short = shortNameOf(root, ".iterbar");
    expect(short, "the .iterbar directory has no 8.3 short name; enable them with fsutil 8dot3name set").not.toBeNull();
    // The short name really reaches the store, so a 404 below comes from the guard and not a missing file.
    expect(await readFile(join(root, short ?? "", "daemon.json"), "utf8")).toContain(info?.token ?? "");

    const other = shortNameOf(root, "itemsarchive");
    console.log(`short names: .iterbar -> ${short}, itemsarchive -> ${other}`);
    expect(other, "the itemsarchive directory has no 8.3 short name").not.toBeNull();
    expect(other?.toLowerCase().startsWith("it"), `${other}`).toBe(true);
    expect(other?.toLowerCase()).not.toBe(short?.toLowerCase());

    const fsRoot = root.replaceAll("\\", "/");
    for (const path of [`/${other}/a.js`, `/@fs/${fsRoot}/${other}/a.js`]) {
      const answer = await fetch(base + path, { headers: { "sec-fetch-site": "same-origin" } });
      expect(answer.status, path).toBe(200);
      expect(await answer.text(), path).toContain("MODULE-IN-ITEMSARCHIVE");
    }
    for (const path of [
      `/${short}/daemon.json`,
      `/${short?.toLowerCase()}/daemon.json`,
      `/${short}./daemon.json`,
      `/@fs/${fsRoot}/${short}/daemon.json`,
      `/@fs/${fsRoot}/${short}/daemon.json?raw`,
      `/@fs/${fsRoot}/${short}/store.lock?raw`,
    ]) {
      const answer = await fetch(base + path, { headers: { "sec-fetch-site": "same-origin" } });
      expect(answer.status, path).toBe(404);
      expect(await answer.text(), path).not.toContain(info?.token ?? "");
    }
  });
});
