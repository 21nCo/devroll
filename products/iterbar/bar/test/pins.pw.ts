import { SCHEMA_VERSION } from "@iterbar/core";
import { comment, fakeDaemon } from "./support/fake-daemon.js";
import { expect, inBar, mountBar, PRICING, registerSlots, test } from "./support/fixtures.js";

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

test("threads whose different selectors find the same element share one pin", async ({ page, openFixture, fixtureServer }) => {
  const here = `${fixtureServer.origin}/`;
  const byId = comment("By id", { pageUrl: here, target: target("#page-text") });
  const byPath = comment("By path", { pageUrl: here, target: target("main > p") });
  const daemon = await fakeDaemon(page, fixtureServer.origin, [byId, byPath]);
  await openFixture();
  await page.evaluate(() => { document.getElementById("page-text")!.style.width = "300px"; });
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, expanded: false });
  await expect(pins(page)).toHaveCount(1);
  await expect(pins(page).locator(".pin-count")).toHaveText("2");
});

test("a pin hides while its element is scrolled out of a scrolling box, and survives the bar being put back", async ({ page, openFixture, fixtureServer }) => {
  const here = `${fixtureServer.origin}/`;
  const item = comment("In the list", { pageUrl: here, target: target("#row-30") });
  const daemon = await fakeDaemon(page, fixtureServer.origin, [item]);
  await openFixture();
  await page.evaluate(() => {
    const rows = Array.from({ length: 40 }, (_, index) => `<p id="row-${index}" style="margin: 0; height: 20px; width: 200px">Row ${index}</p>`).join("");
    document.querySelector("main")!.insertAdjacentHTML("afterbegin", `<div id="scroller" style="height: 100px; width: 260px; overflow: auto">${rows}</div>`);
  });
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, expanded: false });
  await expect(inBar(page, "[data-role=pin]")).toHaveCount(1);
  await expect(pins(page)).toHaveCount(0);
  await page.evaluate(() => { document.getElementById("row-30")!.scrollIntoView({ block: "center" }); });
  await expect(pins(page)).toHaveCount(1);
  await page.evaluate(() => {
    const bar = document.querySelector("iterbar-bar")!;
    bar.remove();
    document.body.append(bar);
  });
  await expect(pins(page)).toHaveCount(1);
  await page.evaluate(() => { document.getElementById("row-30")!.style.height = "60px"; document.getElementById("row-30")!.scrollIntoView({ block: "center" }); });
  await expect.poll(async () => Math.round((await pins(page).boundingBox())!.y + 11)).toBe(Math.round((await page.locator("#row-30").boundingBox())!.y));
});

test("a fixed element is clipped only by the box it is fixed to", async ({ page, openFixture, fixtureServer }) => {
  const here = `${fixtureServer.origin}/`;
  const free = comment("Free", { pageUrl: here, target: target("#free-fixed") });
  const held = comment("Held", { pageUrl: here, target: target("#held-fixed") });
  const daemon = await fakeDaemon(page, fixtureServer.origin, [free, held]);
  await openFixture();
  await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("afterbegin", `
    <div style="height: 40px; overflow: hidden"><p id="free-fixed" style="position: fixed; top: 200px; left: 40px; width: 120px; margin: 0">Free</p></div>
    <div style="height: 40px; overflow: hidden; transform: translateZ(0)"><p id="held-fixed" style="position: fixed; top: 200px; left: 300px; width: 120px; margin: 0">Held</p></div>`));
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, expanded: false });
  // The untransformed box does not clip its fixed child; the transformed one holds it and clips it.
  await expect(inBar(page, `[data-role=pin][data-feedback-ids="${free.id}"]:not([hidden])`)).toHaveCount(1);
  await expect(inBar(page, `[data-role=pin][data-feedback-ids="${held.id}"]:not([hidden])`)).toHaveCount(0);
});

