import type { Locator, Page } from "@playwright/test";
import type { FeedbackDraft } from "iterbar";
import { fakeDaemon, type FakeDaemon } from "./support/fake-daemon.js";
import { expect, inBar, mountBar, PRICING, registerSlots, test } from "./support/fixtures.js";
import { pngSize } from "./support/png.js";

// Comment mode against a fake daemon that records each POST /feedback: picking, the selector's closed set, the
// target description, the screenshot and its failure path, and what the page receives while picking.

const CASES_HTML = `
<section class="cases">
  <button type="button" data-testid="save" data-case="testid">Save</button>
  <button type="button" data-testid="dup" data-case="dup-a">A</button>
  <button type="button" data-testid="dup" id="dup-b" data-case="id">B</button>
  <div class="card" data-iterbar-src="src/Card.tsx:4:3">
    <p class="lead">First</p>
    <p class="lead" data-case="stamped">Second <b>line</b></p>
  </div>
  <div data-iterbar-slot="pricing">
    <ul class="plans">
      <li class="plan" data-iterbar-src="src/Plans.tsx:7:9"><span class="name">Free</span></li>
      <li class="plan" data-iterbar-src="src/Plans.tsx:7:9"><span class="name" data-case="slot">Pro</span></li>
    </ul>
  </div>
  <div class="plain"><p>One <em data-case="root">two</em></p></div>
</section>`;

async function openCases(page: Page, openFixture: (path?: string) => Promise<void>, daemon?: FakeDaemon): Promise<void> {
  await openFixture();
  await page.evaluate((html) => {
    document.querySelector("main")!.insertAdjacentHTML("beforeend", html);
    window.pageEvents = [];
    for (const type of ["pointerdown", "mousedown", "click"]) {
      document.addEventListener(type, (event) => window.pageEvents.push(`${type}:${(event.target as Element).localName}`));
    }
  }, CASES_HTML);
  await mountBar(page, daemon ? { daemonUrl: daemon.url, token: daemon.token } : {});
}

async function enterCommentMode(page: Page): Promise<void> {
  await inBar(page, "[data-role=comment]").click();
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "true");
}

/** Picks `target`, types `text` and sends it; resolves with the draft the daemon received. */
async function comment(page: Page, daemon: FakeDaemon, target: Locator, text: string): Promise<FakeDaemon["posts"][number]> {
  const before = daemon.posts.length;
  await enterCommentMode(page);
  await target.click();
  await inBar(page, "[data-role=composer-text]").fill(text);
  await inBar(page, "[data-role=composer-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(before + 1);
  return daemon.posts[before]!;
}

/** How many `POST /feedback` requests reached the daemon, held or not. */
function feedbackPosts(daemon: FakeDaemon): number {
  return daemon.requests.filter((request) => request.method === "POST" && request.path === "/feedback").length;
}

/**
 * Serves a `width` x `height` SVG at `url` only once the returned function is called. The capture waits for the
 * images in the element, so this holds a screenshot back for as long as the test needs.
 */
async function heldImage(page: Page, url: string, width: number, height: number): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const body = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#c60"/></svg>`;
  await page.route(url, async (route) => {
    await released;
    await route.fulfill({ status: 200, contentType: "image/svg+xml", headers: { "cache-control": "no-store" }, body });
  });
  return release;
}

/** Counts the PNGs the page's canvases have produced in `window.canvasBlobs`. */
async function countCanvasBlobs(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.canvasBlobs = 0;
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
      toBlob.call(this, (blob) => {
        window.canvasBlobs += 1;
        callback(blob);
      }, ...rest);
    };
  });
}

/** What `selector` matches in the page, by `data-case`. */
function resolve(page: Page, selector: string): Promise<(string | undefined)[]> {
  return page.evaluate((value) => [...document.querySelectorAll<HTMLElement>(value)].map((element) => element.dataset.case), selector);
}

const SELECTOR_CASES = [
  { form: "its unique data-testid", target: "testid", selector: '[data-testid="save"]', source: null },
  { form: "its id when the data-testid is shared", target: "id", selector: "#dup-b", source: null },
  {
    form: "a path from the nearest stamped ancestor",
    target: "stamped",
    selector: '[data-iterbar-src="src/Card.tsx:4:3"] > p.lead:nth-of-type(2)',
    source: { path: "src/Card.tsx", line: 4, column: 3 },
  },
  {
    form: "a path from the slot root when the nearer stamps repeat",
    target: "slot",
    selector: '[data-iterbar-slot="pricing"] > ul.plans > li.plan:nth-of-type(2) > span.name',
    source: { path: "src/Plans.tsx", line: 7, column: 9 },
  },
  {
    form: "a path from :root without a stamped or slot ancestor",
    target: "root",
    selector: ":root > body > main > section.cases > div.plain:nth-of-type(3) > p > em",
    source: null,
  },
] as const;

