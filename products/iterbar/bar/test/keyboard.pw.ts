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
      id: active.dataset.role ?? active.dataset.version ?? active.dataset.filter ?? (active.tagName === "SUMMARY" ? "summary" : active.tagName),
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
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await expect(inBar(page, ".thread")).toHaveCount(1);
  await expect(inBar(page, "[data-role=dock]")).toBeHidden();

  await page.locator("#page-button").focus();
  // Ctrl+. keeps the toolbar expanded from anywhere and moves focus into it.
  await page.keyboard.press("Control+Period");
  await expect(inBar(page, "[data-role=toggle]")).toHaveAttribute("aria-expanded", "true");
  expect(await focusedControl(page)).toMatchObject({ id: "comment" });

  // Every toolbar control is reachable by Tab, in order, and each shows a focus ring.
  expect(await tabThrough(page)).toEqual(["comment", "drafts-toggle", "inbox-toggle", "versions-toggle", "dock", "toggle"]);

  // The versions panel: choose the second slot by typing, then switch its version with Enter.
  await inBar(page, "[data-role=versions-toggle]").focus();
  await page.keyboard.press("Enter");
  await expect(inBar(page, "[data-role=versions-toggle]")).toHaveAttribute("aria-expanded", "true");
  await inBar(page, "[data-role=slot-select]").focus();
  await page.keyboard.type("h");
  await expect(inBar(page, "[data-role=versions] button")).toHaveText(["a (default)", "b"]);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  expect(await focusedControl(page)).toMatchObject({ id: "b" });
  await page.keyboard.press("Enter");
  await expect(inBar(page, "[data-version=b]")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => location.search)).toBe("?iterbar=hero:b");
  // Escape closes the panel and returns focus to its button.
  await page.keyboard.press("Escape");
  await expect(inBar(page, "[data-role=panel]")).toBeHidden();
  expect(await focusedControl(page)).toMatchObject({ id: "versions-toggle" });

  // The inbox: after the toolbar, Tab reaches the panel's controls, filters and threads.
  await inBar(page, "[data-role=inbox-toggle]").focus();
  await page.keyboard.press("Enter");
  expect(await tabThrough(page)).toEqual([
    "inbox-toggle", "versions-toggle", "dock", "toggle", "panel-close", "all", "open", "progress", "done", "summary",
  ]);
  await inBar(page, ".thread summary").focus();
  await page.keyboard.press("Enter");
  await expect(inBar(page, ".thread details")).toHaveAttribute("open", "");
  const controls = await page.evaluate(() => [...document.querySelector("iterbar-bar")!.shadowRoot!
    .querySelectorAll("button, select, summary, input, textarea, a[href], [tabindex]")]
    .filter((element) => (element as HTMLElement).checkVisibility()).length);
  // The six toolbar controls, the close button, four filters and the thread: nothing focusable is left out of the order.
  expect(controls).toBe(12);

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

  // Arrow keys on the dock button move the toolbar along the bottom edge.
  await inBar(page, "[data-role=dock]").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(inBar(page, ".dock")).toHaveAttribute("data-dock", "left");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(inBar(page, ".dock")).toHaveAttribute("data-dock", "right");

  // Ctrl+. lets it sleep again; focus that was inside stays on a visible control.
  await page.keyboard.press("Control+Period");
  await expect(inBar(page, "[data-role=toggle]")).toHaveAttribute("aria-expanded", "false");
  expect(await focusedControl(page)).toMatchObject({ id: "comment" });
  await expect(inBar(page, "[data-role=comment]")).toBeVisible();
});

test("the shortcuts ignore other modifier combinations and text entry", async ({ page, openFixture }) => {
  await openFixture();
  await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("beforeend", '<input id="field"><div id="editor" contenteditable>x</div>'));
  await mountBar(page);
  const expanded = inBar(page, "[data-role=toggle]");
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
  await page.locator("#page-button").focus();
  for (const keys of ["Control+KeyC", "Meta+KeyC", "Alt+KeyC"]) await page.keyboard.press(keys);
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "false");
  expect(await page.locator("#field").inputValue()).toBe("c");
});
