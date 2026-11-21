import { fakeDaemon, comment } from "./support/fake-daemon.js";
import { expect, inBar, mountBar, openPanel, test } from "./support/fixtures.js";

// The docked toolbar: asleep by default at the bottom centre, docked left, centre or right, with its state remembered.

test("sleeps as a compact pill at the bottom centre and wakes on hover and focus", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("One open"), comment("Done one", { status: "done" })]);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await expect(inBar(page, "[data-role=status]")).toHaveText("Connected");
  const toolbar = inBar(page, ".toolbar");
  const viewport = page.viewportSize()!;

  // Asleep: the comment and inbox buttons and the open count, nothing else.
  await expect(inBar(page, "[data-role=comment]")).toBeVisible();
  await expect(inBar(page, "[data-role=inbox-toggle]")).toBeVisible();
  await expect(inBar(page, "[data-role=open-count]")).toHaveText("1");
  for (const role of ["versions-toggle", "drafts-toggle", "dock", "toggle"]) await expect(inBar(page, `[data-role=${role}]`)).toBeHidden();
  const asleep = (await toolbar.boundingBox())!;
  expect(asleep.y + asleep.height).toBeCloseTo(viewport.height - 12, 0);
  expect(asleep.x + asleep.width / 2).toBeCloseTo(viewport.width / 2, 0);
  expect(asleep.width).toBeLessThan(200);

  // Hover wakes it in place: whichever sleeping button is under the pointer stays there, at every dock.
  const roleAt = (x: number, y: number) => page.evaluate(({ x, y }) => {
    const root = document.querySelector("iterbar-bar")!.shadowRoot!;
    return (root.elementFromPoint(x, y)?.closest("[data-role]") as HTMLElement | null)?.dataset.role;
  }, { x, y });
  for (const dock of ["center", "left", "right", "narrow", "narrow-right"] as const) {
    if (dock !== "center") {
      // Narrow: centred, but too narrow for the woken toolbar beside the pill, so the rest wraps above it.
      if (dock === "narrow") await page.setViewportSize({ width: 360, height: 700 });
      if (dock === "narrow-right") await page.setViewportSize({ width: 280, height: 700 });
      const stored = { narrow: "center", "narrow-right": "right" }[dock as string] ?? dock;
      await page.evaluate((value) => localStorage.setItem(window.fixture.BAR_STATE_STORAGE_KEY, JSON.stringify({ dock: value })), stored);
      await openFixture();
      await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
      await expect(inBar(page, "[data-role=open-count]")).toHaveText("1");
    }
    for (const role of ["comment", "inbox-toggle"]) {
      await page.mouse.move(5, 5);
      await expect(inBar(page, "[data-role=versions-toggle]")).toBeHidden();
      const box = (await inBar(page, `[data-role=${role}]`).boundingBox())!;
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(point.x, point.y);
      await expect(inBar(page, "[data-role=versions-toggle]")).toBeVisible();
      expect(await roleAt(point.x, point.y), `${role} at the ${dock} dock`).toBe(role);
    }
  }
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.evaluate(() => localStorage.removeItem(window.fixture.BAR_STATE_STORAGE_KEY));
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await toolbar.hover();
  await expect(inBar(page, "[data-role=versions-toggle]")).toBeVisible();
  const awake = (await toolbar.boundingBox())!;
  expect(awake.width).toBeGreaterThan(asleep.width);
  expect(awake.x + awake.width).toBeLessThanOrEqual(viewport.width - 12 + 0.5);
  await page.mouse.move(5, 5);
  await expect(inBar(page, "[data-role=versions-toggle]")).toBeHidden();

  // Focus wakes it too.
  await inBar(page, "[data-role=comment]").focus();
  await expect(inBar(page, "[data-role=versions-toggle]")).toBeVisible();
});