test.describe("selector closed set", () => {
  for (const { form, target, selector, source } of SELECTOR_CASES) {
    test(`names a picked element by ${form}, which resolves back to it`, async ({ page, openFixture, fixtureServer }) => {
      const daemon = await fakeDaemon(page, fixtureServer.origin);
      await openCases(page, openFixture, daemon);
      const { draft } = await comment(page, daemon, page.locator(`[data-case="${target}"]`), `About ${target}`);
      expect(draft.target?.selector).toBe(selector);
      expect(draft.target?.sourceLocation).toEqual(source);
      expect(await resolve(page, selector)).toEqual([target]);
    });
  }
});

test("quotes awkward attribute values so the selector still resolves", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openCases(page, openFixture, daemon);
  await page.evaluate(() => {
    const awkward = document.createElement("span");
    awkward.textContent = "Awkward";
    awkward.dataset.case = "awkward";
    awkward.dataset.testid = 'say "hi"\\now\nplease';
    document.querySelector("main")!.append(awkward);
  });
  const { draft } = await comment(page, daemon, page.locator('[data-case="awkward"]'), "Quoted");
  expect(draft.target?.selector).toBe('[data-testid="say \\"hi\\"\\\\now\\a please"]');
  expect(await resolve(page, draft.target!.selector)).toEqual(["awkward"]);
});

test("sends a comment with the excerpt, document box, source, active variants and a PNG of the element", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture("/shop?iterbar=pricing:v2#top");
  await registerSlots(page, [PRICING]);
  await page.evaluate(() => {
    document.querySelector("main")!.insertAdjacentHTML("beforeend", `
      <div style="height: 1500px"></div>
      <div data-iterbar-src="src/Box.tsx:12:5">
        <div data-testid="box" style="width: 240px; height: 120px; overflow: hidden; background: #c00; color: #fff">
          ${"Lorem   ipsum\n dolor ".repeat(40)}
        </div>
      </div>`);
  });
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });

  const box = page.getByTestId("box");
  const { draft, screenshot } = await comment(page, daemon, box, "  Make this calmer\nplease ");
  const expected = await box.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height };
  });
  expect(expected.y).toBeGreaterThan(1500);

  expect(draft).toMatchObject({
    kind: "comment",
    text: "  Make this calmer\nplease ",
    pageUrl: `${fixtureServer.origin}/shop`,
    activeVariants: [{ slot: "pricing", version: "v2" }],
    screenshotUnavailableReason: null,
    evidenceWindow: null,
  } satisfies Partial<FeedbackDraft>);
  expect(draft.target).toEqual({
    selector: '[data-testid="box"]',
    textExcerpt: expect.any(String),
    boundingBox: expected,
    sourceLocation: { path: "src/Box.tsx", line: 12, column: 5 },
  });
  // Whitespace is collapsed and the text cut to 200 characters, ending with an ellipsis.
  expect(draft.target!.textExcerpt).toHaveLength(200);
  expect(draft.target!.textExcerpt).toMatch(/^Lorem ipsum dolor Lorem ipsum dolor .*…$/);

  expect(screenshot).not.toBeNull();
  expect(pngSize(screenshot!)).toEqual({ width: 240, height: 120 });

  // The thread appears in the bar and comment mode ends.
  await expect(inBar(page, '[data-feedback-id="posted-1"] .thread-text')).toHaveText("Make this calmer please");
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "false");
  await expect(inBar(page, "[data-section=composer]")).toBeHidden();
  await expect(inBar(page, "[data-role=pick-picked]")).toBeHidden();
});

