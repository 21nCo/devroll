import type { Page } from "@playwright/test";
import { SCHEMA_VERSION } from "@iterbar/core";
import { comment, fakeDaemon } from "./support/fake-daemon.js";
import { expect, inBar, mountBar, openPanel, test } from "./support/fixtures.js";

// The draft tray (several picks sent as one batch), readable target labels, the inbox layout and a screenshot of an
// element whose icon is a <use> of a sprite id with a colon.

const PAGE_HTML = `
<svg style="display: none" aria-hidden="true">
  <symbol id="ph:sparkle-light" viewBox="0 0 16 16"><path d="M8 1l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="rgb(0, 0, 255)"/></symbol>
</svg>
<section class="row" style="display: flex; gap: 48px; align-items: flex-start">
  <button type="button" data-testid="suggest" data-iterbar-src="src/components/AskBox.svelte:45:14"
    style="display: inline-flex; gap: 4px; align-items: center; font: 14px sans-serif">
    <svg width="16" height="16"><use href="#ph:sparkle-light"/></svg>Suggestions</button>
  <div data-testid="card" class="text-[12px] card" data-iterbar-src="src/components/home/FreshStart.svelte:70:7">Fresh start card</div>
  <img data-testid="logo" alt="Company logo" width="20" height="20" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
</section>`;

async function open(page: Page, openFixture: (path?: string) => Promise<void>, daemonUrl: string, token: string): Promise<void> {
  await openFixture();
  await page.evaluate((html) => document.querySelector("main")!.insertAdjacentHTML("afterbegin", html), PAGE_HTML);
  await mountBar(page, { daemonUrl, token });
  await expect(inBar(page, "[data-role=status]")).toHaveText("Connected");
}

/** Picks `testId` in comment mode, types `text` and adds it to the draft tray with Ctrl+Enter. */
async function draft(page: Page, testId: string, text: string): Promise<void> {
  await page.getByTestId(testId).click();
  const box = inBar(page, "[data-role=composer-text]");
  await box.fill(text);
  await box.press("Control+Enter");
  await expect(inBar(page, "[data-section=composer]")).toBeHidden();
}

test("drafts several comments, edits and removes one, and sends the rest as one batch", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await open(page, openFixture, daemon.url, daemon.token);

  await inBar(page, "[data-role=comment]").click();
  await draft(page, "suggest", "Use a friendlier label");
  // Comment mode stays on for the next pick, and nothing has been sent yet.
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "true");
  await draft(page, "card", "Too small");
  await draft(page, "logo", "Wrong logo");
  expect(daemon.posts).toHaveLength(0);
  await expect(inBar(page, "[data-role=draft-count]")).toHaveText("3");
  await expect(inBar(page, "[data-role=announce]")).toContainText("3 drafts waiting");

  await page.keyboard.press("Escape");
  await openPanel(page, "drafts");
  const rows = inBar(page, ".draft");
  await expect(rows.locator(".draft-target")).toHaveText([
    "“Suggestions” · AskBox.svelte:45", "“Fresh start card” · FreshStart.svelte:70", "“Company logo”",
  ]);
  await expect(rows.nth(1).locator(".draft-target")).toHaveAttribute("title",
    'Source: src/components/home/FreshStart.svelte:70:7\nSelector: [data-testid="card"]');

  // Hovering a draft outlines its element.
  await rows.nth(1).hover();
  await expect(inBar(page, "[data-role=pick-marked]")).toBeVisible();
  expect(await inBar(page, "[data-role=pick-marked]").boundingBox()).toEqual(await page.getByTestId("card").boundingBox());

  // Edit the second, remove the third.
  await rows.nth(1).locator("[data-role=draft-edit]").click();
  const area = rows.nth(1).locator("[data-role=draft-text]");
  await expect(area).toBeFocused();
  await area.fill("Make the card text 14px");
  await rows.nth(1).locator("[data-role=draft-save]").click();
  await expect(rows.nth(1).locator(".draft-text")).toHaveText("Make the card text 14px");
  await rows.nth(2).locator("[data-role=draft-remove]").click();
  await expect(rows).toHaveCount(2);
  // Focus moves to the Remove of the draft now last, not to the page.
  await expect(rows.nth(1).locator("[data-role=draft-remove]")).toBeFocused();
  await expect(inBar(page, "[data-role=drafts-send]")).toHaveText("Send all 2");

  await inBar(page, "[data-role=drafts-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(2);
  const [first, second] = daemon.posts;
  expect(first!.draft).toMatchObject({ text: "Use a friendlier label", target: { sourceLocation: { path: "src/components/AskBox.svelte", line: 45 } } });
  expect(second!.draft).toMatchObject({ text: "Make the card text 14px", target: { selector: '[data-testid="card"]' } });
  const batchId = first!.draft.batchId;
  expect(batchId).toMatch(/^batch-[a-z0-9-]+$/);
  expect(second!.draft.batchId).toBe(batchId);
  // Each comment says how many the batch holds, so an agent can tell when all of it has arrived.
  expect([first!.draft.batchSize, second!.draft.batchSize]).toEqual([2, 2]);
  expect([first!.draft.batchIndex, second!.draft.batchIndex]).toEqual([0, 1]);
  // Both screenshots were taken, the sprite icon's included.
  expect(first!.draft.screenshotUnavailableReason).toBeNull();
  expect(first!.screenshot).not.toBeNull();
  expect(second!.screenshot).not.toBeNull();

  // The tray empties, the inbox opens with both threads, and the count is announced.
  await expect(inBar(page, "[data-role=draft-count]")).toBeHidden();
  await expect(inBar(page, "[data-role=inbox-toggle]")).toHaveAttribute("aria-expanded", "true");
  await expect(inBar(page, ".thread")).toHaveCount(2);
  await expect(inBar(page, "[data-role=announce]")).toHaveText("Sent 2 comments as one batch.");
});