test("an absolute element escapes a static clipping box, and a body that only scrolls the page clips nothing", async ({ page, openFixture, fixtureServer }) => {
  const here = `${fixtureServer.origin}/`;
  const popover = comment("Popover", { pageUrl: here, target: target("#popover") });
  const far = comment("Far down", { pageUrl: here, target: target("#far") });
  const daemon = await fakeDaemon(page, fixtureServer.origin, [popover, far]);
  await openFixture();
  await page.evaluate(() => {
    document.documentElement.style.height = "100%";
    Object.assign(document.body.style, { height: "100%", overflowX: "hidden" });
    document.querySelector("main")!.insertAdjacentHTML("afterbegin", `
      <div style="position: relative">
        <div style="height: 20px; overflow: hidden"><p id="popover" style="position: absolute; top: 60px; left: 20px; width: 120px; margin: 0">Popover</p></div>
      </div>
      <div style="height: 1500px"></div><p id="far" style="width: 200px">Far down</p>`);
  });
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, expanded: false });
  await expect(inBar(page, `[data-role=pin][data-feedback-ids="${popover.id}"]:not([hidden])`)).toHaveCount(1);
  await page.evaluate(() => document.getElementById("far")!.scrollIntoView({ block: "center" }));
  await expect(inBar(page, `[data-role=pin][data-feedback-ids="${far.id}"]:not([hidden])`)).toHaveCount(1);
});

test("a wrapper with display: contents clips nothing", async ({ page, openFixture, fixtureServer }) => {
  const here = `${fixtureServer.origin}/`;
  const item = comment("Inside contents", { pageUrl: here, target: target("#in-contents") });
  const daemon = await fakeDaemon(page, fixtureServer.origin, [item]);
  await openFixture();
  await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("afterbegin", '<div style="display: contents; overflow: hidden"><p id="in-contents" style="width: 200px">Inside</p></div>'));
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, expanded: false });
  await expect(pins(page)).toHaveCount(1);
});

test("a thread made on one variant of a slot pins only while that variant shows, even when variants share a selector", async ({ page, openFixture, fixtureServer }) => {
  const here = `${fixtureServer.origin}/`;
  const onV1 = comment("On v1", { pageUrl: here, target: target("#shared"), activeVariants: [{ slot: "pricing", variant: "v1" }] });
  const onV2 = comment("On v2", { pageUrl: here, target: target("#shared"), activeVariants: [{ slot: "pricing", variant: "v2" }] });
  const daemon = await fakeDaemon(page, fixtureServer.origin, [onV1, onV2]);
  await openFixture();
  await page.evaluate(() => {
    const slot = document.createElement("div");
    slot.setAttribute("data-iterbar-slot", "pricing");
    slot.innerHTML = '<p id="shared" style="width: 200px">Variant text</p>';
    document.body.prepend(slot);
  });
  await registerSlots(page, [PRICING]);
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, expanded: false });
  await expect(pins(page)).toHaveCount(1);
  await expect(pins(page).locator(".pin-count")).toBeHidden();
  await pins(page).click();
  await expect(inBar(page, `[data-feedback-id="${onV1.id}"] details`)).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  // Switched to v2 (the element keeps its selector): the pin is now v2's thread.
  await page.evaluate(() => (window as unknown as { __ITERBAR__: { select(selection: unknown): void } }).__ITERBAR__.select({ schemaVersion: 2, slot: "pricing", variant: "v2" }));
  await expect(pins(page)).toHaveCount(1);
  await pins(page).click();
  await expect(inBar(page, `[data-feedback-id="${onV2.id}"] details`)).toHaveAttribute("open", "");
});

test("a thread inside a nested slot keeps its pin only while the outer slot shows its recorded variant too", async ({ page, openFixture, fixtureServer }) => {
  const here = `${fixtureServer.origin}/`;
  const made = comment("On the inner CTA", {
    pageUrl: here, target: target("#cta"),
    activeVariants: [{ slot: "pricing", variant: "v1" }, { slot: "hero", variant: "a" }],
  });
  const daemon = await fakeDaemon(page, fixtureServer.origin, [made]);
  await openFixture();
  await page.evaluate(() => {
    const outer = document.createElement("div");
    outer.setAttribute("data-iterbar-slot", "pricing");
    outer.innerHTML = '<div data-iterbar-slot="hero"><button id="cta" style="width: 120px">Buy</button></div>';
    document.body.prepend(outer);
  });
  await registerSlots(page, [PRICING, { slot: "hero", variants: ["a", "b"], defaultVariant: "a" }]);
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, expanded: false });
  await expect(pins(page)).toHaveCount(1);
  // The outer slot switches; the inner one (same name, same variant, same selector) still shows "a".
  await page.evaluate(() => (window as unknown as { __ITERBAR__: { select(selection: unknown): void } }).__ITERBAR__.select({ schemaVersion: 2, slot: "pricing", variant: "v2" }));
  await expect(pins(page)).toHaveCount(0);
});
