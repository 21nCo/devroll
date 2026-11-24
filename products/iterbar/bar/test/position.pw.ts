import type { Page } from "@playwright/test";
import { fakeDaemon, comment } from "./support/fake-daemon.js";
import { expect, inBar, mountBar, openPanel, PRICING, registerSlots, test } from "./support/fixtures.js";

// The docked toolbar: collapsed to its logo by default at the bottom centre, expanded by clicking the logo, moved along
// the bottom edge by dragging the logo, with its state remembered per project.

const stored = (page: Page, project?: string) => page.evaluate((key) => {
  const text = localStorage.getItem(key);
  return text === null ? null : JSON.parse(text) as Record<string, unknown>;
}, `${"iterbar:toolbar"}${project ? `:${project}` : ""}`);

/** Drags the logo by `dx` pixels (or to the viewport `x` when `to` is set). */
async function dragLogo(page: Page, dx: number, options: { to?: number; release?: boolean } = {}): Promise<void> {
  const logo = (await inBar(page, "[data-role=logo]").boundingBox())!;
  const y = logo.y + logo.height / 2;
  const x = logo.x + logo.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(options.to ?? x + dx, y, { steps: 8 });
  if (options.release !== false) await page.mouse.up();
}

test("collapses to the logo at the bottom centre; clicking the logo expands it, hovering never does", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("One open"), comment("Done one", { status: "done" })]);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, expanded: false });
  await expect(inBar(page, "[data-role=status]")).toHaveText("Connected");
  const viewport = page.viewportSize()!;
  const logo = inBar(page, "[data-role=logo]");

  // Collapsed: the logo and nothing else.
  await expect(logo).toBeVisible();
  for (const role of ["comment", "inbox-toggle", "variants-toggle", "settings-toggle", "help-toggle"]) {
    await expect(inBar(page, `[data-role=${role}]`), role).toBeHidden();
  }
  const collapsed = (await inBar(page, ".toolbar").boundingBox())!;
  // A gap below the toolbar: it never sits on the bottom edge. Centred, and small.
  expect(collapsed.y + collapsed.height).toBeCloseTo(viewport.height - 20, 0);
  expect(collapsed.x + collapsed.width / 2).toBeCloseTo(viewport.width / 2, 0);
  expect(collapsed.width).toBeLessThan(50);

  // Hovering shows the logo's tooltip, with the open count and the connection, and does not expand it.
  await logo.hover();
  await expect(inBar(page, "[data-role=tooltip]")).toContainText("Expand Iterbar");
  await expect(inBar(page, "[data-role=tooltip]")).toContainText("1 open in the inbox · Connected");
  await page.waitForTimeout(150);
  await expect(inBar(page, "[data-role=comment]")).toBeHidden();
  // Focus does not expand it either.
  await logo.focus();
  await expect(inBar(page, "[data-role=comment]")).toBeHidden();

  // A click expands it in place: the logo does not move, and everything else grows to its right.
  const before = (await logo.boundingBox())!;
  await logo.click();
  await expect(logo).toHaveAttribute("aria-expanded", "true");
  await expect(inBar(page, "[data-role=variants-toggle]")).toBeVisible();
  await expect(inBar(page, "[data-role=open-count]")).toHaveText("1");
  const after = (await logo.boundingBox())!;
  expect(after.x).toBeCloseTo(before.x, 0);
  const expanded = (await inBar(page, ".toolbar").boundingBox())!;
  expect(expanded.width).toBeGreaterThan(collapsed.width);
  expect(expanded.x + expanded.width).toBeLessThanOrEqual(viewport.width - 12 + 0.5);
  expect(await stored(page)).toMatchObject({ expanded: true });

  // Another click collapses it, at the same place.
  await logo.click();
  await expect(inBar(page, "[data-role=comment]")).toBeHidden();
  expect((await logo.boundingBox())!.x).toBeCloseTo(before.x, 0);

  // Comment mode and an open panel show the whole toolbar while they last, and it collapses again after.
  await page.locator("#page-button").focus();
  await page.keyboard.press("c");
  await expect(inBar(page, "[data-role=comment]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inBar(page, "[data-role=comment]")).toBeHidden();
});