test("docks left, centre or right, opens panels upward, and remembers the state for the origin", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("Thread")]);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  const toolbar = inBar(page, ".toolbar");
  const viewport = page.viewportSize()!;

  await toolbar.hover();
  await inBar(page, "[data-role=dock]").click();
  await expect(inBar(page, ".dock")).toHaveAttribute("data-dock", "right");
  await expect.poll(async () => {
    const box = (await toolbar.boundingBox())!;
    return Math.round(box.x + box.width);
  }).toBe(viewport.width - 12);
  await inBar(page, "[data-role=dock]").click();
  await expect(inBar(page, ".dock")).toHaveAttribute("data-dock", "left");
  await expect.poll(async () => (await toolbar.boundingBox())!.x).toBe(12);

  // The inbox opens above the toolbar, along the same edge, without covering it.
  await openPanel(page, "inbox");
  const panel = (await inBar(page, "[data-role=panel]").boundingBox())!;
  const bar = (await toolbar.boundingBox())!;
  expect(panel.y + panel.height).toBeLessThanOrEqual(bar.y);
  expect(panel.x).toBe(12);
  await expect(inBar(page, "[data-role=panel] h2").first()).toHaveText("Inbox");

  // Pinned open and reloaded: the dock, the pin and the open panel come back.
  await inBar(page, "[data-role=toggle]").click();
  await expect(inBar(page, "[data-role=toggle]")).toHaveAttribute("aria-expanded", "true");
  const stored = await page.evaluate(() => localStorage.getItem(window.fixture.BAR_STATE_STORAGE_KEY));
  expect(JSON.parse(stored!)).toEqual({ dock: "left", expanded: true, panel: "inbox", filter: "all" });
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await expect(inBar(page, ".dock")).toHaveAttribute("data-dock", "left");
  await expect(inBar(page, "[data-role=panel]")).toBeVisible();
  await expect(inBar(page, "[data-role=dock]")).toBeVisible();
  await expect(inBar(page, ".thread")).toHaveCount(1);
});

test("applies an expanded property set before the element was defined, over the saved state", async ({ page, openFixture }) => {
  await openFixture();
  await page.evaluate(() => {
    localStorage.setItem(window.fixture.BAR_STATE_STORAGE_KEY, JSON.stringify({ expanded: false }));
    const bar = document.createElement("iterbar-bar") as HTMLElement & { expanded: boolean };
    bar.expanded = true;
    document.body.append(bar);
    window.fixture.defineIterbarBar();
  });
  await expect(inBar(page, ".dock")).toHaveAttribute("data-expanded", "");
  await expect(inBar(page, "[data-role=dock]")).toBeVisible();
  // The earlier `collapsed` property still works, as the opposite of `expanded`.
  await page.evaluate(() => {
    (document.querySelector("iterbar-bar") as HTMLElement & { collapsed: boolean }).collapsed = true;
  });
  await expect(inBar(page, ".dock")).not.toHaveAttribute("data-expanded", "");
  expect(await page.evaluate(() => localStorage.getItem(window.fixture.BAR_STATE_STORAGE_KEY))).toContain('"expanded":false');
});

test("fits a narrow screen asleep, awake and with a panel open", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("A rather long comment ".repeat(20))]);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  for (const width of [1280, 320, 280]) {
    await page.setViewportSize({ width, height: 568 });
    const inside = async () => {
      for (const selector of [".toolbar", ".toolbar > :not([hidden])", "[data-role=panel]:not([hidden])"]) {
        for (const element of await inBar(page, selector).all()) {
          const box = await element.boundingBox();
          if (!box) continue;
          expect(box.x, selector).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width, selector).toBeLessThanOrEqual(width + 0.5);
        }
      }
    };
    await inside();
    await inBar(page, "[data-role=comment]").focus();
    await inside();
    await openPanel(page, "inbox");
    await inside();
    // A long comment wraps inside the panel rather than overflowing it.
    const text = (await inBar(page, ".thread-text").boundingBox())!;
    const panel = (await inBar(page, "[data-role=panel]").boundingBox())!;
    expect(text.x + text.width).toBeLessThanOrEqual(panel.x + panel.width);
    await inBar(page, "[data-role=panel-close]").click();
  }
});

test("ignores a corrupt stored state and keeps working without storage", async ({ page, openFixture }) => {
  await openFixture();
  await page.evaluate(() => localStorage.setItem(window.fixture.BAR_STATE_STORAGE_KEY, "{corrupt"));
  await mountBar(page);
  await expect(inBar(page, ".dock")).toHaveAttribute("data-dock", "center");
  await page.evaluate(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => { throw new DOMException("denied", "SecurityError"); } });
  });
  await inBar(page, ".toolbar").hover();
  await inBar(page, "[data-role=toggle]").click();
  await expect(inBar(page, ".dock")).toHaveAttribute("data-expanded", "");
});

