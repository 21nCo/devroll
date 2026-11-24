import { comment, fakeDaemon } from "./support/fake-daemon.js";
import { expect, inBar, mountBar, openPanel, test } from "./support/fixtures.js";

// Iterbar's settings sheet: the daemon and MCP server, updates, the toolbar's options and the project's data.

test("opens from the gear just before Help, and shows the daemon's process", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await expect(inBar(page, "[data-role=status]")).toHaveText("Connected");
  const order = await page.evaluate(() => [...document.querySelector("iterbar-bar")!.shadowRoot!.querySelectorAll(".toolbar > button")]
    .map((button) => (button as HTMLElement).dataset.role));
  expect(order.slice(-2)).toEqual(["settings-toggle", "help-toggle"]);
  await openPanel(page, "settings");
  await expect(inBar(page, ".panel-title")).toHaveText("Iterbar settings");
  await expect(inBar(page, "[data-role=panel]")).toHaveAttribute("data-mode", "sheet");
  await expect(inBar(page, "[data-role=settings-daemon]")).toContainText("Process 4242");
  // Without the Vite plugin the bar can't start the daemon, and says so; it can still stop it, after a confirmation.
  await expect(inBar(page, "[data-role=daemon-start]")).toHaveCount(0);
  await expect(inBar(page, "[data-role=settings-daemon]")).toContainText("no Iterbar dev-server plugin");
  await inBar(page, "[data-role=daemon-stop]").click();
  await expect(inBar(page, "[data-role=settings-cancel]")).toBeFocused();
  await inBar(page, "[data-role=settings-cancel]").click();
  expect(daemon.shutdowns).toBe(0);
  await inBar(page, "[data-role=daemon-stop]").click();
  await inBar(page, "[data-role=daemon-stop-confirm]").click();
  await expect.poll(() => daemon.shutdowns).toBe(1);
});

test("deletes all of the project's data only after a confirmation that says what goes", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("First"), comment("Second")]);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await expect(inBar(page, "[data-role=open-count]")).toHaveText("2");
  await openPanel(page, "settings");
  await expect(inBar(page, "[data-role=settings-daemon]")).toContainText("Process 4242");
  await inBar(page, "[data-role=data-delete]").click();
  const confirm = inBar(page, ".settings-confirm");
  await expect(confirm).toContainText("2 threads");
  await expect(confirm).toContainText("/work/shop/.iterbar/feedback");
  await expect(confirm).toContainText("leaves your code");
  expect(daemon.items).toHaveLength(2);
  await inBar(page, "[data-role=data-delete-confirm]").click();
  await expect(inBar(page, "[data-role=settings-message]")).toHaveText("Deleted 2 items.");
  expect(daemon.items).toHaveLength(0);
  await expect(inBar(page, "[data-role=open-count]")).toBeHidden();
});

test("the toolbar's options: position, colours, shortcuts, screenshots and pins", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await openPanel(page, "settings");
  const dock = inBar(page, ".dock");

  // Colours: dark whatever the system says, then back to the system's.
  await page.emulateMedia({ colorScheme: "light" });
  const background = () => dock.locator(".toolbar").evaluate((element) => getComputedStyle(element).backgroundColor);
  const light = await background();
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await background();
  expect(dark).not.toBe(light);
  await page.emulateMedia({ colorScheme: "light" });
  await inBar(page, "[data-role=settings-theme] [data-value=dark]").click();
  await expect(dock).toHaveAttribute("data-theme", "dark");
  expect(await background()).toBe(dark);
  await inBar(page, "[data-role=settings-theme] [data-value=light]").click();
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await background()).toBe(light);
  await inBar(page, "[data-role=settings-theme] [data-value=auto]").click();
  expect(await background()).toBe(dark);
  await page.emulateMedia({ colorScheme: "light" });

  // Position: the toolbar moves to the left.
  await inBar(page, "[data-role=settings-position] [data-value='0']").click();
  await expect.poll(async () => Math.round((await inBar(page, "[data-role=logo]").boundingBox())!.x)).toBeLessThan(40);

  // Shortcuts off: C no longer enters comment mode.
  await inBar(page, "[data-role=settings-shortcuts]").uncheck();
  await inBar(page, "[data-role=panel-close]").click();
  await page.locator("#page-text").click();
  await page.keyboard.press("c");
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "false");

  // The choices are remembered.
  const stored = await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith("iterbar:toolbar"))?.[1] ?? "");
  expect(JSON.parse(stored)).toMatchObject({ theme: "auto", shortcuts: false, x: 0 });
});

test("shows the installed versions and checks for updates only when asked", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await page.evaluate(({ url, token }) => {
    let checks = 0;
    const bar = window.fixture.mountIterbarBar({
      daemonUrl: url, token,
      devServer: {
        about: { packages: [{ name: "@iterbar/vite", version: "0.1.0" }, { name: "@iterbar/cli", version: "0.1.0" }], cli: { path: "/repo/cli/dist/cli.js", version: "0.1.0" } },
        reconnect: async () => ({ daemonUrl: url, token }),
        checkUpdates: async () => {
          checks += 1;
          (window as unknown as { checks: number }).checks = checks;
          return { packages: [{ name: "@iterbar/vite", installed: "0.1.0", latest: "0.2.0" }, { name: "@iterbar/cli", installed: "0.1.0", latest: null }] };
        },
      },
    });
    bar.expanded = true;
  }, { url: daemon.url, token: daemon.token });
  await openPanel(page, "settings");
  const updates = inBar(page, "[data-role=settings-updates]");
  await expect(updates).toContainText("@iterbar/vite");
  await expect(updates).toContainText("npm install -D @iterbar/vite@latest @iterbar/cli@latest");
  expect(await page.evaluate(() => (window as unknown as { checks?: number }).checks ?? 0)).toBe(0);
  await inBar(page, "[data-role=updates-check]").click();
  await expect(updates).toContainText("0.2.0 available");
  await expect(updates).toContainText("not on npm yet");
  // With the dev server's link, the daemon can be restarted from here.
  await expect(inBar(page, "[data-role=daemon-restart]")).toBeVisible();
});