test("moves along the bottom edge by dragging the logo, kept in view, and remembers the place per project", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("Thread")]);
  const project = "/work/shop";
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, project, expanded: false });
  const toolbar = inBar(page, ".toolbar");
  const logo = inBar(page, "[data-role=logo]");
  const viewport = page.viewportSize()!;

  // Dragged left, it follows the pointer; a drag never expands or collapses it.
  const before = (await toolbar.boundingBox())!;
  await dragLogo(page, -100, { release: false });
  expect(Math.round((await toolbar.boundingBox())!.x)).toBe(Math.round(before.x - 100));
  await page.mouse.move(-500, before.y + before.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await toolbar.boundingBox())!.x)).toBe(12);
  await expect(inBar(page, "[data-role=comment]")).toBeHidden();
  expect(await stored(page, project)).toMatchObject({ x: 0, expanded: false });

  // Past the right edge it stops at the right margin; expanded there, it runs right to left with the logo at its end.
  await dragLogo(page, 0, { to: viewport.width + 400 });
  await expect.poll(async () => Math.round((await logo.boundingBox())!.x + (await logo.boundingBox())!.width)).toBe(viewport.width - 12 - 4);
  await logo.click();
  await expect(inBar(page, "[data-role=comment]")).toBeVisible();
  const right = (await toolbar.boundingBox())!;
  expect(Math.round(right.x + right.width)).toBe(viewport.width - 12);
  expect((await inBar(page, "[data-role=comment]").boundingBox())!.x).toBeLessThan((await logo.boundingBox())!.x);

  // The place is stored for the project, not for the whole origin.
  expect(await stored(page, project)).toMatchObject({ x: 1, expanded: true });
  expect(await stored(page)).toBeNull();

  // The inbox opens as the sheet on the right; with the toolbar under it, the sheet stops above the toolbar.
  await openPanel(page, "inbox");
  const panel = (await inBar(page, "[data-role=panel]").boundingBox())!;
  const bar = (await toolbar.boundingBox())!;
  expect(panel.y + panel.height).toBeLessThanOrEqual(bar.y);
  expect(Math.round(panel.x + panel.width)).toBe(viewport.width - 12);
  await expect(inBar(page, "[data-role=panel] h2").first()).toHaveText("Inbox");

  // Reloaded: the place, the expanded state and the open panel come back for the project.
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, project, expanded: false });
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