test("a panel opened from a woken toolbar on a narrow screen stays on screen", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("Thread")]);
  await page.setViewportSize({ width: 360, height: 700 });
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  const inbox = (await inBar(page, "[data-role=inbox-toggle]").boundingBox())!;
  // The pointer stays on the toolbar throughout.
  await page.mouse.move(inbox.x + inbox.width / 2, inbox.y + inbox.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(inBar(page, "[data-role=panel]")).toBeVisible();
  const panel = (await inBar(page, "[data-role=panel]").boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(360);
});

test("a tap on a page control that stops the event still ends a wake begun by a tap", async ({ browser, fixtureServer }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  try {
    await page.goto(fixtureServer.origin);
    await page.waitForFunction(() => window.fixture !== undefined);
    await page.evaluate(() => document.getElementById("page-button")!.addEventListener("pointerdown", (event) => event.stopPropagation()));
    await mountBar(page);
    await inBar(page, "[data-role=status-dot]").tap();
    await expect(inBar(page, "[data-role=toggle]")).toBeVisible();
    await page.locator("#page-button").tap();
    await expect(inBar(page, "[data-role=toggle]")).toBeHidden();
  } finally {
    await context.close();
  }
});

test("the warning dot on a sleeping Inbox does not change its size", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [], { socket: false });
  await openFixture();
  await page.evaluate(() => localStorage.setItem(window.fixture.BAR_STATE_STORAGE_KEY, JSON.stringify({ dock: "right" })));
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await expect(inBar(page, "[data-role=status]")).toHaveText("Reconnecting…");
  const asleep = (await inBar(page, "[data-role=inbox-toggle]").boundingBox())!;
  await page.mouse.move(asleep.x + 3, asleep.y + asleep.height / 2);
  await expect(inBar(page, "[data-role=versions-toggle]")).toBeVisible();
  expect(await inBar(page, "[data-role=inbox-toggle]").boundingBox()).toEqual(asleep);
});

test("a tap on a bar inside a closed shadow root keeps it awake", async ({ browser, fixtureServer }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  try {
    await page.goto(fixtureServer.origin);
    await page.waitForFunction(() => window.fixture !== undefined);
    const box = await page.evaluate(() => {
      window.fixture.defineIterbarBar();
      const host = document.createElement("div");
      const bar = document.createElement("iterbar-bar");
      host.attachShadow({ mode: "closed" }).append(bar);
      document.body.append(host);
      (window as unknown as { closedBar: Element }).closedBar = bar;
      const rect = bar.shadowRoot!.querySelector("[data-role=status-dot]")!.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.touchscreen.tap(box.x, box.y);
    // The finger has lifted and the toolbar is still awake: its pin shows.
    await expect.poll(() => page.evaluate(() => {
      const bar = (window as unknown as { closedBar: Element }).closedBar;
      return getComputedStyle(bar.shadowRoot!.querySelector("[data-role=toggle]")!).display;
    })).not.toBe("none");
  } finally {
    await context.close();
  }
});

test("a press outside followed at once by one inside leaves the toolbar awake", async ({ page, openFixture }) => {
  await openFixture();
  await mountBar(page);
  // Both presses are dispatched before either one's decision runs.
  const awake = await page.evaluate(async () => {
    const bar = document.querySelector("iterbar-bar")!;
    const dot = bar.shadowRoot!.querySelector("[data-role=status-dot]")!;
    const dock = bar.shadowRoot!.querySelector(".dock")!;
    document.getElementById("page-text")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, pointerType: "touch" }));
    dot.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "touch" }));
    bar.shadowRoot!.querySelector(".toolbar")!.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "touch" }));
    dot.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, pointerType: "touch" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return dock.hasAttribute("data-hovered");
  });
  expect(awake).toBe(true);
});

test("a tap wakes the sleeping toolbar until the next tap elsewhere", async ({ browser, fixtureServer }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  try {
    await page.goto(fixtureServer.origin);
    await page.waitForFunction(() => window.fixture !== undefined);
    await mountBar(page);
    await expect(inBar(page, "[data-role=toggle]")).toBeHidden();
    await inBar(page, "[data-role=status-dot]").tap();
    // The finger has lifted, and the toolbar stays awake: its pin is there to tap.
    await expect(inBar(page, "[data-role=toggle]")).toBeVisible();
    await inBar(page, "[data-role=toggle]").tap();
    await expect(inBar(page, "[data-role=toggle]")).toHaveAttribute("aria-expanded", "true");
    await inBar(page, "[data-role=toggle]").tap();
    await page.locator("#page-text").tap();
    await expect(inBar(page, "[data-role=toggle]")).toBeHidden();
  } finally {
    await context.close();
  }
});
