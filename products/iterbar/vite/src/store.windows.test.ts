import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { readMatchingDaemonFile } from "./daemon.js";
import { iterbar } from "./index.js";
import { isStoreFile } from "./store.js";

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

const MARKER = "MODULE-IN-SIBLING";
const cwd = process.cwd();
let server: ViteDevServer | undefined;
let root: string | undefined;

afterEach(async () => {
  process.chdir(cwd);
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
  server = undefined;
  root = undefined;
});

/** A project with sibling directories made before the daemon makes `.iterbar`, served with `fs.strict` as given. */
async function project(strict: boolean, siblings: readonly string[]) {
  const dir = (root = await realpath(await mkdtemp(join(tmpdir(), "iterbar-vite-win-"))));
  await writeFile(join(dir, "index.html"), "<!doctype html><html><body></body></html>");
  for (const sibling of siblings) {
    await mkdir(join(dir, sibling));
    await writeFile(join(dir, sibling, "a.js"), `export const marker = "${MARKER}";`);
    await writeFile(join(dir, sibling, "a.txt"), MARKER);
  }
  // Vite serves `/@fs/` from the drive of the working directory when it starts, which a project is on.
  process.chdir(dir);
  server = await createServer({
    root: dir,
    configFile: false,
    logLevel: "silent",
    plugins: [iterbar()],
    optimizeDeps: { noDiscovery: true },
    server: { host: "127.0.0.1", port: 0, fs: { strict } },
  });
  await server.listen();
  const address = server.httpServer?.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const get = async (path: string) => {
    const answer = await fetch(base + path, { headers: { "sec-fetch-site": "same-origin" } });
    return { status: answer.status, body: await answer.text() };
  };

  const config = await get("/__iterbar/config");
  expect(config.status).toBe(200);
  const token = (await readMatchingDaemonFile(dir))?.token ?? "";
  expect((JSON.parse(config.body) as { token: string }).token).toBe(token);
  // Fails, never skips, when the volume gives the store no short name: the guard must be tested against one.
  const store = shortNameOf(dir, ".iterbar");
  expect(store, "the .iterbar directory has no 8.3 short name; enable them with fsutil 8dot3name set").not.toBeNull();
  // The short name really reaches the store, so a 404 below comes from the guard and not a missing file.
  expect(await readFile(join(dir, store ?? "", "daemon.json"), "utf8")).toContain(token);
  const shortNames = new Map(siblings.map((sibling) => [sibling, shortNameOf(dir, sibling)]));
  console.log(`fs.strict ${strict}: .iterbar -> ${store}; ${[...shortNames].map(([name, short]) => `${name} -> ${short}`).join(", ")}`);
  for (const [name, short] of shortNames) expect(short, `${name} has no 8.3 short name`).not.toBeNull();
  return { fsRoot: dir.replaceAll("\\", "/"), store: store ?? "", shortNames, token, get };
}