test("explains every toolbar control in a tooltip; help opens the setup sheet with the connection at its top", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, []);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, project: "/work/shop" });
  await expect(inBar(page, "[data-role=status]")).toHaveText("Connected");
  const tooltip = inBar(page, "[data-role=tooltip]");
  for (const [role, label] of [
    ["logo", "Collapse Iterbar"], ["comment", "Comment"], ["inbox-toggle", "Inbox"],
    ["variants-toggle", "Variants"], ["settings-toggle", "Settings"], ["help-toggle", "Help and setup"],
  ] as const) {
    const control = inBar(page, `[data-role=${role}]`);
    await control.hover();
    await expect(tooltip, role).toBeVisible();
    await expect(tooltip.locator(".tooltip-label"), role).toContainText(label);
    // Every control has an accessible name of its own.
    expect(await control.getAttribute("aria-label"), role).toBeTruthy();
  }
  // The help button's tooltip says how the bar is connected.
  await inBar(page, "[data-role=help-toggle]").hover();
  await expect(tooltip).toContainText("Connected. How to connect your coding agent.");
  await expect(inBar(page, "[data-role=help-toggle]")).toHaveAttribute("aria-describedby", "iterbar-tooltip");
  await page.mouse.move(5, 5);
  await expect(tooltip).toBeHidden();

  // Clicking it opens the setup sheet: the connection at its top, then one init command for the project, a prompt to
  // copy, and the same setup by hand.
  await inBar(page, "[data-role=help-toggle]").click();
  await expect(inBar(page, "[data-role=panel] h2").first()).toHaveText("Set up your agent");
  await expect(inBar(page, "[data-role=connection]")).toBeVisible();
  await expect(inBar(page, "[data-role=connection]")).toContainText("ConnectedConnected to Iterbar: comments are saved for your coding agent.");
  const dot = (await inBar(page, "[data-role=status-dot]").boundingBox())!;
  const label = (await inBar(page, "[data-role=status]").boundingBox())!;
  expect(label.x - (dot.x + dot.width)).toBeLessThan(10);
  // A full-height sheet on the right.
  const sheet = (await inBar(page, "[data-role=panel]").boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.round(sheet.y)).toBe(12);
  expect(Math.round(sheet.x + sheet.width)).toBe(viewport.width - 12);
  await expect(inBar(page, "[data-step=init] .snippet-text")).toHaveText([
    "npx iterbar init --agent claude",
    "pnpm add -D iterbar",
    "pnpm exec iterbar init --agent claude",
  ]);
  await inBar(page, "[data-role=agent-manual] summary").click();
  await expect(inBar(page, "[data-role=agent-manual] .snippet-text").first()).toHaveText("claude mcp add iterbar -- npx -y iterbar mcp --root /work/shop");
  // When the dev server says which CLI it runs, a third form runs that one, and the manual steps use it.
  await page.evaluate(() => {
    const bar = document.querySelector("iterbar-bar") as HTMLElement & { devServer: unknown };
    bar.devServer = {
      about: { packages: [], cli: { path: "/repo/products/iterbar/cli/dist/cli.js", version: "0.1.0" } },
      reconnect: async () => ({ daemonUrl: null, token: null }),
      checkUpdates: async () => ({ packages: [] }),
    };
  });
  await expect(inBar(page, "[data-step=init] .snippet-text")).toHaveText([
    "npx iterbar init --agent claude",
    "pnpm add -D iterbar",
    "pnpm exec iterbar init --agent claude",
    "node /repo/products/iterbar/cli/dist/cli.js init --agent claude",
  ]);
  await expect(inBar(page, "[data-role=agent-manual] .snippet-text").first())
    .toHaveText("claude mcp add iterbar -- node /repo/products/iterbar/cli/dist/cli.js mcp --root /work/shop");
  await expect(inBar(page, "[data-role=agent-manual] .snippet-text").nth(1)).toContainText("cp -R /repo/products/iterbar/cli/skills/iterbar");
  await inBar(page, "#iterbar-agent-codex").click();
  await expect(inBar(page, "[data-step=init] .snippet-text").first()).toContainText("init --agent codex");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixtureServer.origin });
  await inBar(page, "[data-role=copy-prompt]").click();
  await expect(inBar(page, "[data-role=copy-prompt]")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Use the iterbar MCP tools");
  // The chosen agent is remembered.
  expect(await stored(page, "/work/shop")).toMatchObject({ agent: "codex", panel: "agent" });
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
  await expect(inBar(page, "[data-role=comment]")).toBeVisible();
  // The earlier `collapsed` property still works, as the opposite of `expanded`.
  await page.evaluate(() => {
    (document.querySelector("iterbar-bar") as HTMLElement & { collapsed: boolean }).collapsed = true;
  });
  await expect(inBar(page, ".dock")).not.toHaveAttribute("data-expanded", "");
  await expect(inBar(page, "[data-role=comment]")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem(window.fixture.BAR_STATE_STORAGE_KEY))).toContain('"expanded":false');
});

test("fits a narrow screen collapsed, expanded and with a panel open", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("A rather long comment ".repeat(20))]);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, expanded: false });
  for (const width of [1280, 320, 280]) {
    await page.setViewportSize({ width, height: 568 });
    // The bar places itself on the resize, which the page sees on its next frame.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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
    await openPanel(page, "inbox");
    await inside();
    // A long comment wraps inside the panel rather than overflowing it.
    const text = (await inBar(page, ".thread-text").boundingBox())!;
    const panel = (await inBar(page, "[data-role=panel]").boundingBox())!;
    expect(text.x + text.width).toBeLessThanOrEqual(panel.x + panel.width);
    await inBar(page, "[data-role=panel-close]").click();
    await inside();
  }
});

test("ignores a corrupt stored state and keeps working without storage", async ({ page, openFixture }) => {
  await openFixture();
  await page.evaluate(() => localStorage.setItem(window.fixture.BAR_STATE_STORAGE_KEY, "{corrupt"));
  await mountBar(page, { expanded: false });
  await expect(inBar(page, "[data-role=comment]")).toBeHidden();
  await page.evaluate(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => { throw new DOMException("denied", "SecurityError"); } });
  });
  await inBar(page, "[data-role=logo]").click();
  await expect(inBar(page, ".dock")).toHaveAttribute("data-expanded", "");
});

test("a toolbar taken off the page and put back keeps its place and state", async ({ page, openFixture }) => {
  await openFixture();
  await mountBar(page, { expanded: false });
  const collapsed = (await inBar(page, ".toolbar").boundingBox())!;
  await page.evaluate(() => {
    const bar = document.querySelector("iterbar-bar")!;
    bar.remove();
    document.body.append(bar);
  });
  expect(await inBar(page, ".toolbar").boundingBox()).toEqual(collapsed);
});