test.describe("on a 2x display", () => {
  test.use({ deviceScaleFactor: 2 });

  test("captures at the device pixel ratio", async ({ page, openFixture, fixtureServer }) => {
    const daemon = await fakeDaemon(page, fixtureServer.origin);
    await openFixture();
    await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("beforeend",
      '<div data-testid="tile" style="width: 150px; height: 50px; background: #036"></div>'));
    await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
    const { screenshot } = await comment(page, daemon, page.getByTestId("tile"), "Sharper");
    expect(pngSize(screenshot!)).toEqual({ width: 300, height: 100 });
  });

  test("caps a large element at 4 MP, keeping its aspect ratio", async ({ page, openFixture, fixtureServer }) => {
    const daemon = await fakeDaemon(page, fixtureServer.origin);
    await openFixture();
    // 2000 x 1000 CSS pixels is 8 MP at 2x.
    await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("afterbegin",
      '<div data-testid="hero" style="width: 2000px; height: 1000px; background: linear-gradient(#fff, #000)"></div>'));
    await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
    const { draft, screenshot } = await comment(page, daemon, page.getByTestId("hero"), "Too big");
    expect(draft.screenshotUnavailableReason).toBeNull();
    const { width, height } = pngSize(screenshot!);
    expect(width * height).toBeLessThanOrEqual(4_000_000);
    expect(width * height).toBeGreaterThan(3_990_000);
    expect(width / height).toBeCloseTo(2, 2);
  });
});

test("keeps the screenshot within 4 MP when the element grows while it is being captured", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  // At the pick the element is 40 x 40; once its image loads, during the capture, it is 2500 x 2000 (5 MP).
  const release = await heldImage(page, `${fixtureServer.origin}/grow.svg`, 2500, 2000);
  await openFixture();
  await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("afterbegin",
    '<div data-testid="grows" style="display: inline-block; vertical-align: top; min-width: 40px; min-height: 40px; background: #036">'
    + '<img src="/grow.svg" alt="" style="display: block"></div>'));
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await enterCommentMode(page);
  await page.getByTestId("grows").click();
  await inBar(page, "[data-role=composer-text]").fill("Grew");
  await inBar(page, "[data-role=composer-send]").click();
  await expect(inBar(page, "[data-role=composer-send]")).toHaveText("Sending…");
  release();
  await expect.poll(() => daemon.posts.length).toBe(1);
  expect(await page.getByTestId("grows").evaluate((element) => element.getBoundingClientRect().width)).toBe(2500);
  const { draft, screenshot } = daemon.posts[0]!;
  expect(draft.screenshotUnavailableReason).toBeNull();
  const { width, height } = pngSize(screenshot!);
  expect(width * height).toBeLessThanOrEqual(4_000_000);
  expect(width * height).toBeGreaterThan(3_990_000);
  expect(width / height).toBeCloseTo(1.25, 2);
});

test("sends no screenshot, and says why, when the image produced is over 4 MP", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openCases(page, openFixture, daemon);
  // Whatever the renderer did, the image it hands back is checked: here every canvas exports 2001 x 2000.
  await page.evaluate(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
      const big = document.createElement("canvas");
      big.width = 2001;
      big.height = 2000;
      toBlob.call(big, callback, ...rest);
    };
  });
  const { draft, screenshot } = await comment(page, daemon, page.locator('[data-case="testid"]'), "Oversized");
  expect(screenshot).toBeNull();
  expect(draft.screenshotUnavailableReason).toBe("The screenshot failed: the image is 2001 x 2000 pixels, over the 4 MP cap");
  await expect(inBar(page, '[data-feedback-id="posted-1"] .thread-text')).toHaveText("Oversized");
});

test("still sends the comment when the screenshot fails, with the reason and no screenshot", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openCases(page, openFixture, daemon);
  // A tainted canvas (a cross-origin image without CORS) refuses every export like this.
  await page.evaluate(() => {
    const refuse = () => {
      throw new DOMException("Tainted canvases may not be exported.", "SecurityError");
    };
    HTMLCanvasElement.prototype.toBlob = refuse;
    HTMLCanvasElement.prototype.toDataURL = refuse;
  });
  const { draft, screenshot } = await comment(page, daemon, page.locator('[data-case="testid"]'), "No picture");
  expect(screenshot).toBeNull();
  expect(draft.screenshotUnavailableReason).toBe("The screenshot failed: Tainted canvases may not be exported.");
  expect(draft.target?.selector).toBe('[data-testid="save"]');
  await expect(inBar(page, '[data-feedback-id="posted-1"] .thread-text')).toHaveText("No picture");
});

