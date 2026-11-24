import { SCHEMA_VERSION } from "iterbar";
import { comment, fakeDaemon } from "./support/fake-daemon.js";
import { expect, inBar, mountBar, openPanel, test } from "./support/fixtures.js";

// The inbox's filters, its fixed height, selection and the actions on one thread or a selection.

async function openInbox(page: import("@playwright/test").Page, openFixture: () => Promise<void>, items: ReturnType<typeof comment>[], origin: string) {
  const daemon = await fakeDaemon(page, origin, items);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await openPanel(page, "inbox");
  await expect(inBar(page, ".thread")).not.toHaveCount(0);
  return daemon;
}

const texts = (page: import("@playwright/test").Page) => inBar(page, ".thread .thread-text");

test("keeps one height for every filter, shows resolved as Done and lists archived threads only under Archived", async ({ page, openFixture, fixtureServer }) => {
  await openInbox(page, openFixture, [
    comment("Open one"), comment("Answered", { status: "resolved" }), comment("Changed", { status: "done" }),
    comment("Put away", { status: "archived" }),
  ], fixtureServer.origin);
  await expect(inBar(page, "[data-filter]")).toHaveText(["All3", "Open1", "In progress0", "Done2", "Archived1"]);
  await expect(texts(page)).toHaveText(["Changed", "Answered", "Open one"]);
  await expect(inBar(page, `.thread[data-status=resolved] .badge`)).toHaveText("Done");
  const heights = new Set<number>();
  for (const filter of ["all", "open", "progress", "done", "archived"]) {
    await inBar(page, `[data-filter=${filter}]`).click();
    heights.add(Math.round((await inBar(page, "[data-role=panel]").boundingBox())!.height));
  }
  expect(heights.size).toBe(1);
  await expect(texts(page)).toHaveText(["Put away"]);
  await expect(inBar(page, ".thread .badge")).toHaveText("Archived");
  // The empty state says what is empty.
  await inBar(page, "[data-filter=progress]").click();
  await expect(inBar(page, "[data-role=threads-filtered-empty]")).toHaveText("Nothing in In progress.");
});

test("selects with the checkbox, shift-click, Ctrl/Cmd-click and by dragging across rows, and Escape clears it", async ({ page, openFixture, fixtureServer }) => {
  const items = Array.from({ length: 6 }, (_, index) => comment(`Thread ${index}`));
  await openInbox(page, openFixture, items, fixtureServer.origin);
  const rows = inBar(page, ".thread");
  const count = inBar(page, "[data-role=inbox-count]");
  await expect(count).toHaveText("6 of 6");

  await rows.nth(0).locator("[data-role=thread-select]").check();
  await rows.nth(2).locator("[data-role=thread-select]").click({ modifiers: ["Shift"] });
  await expect(count).toHaveText("3 selected");
  await rows.nth(4).locator("summary").click({ modifiers: ["ControlOrMeta"] });
  await expect(count).toHaveText("4 selected");
  // A modifier click selects instead of opening the thread.
  await expect(rows.nth(4).locator("details")).not.toHaveAttribute("open", "");
  await expect(inBar(page, "[data-role=select-all]")).toHaveJSProperty("indeterminate", true);
  await page.keyboard.press("Escape");
  await expect(count).toHaveText("6 of 6");
  // Escape cleared the selection; the panel stays open until the next Escape.
  await expect(inBar(page, "[data-role=panel]")).toBeVisible();

  // Dragging from one summary across three more selects all four, and opens none of them.
  const first = (await rows.nth(1).locator("summary").boundingBox())!;
  const last = (await rows.nth(4).locator("summary").boundingBox())!;
  await page.mouse.move(first.x + 40, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + 40, last.y + last.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(count).toHaveText("4 selected");
  await expect(inBar(page, ".thread[data-selected] .thread-text")).toHaveText(["Thread 4", "Thread 3", "Thread 2", "Thread 1"]);
  await expect(inBar(page, ".thread details[open]")).toHaveCount(0);
  // An ordinary click afterwards opens a thread again.
  await rows.nth(0).locator("summary").click();
  await expect(rows.nth(0).locator("details")).toHaveAttribute("open", "");

  await inBar(page, "[data-role=select-all]").check();
  await expect(count).toHaveText("6 selected");
  await inBar(page, "[data-role=clear-selection]").click();
  await expect(count).toHaveText("6 of 6");
});

test("marks done, reopens and archives a selection, offering only the actions that change something", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await openInbox(page, openFixture, [comment("A"), comment("B"), comment("C", { status: "done" })], fixtureServer.origin);
  const rows = inBar(page, ".thread");
  await inBar(page, "[data-role=select-all]").check();
  // Two open and one done: every action applies to some of them.
  for (const action of ["done", "reopen", "archive", "delete"]) await expect(inBar(page, `[data-bulk=${action}]`)).toBeVisible();
  await rows.nth(0).locator("[data-role=thread-select]").uncheck();
  // A and B are open: nothing to reopen.
  await expect(inBar(page, "[data-bulk=reopen]")).toBeHidden();
  await inBar(page, "[data-bulk=done]").click();
  await expect(inBar(page, "[data-filter=done]")).toHaveAttribute("aria-label", "Done, 3");
  // One request per thread it changes: A and B, not the unselected C.
  const [a, b] = daemon.items;
  expect(daemon.requests.filter((request) => request.method === "POST" && request.path.endsWith("/status")).map((request) => request.path).sort())
    .toEqual([`/feedback/${a!.id}/status`, `/feedback/${b!.id}/status`]);
  await expect(inBar(page, "[data-role=inbox-count]")).toHaveText("3 of 3");

  await inBar(page, "[data-role=select-all]").check();
  await inBar(page, "[data-bulk=archive]").click();
  await expect(inBar(page, "[data-filter=archived]")).toHaveAttribute("aria-label", "Archived, 3");
  await expect(inBar(page, "[data-role=threads-filtered-empty]")).toHaveText("Nothing here: every thread is archived.");
  expect(daemon.items.map((item) => item.status)).toEqual(["archived", "archived", "archived"]);

  // One thread's own actions: open it under Archived and reopen it.
  await inBar(page, "[data-filter=archived]").click();
  await rows.nth(0).locator("summary").click();
  await expect(rows.nth(0).locator("[data-action]")).toHaveText(["Mark done", "Reopen", "Delete"]);
  await rows.nth(0).locator("[data-action=reopen]").click();
  await expect(inBar(page, "[data-filter=open]")).toHaveAttribute("aria-label", "Open, 1");
});

