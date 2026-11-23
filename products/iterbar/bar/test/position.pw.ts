import { fakeDaemon, comment } from "./support/fake-daemon.js";
import { expect, inBar, mountBar, openPanel, test } from "./support/fixtures.js";

/**
 * A finger on the sleeping toolbar's own surface, as touch pointer events. Every part of the sleeping pill is a button
 * (and Chrome moves a tap onto the nearest one), so a real tap would also press one.
 */
async function touchToolbar(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const toolbar = document.querySelector("iterbar-bar")!.shadowRoot!.querySelector(".toolbar")!;
    for (const type of ["pointerover", "pointerenter", "pointerdown", "pointerup", "pointerout", "pointerleave"]) {
      toolbar.dispatchEvent(new PointerEvent(type, { bubbles: !type.endsWith("enter") && !type.endsWith("leave"), composed: true, pointerType: "touch" }));
    }
  });
}

// The docked toolbar: asleep by default at the bottom centre, moved along the bottom edge with its grab handle, with its
// state remembered per project.

test("sleeps as a compact pill at the bottom centre and wakes on hover and focus", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("One open"), comment("Done one", { status: "done" })]);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await expect(inBar(page, "[data-role=status]")).toHaveText("Connected");
  const toolbar = inBar(page, ".toolbar");
  const viewport = page.viewportSize()!;

  // Asleep: the comment and inbox buttons, the open count and the connection's dot, nothing else.
  await expect(inBar(page, "[data-role=comment]")).toBeVisible();
  await expect(inBar(page, "[data-role=inbox-toggle]")).toBeVisible();
  await expect(inBar(page, "[data-role=status-dot]")).toBeVisible();
  await expect(inBar(page, "[data-role=open-count]")).toHaveText("1");
  for (const role of ["versions-toggle", "drafts-toggle", "grab", "toggle"]) await expect(inBar(page, `[data-role=${role}]`)).toBeHidden();
  const asleep = (await toolbar.boundingBox())!;
  // A gap below the toolbar: it never sits on the bottom edge.
  expect(asleep.y + asleep.height).toBeCloseTo(viewport.height - 20, 0);
  expect(asleep.x + asleep.width / 2).toBeCloseTo(viewport.width / 2, 0);
  expect(asleep.width).toBeLessThan(200);

  // Hover wakes it in place: whichever sleeping button is under the pointer stays there, wherever the toolbar sits
  // and the woken toolbar fits.
  const roleAt = (x: number, y: number) => page.evaluate(({ x, y }) => {
    const root = document.querySelector("iterbar-bar")!.shadowRoot!;
    return (root.elementFromPoint(x, y)?.closest("[data-role]") as HTMLElement | null)?.dataset.role;
  }, { x, y });
  for (const position of [0.5, 0, 0.3]) {
    if (position !== 0.5) {
      await page.evaluate((x) => localStorage.setItem(window.fixture.BAR_STATE_STORAGE_KEY, JSON.stringify({ x })), position);
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
      await expect(inBar(page, "[data-role=grab]")).toBeVisible();
      expect(await roleAt(point.x, point.y), `${role} at position ${position}`).toBe(role);
    }
  }
  // At the right edge, the woken toolbar moves left only as far as it needs to stay in view.
  await page.evaluate(() => localStorage.setItem(window.fixture.BAR_STATE_STORAGE_KEY, JSON.stringify({ x: 1 })));
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await page.mouse.move(5, 5);
  await inBar(page, "[data-role=comment]").hover();
  await expect(inBar(page, "[data-role=versions-toggle]")).toBeVisible();
  const right = (await toolbar.boundingBox())!;
  expect(right.x + right.width).toBeLessThanOrEqual(viewport.width - 12 + 0.5);

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

test("moves along the bottom edge by its grab handle, kept in view, and remembers the place per project", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("Thread")]);
  const project = "/work/shop";
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, project });
  const toolbar = inBar(page, ".toolbar");
  const viewport = page.viewportSize()!;

  // The grab handle shows at the toolbar's start once it wakes; there is no dock button any more.
  await expect(inBar(page, "[data-role=dock]")).toHaveCount(0);
  await inBar(page, "[data-role=comment]").hover();
  const grab = inBar(page, "[data-role=grab]");
  await expect(grab).toBeVisible();
  const handle = (await grab.boundingBox())!;
  expect(handle.x).toBeLessThan((await inBar(page, "[data-role=comment]").boundingBox())!.x);

  // Dragged left, it follows the pointer; dragged far past the left edge, it stops at the margin.
  const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  const before = (await toolbar.boundingBox())!;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 100, start.y, { steps: 5 });
  expect(Math.round((await toolbar.boundingBox())!.x)).toBe(Math.round(before.x - 100));
  await page.mouse.move(-500, start.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await toolbar.boundingBox())!.x)).toBe(12);
  await expect(grab).toHaveAttribute("aria-valuetext", "left");

  // And past the right edge, it stops at the right margin.
  await inBar(page, "[data-role=comment]").hover();
  const left = (await grab.boundingBox())!;
  await page.mouse.move(left.x + left.width / 2, left.y + left.height / 2);
  await page.mouse.down();
  await page.mouse.move(viewport.width + 400, left.y + left.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => {
    const box = (await toolbar.boundingBox())!;
    return Math.round(box.x + box.width);
  }).toBe(viewport.width - 12);
  await expect(grab).toHaveAttribute("aria-valuetext", "right");

  // The place is stored for the project, not for the whole origin.
  const stored = await page.evaluate((key) => localStorage.getItem(key), `${await page.evaluate(() => window.fixture.BAR_STATE_STORAGE_KEY)}:${project}`);
  expect(JSON.parse(stored!)).toMatchObject({ x: 1 });
  expect(await page.evaluate(() => localStorage.getItem(window.fixture.BAR_STATE_STORAGE_KEY))).toBeNull();

  // The inbox opens above the toolbar, along the same edge, without covering it.
  await openPanel(page, "inbox");
  const panel = (await inBar(page, "[data-role=panel]").boundingBox())!;
  const bar = (await toolbar.boundingBox())!;
  expect(panel.y + panel.height).toBeLessThanOrEqual(bar.y);
  expect(Math.round(panel.x + panel.width)).toBe(viewport.width - 12);
  await expect(inBar(page, "[data-role=panel] h2").first()).toHaveText("Inbox");

  // Pinned open and reloaded: the place, the pin and the open panel come back for the project.
  await inBar(page, "[data-role=toggle]").click();
  await expect(inBar(page, "[data-role=toggle]")).toHaveAttribute("aria-expanded", "true");
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, project });
  await expect(inBar(page, "[data-role=panel]")).toBeVisible();
  await expect(inBar(page, ".thread")).toHaveCount(1);
  await expect.poll(async () => {
    const box = (await toolbar.boundingBox())!;
    return Math.round(box.x + box.width);
  }).toBe(viewport.width - 12);

  // A narrower window keeps it in view.
  await page.setViewportSize({ width: 600, height: viewport.height });
  await expect.poll(async () => {
    const box = (await toolbar.boundingBox())!;
    return Math.round(box.x + box.width);
  }).toBe(600 - 12);
});