test("a connection problem shows as a dot on the collapsed logo, which keeps its size", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [], { socket: false });
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, expanded: false });
  await expect(inBar(page, "[data-role=status]")).toHaveText("Reconnecting…");
  const content = await inBar(page, "[data-role=logo]").evaluate((element) => getComputedStyle(element, "::after").content);
  expect(content).not.toBe("none");
  expect((await inBar(page, "[data-role=logo]").boundingBox())!.width).toBe(30);
});

test("a toolbar removed in the middle of a drag comes back at its saved place", async ({ page, openFixture }) => {
  await openFixture();
  await mountBar(page, { project: "/work/shop", expanded: false });
  const toolbar = inBar(page, ".toolbar");
  const collapsed = (await toolbar.boundingBox())!;
  await dragLogo(page, -150, { release: false });
  await page.evaluate(() => {
    const bar = document.querySelector("iterbar-bar")!;
    bar.remove();
    document.body.append(bar);
  });
  await page.mouse.up();
  await expect(inBar(page, ".dock")).not.toHaveAttribute("data-dragging", "");
  // Nothing was saved, and the toolbar is where it was, still collapsed.
  expect(await toolbar.boundingBox()).toEqual(collapsed);
  expect(await stored(page, "/work/shop")).toBeNull();
  await expect(inBar(page, "[data-role=comment]")).toBeHidden();
});

test("dragging with the wide agent panel open keeps the panel in view and drops without a jump", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, []);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, project: "/work/shop" });
  await inBar(page, "[data-role=help-toggle]").click();
  const panel = inBar(page, "[data-role=panel]");
  await expect(panel).toBeVisible();
  const width = page.viewportSize()!.width;
  const logoBox = (await inBar(page, "[data-role=logo]").boundingBox())!;
  const y = logoBox.y + logoBox.height / 2;
  await page.mouse.move(logoBox.x + logoBox.width / 2, y);
  await page.mouse.down();
  // Across the two-thirds mark, where the toolbar turns to run right to left.
  for (const target of [width * 0.6, width * 0.75, width * 0.95, width + 200]) {
    await page.mouse.move(target, y, { steps: 3 });
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(12 - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(width - 12 + 0.5);
  }
  const handle = (await inBar(page, "[data-role=logo]").boundingBox())!;
  const panelBefore = (await panel.boundingBox())!;
  await page.mouse.up();
  // Dropped: neither the logo nor the panel moves, and the drop did not collapse the toolbar.
  expect((await inBar(page, "[data-role=logo]").boundingBox())!.x).toBeCloseTo(handle.x, 0);
  expect((await panel.boundingBox())!.x).toBeCloseTo(panelBefore.x, 0);
  await expect(inBar(page, "[data-role=logo]")).toHaveAttribute("aria-expanded", "true");
});

test("copies without the Clipboard API from inside the bar, keeping focus on the copy button", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, []);
  await openFixture();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, get: () => undefined });
    const copies: string[] = [];
    (window as unknown as { copies: string[] }).copies = copies;
    document.execCommand = ((command: string) => {
      const root = document.querySelector("iterbar-bar")!.shadowRoot!;
      const area = root.querySelector<HTMLTextAreaElement>(".copy-buffer");
      if (command === "copy" && area && root.activeElement === area) copies.push(area.value);
      return command === "copy" && area !== null;
    }) as typeof document.execCommand;
    document.head.insertAdjacentHTML("beforeend", "<style>textarea { display: none !important; }</style>");
  });
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, project: "/work/shop" });
  await inBar(page, "[data-role=help-toggle]").click();
  const copy = inBar(page, "[data-role=copy-prompt]");
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect(copy).toHaveText("Copied");
  await expect(copy).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { copies: string[] }).copies)).toEqual([
    // Not "the latest batch": a comment sent on its own has no batch, and the prompt must not skip it.
    "Use the iterbar MCP tools to read my open Iterbar feedback (with get_batch for comments I sent together), make the changes, and reply on each item when done.",
  ]);
  // The page never saw a text area of the bar's.
  expect(await page.evaluate(() => document.querySelectorAll("textarea").length)).toBe(0);
  expect(await inBar(page, ".copy-buffer").count()).toBe(0);
  // Cursor's manual snippet names the project's own folder when the bar knows it.
  await inBar(page, "#iterbar-agent-cursor").click();
  await inBar(page, "[data-role=agent-manual] summary").click();
  await expect(inBar(page, "[data-role=agent-manual] .snippet-text").first()).toContainText('"args": ["-y", "iterbar", "mcp", "--root", "/work/shop"]');
});