test("deletes after an undo window, and Undo brings the threads back without a request", async ({ page, openFixture, fixtureServer }) => {
  await page.clock.install();
  const items = [comment("Keep"), comment("Drop one"), comment("Drop two")];
  const daemon = await openInbox(page, openFixture, items, fixtureServer.origin);
  const rows = inBar(page, ".thread");
  await rows.nth(0).locator("[data-role=thread-select]").check();
  await rows.nth(1).locator("[data-role=thread-select]").click({ modifiers: ["Shift"] });
  await inBar(page, "[data-bulk=delete]").click();
  await expect(inBar(page, "[data-role=undo]")).toContainText("Deleted 2 threads.");
  await expect(texts(page)).toHaveText(["Keep"]);
  await inBar(page, "[data-role=undo-delete]").click();
  await expect(texts(page)).toHaveText(["Drop two", "Drop one", "Keep"]);
  expect(daemon.requests.filter((request) => request.method === "DELETE")).toEqual([]);

  await rows.nth(0).locator("[data-role=thread-select]").check();
  await inBar(page, "[data-bulk=delete]").click();
  await page.clock.runFor(7000);
  await expect.poll(() => daemon.requests.filter((request) => request.method === "DELETE").map((request) => request.path))
    .toEqual([`/feedback/${items[2]!.id}`]);
  await expect(inBar(page, "[data-role=undo]")).toBeHidden();
  expect(daemon.items.map((item) => item.text)).toEqual(["Keep", "Drop one"]);

  // A delete from elsewhere (another tab, say) arrives as an event and removes the thread here too.
  daemon.send({ schemaVersion: SCHEMA_VERSION, type: "feedback.deleted", feedbackId: daemon.items[1]!.id });
  await expect(texts(page)).toHaveText(["Keep"]);
});

test("drops a selected thread from the selection when it leaves the filter, so a bulk action never reaches it", async ({ page, openFixture, fixtureServer }) => {
  const items = [comment("Stays open"), comment("Gets picked up")];
  const daemon = await openInbox(page, openFixture, items, fixtureServer.origin);
  await inBar(page, "[data-filter=open]").click();
  await inBar(page, "[data-role=select-all]").check();
  await expect(inBar(page, "[data-role=inbox-count]")).toHaveText("2 selected");
  const moved = items[1]!;
  daemon.send({ schemaVersion: SCHEMA_VERSION, type: "feedback.updated", feedback: { ...moved, status: "working", updatedAt: new Date(Date.parse(moved.updatedAt) + 1000).toISOString() } });
  await expect(inBar(page, "[data-role=inbox-count]")).toHaveText("1 selected");
  await inBar(page, "[data-bulk=archive]").click();
  await expect.poll(() => daemon.requests.filter((request) => request.path.endsWith("/status")).map((request) => request.path)).toEqual([`/feedback/${items[0]!.id}/status`]);
});