test("explains every toolbar control in a tooltip, the connection included, which opens Use with your agent", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, []);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, project: "/work/shop" });
  await expect(inBar(page, "[data-role=status]")).toHaveText("Connected");
  await inBar(page, "[data-role=comment]").hover();
  const tooltip = inBar(page, "[data-role=tooltip]");
  for (const [role, label] of [
    ["comment", "Comment"], ["inbox-toggle", "Inbox"], ["drafts-toggle", "Drafts"], ["status-button", "Connected"],
    ["versions-toggle", "Versions"], ["toggle", "Keep expanded"], ["grab", "Drag to move"],
  ] as const) {
    const control = inBar(page, `[data-role=${role}]`);
    await control.hover();
    await expect(tooltip, role).toBeVisible();
    await expect(tooltip.locator(".tooltip-label"), role).toContainText(label);
    // Every control has an accessible name of its own.
    expect(await control.getAttribute("aria-label"), role).toBeTruthy();
  }
  // The connection is one control, its dot next to its label, and its tooltip says what it is connected to.
  await inBar(page, "[data-role=status-button]").hover();
  await expect(tooltip).toContainText("Connected to Iterbar: comments are saved for your coding agent.");
  await expect(inBar(page, "[data-role=status-button]")).toHaveAttribute("aria-describedby", "iterbar-tooltip");
  const dot = (await inBar(page, "[data-role=status-dot]").boundingBox())!;
  const label = (await inBar(page, "[data-role=status]").boundingBox())!;
  expect(label.x - (dot.x + dot.width)).toBeLessThan(10);
  await page.mouse.move(5, 5);
  await expect(tooltip).toBeHidden();

  // Clicking it opens "Use with your agent", with the project's path in the setup commands and a prompt to copy.
  await inBar(page, "[data-role=comment]").hover();
  await inBar(page, "[data-role=status-button]").click();
  await expect(inBar(page, "[data-role=panel] h2").first()).toHaveText("Use with your agent");
  await expect(inBar(page, "[data-step=connect] .snippet-text")).toHaveText("claude mcp add iterbar -- iterbar mcp --root /work/shop");
  await inBar(page, "#iterbar-agent-codex").click();
  await expect(inBar(page, "[data-step=connect] .snippet-text")).toContainText('args = ["mcp", "--root", "/work/shop"]');
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixtureServer.origin });
  await inBar(page, "[data-role=copy-prompt]").click();
  await expect(inBar(page, "[data-role=copy-prompt]")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Use the iterbar MCP tools");
  // The chosen agent is remembered.
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem(`${window.fixture.BAR_STATE_STORAGE_KEY}:/work/shop`)))!))
    .toMatchObject({ agent: "codex", panel: "agent" });
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
  await expect(inBar(page, "[data-role=grab]")).toBeVisible();
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
  await expect(inBar(page, "[data-role=grab]")).toHaveAttribute("aria-valuetext", "centre");
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
    await touchToolbar(page);
    await expect(inBar(page, "[data-role=toggle]")).toBeVisible();
    await page.locator("#page-button").tap();
    await expect(inBar(page, "[data-role=toggle]")).toBeHidden();
  } finally {
    await context.close();
  }
});

test("a toolbar taken off the page and put back starts asleep at its dock", async ({ page, openFixture }) => {
  await openFixture();
  await mountBar(page);
  const asleep = (await inBar(page, ".toolbar").boundingBox())!;
  await inBar(page, "[data-role=comment]").hover();
  await expect(inBar(page, ".dock")).toHaveAttribute("data-held", "");
  await page.evaluate(() => {
    const bar = document.querySelector("iterbar-bar")!;
    bar.remove();
    document.body.append(bar);
  });
  await page.mouse.move(5, 5);
  await expect(inBar(page, ".dock")).not.toHaveAttribute("data-held", "");
  await expect(inBar(page, ".dock")).not.toHaveAttribute("data-hovered", "");
  expect(await inBar(page, ".toolbar").boundingBox()).toEqual(asleep);
});

test("the warning dot on a sleeping Inbox does not change its size", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [], { socket: false });
  await openFixture();
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
    await touchToolbar(page);
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
