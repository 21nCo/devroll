import { win32 } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isStoreFile, linkTarget, type PathLookups, type Store } from "./store.js";

// The store guard as it runs on Windows, on any OS: Windows path rules, and a file system modelled below.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual.win32, win32: actual.win32, posix: actual.posix, default: actual.win32 };
});
const platform = Object.getOwnPropertyDescriptor(process, "platform");
beforeAll(() => Object.defineProperty(process, "platform", { value: "win32" }));
afterAll(() => platform && Object.defineProperty(process, "platform", platform));

describe("linkTarget", () => {
  it("places a link's target where each OS opens it, and gives up on a target it cannot place", () => {
    const cases: [string, string, NodeJS.Platform, string | null][] = [
      ["D:\\proj", "\\vault\\daemon.json", "win32", "D:\\vault\\daemon.json"],
      ["D:\\proj", "/vault/x", "win32", "D:/vault/x"],
      ["D:\\", "\\vault", "win32", "D:\\vault"],
      ["\\\\srv\\sh\\p", "\\vault", "win32", "\\\\srv\\sh\\vault"],
      ["D:\\proj", "C:\\x", "win32", "C:\\x"],
      ["D:\\proj", "C:/x", "win32", "C:/x"],
      ["D:\\proj", "\\\\srv\\sh\\x", "win32", "\\\\srv\\sh\\x"],
      ["D:\\proj", "\\\\?\\C:\\x", "win32", "C:\\x"],
      ["D:\\proj", "\\??\\C:\\x", "win32", "C:\\x"],
      ["D:\\proj", "\\\\?\\UNC\\srv\\sh\\x", "win32", "\\\\srv\\sh\\x"],
      ["D:\\proj", "..\\vault", "win32", "D:\\proj\\..\\vault"],
      ["D:\\proj", "vault/x", "win32", "D:\\proj\\vault/x"],
      ["D:\\proj", "D:x", "win32", null],
      ["D:\\proj", "D:", "win32", null],
      ["D:\\proj", "\\\\srv", "win32", null],
      ["D:\\proj", "\\\\?\\Volume{0}\\x", "win32", null],
      ["D:\\proj", "", "win32", null],
      ["D:\\proj", "a\0b", "win32", null],
      ["/srv/app", "/x", "linux", "/x"],
      ["/srv/app", "x", "darwin", "/srv/app/x"],
      ["/srv/app", "../vault/x", "linux", "/srv/app/../vault/x"],
      ["/srv/app", "\\x", "linux", "/srv/app/\\x"],
      ["/srv/app", "", "linux", null],
    ];
    for (const [parent, target, os, expected] of cases) expect(linkTarget(parent, target, os), `${os} ${parent} ${target}`).toBe(expected);
  });
});

describe("isStoreFile on Windows", () => {
  it("decides a dangling link by its target on the link's drive, not the working directory's", async () => {
    // Vite runs from C:\work; the project and the store it links to are on D:, and daemon.json is not written yet.
    const real: Record<string, string> = { "C:\\": "C:\\", "C:\\work": "C:\\work", "C:\\vault": "C:\\vault", "D:\\": "D:\\", "D:\\proj": "D:\\proj", "D:\\proj\\.iterbar": "D:\\vault", "D:\\vault": "D:\\vault" };
    const links: Record<string, string> = {
      "D:\\proj\\L": "\\vault\\daemon.json",
      "D:\\proj\\P": "\\\\?\\D:\\vault\\daemon.json",
      "D:\\proj\\R": "D:vault\\daemon.json",
      "D:\\proj\\U": "\\elsewhere\\x.js",
    };
    const failure = (code: string): Promise<never> => Promise.reject(Object.assign(new Error(code), { code }));
    // Each path as Windows reads it: rooted without a drive is on the working directory's drive, C:.
    const onDisk = (path: string): string => win32.resolve("C:\\work", path);
    const files: PathLookups = {
      realpath: async (path) => real[onDisk(path)] ?? failure("ENOENT"),
      readlink: async (path) => links[onDisk(path)] ?? failure(real[onDisk(path)] ? "EINVAL" : "ENOENT"),
    };
    const store = (): Store => ({ path: "D:\\proj\\.iterbar", real: null });
    for (const file of ["D:\\proj\\L", "D:\\proj\\L\\index", "D:\\proj\\P", "D:\\proj\\R"]) expect(await isStoreFile(file, store(), files), file).toBe(true);
    // A dangling link elsewhere, and a missing route, stay Vite's to answer.
    for (const file of ["D:\\proj\\U", "D:\\proj\\about"]) expect(await isStoreFile(file, store(), files), file).toBe(false);
  });
});
