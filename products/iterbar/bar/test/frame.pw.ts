import type { Locator, Page } from "@playwright/test";
import { fakeDaemon, type FakeDaemon } from "./support/fake-daemon.js";
import { expect, inBar, mountBar, test } from "./support/fixtures.js";
import { darkPixels, pngSize } from "./support/png.js";

// Screenshot framing with scrollbars that take room, as on Linux; the page's scrollbar style gives them a width on
// macOS too. The option forces its own browser, so these tests have their own file.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

/** Picks `target` near its top-left corner in comment mode and sends a comment; resolves with what the daemon received. */
async function comment(page: Page, daemon: FakeDaemon, target: Locator, text: string): Promise<FakeDaemon["posts"][number]> {
  const before = daemon.posts.length;
  await inBar(page, "[data-role=comment]").click();
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "true");
  await target.click({ position: { x: 3, y: 3 } });
  await inBar(page, "[data-role=composer-text]").fill(text);
  await inBar(page, "[data-role=composer-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(before + 1);
  return daemon.posts[before]!;
}

test("frames a scroll container's whole border box, its scrollbars included, and an inline box at its rendered size", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  const text = "font: 20px/24px monospace; background: #fff; color: #000";
  await page.evaluate((text) => document.querySelector("main")!.insertAdjacentHTML("afterbegin", `
    <style>.bars::-webkit-scrollbar { width: 15px; height: 15px; background: #ccc }</style>
    <div data-testid="y" class="bars" style="width: 100px; height: 24px; overflow-y: scroll; ${text}">ABC DE</div>
    <div data-testid="y-plain" style="width: 100px; height: 24px; overflow: hidden; ${text}">ABC DE</div>
    <div data-testid="x" class="bars" style="width: 100px; height: 40px; overflow-x: scroll; ${text}">AB</div>
    <div data-testid="x-plain" style="width: 100px; height: 40px; overflow: hidden; ${text}">AB</div>
    <div data-testid="y-border-box" class="bars" style="box-sizing: border-box; width: 100.5px; height: 24px; border: 2px solid #000; overflow-y: scroll; ${text}">AB</div>
    <span data-testid="inline" style="width: 300px; height: 80px; ${text}">Hi</span>`), text);
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  const gutter = await page.getByTestId("y").evaluate((element) => (element as HTMLElement).offsetWidth - element.clientWidth);
  expect(gutter).toBe(15);

  for (const [id, plain, size] of [["y", "y-plain", { width: 100, height: 24 }], ["x", "x-plain", { width: 100, height: 40 }]] as const) {
    const reference = (await comment(page, daemon, page.getByTestId(plain), plain)).screenshot!;
    const { draft, screenshot } = await comment(page, daemon, page.getByTestId(id), id);
    expect(draft.screenshotUnavailableReason, id).toBeNull();
    expect(pngSize(screenshot!), id).toEqual(size);
    const text = await darkPixels(page, reference);
    expect(text, plain).toBeGreaterThan(50);
    expect(Math.abs(await darkPixels(page, screenshot!) - text) / text, id).toBeLessThan(0.05);
  }
  // A border-box size already holds the scrollbar.
  expect(pngSize((await comment(page, daemon, page.getByTestId("y-border-box"), "Border box")).screenshot!)).toEqual({ width: 100, height: 24 });

  // An inline box's width and height do not apply: it is framed at its box on screen.
  const box = await page.getByTestId("inline").evaluate((element) => element.getBoundingClientRect());
  const inline = await comment(page, daemon, page.getByTestId("inline"), "Inline");
  expect(inline.draft.screenshotUnavailableReason).toBeNull();
  expect(pngSize(inline.screenshot!)).toEqual({ width: Math.floor(box.width), height: Math.floor(box.height) });
  expect(box.width).toBeLessThan(100);
});