test("a project with nothing stored yet starts from the state the origin kept", async ({ page, openFixture }) => {
  await openFixture();
  await page.evaluate(() => {
    localStorage.setItem(window.fixture.BAR_STATE_STORAGE_KEY, JSON.stringify({ dock: "left", expanded: true, panel: "versions" }));
    localStorage.setItem(`${window.fixture.BAR_STATE_STORAGE_KEY}:/work/other`, JSON.stringify({ x: 0.8 }));
  });
  await mountBar(page, { project: "/work/shop", expanded: false });
  await expect.poll(async () => Math.round((await inBar(page, ".toolbar").boundingBox())!.x)).toBe(12);
  await expect(inBar(page, ".dock")).toHaveAttribute("data-expanded", "");
  // The earlier "versions" panel opens as Variants.
  await expect(inBar(page, ".panel-title")).toHaveText("Variants");
  // A project that has its own state keeps it.
  await openFixture();
  await mountBar(page, { project: "/work/other", expanded: false });
  const width = page.viewportSize()!.width;
  await expect.poll(async () => Math.round((await inBar(page, "[data-role=logo]").boundingBox())!.x)).toBe(Math.round(12 + 0.8 * (width - 24 - 38) + 4));
});

test("on a short, narrow screen the panel fits between the top and the wrapped toolbar", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("Thread")]);
  await page.setViewportSize({ width: 280, height: 280 });
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, project: "/work/shop" });
  await inBar(page, "[data-role=help-toggle]").click();
  const panel = (await inBar(page, "[data-role=panel]").boundingBox())!;
  const toolbar = (await inBar(page, ".toolbar").boundingBox())!;
  expect(panel.y).toBeGreaterThanOrEqual(0);
  expect(panel.y + panel.height).toBeLessThanOrEqual(toolbar.y);
});

test("an open composer moves clear of a panel opened under it", async ({ page, openFixture }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await openFixture();
  await page.evaluate(() => {
    const target = document.createElement("button");
    target.id = "low-target";
    target.textContent = "Low target";
    target.style.cssText = "position: absolute; left: 380px; top: 470px";
    document.body.append(target);
  });
  await mountBar(page, { daemonUrl: "http://127.0.0.1:9", token: "0".repeat(64) });
  await inBar(page, "[data-role=comment]").click();
  await page.locator("#low-target").click();
  const composer = inBar(page, "[data-section=composer]");
  await expect(composer).toBeVisible();
  await inBar(page, "[data-role=inbox-toggle]").click();
  const panel = inBar(page, "[data-role=panel]");
  await expect(panel).toBeVisible();
  await expect.poll(async () => {
    const c = (await composer.boundingBox())!;
    const p = (await panel.boundingBox())!;
    const overlaps = c.x < p.x + p.width && p.x < c.x + c.width && c.y < p.y + p.height && p.y < c.y + c.height;
    return overlaps;
  }).toBe(false);
});

test("expanding never moves the logo: the toolbar grows toward the side with room, and wraps when neither side has it", async ({ page, openFixture }) => {
  for (const [width, x] of [[1000, 0.6], [1000, 0.5], [360, 0.5], [280, 0.5], [360, 0.9], [150, 0.5]] as const) {
    await page.setViewportSize({ width, height: 700 });
    await openFixture();
    // With slots, so Variants shows its label and count where there is room.
    await registerSlots(page, [PRICING]);
    await page.evaluate((position) => localStorage.setItem(window.fixture.BAR_STATE_STORAGE_KEY, JSON.stringify({ x: position })), x);
    await mountBar(page, { expanded: false });
    const logo = inBar(page, "[data-role=logo]");
    const before = (await logo.boundingBox())!;
    await logo.click();
    await expect(inBar(page, "[data-role=variants-toggle]")).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect((await logo.boundingBox())!.x, `${width} px at ${x}`).toBeCloseTo(before.x, 0);
    for (const control of await inBar(page, ".toolbar > :not([hidden])").all()) {
      const box = await control.boundingBox();
      if (!box) continue;
      expect(box.x, `${width} px at ${x}`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${width} px at ${x}`).toBeLessThanOrEqual(width + 0.5);
    }
  }
});
