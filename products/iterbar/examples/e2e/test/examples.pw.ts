import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { startDaemon } from "@iterbar/cli/daemon";
import { expect, test, type Page } from "@playwright/test";
import { bearerAuthorization, daemonInfoSchema, parseMessage, type DaemonInfo } from "iterbar";
import { iterbarPaths } from "iterbar/node";
import { APPS, buildApp, projectRoot, readTree, startVite, type ExampleApp } from "./support/apps.js";

/** Text the bar's own code contains; a build that has the bar has these, a build without it does not. */
const BAR_MARKERS = ["iterbar-bar", "iterbar-comment-mode", "Move Iterbar", "Token rejected"];
/** Text of the plugin's client module, which mounts the bar. */
const CLIENT_MARKERS = ["__iterbar/config"];

const HERO = { calm: "Ship small changes, see them at once", bold: "SHIP IT. SEE IT. NOW." };
/** The attribute that names, in vite dev, the source location each element was written at. */
const SOURCE_ATTRIBUTE = "data-iterbar-src";
/** Where each app writes its default hero and its pricing table: `<project-relative path>:<line>:<column>`. */
const SOURCES: Record<string, { hero: string; pricing: string }> = {
  "vite-react": { hero: "src/App.tsx:4:10", pricing: "src/App.tsx:13:5" },
  sveltekit: { hero: "src/lib/CalmHero.svelte:1:1", pricing: "src/routes/+page.svelte:9:3" },
};

async function readDaemonFile(app: ExampleApp): Promise<DaemonInfo | null> {
  try {
    const text = await readFile(iterbarPaths(await projectRoot(app)).daemonFile, "utf8");
    return parseMessage(daemonInfoSchema, JSON.parse(text), "daemon info");
  } catch {
    return null;
  }
}

async function daemonSlots(info: DaemonInfo): Promise<{ pageUrl: string; slots: { slot: string; activeVersion: string }[] }[]> {
  const response = await fetch(`http://${info.host}:${info.port}/slots`, { headers: { authorization: bearerAuthorization(info.token) } });
  expect(response.status).toBe(200);
  return ((await response.json()) as { pages: { pageUrl: string; slots: { slot: string; activeVersion: string }[] }[] }).pages;
}

const bar = (page: Page, selector: string) => page.locator("iterbar-bar").locator(selector);

/** Chooses a version through the bar and waits until the page shows it. */
async function switchSlot(page: Page, slot: string, version: string): Promise<void> {
  await bar(page, "[data-role=slot-select]").selectOption(slot);
  await bar(page, `[data-version="${version}"]`).click();
  await expect(bar(page, `[data-version="${version}"]`)).toHaveAttribute("aria-pressed", "true");
}