test("keeps a draft the daemon refused and retries it in the same batch", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await open(page, openFixture, daemon.url, daemon.token);
  await inBar(page, "[data-role=comment]").click();
  await draft(page, "suggest", "First");
  await draft(page, "card", "Second");
  await page.keyboard.press("Escape");
  await openPanel(page, "drafts");

  daemon.failFeedback = 409;
  await inBar(page, "[data-role=drafts-send]").click();
  await expect(inBar(page, "[data-role=drafts-error]")).toHaveText("2 of 2 not sent; Send all tries them again in the same batch.");
  await expect(inBar(page, ".draft[data-state=failed]")).toHaveCount(2);
  await expect(inBar(page, ".draft .composer-error").first()).toContainText("409");

  daemon.failFeedback = null;
  await inBar(page, "[data-role=drafts-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(2);
  const ids = daemon.posts.map((post) => post.draft.batchId);
  expect(new Set(ids).size).toBe(1);
  expect(daemon.posts.map((post) => post.draft.batchIndex)).toEqual([0, 1]);
  await expect(inBar(page, ".draft")).toHaveCount(0);
});

test("a draft added while a batch is being sent waits for the next batch and is not reported as failed", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await open(page, openFixture, daemon.url, daemon.token);
  await inBar(page, "[data-role=comment]").click();
  await draft(page, "suggest", "First");
  await draft(page, "card", "Second");
  let release!: () => void;
  daemon.holdFeedback = new Promise<void>((resolve) => {
    release = resolve;
  });
  await openPanel(page, "drafts");
  await inBar(page, "[data-role=drafts-send]").click();
  await expect.poll(() => daemon.requests.filter((request) => request.method === "POST").length).toBe(1);
  // Comment mode is still on: pick and draft another while the batch is on its way.
  await draft(page, "logo", "Third, later");
  release();
  daemon.holdFeedback = null;
  await expect.poll(() => daemon.posts.length).toBe(2);
  await expect(inBar(page, ".draft")).toHaveCount(1);
  await expect(inBar(page, ".draft[data-state=draft] .draft-text")).toHaveText("Third, later");
  await expect(inBar(page, "[data-role=drafts-error]")).toBeHidden();
  await expect(inBar(page, "[data-role=announce]")).toHaveText("Sent 2 comments as one batch.");

  await inBar(page, "[data-role=drafts-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(3);
  const [first, , third] = daemon.posts;
  expect(third!.draft.batchId).toMatch(/^batch-/);
  expect(third!.draft.batchId).not.toBe(first!.draft.batchId);
  expect(third!.draft.batchSize).toBe(1);
});