// The Windows process lifecycle workflow runs this file on windows-latest with 8.3 names enabled.
describe.runIf(process.platform === "win32")("the store guard on Windows", () => {
  it("refuses the store by its short name itself and leaves other short names to Vite's own fs.strict", async () => {
    const { fsRoot, store, shortNames, token, get } = await project(true, ["itemsarchive"]);
    for (const path of [`/${store}/daemon.json`, `/@fs/${fsRoot}/${store}/daemon.json?raw`]) {
      const answer = await get(path);
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).toBe("Not found");
      expect(answer.body, path).not.toContain(token);
    }
    // Vite refuses a Windows path with a `~` under fs.strict when it serves a file as it is; its 403, not the guard's
    // 404, shows the guard let it by. (A module may be served by the long name Vite resolves for it.)
    const other = shortNames.get("itemsarchive");
    for (const path of [`/${other}/a.txt`, `/@fs/${fsRoot}/${other}/a.txt`]) {
      const answer = await get(path);
      expect(answer.status, path).toBe(403);
      expect(answer.body, path).toContain("403 Restricted");
    }
  });

  it("with fs.strict off, serves other short-named directories, hashed ones too, and never the store", async () => {
    // Five longer names before it that start like `iterbar`, so `.iterbar` may get a hashed short name as well.
    const iterbarSiblings = Array.from({ length: 5 }, (_, index) => `iterbarsibling${index + 1}`);
    // Past four names with one start, Windows hashes the rest: ITFACE~1 to ITFACE~4, then IT<hex>~1.
    const faceSiblings = Array.from({ length: 6 }, (_, index) => `itfacearchive${index + 1}`);
    const { fsRoot, store, shortNames, token, get } = await project(false, [...iterbarSiblings, "itemsarchive", ...faceSiblings]);
    const hashed = faceSiblings.map((name) => shortNames.get(name) ?? "").filter((short) => !short.toUpperCase().startsWith("ITFACE"));
    expect(hashed.length, "no itfacearchive directory got a hashed short name").toBeGreaterThan(0);
    for (const other of [shortNames.get("itemsarchive"), hashed[0]]) {
      for (const path of [`/${other}/a.js`, `/@fs/${fsRoot}/${other}/a.js`, `/${other}/a.txt`, `/@fs/${fsRoot}/${other}/a.txt`]) {
        const answer = await get(path);
        expect(answer.status, path).toBe(200);
        expect(answer.body, path).toContain(MARKER);
      }
    }
    for (const path of [
      `/${store}/daemon.json`,
      `/${store.toLowerCase()}/daemon.json`,
      `/@fs/${fsRoot}/${store}/daemon.json`,
      `/@fs/${fsRoot}/${store}/daemon.json?raw`,
      `/@fs/${fsRoot}/${store}/store.lock?raw`,
    ]) {
      const answer = await get(path);
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).not.toContain(token);
    }
    // Any other spelling may reach no file at all, which Vite answers with the app's page; never with the store.
    for (const path of [`/${store}./daemon.json`, `/${store}%20/daemon.json?raw`, `/@id/${fsRoot}/${store}/daemon.json?import&raw`]) {
      const answer = await get(path);
      expect(answer.status === 200 ? answer.body : "<html", path).toContain("<html");
      expect(answer.body, path).not.toContain(token);
    }
  });
  it.each([true, false])("refuses a link to the store rooted without a drive, on the link's drive (fs.strict %s)", async (strict) => {
    const dir = (root = await realpath(await mkdtemp(join(tmpdir(), "iterbar-vite-win-"))));
    const drive = parse(dir).root;
    // Vite runs from the checkout's drive, and the project is on the temp volume: a link's `\\x` is on the latter.
    console.log(`working directory drive ${parse(cwd).root}, project drive ${drive}`);
    expect(parse(cwd).root.toLowerCase(), "the project must be on another drive than the working directory").not.toBe(drive.toLowerCase());
    await writeFile(join(dir, "index.html"), "<!doctype html><html><body><p>App</p></body></html>");
    await mkdir(join(dir, "vault"));
    await symlink(join(dir, "vault"), join(dir, ".iterbar"), "junction");
    // Node would give the target the working directory's drive, so `mklink` makes the links; each fails, never skips.
    const rooted = (path: string): string => path.slice(drive.length - 1);
    const links = { L: rooted(join(dir, "vault", "daemon.json")), U: rooted(join(dir, "elsewhere", "x.js")) };
    for (const [name, target] of Object.entries(links)) {
      execFileSync("cmd.exe", ["/d", "/c", "mklink", join(dir, name), target], { stdio: "ignore" });
      expect(await readlink(join(dir, name))).toBe(target);
    }
    console.log(`L -> ${links.L}, U -> ${links.U}`);
    expect(await isStoreFile(join(dir, "L"), { path: join(dir, ".iterbar"), real: null })).toBe(true);
    server = await createServer({
      root: dir,
      configFile: false,
      logLevel: "silent",
      plugins: [iterbar()],
      optimizeDeps: { noDiscovery: true },
      server: { host: "127.0.0.1", port: 0, fs: { strict } },
    });
    await server.listen();
    const address = server.httpServer?.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const get = async (path: string) => {
      const answer = await fetch(base + path, { headers: { "sec-fetch-site": "same-origin" } });
      return { status: answer.status, body: await answer.text() };
    };
    const fsPath = `/@fs/${dir.replaceAll("\\", "/")}/L`;
    // The guard's 404, the plugin's load error or Vite's own fs refusal, before the daemon writes daemon.json and after.
    const refusesL = async (token: string) => {
      for (const path of ["/L", "/L?raw", fsPath, `${fsPath}?raw`]) {
        const answer = await get(path);
        const refused = (answer.status === 404 && answer.body === "Not found") || (answer.status === 500 && answer.body.includes("which the dev server does not serve"))
          || (answer.status === 403 && answer.body.includes("403 Restricted"));
        expect(refused, `${path}: ${answer.status} ${answer.body.slice(0, 200)}`).toBe(true);
        if (token) expect(answer.body, path).not.toContain(token);
      }
    };
    // The plugin starts the daemon on the first config request, so daemon.json is not there yet: L dangles.
    await expect(readFile(join(dir, "vault", "daemon.json"))).rejects.toThrow(/ENOENT/);
    await refusesL("");
    expect((await get("/__iterbar/config")).status).toBe(200);
    const token = (await readMatchingDaemonFile(dir))?.token ?? "";
    expect(token).not.toBe("");
    expect(await readFile(join(dir, "L"), "utf8")).toContain(token);
    await refusesL(token);
    // A link rooted the same way that leads elsewhere stays Vite's to answer, with the app's page.
    const other = await get("/U");
    expect(other.status === 200 && other.body.includes("<p>App</p>"), `${other.status} ${other.body.slice(0, 200)}`).toBe(true);
  });
});
