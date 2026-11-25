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
  await expect(inBar(page, "[data-role=updates-npm]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { checks?: number }).checks ?? 0)).toBe(0);
  await inBar(page, "[data-role=updates-check]").click();
  await expect(updates).toContainText("0.2.0 available");
  await expect(updates).toContainText("not on npm yet");
  // The command names only what the registry has a newer version of.
  await expect(inBar(page, "[data-role=updates-npm] .snippet-text")).toHaveText("npm install -D @iterbar/vite@0.2.0");
  // With the dev server's link, the daemon can be restarted from here.
  await expect(inBar(page, "[data-role=daemon-restart]")).toBeVisible();
});

test("keeps keyboard focus on the control in use, and Restart stops the daemon and starts the next one", async ({ page, openFixture, fixtureServer }) => {
  const first = await fakeDaemon(page, fixtureServer.origin);
  const second = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await page.evaluate(({ first, second }) => {
    const bar = window.fixture.mountIterbarBar({
      daemonUrl: first.url, token: first.token,
      devServer: { about: null, reconnect: async () => ({ daemonUrl: second.url, token: second.token }), checkUpdates: async () => ({ packages: [] }) },
    });
    bar.expanded = true;
  }, { first: { url: first.url, token: first.token }, second: { url: second.url, token: second.token } });
  await expect(inBar(page, "[data-role=status]")).toHaveText("Connected");
  await openPanel(page, "settings");
  // Space on a toggle, and arrow keys in a choice, leave focus where it was.
  await inBar(page, "[data-role=settings-screenshots]").focus();
  await page.keyboard.press("Space");
  await expect(inBar(page, "[data-role=settings-screenshots]")).toBeFocused();
  await expect(inBar(page, "[data-role=settings-screenshots]")).not.toBeChecked();
  await inBar(page, "[data-role=settings-theme] [data-value=auto]").focus();
  await page.keyboard.press("ArrowRight");
  await expect(inBar(page, "[data-role=settings-theme] [data-value=light]")).toBeFocused();
  await expect(inBar(page, "[data-role=settings-theme] [data-value=light]")).toHaveAttribute("aria-checked", "true");
  // A confirmation takes focus on Cancel, and Cancel gives it back to the button that opened it.
  await inBar(page, "[data-role=daemon-stop]").click();
  await expect(inBar(page, "[data-role=settings-cancel]")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(inBar(page, "[data-role=daemon-stop]")).toBeFocused();
  // Restart: the first daemon is asked to stop, and the bar connects to the one the dev server hands it next.
  await inBar(page, "[data-role=daemon-restart]").focus();
  await page.keyboard.press("Enter");
  await expect(inBar(page, "[data-role=settings-message]")).toHaveText("The daemon restarted.");
  // Focus stays in the sheet through the action, back on Restart.
  await expect(inBar(page, "[data-role=daemon-restart]")).toBeFocused();
  expect(first.shutdowns).toBe(1);
  await expect.poll(() => page.evaluate(() => (document.querySelector("iterbar-bar") as HTMLElement & { daemonUrl: string }).daemonUrl)).toBe(second.url);
  await expect(inBar(page, "[data-role=status]")).toHaveText("Connected");
});

test("forgets the earlier daemon when the bar loses its configuration, and says nothing of updates it could not check", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await page.evaluate(({ url, token }) => {
    const bar = window.fixture.mountIterbarBar({
      daemonUrl: url, token,
      devServer: {
        about: { packages: [{ name: "@iterbar/vite", version: "0.1.0" }], cli: null },
        reconnect: async () => ({ daemonUrl: null, token: null }),
        checkUpdates: async () => ({ packages: [{ name: "@iterbar/vite", installed: "0.1.0", latest: null, error: "timed out" }] }),
      },
    });
    bar.expanded = true;
  }, { url: daemon.url, token: daemon.token });
  await openPanel(page, "settings");
  await expect(inBar(page, "[data-role=settings-daemon]")).toContainText("Process 4242");
  await inBar(page, "[data-role=updates-check]").click();
  await expect(inBar(page, "[data-role=settings-updates]")).toContainText("couldn't check");
  await expect(inBar(page, "[data-role=updates-none]")).toHaveCount(0);
  await inBar(page, "[data-role=data-delete]").click();
  await expect(inBar(page, ".settings-confirm")).toBeVisible();
  await page.evaluate(() => { (document.querySelector("iterbar-bar") as HTMLElement & { token: string | null }).token = null; });
  await expect(inBar(page, ".settings-confirm")).toHaveCount(0);
  await expect(inBar(page, "[data-role=settings-daemon]")).not.toContainText("Process 4242");
});

