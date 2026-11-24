import type { Page } from "@playwright/test";
import { comment, fakeDaemon } from "./support/fake-daemon.js";
import { expect, HERO, inBar, mountBar, PRICING, registerSlots, test } from "./support/fixtures.js";

/** The control focused inside the bar, described by its role, or `null` when focus is outside the bar. */
function focusedControl(page: Page) {
  return page.evaluate(() => {
    const active = document.querySelector("iterbar-bar")?.shadowRoot?.activeElement as HTMLElement | null | undefined;
    if (!active) return null;
    const style = getComputedStyle(active);
    return {
      id: active.dataset.role ?? active.dataset.variant ?? active.dataset.filter ?? (active.tagName === "SUMMARY" ? "summary" : active.tagName),
      outline: `${style.outlineStyle} ${style.outlineWidth}`,
    };
  });
}

/** Tabs through the bar from the focused control, checking each one's focus ring, until focus leaves the bar. */
async function tabThrough(page: Page, steps = 20): Promise<string[]> {
  const visited: string[] = [];
  for (let step = 0; step < steps; step += 1) {
    const focused = await focusedControl(page);
    if (!focused) break;
    expect(focused.outline, `focus ring on ${focused.id}`).toMatch(/^solid [1-9]/);
    visited.push(focused.id);
    await page.keyboard.press("Tab");
  }
  return visited;
}

test("is fully operable from the keyboard, with visible focus on every control", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("Keyboard thread")]);
  await openFixture();
  await registerSlots(page, [PRICING, HERO]);
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token, expanded: false });
  await expect(inBar(page, ".thread")).toHaveCount(1);
  // Collapsed, the logo is the only control.
  await expect(inBar(page, "[data-role=logo]")).toBeVisible();
  await expect(inBar(page, "[data-role=comment]")).toBeHidden();

  await page.locator("#page-button").focus();
  // Ctrl+. expands the toolbar from anywhere and moves focus into it.
  await page.keyboard.press("Control+Period");
  await expect(inBar(page, "[data-role=logo]")).toHaveAttribute("aria-expanded", "true");
  expect(await focusedControl(page)).toMatchObject({ id: "comment" });

  // Every toolbar control is reachable by Tab, in order, and each shows a focus ring.
  expect(await tabThrough(page)).toEqual(["comment", "inbox-toggle", "drafts-toggle", "status-button", "variants-toggle"]);
  // The logo comes before them, at the toolbar's start.
  await inBar(page, "[data-role=comment]").focus();
  await page.keyboard.press("Shift+Tab");
  expect(await focusedControl(page)).toMatchObject({ id: "logo" });
  // Keyboard focus shows a control's tooltip: its label and shortcut.
  await page.keyboard.press("Tab");
  await expect(inBar(page, "[data-role=tooltip]")).toBeVisible();
  await expect(inBar(page, "[data-role=tooltip]")).toContainText("Comment");
  await expect(inBar(page, "[data-role=tooltip] kbd")).toHaveText("C");

  // The variants panel: choose the second slot by typing, then switch its variant with Enter.
  await inBar(page, "[data-role=variants-toggle]").focus();
  await page.keyboard.press("Enter");
  await expect(inBar(page, "[data-role=variants-toggle]")).toHaveAttribute("aria-expanded", "true");
  await inBar(page, "[data-role=slot-select]").focus();
  await page.keyboard.type("h");
  await expect(inBar(page, "[data-role=variants] button")).toHaveText(["adefault", "b"]);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  expect(await focusedControl(page)).toMatchObject({ id: "b" });
  await page.keyboard.press("Enter");
  await expect(inBar(page, "[data-variant=b]")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => location.search)).toBe("?iterbar=hero:b");
  // Escape closes the panel and returns focus to its button.
  await page.keyboard.press("Escape");
  await expect(inBar(page, "[data-role=panel]")).toBeHidden();
  expect(await focusedControl(page)).toMatchObject({ id: "variants-toggle" });

  // The inbox: after the toolbar, Tab reaches the panel's controls, filters and threads.
  await inBar(page, "[data-role=inbox-toggle]").focus();
  await page.keyboard.press("Enter");
  expect(await tabThrough(page)).toEqual([
    "inbox-toggle", "drafts-toggle", "status-button", "variants-toggle", "panel-close", "all", "open", "progress", "done", "archived",
    "select-all", "thread-select", "summary",
  ]);
  await inBar(page, ".thread summary").focus();
  await page.keyboard.press("Enter");
  await expect(inBar(page, ".thread details")).toHaveAttribute("open", "");
  const controls = await page.evaluate(() => [...document.querySelector("iterbar-bar")!.shadowRoot!
    .querySelectorAll("button, select, summary, input, textarea, a[href], [tabindex]")]
    .filter((element) => (element as HTMLElement).checkVisibility()).length);
  // The six toolbar controls (the logo among them), the close button, five filters, the select-all and the thread's
  // checkbox, its summary and its three actions (mark done, archive, delete): nothing focusable is left out.
  expect(controls).toBe(18);

  // C enters comment mode from the page and announces the change; Escape leaves it.
  const events = page.evaluate(() => new Promise<boolean>((resolve) => {
    document.addEventListener(window.fixture.COMMENT_MODE_EVENT, (event) => resolve((event as CustomEvent<{ active: boolean }>).detail.active), { once: true });
  }));
  await page.locator("#page-button").focus();
  await page.keyboard.press("c");
  expect(await events).toBe(true);
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).cursor)).toBe("crosshair");
  await page.keyboard.press("Escape");
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => document.documentElement.getAttribute("style"))).toBeNull();

  // Arrow keys (Shift for bigger steps), Home and End on the logo move the toolbar along the bottom edge.
  const logo = inBar(page, "[data-role=logo]");
  const storedX = () => page.evaluate(() => JSON.parse(localStorage.getItem(window.fixture.BAR_STATE_STORAGE_KEY) ?? "{}").x);
  await logo.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(storedX).toBe(0.45);
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(storedX).toBe(0.7);
  await page.keyboard.press("End");
  await expect.poll(storedX).toBe(1);
  const width = page.viewportSize()!.width;
  await expect.poll(async () => {
    const box = (await inBar(page, ".toolbar").boundingBox())!;
    return Math.round(box.x + box.width);
  }).toBe(width - 12);
  await page.keyboard.press("Home");
  await expect.poll(async () => Math.round((await inBar(page, ".toolbar").boundingBox())!.x)).toBe(12);

  // Ctrl+. collapses it again (with no panel open); focus that was inside goes to the logo, the one control left.
  await inBar(page, "[data-role=panel-close]").click();
  await inBar(page, "[data-role=comment]").focus();
  await page.keyboard.press("Control+Period");
  await expect(logo).toHaveAttribute("aria-expanded", "false");
  await expect(inBar(page, "[data-role=comment]")).toBeHidden();
  expect(await focusedControl(page)).toMatchObject({ id: "logo" });
  // Enter on the logo expands it again.
  await page.keyboard.press("Enter");
  await expect(logo).toHaveAttribute("aria-expanded", "true");
});