test("sends no screenshot for an element without area, and says why", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openCases(page, openFixture, daemon);
  await enterCommentMode(page);
  // An empty element can still be clicked through the keyboard: Enter on a focused button.
  await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("beforeend",
    '<button type="button" data-testid="flat" style="width: 0; height: 0; padding: 0; border: 0; overflow: hidden"></button>'));
  await page.getByTestId("flat").focus();
  await page.keyboard.press("Enter");
  await inBar(page, "[data-role=composer-text]").fill("Invisible");
  await inBar(page, "[data-role=composer-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(1);
  expect(daemon.posts[0]!.screenshot).toBeNull();
  expect(daemon.posts[0]!.draft.screenshotUnavailableReason).toBe("The screenshot failed: the element has no visible area");
});

test("the page receives every event while comment mode is off, and none of a pick while it is on", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openCases(page, openFixture, daemon);
  const events = () => page.evaluate(() => window.pageEvents.splice(0));
  const save = page.locator('[data-case="testid"]');

  await save.click();
  expect(await events()).toEqual(["pointerdown:button", "mousedown:button", "click:button"]);
  await expect(inBar(page, "[data-role=pick-layer]")).toBeHidden();

  await enterCommentMode(page);
  await events();
  await save.hover();
  await expect(inBar(page, "[data-role=pick-hover]")).toBeVisible();
  expect(await inBar(page, "[data-role=pick-hover]").boundingBox()).toEqual(await save.boundingBox());
  await save.click();
  expect(await events()).toEqual([]);
  await expect(inBar(page, "[data-role=composer-target]")).toHaveText("On button");
  await expect(inBar(page, "[data-role=pick-picked]")).toBeVisible();
  // Focus moved to the composer, not to the clicked page button.
  expect(await page.evaluate(() => document.activeElement?.localName)).toBe("iterbar-bar");

  // Escape leaves comment mode from the composer; the page gets its events back at once.
  await inBar(page, "[data-role=composer-text]").fill("Never sent");
  await page.keyboard.press("Escape");
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "false");
  await expect(inBar(page, "[data-section=composer]")).toBeHidden();
  await expect(inBar(page, "[data-role=pick-layer]")).toBeHidden();
  await save.click();
  expect(await events()).toEqual(["pointerdown:button", "mousedown:button", "click:button"]);
  expect(daemon.posts).toEqual([]);

  // A page script's own click is never taken for a pick.
  await enterCommentMode(page);
  await events();
  await save.evaluate((button) => (button as HTMLElement).click());
  expect(await events()).toEqual(["click:button"]);
  await expect(inBar(page, "[data-section=composer]")).toBeHidden();
});

test("picking another element keeps the text, Cancel keeps comment mode, and a refused send can be retried", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openCases(page, openFixture, daemon);
  await enterCommentMode(page);
  await page.locator('[data-case="testid"]').click();
  await inBar(page, "[data-role=composer-text]").fill("Draft text");
  await page.locator('[data-case="id"]').click();
  await expect(inBar(page, "[data-role=composer-target]")).toHaveText("On button#dup-b");
  await expect(inBar(page, "[data-role=composer-text]")).toHaveValue("Draft text");

  await inBar(page, "[data-role=composer-cancel]").click();
  await expect(inBar(page, "[data-section=composer]")).toBeHidden();
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "true");
  await expect(inBar(page, "[data-role=pick-picked]")).toBeHidden();

  await page.locator('[data-case="stamped"]').click();
  await expect(inBar(page, "[data-role=composer-text]")).toHaveValue("");
  await expect(inBar(page, "[data-role=composer-send]")).toBeDisabled();
  await inBar(page, "[data-role=composer-text]").fill("Retry me");
  daemon.failFeedback = 500;
  await inBar(page, "[data-role=composer-send]").click();
  await expect(inBar(page, "[data-role=composer-error]")).toHaveText("The daemon refused it (500): The store is unavailable");
  await expect(inBar(page, "[data-role=composer-text]")).toHaveValue("Retry me");
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "true");

  daemon.failFeedback = null;
  await inBar(page, "[data-role=composer-text]").press("Control+Enter");
  await expect.poll(() => daemon.posts.length).toBe(1);
  expect(daemon.posts[0]!.draft.target?.selector).toBe('[data-iterbar-src="src/Card.tsx:4:3"] > p.lead:nth-of-type(2)');
  await expect(inBar(page, '[data-feedback-id="posted-1"] .thread-text')).toHaveText("Retry me");
});