test("a remount for another dev server while Start waits voids it: nothing stays busy and its answer is dropped", async ({ page, openFixture }) => {
  await openFixture();
  await page.evaluate(() => {
    const w = window as unknown as { release?: () => void };
    const bar = window.fixture.mountIterbarBar({
      devServer: {
        about: null,
        reconnect: () => new Promise((resolve) => {
          w.release = () => resolve({ daemonUrl: null, token: null });
        }),
        checkUpdates: async () => ({ packages: [] }),
      },
    });
    bar.expanded = true;
  });
  await openPanel(page, "settings");
  await inBar(page, "[data-role=daemon-start]").click();
  await expect(inBar(page, "[data-role=daemon-start]")).toHaveAttribute("aria-disabled", "true");
  // Set up again for another dev server before the first one answers.
  await page.evaluate(() => {
    window.fixture.mountIterbarBar({
      devServer: { about: null, reconnect: async () => ({ daemonUrl: null, token: null }), checkUpdates: async () => ({ packages: [] }) },
    });
  });
  await expect(inBar(page, "[data-role=daemon-start]")).not.toHaveAttribute("aria-disabled", "true");
  await page.evaluate(() => (window as unknown as { release: () => void }).release());
  await page.waitForTimeout(200);
  await expect(inBar(page, "[data-role=settings-message]")).toBeHidden();
});

test("a Start whose dev server answers after the bar was pointed at another daemon changes nothing", async ({ page, openFixture, fixtureServer }) => {
  const other = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await page.evaluate(() => {
    const w = window as unknown as { release?: () => void };
    const bar = window.fixture.mountIterbarBar({
      devServer: {
        about: null,
        reconnect: () => new Promise((resolve) => {
          w.release = () => resolve({ daemonUrl: "http://127.0.0.1:9", token: "1".repeat(64) });
        }),
        checkUpdates: async () => ({ packages: [] }),
      },
    });
    bar.expanded = true;
  });
  await openPanel(page, "settings");
  await inBar(page, "[data-role=daemon-start]").click();
  // The same dev server and project, pointed at daemon B before the dev server answers about A.
  await page.evaluate(({ url, token }) => {
    const bar = document.querySelector("iterbar-bar") as HTMLElement & { daemonUrl: string; token: string };
    bar.daemonUrl = url;
    bar.token = token;
  }, { url: other.url, token: other.token });
  await expect(inBar(page, "[data-role=status]")).toHaveText("Connected");
  await page.evaluate(() => (window as unknown as { release: () => void }).release());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (document.querySelector("iterbar-bar") as HTMLElement & { daemonUrl: string }).daemonUrl)).toBe(other.url);
});

test("a Start voided by a switch away and back again still changes nothing when its answer comes", async ({ page, openFixture, fixtureServer }) => {
  const first = await fakeDaemon(page, fixtureServer.origin);
  const second = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await page.evaluate(({ url, token }) => {
    const w = window as unknown as { release?: () => void };
    const bar = window.fixture.mountIterbarBar({
      daemonUrl: "http://127.0.0.1:9", token: "2".repeat(64),
      devServer: {
        about: null,
        reconnect: () => new Promise((resolve) => {
          w.release = () => resolve({ daemonUrl: url, token });
        }),
        checkUpdates: async () => ({ packages: [] }),
      },
    });
    bar.expanded = true;
  }, { url: first.url, token: first.token });
  await openPanel(page, "settings");
  await inBar(page, "[data-role=daemon-start]").click();
  // Away to B and back to the unreachable daemon the bar began with.
  await page.evaluate(({ url, token }) => {
    const bar = document.querySelector("iterbar-bar") as HTMLElement & { daemonUrl: string; token: string };
    bar.daemonUrl = url;
    bar.token = token;
  }, { url: second.url, token: second.token });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const bar = document.querySelector("iterbar-bar") as HTMLElement & { daemonUrl: string; token: string };
    bar.daemonUrl = "http://127.0.0.1:9";
    bar.token = "2".repeat(64);
  });
  await page.evaluate(() => (window as unknown as { release: () => void }).release());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (document.querySelector("iterbar-bar") as HTMLElement & { daemonUrl: string }).daemonUrl)).toBe("http://127.0.0.1:9");
});