test("a retry with a new draft keeps every comment's place in the batch distinct", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await open(page, openFixture, daemon.url, daemon.token);
  await inBar(page, "[data-role=comment]").click();
  await draft(page, "suggest", "A fails first");
  await draft(page, "card", "B");
  daemon.failFeedbackText = "A fails first";
  await openPanel(page, "drafts");
  await inBar(page, "[data-role=drafts-send]").click();
  await expect(inBar(page, "[data-role=drafts-error]")).toContainText("1 of 2 not sent");
  await draft(page, "logo", "C, added before the retry");
  daemon.failFeedbackText = null;
  await inBar(page, "[data-role=drafts-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(3);
  const sent = Object.fromEntries(daemon.posts.map((post) => [post.draft.text, [post.draft.batchIndex, post.draft.batchSize]]));
  expect(sent).toEqual({ "B": [1, 2], "A fails first": [0, 3], "C, added before the retry": [2, 3] });
  expect(new Set(daemon.posts.map((post) => post.draft.batchId)).size).toBe(1);
});

test("a draft withdrawn after a failed send no longer counts toward its batch", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await open(page, openFixture, daemon.url, daemon.token);
  await inBar(page, "[data-role=comment]").click();
  await draft(page, "suggest", "A");
  await draft(page, "card", "B");
  daemon.failFeedback = 409;
  await openPanel(page, "drafts");
  await inBar(page, "[data-role=drafts-send]").click();
  await expect(inBar(page, ".draft[data-state=failed]")).toHaveCount(2);
  daemon.failFeedback = null;
  await inBar(page, ".draft").nth(1).locator("[data-role=draft-remove]").click();
  await inBar(page, "[data-role=drafts-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(1);
  expect(daemon.posts[0]!.draft).toMatchObject({ text: "A", batchIndex: 0, batchSize: 1 });
});

test("a draft that may already be stored still counts toward its batch when withdrawn", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await open(page, openFixture, daemon.url, daemon.token);
  await inBar(page, "[data-role=comment]").click();
  await draft(page, "suggest", "A");
  await draft(page, "card", "B");
  // Both are stored, but no answer comes back: the bar cannot tell.
  daemon.dropFeedbackAnswer = true;
  await openPanel(page, "drafts");
  await inBar(page, "[data-role=drafts-send]").click();
  await expect(inBar(page, ".draft[data-state=failed]")).toHaveCount(2);
  await expect(inBar(page, ".draft .composer-error").first()).toContainText("may already be stored");
  daemon.dropFeedbackAnswer = false;
  await inBar(page, ".draft").first().locator("[data-role=draft-remove]").click();
  await inBar(page, "[data-role=drafts-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(3);
  expect(daemon.posts[2]!.draft).toMatchObject({ text: "B", batchIndex: 1, batchSize: 2 });
});

test("a custom element with an unusual labels property can still be picked", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await open(page, openFixture, daemon.url, daemon.token);
  await page.evaluate(() => {
    class OddLabels extends HTMLElement {
      get labels() {
        return 42;
      }
    }
    customElements.define("odd-labels", OddLabels);
    document.querySelector("main")!.insertAdjacentHTML("afterbegin", '<odd-labels data-testid="odd" style="display: block; width: 80px">Odd one</odd-labels>');
  });
  await inBar(page, "[data-role=comment]").click();
  await page.getByTestId("odd").click();
  await expect(inBar(page, "[data-role=composer-target]")).toHaveText("On “Odd one”");
});