test("Cancel or Escape while the screenshot is being taken withdraws the comment, and nothing is posted", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  const release = await heldImage(page, `${fixtureServer.origin}/slow.svg`, 40, 40);
  await openCases(page, openFixture, daemon);
  await countCanvasBlobs(page);
  await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("beforeend",
    '<div data-testid="slow" style="width: 120px; height: 60px; background: #036"><img src="/slow.svg" alt=""></div>'));
  const slow = page.getByTestId("slow");
  const text = inBar(page, "[data-role=composer-text]");
  const send = inBar(page, "[data-role=composer-send]");
  const cancel = inBar(page, "[data-role=composer-cancel]");

  await enterCommentMode(page);
  await slow.click();
  await text.fill("Withdrawn by Cancel");
  await send.click();
  await expect(send).toHaveText("Sending…");
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(inBar(page, "[data-section=composer]")).toBeHidden();
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "true");

  await slow.click();
  await expect(send).toHaveText("Send");
  await text.fill("Withdrawn by Escape");
  await send.click();
  await expect(send).toHaveText("Sending…");
  await page.keyboard.press("Escape");
  await expect(inBar(page, "[data-section=composer]")).toBeHidden();
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "false");

  // Both captures finish after they were withdrawn; neither comment is posted.
  release();
  await expect.poll(() => page.evaluate(() => window.canvasBlobs)).toBe(2);
  const { draft } = await comment(page, daemon, slow, "Kept");
  expect(draft.text).toBe("Kept");
  expect(feedbackPosts(daemon)).toBe(1);
  await expect(inBar(page, "[data-section=threads] [data-feedback-id]")).toHaveCount(1);
});

test("a comment already posted cannot be cancelled, and leaving comment mode keeps it until the daemon answers", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openCases(page, openFixture, daemon);
  const save = page.locator('[data-case="testid"]');
  const composer = inBar(page, "[data-section=composer]");
  const text = inBar(page, "[data-role=composer-text]");
  const send = inBar(page, "[data-role=composer-send]");
  const cancel = inBar(page, "[data-role=composer-cancel]");
  let answer!: () => void;
  daemon.holdFeedback = new Promise((resolve) => {
    answer = resolve;
  });

  await enterCommentMode(page);
  await save.click();
  await text.fill("In flight");
  await send.click();
  await expect.poll(() => feedbackPosts(daemon)).toBe(1);
  await expect(send).toHaveText("Sending…");
  await expect(cancel).toBeDisabled();
  await page.keyboard.press("Escape");
  // Comment mode ends and the page has its events back, but the comment is not shown as discarded.
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "false");
  await expect(inBar(page, "[data-role=pick-layer]")).toBeHidden();
  await expect(composer).toBeVisible();
  await expect(text).toHaveValue("In flight");
  await expect(send).toHaveText("Sending…");
  answer();
  await expect(inBar(page, '[data-feedback-id="posted-1"] .thread-text')).toHaveText("In flight");
  await expect(composer).toBeHidden();

  // A refusal that arrives after leaving comment mode is still shown, with the text, until Cancel.
  daemon.holdFeedback = new Promise((resolve) => {
    answer = resolve;
  });
  daemon.failFeedback = 500;
  await enterCommentMode(page);
  await save.click();
  await text.fill("Refused later");
  await send.click();
  await expect.poll(() => feedbackPosts(daemon)).toBe(2);
  await page.keyboard.press("Escape");
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "false");
  answer();
  await expect(inBar(page, "[data-role=composer-error]")).toHaveText("The daemon refused it (500): The store is unavailable");
  await expect(text).toHaveValue("Refused later");
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(composer).toBeHidden();
  expect(daemon.posts).toHaveLength(1);
});

test("says why a comment cannot be sent without a daemon", async ({ page, openFixture }) => {
  await openCases(page, openFixture);
  await enterCommentMode(page);
  await page.locator('[data-case="testid"]').click();
  await inBar(page, "[data-role=composer-text]").fill("Nowhere to go");
  await inBar(page, "[data-role=composer-send]").click();
  await expect(inBar(page, "[data-role=composer-error]")).toContainText("Comments need the Iterbar daemon");
});

test("removing the bar from the page leaves comment mode and gives the page its events back", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openCases(page, openFixture, daemon);
  await enterCommentMode(page);
  await page.evaluate(() => document.querySelector("iterbar-bar")!.remove());
  await page.evaluate(() => window.pageEvents.splice(0));
  await page.locator('[data-case="testid"]').click();
  expect(await page.evaluate(() => window.pageEvents)).toEqual(["pointerdown:button", "mousedown:button", "click:button"]);
});