test("a delete still undoable is sent when the bar is removed, and survives the bar's connection closing", async ({ page, openFixture, fixtureServer }) => {
  const items = [comment("Keep"), comment("Drop")];
  const daemon = await openInbox(page, openFixture, items, fixtureServer.origin);
  await inBar(page, `[data-feedback-id="${items[1]!.id}"] [data-role=thread-select]`).check();
  await inBar(page, "[data-bulk=delete]").click();
  await expect(inBar(page, "[data-role=undo]")).toBeVisible();
  await page.evaluate(() => document.querySelector("iterbar-bar")!.remove());
  await expect.poll(() => daemon.items.map((item) => item.text)).toEqual(["Keep"]);
});

test("a bulk delete removes the threads that went even when one fails, and Escape keeps focus in the inbox", async ({ page, openFixture, fixtureServer }) => {
  await page.clock.install();
  const items = [comment("Goes"), comment("Fails")];
  const daemon = await openInbox(page, openFixture, items, fixtureServer.origin);
  await page.route(`${daemon.url}/feedback/${items[1]!.id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    await route.fulfill({ status: 500, headers: { "access-control-allow-origin": fixtureServer.origin }, contentType: "application/json", body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, error: { code: "internal", message: "disk full" } }) });
  });
  await inBar(page, "[data-role=select-all]").check();
  await inBar(page, "[data-bulk=delete]").click();
  await page.clock.runFor(7000);
  await expect(inBar(page, "[data-role=inbox-error]")).toContainText("1 of 2 could not be deleted");
  await expect(texts(page)).toHaveText(["Fails"]);

  await inBar(page, "[data-role=select-all]").check();
  await inBar(page, "[data-bulk=archive]").focus();
  await page.keyboard.press("Escape");
  await expect(inBar(page, "[data-role=inbox-count]")).toHaveText("1 of 1");
  await expect(inBar(page, "[data-role=select-all]")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(inBar(page, "[data-role=panel]")).toBeHidden();
});

test("Show more from the keyboard moves focus to the first thread it lists", async ({ page, openFixture, fixtureServer }) => {
  const items = Array.from({ length: 30 }, (_, index) => comment(`Thread ${index}`));
  await openInbox(page, openFixture, items, fixtureServer.origin);
  await inBar(page, "[data-role=threads-more]").focus();
  await page.keyboard.press("Enter");
  await expect(inBar(page, "[data-role=inbox-count]")).toHaveText("30 of 30");
  await expect(inBar(page, ".thread").nth(25).locator("summary")).toBeFocused();
});

test("a delete that leaves room among the kept threads lists again to bring in the next older one", async ({ page, openFixture, fixtureServer }) => {
  const items = Array.from({ length: 501 }, (_, index) => comment(`Thread ${index}`));
  const daemon = await openInbox(page, openFixture, items, fixtureServer.origin);
  await expect(inBar(page, "[data-filter=all]")).toHaveAttribute("aria-label", "All, 500");
  const listings = () => daemon.requests.filter((request) => request.method === "GET" && request.path === "/feedback").length;
  const before = listings();
  daemon.items = daemon.items.filter((item) => item.id !== items[500]!.id);
  daemon.send({ schemaVersion: SCHEMA_VERSION, type: "feedback.deleted", feedbackId: items[500]!.id });
  await expect.poll(listings).toBeGreaterThan(before);
  await expect(inBar(page, "[data-filter=all]")).toHaveAttribute("aria-label", "All, 500");
  await expect(inBar(page, "[data-role=threads-older]")).toBeHidden();
});

test("a reply that leaves a thread's actions as they were keeps focus on the same action", async ({ page, openFixture, fixtureServer }) => {
  const item = comment("Focus me");
  const daemon = await openInbox(page, openFixture, [item], fixtureServer.origin);
  await inBar(page, ".thread summary").click();
  await inBar(page, ".thread [data-action=archive]").focus();
  daemon.send({
    schemaVersion: SCHEMA_VERSION, type: "feedback.updated",
    feedback: { ...item, updatedAt: new Date(Date.parse(item.updatedAt) + 1000).toISOString(), replies: [{ id: "r1", author: { kind: "agent", name: null }, text: "On it.", createdAt: item.updatedAt }] },
  });
  await expect(inBar(page, ".thread .reply")).toHaveCount(1);
  await expect(inBar(page, ".thread [data-action=archive]")).toBeFocused();
});

test("deleting from the keyboard moves focus to Undo, and Undo returns it to the restored thread", async ({ page, openFixture, fixtureServer }) => {
  const item = comment("Delete me");
  await openInbox(page, openFixture, [comment("Keep"), item], fixtureServer.origin);
  await inBar(page, `[data-feedback-id="${item.id}"] summary`).click();
  await inBar(page, `[data-feedback-id="${item.id}"] [data-action=delete]`).focus();
  await page.keyboard.press("Enter");
  await expect(inBar(page, "[data-role=undo-delete]")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(inBar(page, `[data-feedback-id="${item.id}"] summary`)).toBeFocused();
});