test("Escape while editing a draft in comment mode cancels the edit and keeps comment mode", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await open(page, openFixture, daemon.url, daemon.token);
  await inBar(page, "[data-role=comment]").click();
  await draft(page, "card", "Original");
  await openPanel(page, "drafts");
  await inBar(page, "[data-role=draft-edit]").click();
  await inBar(page, "[data-role=draft-text]").fill("Changed, then abandoned");
  await page.keyboard.press("Escape");
  await expect(inBar(page, "[data-role=draft-text]")).toHaveCount(0);
  await expect(inBar(page, ".draft-text")).toHaveText("Original");
  await expect(inBar(page, "[data-role=draft-edit]")).toBeFocused();
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "true");
  // From any other control in the tray, Escape leaves comment mode as usual.
  await page.keyboard.press("Escape");
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "false");
});

test("with a draft waiting, the collapsed toolbar shows only its logo, and clicking it brings Drafts back", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await open(page, openFixture, daemon.url, daemon.token);
  await inBar(page, "[data-role=comment]").click();
  await draft(page, "card", "Waiting");
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    document.querySelector("iterbar-bar")!.expanded = false;
  });
  await page.locator("#page-text").click();
  await expect(inBar(page, "[data-role=drafts-toggle]")).toBeHidden();
  // Hovering never expands it.
  await inBar(page, "[data-role=logo]").hover();
  await page.waitForTimeout(200);
  await expect(inBar(page, "[data-role=drafts-toggle]")).toBeHidden();
  await inBar(page, "[data-role=logo]").click();
  await expect(inBar(page, "[data-role=draft-count]")).toHaveText("1");
});

test("one draft is edited at a time", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await open(page, openFixture, daemon.url, daemon.token);
  await inBar(page, "[data-role=comment]").click();
  await draft(page, "suggest", "One");
  await draft(page, "card", "Two");
  await page.keyboard.press("Escape");
  await openPanel(page, "drafts");
  await inBar(page, "[data-role=draft-edit]").first().click();
  await expect(inBar(page, "[data-role=draft-text]")).toBeFocused();
  await expect(inBar(page, "[data-role=draft-edit]")).toBeDisabled();
  // A draft added meanwhile re-renders the tray without pulling focus back into the editor.
  await inBar(page, "[data-role=comment]").click();
  await draft(page, "logo", "Three");
  await expect(inBar(page, "[data-role=draft-text]")).not.toBeFocused();
  await expect(inBar(page, "[data-role=draft-text]")).toHaveValue("One");
});

test("says so when an older daemon drops the batch", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  daemon.dropBatch = true;
  await open(page, openFixture, daemon.url, daemon.token);
  await inBar(page, "[data-role=comment]").click();
  await draft(page, "card", "Ungrouped");
  await page.keyboard.press("Escape");
  await openPanel(page, "drafts");
  await inBar(page, "[data-role=drafts-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(1);
  await expect(inBar(page, "[data-role=announce]")).toContainText("filed one by one, not as a batch");
  // The tray is empty, and the warning still shows there.
  await expect(inBar(page, "[data-role=drafts-error]")).toBeVisible();
});

test("the page's own style attribute on the root survives comment mode", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await open(page, openFixture, daemon.url, daemon.token);
  await page.evaluate(() => document.documentElement.setAttribute("style", ""));
  await page.keyboard.press("c");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.getAttribute("style"))).toBe("");
});

test("the composer opens next to its element under a page zoom", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await open(page, openFixture, daemon.url, daemon.token);
  await page.addStyleTag({ content: "html { zoom: 1.5 }" });
  await inBar(page, "[data-role=comment]").click();
  await page.getByTestId("card").click();
  const card = (await page.getByTestId("card").boundingBox())!;
  const composer = (await inBar(page, ".composer").boundingBox())!;
  expect(Math.abs(composer.x - card.x)).toBeLessThan(2);
  expect(composer.y).toBeGreaterThanOrEqual(card.y + card.height);
  expect(composer.y).toBeLessThan(card.y + card.height + 20);
});

