import { SCHEMA_VERSION } from "@iterbar/core";
import { comment, fakeDaemon } from "./support/fake-daemon.js";
import { expect, inBar, mountBar, test } from "./support/fixtures.js";

// Comment pins: a pin on the element of each unfinished thread on this page.

const target = (selector: string) => ({ selector, textExcerpt: "", boundingBox: { x: 0, y: 0, width: 1, height: 1 }, sourceLocation: null });
const pins = (page: import("@playwright/test").Page) => inBar(page, "[data-role=pin]:not([hidden])");

test("pins unfinished threads on their elements, follows them, and opens the thread on click", async ({ page, openFixture, fixtureServer }) => {
  const here = `${fixtureServer.origin}/`;
  const open = comment("On the text", { pageUrl: here, target: target("#page-text") });
  const second = comment("Also the text", { pageUrl: here, target: target("#page-text"), status: "working" });
  const done = comment("Done already", { pageUrl: here, target: target("#page-heading"), status: "done" });
  const elsewhere = comment("Another page", { pageUrl: `${fixtureServer.origin}/other`, target: target("#page-button") });
  const gone = comment("Element gone", { pageUrl: here, target: target("#nothing-here") });
  const daemon = await fakeDaemon(page, fixtureServer.origin, [open, second, done, elsewhere, gone]);
  await openFixture();
  await page.evaluate(() => { document.getElementById("page-text")!.style.width = "300px"; });
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, expanded: false });

  // One pin for the two unfinished threads on #page-text, none for the done one, the other page or the missing element.
  await expect(pins(page)).toHaveCount(1);
  await expect(pins(page).locator(".pin-count")).toHaveText("2");
  const text = (await page.locator("#page-text").boundingBox())!;
  const pin = (await pins(page).boundingBox())!;
  expect(pin.x + pin.width / 2).toBeCloseTo(text.x + text.width, 0);
  expect(pin.y + pin.height / 2).toBeCloseTo(text.y, 0);

  // A pin on an element that reaches the screen's edge stays on screen.
  await page.evaluate(() => { document.getElementById("page-text")!.style.width = ""; });
  await expect.poll(async () => Math.round((await pins(page).boundingBox())!.x + 22)).toBeLessThanOrEqual(page.viewportSize()!.width);
  // It follows its element when the page moves it.
  await page.evaluate(() => { document.getElementById("page-text")!.style.marginTop = "120px"; });
  await expect.poll(async () => Math.round((await pins(page).boundingBox())!.y + 11)).toBe(Math.round((await page.locator("#page-text").boundingBox())!.y));
  // It hides while its element is hidden, and comes back.
  await page.evaluate(() => { document.getElementById("page-text")!.hidden = true; });
  await expect(pins(page)).toHaveCount(0);
  await page.evaluate(() => { document.getElementById("page-text")!.hidden = false; });
  await expect(pins(page)).toHaveCount(1);

  // A click opens the inbox at the newest of its threads.
  await pins(page).click();
  await expect(inBar(page, "[data-role=panel]")).toBeVisible();
  await expect(inBar(page, `[data-feedback-id="${second.id}"] details`)).toHaveAttribute("open", "");

  // Done threads lose their pins.
  for (const item of [open, second]) {
    daemon.send({ schemaVersion: SCHEMA_VERSION, type: "feedback.updated", feedback: { ...item, status: "done", updatedAt: new Date(Date.parse(item.updatedAt) + 1000).toISOString() } });
  }
  await expect(pins(page)).toHaveCount(0);

  // An element that appears later gets its pin (with the inbox closed: an open sheet keeps pins off its area).
  await inBar(page, "[data-role=panel-close]").click();
  daemon.send({ schemaVersion: SCHEMA_VERSION, type: "feedback.updated", feedback: { ...gone, replies: [], updatedAt: new Date(Date.parse(gone.updatedAt) + 1000).toISOString() } });
  await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("beforeend", '<p id="nothing-here" style="width: 300px">Now here</p>'));
  await expect(pins(page)).toHaveCount(1);
});

test("pins never sit on the toolbar or an open sheet, and closing a sheet opened from a pin focuses the logo", async ({ page, openFixture, fixtureServer }) => {
  const here = `${fixtureServer.origin}/`;
  // A full-width element: its pin is at the right edge, where the sheet opens.
  const item = comment("On the heading", { pageUrl: here, target: target("#page-heading") });
  const daemon = await fakeDaemon(page, fixtureServer.origin, [item]);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, expanded: false });
  await expect(pins(page)).toHaveCount(1);
  await pins(page).click();
  await expect(inBar(page, "[data-role=panel]")).toBeVisible();
  // The sheet covers the pin's place: the pin hides rather than paint over the sheet.
  await expect(pins(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(inBar(page, "[data-role=panel]")).toBeHidden();
  await expect(inBar(page, "[data-role=logo]")).toBeFocused();
  await expect(pins(page)).toHaveCount(1);
});