test("keys typed into the bar's own fields never reach the page's shortcuts", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { seen: string[] }).seen = seen;
    for (const type of ["keydown", "keyup", "keypress"]) {
      window.addEventListener(type, (event) => seen.push(`window ${type} ${(event as KeyboardEvent).key}`));
      document.addEventListener(type, (event) => seen.push(`document ${type} ${(event as KeyboardEvent).key}`));
      document.body.addEventListener(type, (event) => seen.push(`body ${type} ${(event as KeyboardEvent).key}`));
    }
  });
  await inBar(page, "[data-role=comment]").click();
  await page.locator("#page-text").click();
  const text = inBar(page, "#iterbar-composer-text");
  await expect(text).toBeFocused();
  await page.keyboard.type("n?g");
  await expect(text).toHaveValue("n?g");
  expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual([]);
  // Keys outside the bar's fields still reach the page.
  await page.keyboard.press("Escape");
  await page.locator("#page-button").focus();
  await page.keyboard.press("n");
  expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toContain("window keydown n");
});

test("the shortcuts ignore other modifier combinations and text entry", async ({ page, openFixture }) => {
  await openFixture();
  await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("beforeend", '<input id="field"><div id="editor" contenteditable>x</div>'));
  await mountBar(page, { expanded: false });
  const expanded = inBar(page, "[data-role=logo]");
  for (const keys of ["Alt+Period", "Shift+Period", "Control+Alt+Period", "Control+Shift+Period", "Alt+KeyI", "Control+Alt+Shift+KeyI"]) {
    await page.keyboard.press(keys);
    await expect(expanded, keys).toHaveAttribute("aria-expanded", "false");
  }
  // The earlier Alt+Shift+I still toggles it.
  await page.keyboard.press("Alt+Shift+KeyI");
  await expect(expanded).toHaveAttribute("aria-expanded", "true");

  // In a text field neither shortcut applies: Ctrl/Cmd+. is an editor command there, C is a letter. That includes a
  // field inside a closed shadow root, which only shows its host.
  await page.evaluate(() => {
    class ClosedField extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "closed" }).innerHTML = '<input id="inner">';
      }
    }
    customElements.define("closed-field", ClosedField);
    document.querySelector("main")!.append(document.createElement("closed-field"));
  });
  await page.locator("#field").focus();
  await page.keyboard.press("Control+Period");
  await expect(expanded).toHaveAttribute("aria-expanded", "true");
  for (const target of ["#field", "#editor"]) {
    await page.locator(target).focus();
    await page.keyboard.press("c");
  }
  await page.locator("closed-field").click();
  await page.keyboard.press("c");
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "false");
  // A focused custom element without a readable shadow root may hold a field, tabindex or not: C is left to it.
  await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("beforeend", '<x-tab tabindex="0">Tab</x-tab>'));
  await page.locator("x-tab").focus();
  await page.keyboard.press("c");
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "false");
  // So may a built-in element hosting a closed shadow root with a field in it.
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "closed-div";
    host.attachShadow({ mode: "closed" }).innerHTML = "<input>";
    document.querySelector("main")!.append(host);
  });
  await page.locator("#closed-div").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("c");
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "false");
  // A modal dialog that took focus itself takes no text: C applies there.
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.id = "modal";
    dialog.textContent = "Nothing focusable";
    document.body.append(dialog);
    dialog.showModal();
  });
  await page.keyboard.press("c");
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await page.evaluate(() => (document.getElementById("modal") as HTMLDialogElement).close());
  await page.locator("#page-button").focus();
  for (const keys of ["Control+KeyC", "Meta+KeyC", "Alt+KeyC"]) await page.keyboard.press(keys);
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "false");
  expect(await page.locator("#field").inputValue()).toBe("c");
});
