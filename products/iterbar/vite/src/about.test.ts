import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkUpdates, readAbout } from "./about.js";

describe("about", () => {
  it("reads the plugin's and the CLI's versions, and the CLI's entry file", () => {
    const about = readAbout(fileURLToPath(new URL("./index.ts", import.meta.url)));
    expect(about.packages.map((pkg) => pkg.name)).toEqual(["@iterbar/vite", "iterbar"]);
    expect(about.cli?.path).toMatch(/cli[\\/]dist[\\/]cli\.js$/u);
  });

  it("asks the registry for each package's latest version, saying when one is not published or can't be asked", async () => {
    const about = { packages: [{ name: "@iterbar/vite", version: "0.1.0" }, { name: "@iterbar/cli", version: "0.1.0" }, { name: "iterbar", version: "0.1.0" }], cli: null };
    const asked: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      if (url.includes("vite")) return new Response(JSON.stringify({ version: "0.2.0" }), { status: 200 });
      if (url.includes("cli")) return new Response("{}", { status: 404 });
      throw new Error("offline");
    }) as typeof fetch;
    const { packages } = await checkUpdates(about, fakeFetch);
    expect(asked).toEqual([
      "https://registry.npmjs.org/@iterbar%2Fvite/latest",
      "https://registry.npmjs.org/@iterbar%2Fcli/latest",
      "https://registry.npmjs.org/iterbar/latest",
    ]);
    expect(packages).toEqual([
      { name: "@iterbar/vite", installed: "0.1.0", latest: "0.2.0" },
      { name: "@iterbar/cli", installed: "0.1.0", latest: null },
      { name: "iterbar", installed: "0.1.0", latest: null, error: "offline" },
    ]);
  });
});