test("a single comment is still sent on its own, without a batch", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await open(page, openFixture, daemon.url, daemon.token);
  await inBar(page, "[data-role=comment]").click();
  await page.getByTestId("card").click();
  // The composer opens next to the picked element and names it readably, with the selector on hover.
  const target = inBar(page, "[data-role=composer-target]");
  await expect(target).toHaveText("On “Fresh start card” · FreshStart.svelte:70");
  await expect(target).toHaveAttribute("title", /Selector: \[data-testid="card"\]/u);
  const card = (await page.getByTestId("card").boundingBox())!;
  const composer = (await inBar(page, ".composer").boundingBox())!;
  expect(composer.y).toBeGreaterThanOrEqual(card.y + card.height);
  expect(composer.y).toBeLessThan(card.y + card.height + 20);
  await inBar(page, "[data-role=composer-text]").fill("Send me now");
  await inBar(page, "[data-role=composer-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(1);
  expect(daemon.posts[0]!.draft).not.toHaveProperty("batchId");
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "false");
});

test("captures an element whose icon uses a sprite id with a colon", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await open(page, openFixture, daemon.url, daemon.token);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await inBar(page, "[data-role=comment]").click();
  await page.getByTestId("suggest").click();
  await inBar(page, "[data-role=composer-text]").fill("Icon check");
  await inBar(page, "[data-role=composer-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(1);
  const { draft: sent, screenshot } = daemon.posts[0]!;
  expect(sent.screenshotUnavailableReason).toBeNull();
  expect(screenshot).not.toBeNull();
  expect(errors).toEqual([]);
});

test("the inbox wraps long comments and replies, shows statuses, filters, and keeps its padding when a thread opens", async ({ page, openFixture, fixtureServer }) => {
  const long = `${"A long comment that must wrap inside the panel rather than being cut off at its edge. ".repeat(4)}Unbroken${"x".repeat(120)}`;
  const first = comment(long);
  const daemon = await fakeDaemon(page, fixtureServer.origin, [first, comment("Being worked on", { status: "working" }), comment("Finished", { status: "done" })]);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await openPanel(page, "inbox");
  await expect(inBar(page, "[data-role=open-count]")).toHaveText("2");
  await expect(inBar(page, "[data-filter]")).toHaveText(["All3", "Open1", "In progress1", "Done1", "Archived0"]);

  daemon.send({
    schemaVersion: SCHEMA_VERSION,
    type: "feedback.updated",
    feedback: {
      ...first,
      updatedAt: new Date(Date.parse(first.updatedAt) + 1000).toISOString(),
      replies: [{ id: "r1", author: { kind: "agent", name: "Claude" }, text: `Done: ${"changed the copy ".repeat(12)}${"y".repeat(100)}`, createdAt: first.updatedAt }],
    },
  });
  const thread = inBar(page, `[data-feedback-id="${first.id}"]`);
  await expect(thread.locator(".thread-count")).toHaveText("1 reply");
  const panel = (await inBar(page, ".panel-body").boundingBox())!;
  const text = thread.locator(".thread-text");
  const before = (await text.boundingBox())!;
  expect(before.x + before.width).toBeLessThanOrEqual(panel.x + panel.width);

  await thread.locator("summary").click();
  const after = (await text.boundingBox())!;
  // Opening a thread does not move its content sideways, and the full text and the reply wrap inside the panel.
  expect(after.x).toBe(before.x);
  expect(after.height).toBeGreaterThan(before.height);
  for (const part of [text, thread.locator(".reply")]) {
    const box = (await part.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width);
    expect(await part.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  // Between the comment and its replies there is only a labelled details line, never a bare "/" for the root page.
  expect(await thread.locator(".thread-content > *").evaluateAll((parts) => parts.map((part) => part.className))).toEqual(["thread-meta muted", "replies"]);
  await expect(thread.locator(".thread-meta")).toHaveText("Page /page");

  await inBar(page, "[data-filter=progress]").click();
  await expect(inBar(page, ".thread:not([hidden]) .thread-text")).toHaveText(["Being worked on"]);
  await expect(inBar(page, ".thread:not([hidden]) .badge")).toHaveText(["In progress"]);
  await inBar(page, "[data-filter=done]").click();
  await expect(inBar(page, ".thread:not([hidden]) .badge")).toHaveText(["Done"]);
});