for (const app of APPS) {
  test.describe(app.name, () => {
    test("in vite dev the plugin starts the daemon, and its bar connects and switches both slots", async ({ page }) => {
      const before = await readDaemonFile(app);
      expect(before, "no daemon may already run for the example").toBeNull();
      // Vite closes itself on SIGTERM; on Ctrl+C (SIGINT) the plugin shuts its daemon down. Each app covers one.
      const stopSignal: NodeJS.Signals = app.name === "vite-react" ? "SIGINT" : "SIGTERM";
      const dev = await startVite(app, "dev");
      try {
        await page.goto(`${dev.origin}/`);
        await expect(page.locator("iterbar-bar")).toHaveCount(1);
        await expect(bar(page, "[data-role=status]")).toHaveText("Connected", { timeout: 20_000 });

        // The plugin started the daemon in the dev server's process, for this project.
        const info = await readDaemonFile(app);
        expect(info).toMatchObject({ pid: dev.pid, projectRoot: await projectRoot(app) });
        expect(await page.evaluate(() => (document.querySelector("iterbar-bar") as unknown as { daemonUrl: string }).daemonUrl))
          .toBe(`http://${info?.host}:${info?.port}`);

        await expect(page.locator("#hero")).toHaveText(HERO.calm);
        await expect(page.locator("table#pricing")).toBeVisible();
        // Each element names where it was written; a component (the Variants slot) adds no element of its own.
        await expect(page.locator("#hero")).toHaveAttribute(SOURCE_ATTRIBUTE, SOURCES[app.name]!.hero);
        await expect(page.locator("table#pricing")).toHaveAttribute(SOURCE_ATTRIBUTE, SOURCES[app.name]!.pricing);
        await switchSlot(page, "hero", "bold");
        await expect(page.locator("#hero")).toHaveText(HERO.bold);
        await switchSlot(page, "pricing", "cards");
        await expect(page.locator("ul#pricing")).toBeVisible();
        await expect(page.locator("table#pricing")).toHaveCount(0);

        // The dev server does not serve the store, which holds daemon.json with the token, to any page.
        const store = await page.request.get(`${dev.origin}/.iterbar/daemon.json`, { headers: { origin: "http://localhost:3000" } });
        expect(store.status()).toBe(404);
        expect(await store.text()).not.toContain(info?.token);

        // The bar reached the daemon with the token it was given.
        await expect.poll(async () => (await daemonSlots(info as DaemonInfo)).flatMap((entry) => entry.slots)
          .map(({ slot, activeVersion }) => `${slot}:${activeVersion}`).sort((a, b) => a.localeCompare(b))).toEqual(["hero:bold", "pricing:cards"]);
      } finally {
        await dev.stop(stopSignal);
      }
      // Stopping the dev server stops the daemon it started, which removes daemon.json and releases the store.
      expect(await readDaemonFile(app)).toBeNull();
      await expect(access(iterbarPaths(await projectRoot(app)).lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("in vite dev the plugin reuses a running daemon of the same project and leaves it running", async ({ page }) => {
      const daemon = await startDaemon({ projectRoot: await projectRoot(app) });
      try {
        const dev = await startVite(app, "dev");
        try {
          await page.goto(`${dev.origin}/`);
          await expect(bar(page, "[data-role=status]")).toHaveText("Connected", { timeout: 20_000 });
          expect(await page.evaluate(() => (document.querySelector("iterbar-bar") as unknown as { daemonUrl: string }).daemonUrl))
            .toBe(daemon.url);
          await switchSlot(page, "hero", "bold");
          await expect(page.locator("#hero")).toHaveText(HERO.bold);
          // The bar reports slots shortly after a change, to the daemon that was already running.
          await expect.poll(async () => (await daemonSlots(daemon.info)).flatMap((entry) => entry.slots)
            .some(({ slot, activeVersion }) => slot === "hero" && activeVersion === "bold")).toBe(true);
        } finally {
          await dev.stop();
        }
        expect(await readDaemonFile(app)).toEqual(daemon.info);
        expect((await daemonSlots(daemon.info)).length).toBeGreaterThan(0);
      } finally {
        await daemon.close();
      }
    });

    test("a production build and its preview contain no Iterbar runtime", async ({ page }) => {
      // The markers are real: the bar's and the plugin's code contain them, so the bundle grep below would find them.
      const pluginEntry = createRequire(`${app.directory}/package.json`).resolve("@iterbar/vite");
      const barCode = await readFile(createRequire(pluginEntry).resolve("@iterbar/bar"), "utf8");
      for (const marker of BAR_MARKERS) expect(barCode).toContain(marker);
      const pluginCode = await readFile(pluginEntry, "utf8");
      for (const marker of CLIENT_MARKERS) expect(pluginCode).toContain(marker);

      await buildApp(app);
      const output = await readTree(app.outputDirectory);
      expect(output.size).toBeGreaterThan(0);
      for (const [file, text] of output) {
        for (const marker of [...BAR_MARKERS, ...CLIENT_MARKERS, SOURCE_ATTRIBUTE]) {
          expect(text.includes(marker), `${file} contains ${JSON.stringify(marker)}`).toBe(false);
        }
      }

      const preview = await startVite(app, "preview");
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));
      try {
        await page.goto(`${preview.origin}/`);
        await page.waitForLoadState("networkidle");
        await expect(page.locator("#hero")).toHaveText(HERO.calm);
        await expect(page.locator("table#pricing")).toBeVisible();
        expect(await page.locator("iterbar-bar").count()).toBe(0);
        expect(await page.locator(`[${SOURCE_ATTRIBUTE}]`).count()).toBe(0);
        expect(await page.evaluate(() => customElements.get("iterbar-bar") === undefined && !("__ITERBAR__" in window))).toBe(true);
        expect(requests.filter((url) => url.includes("iterbar"))).toEqual([]);
      } finally {
        await preview.stop();
      }
    });
  });
}
