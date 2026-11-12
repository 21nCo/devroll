import type { Locator, Page } from "@playwright/test";
import type { FeedbackDraft } from "iterbar";
import { fakeDaemon, type FakeDaemon } from "./support/fake-daemon.js";
import { expect, inBar, mountBar, PRICING, registerSlots, test } from "./support/fixtures.js";
import { blockFontUrl } from "./support/font.js";
import { darkPixels, pngPixels, pngSize, quadrantColourCounts } from "./support/png.js";

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

/** Picks `target` (clicked at `position`, else its centre), types `text` and sends it; resolves with what the daemon received. */
async function comment(page: Page, daemon: FakeDaemon, target: Locator, text: string, position?: { x: number; y: number }): Promise<FakeDaemon["posts"][number]> {
  const before = daemon.posts.length;
  await enterCommentMode(page);
  await target.click(position ? { position } : {});
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

/**
 * Counts, in `window.cloned`, the nodes copied (`cloneNode`) inside each `[data-big]` subtree, by its value, and
 * records in `window.clonedRuns` the order in which the subtrees were copied, one entry per run.
 */
async function countClones(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as { cloned: Record<string, number>; clonedRuns: string[] };
    state.cloned = {};
    state.clonedRuns = [];
    const cloneNode = Node.prototype.cloneNode;
    Node.prototype.cloneNode = function (this: Node, deep?: boolean) {
      const big = (this instanceof Element ? this : this.parentElement)?.closest<HTMLElement>("[data-big]")?.dataset.big;
      if (big) {
        state.cloned[big] = (state.cloned[big] ?? 0) + 1;
        if (state.clonedRuns.at(-1) !== big) state.clonedRuns.push(big);
      }
      return cloneNode.call(this, deep);
    };
  });
}

/** Adds a `[data-big=name]` box holding `count` small elements to the page. */
async function addBigBox(page: Page, name: string, count: number): Promise<void> {
  await page.evaluate(({ name, count }) => {
    const box = document.createElement("div");
    box.dataset.big = name;
    box.dataset.testid = `big-${name}`;
    box.style.cssText = "width: 300px; height: 40px; overflow: hidden; background: #ddd";
    box.innerHTML = "<i></i>".repeat(count);
    document.querySelector("main")!.prepend(box);
  }, { name, count });
}

/** Picks `id` from the keyboard (an `<svg>` whose shapes cover it), sends it, and resolves with what the daemon received. */
async function commentFromKeyboard(page: Page, daemon: FakeDaemon, id: string): Promise<FakeDaemon["posts"][number]> {
  const index = daemon.posts.length;
  await enterCommentMode(page);
  await page.getByTestId(id).focus();
  await page.keyboard.press("Enter");
  await inBar(page, "[data-role=composer-text]").fill(id);
  await inBar(page, "[data-role=composer-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(index + 1);
  expect(daemon.posts[index]!.draft.target?.selector).toBe(`[data-testid="${id}"]`);
  return daemon.posts[index]!;
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

test("frames a transformed element at the image origin, keeping the transforms inside it", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("afterbegin", `
    <div data-testid="moved" style="position: relative; left: 15px; width: 100px; height: 50px; background: rgb(0, 255, 0);
      transform: translateX(120px)"></div>
    <div style="position: relative; height: 60px">
      <div data-testid="centred" style="position: absolute; left: 50%; width: 100px; height: 50px; background: rgb(0, 255, 0);
        transform: translate(-50%, 0); overflow: hidden">
        <div style="width: 30px; height: 50px; background: rgb(0, 0, 255); transform: translateX(70px)"></div>
      </div>
    </div>
    <div data-testid="scaled" style="width: 100px; height: 50px; margin: 30px; background: rgb(0, 255, 0); transform: scale(1.5) rotate(10deg)"></div>
    <div style="transform: scale(0.5) rotate(5deg); transform-origin: 0 0">
      <div data-testid="inner" style="width: 200px; height: 100px; background: rgb(0, 255, 0)"></div>
    </div>`));
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });

  // Moved off its layout box (and offset relatively): the whole image is the element, not empty.
  const moved = (await comment(page, daemon, page.getByTestId("moved"), "Moved")).screenshot!;
  expect(pngSize(moved)).toEqual({ width: 100, height: 50 });
  expect(await pngPixels(page, moved, [[5, 25], [95, 25]])).toEqual({ at: [[0, 255, 0, 255], [0, 255, 0, 255]], opaque: 1 });

  // Centred with translate(-50%): the image is the element, with its child still moved to its right edge.
  const centred = (await comment(page, daemon, page.getByTestId("centred"), "Centred")).screenshot!;
  expect(pngSize(centred)).toEqual({ width: 100, height: 50 });
  expect(await pngPixels(page, centred, [[25, 25], [85, 25]])).toEqual({ at: [[0, 255, 0, 255], [0, 0, 255, 255]], opaque: 1 });

  // Scaled and rotated, with margins: drawn upright at its own size, filling the image.
  const scaled = (await comment(page, daemon, page.getByTestId("scaled"), "Scaled")).screenshot!;
  expect(pngSize(scaled)).toEqual({ width: 100, height: 50 });
  expect((await pngPixels(page, scaled, [[50, 25]])).opaque).toBe(1);

  // Inside a scaled and rotated ancestor: drawn upright at its own size too, not clipped to its on-screen box.
  const inner = (await comment(page, daemon, page.getByTestId("inner"), "Inner")).screenshot!;
  expect(pngSize(inner)).toEqual({ width: 200, height: 100 });
  expect((await pngPixels(page, inner, [[195, 95]])).opaque).toBe(1);
});

test("the screenshot shows the element as it was when picked", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("afterbegin",
    '<div data-testid="tile" style="width: 60px; height: 40px; background: rgb(255, 0, 0)"></div>'));
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await countCanvasBlobs(page);
  await enterCommentMode(page);
  await page.getByTestId("tile").click();
  // Captured at the pick: a change while the comment is typed (a hover ending, a re-render) does not reach it.
  await expect.poll(() => page.evaluate(() => window.canvasBlobs)).toBe(1);
  await page.getByTestId("tile").evaluate((tile) => {
    (tile as HTMLElement).style.background = "rgb(0, 0, 255)";
  });
  await inBar(page, "[data-role=composer-text]").fill("Was red");
  await inBar(page, "[data-role=composer-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(1);
  expect((await pngPixels(page, daemon.posts[0]!.screenshot!, [[30, 20]])).at).toEqual([[255, 0, 0, 255]]);
});

test("sends no screenshot, and says why, when a box in the element is scrolled", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await page.evaluate(() => {
    document.querySelector("main")!.insertAdjacentHTML("afterbegin", `
      <div data-testid="card" style="width: 140px; height: 120px; padding: 10px 20px; box-sizing: border-box">
        <div data-testid="scroller" style="height: 100px; overflow: auto"><div style="height: 300px; pointer-events: none"></div></div>
      </div>`);
    document.querySelector<HTMLElement>("[data-testid=scroller]")!.scrollTop = 100;
  });
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  // The copy would show the box unscrolled, unlike the page, whether the box is the element or inside it.
  for (const [index, target] of ["card", "scroller"].entries()) {
    const { draft, screenshot } = await comment(page, daemon, page.getByTestId(target), target, { x: 5, y: 5 });
    expect(screenshot, target).toBeNull();
    expect(draft.screenshotUnavailableReason).toBe("The screenshot failed: a box in the element is scrolled, which a screenshot cannot show yet");
    expect(daemon.posts).toHaveLength(index + 1);
  }
});

test("a transformed element still contains its fixed descendants", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("afterbegin",
    '<div data-testid="framed" tabindex="0" style="width: 200px; height: 200px; box-sizing: border-box; border: 50px solid rgb(255, 0, 0);'
    + ' transform: translateZ(0)"><div style="position: fixed; inset: 0; background: rgb(0, 0, 255)"></div></div>'));
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  // Its fixed child covers its padding box, so it is picked from the keyboard.
  await enterCommentMode(page);
  await page.getByTestId("framed").focus();
  await page.keyboard.press("Enter");
  await inBar(page, "[data-role=composer-text]").fill("Framed");
  await inBar(page, "[data-role=composer-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(1);
  const { draft, screenshot } = daemon.posts[0]!;
  expect(draft.target?.selector).toBe('[data-testid="framed"]');
  expect((await pngPixels(page, screenshot!, [[10, 10], [100, 100]])).at).toEqual([[255, 0, 0, 255], [0, 0, 255, 255]]);
});

test("frames every root the same way: exact fractional size, own and ancestor transforms left out, SVG drawings too", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  const chip = (id: string, style = "") =>
    `<span data-testid="${id}" style="display: inline-block; font: 20px/24px monospace; letter-spacing: 0.3px; background: #fff; color: #000; ${style}">ABC DEFG</span>`;
  await page.evaluate((chips) => document.querySelector("main")!.insertAdjacentHTML("afterbegin", `
    <div>${chips[0]}</div>
    <div style="transform: translateZ(0)">${chips[1]}</div>
    <div>${chips[2]}</div>
    <svg data-testid="svg" tabindex="0" width="100" height="50" style="display: block; transform: translateX(120px)">
      <rect data-testid="shape" width="100" height="50" fill="rgb(0, 255, 0)"/></svg>
    <div style="position: relative; height: 60px">
      <svg data-testid="svg-offset" tabindex="0" width="100" height="50" style="position: absolute; left: 10px; top: 5px">
        <rect width="100" height="50" fill="rgb(0, 255, 0)"/></svg></div>
    <svg data-testid="svg-styled" id="styled-svg" tabindex="0" width="100" height="50">
      <style>#styled-svg { transform: translateX(120px); margin-left: 7px }</style><rect width="100" height="50" fill="rgb(0, 255, 0)"/></svg>
    <div data-testid="boxed" style="width: 60px; height: 20px; padding: 10px; border: 5px solid rgb(255, 0, 0); background: rgb(0, 0, 255)"></div>
    <div data-testid="zoomed" style="zoom: 2; width: 50px; height: 25px; background: rgb(0, 255, 0); transform: translateX(80px)"></div>
    <div style="transform: scale(0.5)"><span data-testid="inline" style="background: #fff">Inline</span></div>`),
  [chip("plain"), chip("in-transformed"), chip("transformed", "transform: translateX(5px)")]);
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  const styles = () => page.evaluate(() => [...document.querySelectorAll("main [data-testid]")].map((element) => element.getAttribute("style")));
  const before = await styles();

  // A shrink-to-fit chip with a fractional width: under a transformed ancestor, or with its own transform, its text
  // wraps as on the page (all of "ABC DEFG" on one line), so the image has as much text as the untransformed one.
  const plainPost = await comment(page, daemon, page.getByTestId("plain"), "Plain");
  expect(plainPost.draft.screenshotUnavailableReason).toBeNull();
  const plain = plainPost.screenshot!;
  const plainSize = await page.getByTestId("plain").evaluate((element) => element.getBoundingClientRect());
  expect(plainSize.width % 1).not.toBe(0);
  expect(pngSize(plain)).toEqual({ width: Math.floor(plainSize.width), height: Math.floor(plainSize.height) });
  const text = await darkPixels(page, plain);
  expect(text).toBeGreaterThan(100);
  for (const id of ["in-transformed", "transformed"]) {
    const png = (await comment(page, daemon, page.getByTestId(id), id)).screenshot!;
    expect(pngSize(png), id).toEqual(pngSize(plain));
    expect(Math.abs(await darkPixels(page, png) - text) / text, id).toBeLessThan(0.05);
  }

  // A content-box element with padding and a border: its whole border box, laid out as on the page.
  const boxed = (await comment(page, daemon, page.getByTestId("boxed"), "Boxed")).screenshot!;
  expect(pngSize(boxed)).toEqual({ width: 90, height: 50 });
  expect((await pngPixels(page, boxed, [[2, 2], [87, 47], [12, 12], [77, 37]])).at).toEqual([[255, 0, 0, 255], [255, 0, 0, 255], [0, 0, 255, 255], [0, 0, 255, 255]]);

  // A translated <svg> drawing, one placed by offsets and one placed by its own style sheet (which their shapes cover,
  // so they are picked from the keyboard) fill their images.
  for (const id of ["svg", "svg-offset", "svg-styled"]) {
    const svg = (await commentFromKeyboard(page, daemon, id)).screenshot!;
    expect(pngSize(svg), id).toEqual({ width: 100, height: 50 });
    expect(await pngPixels(page, svg, [[2, 2], [50, 25], [97, 47]]), id).toEqual({ at: [[0, 255, 0, 255], [0, 255, 0, 255], [0, 255, 0, 255]], opaque: 1 });
  }

  // Its own zoom and a transform: drawn at its zoomed size, filled.
  const zoomed = (await comment(page, daemon, page.getByTestId("zoomed"), "Zoomed")).screenshot!;
  expect(pngSize(zoomed)).toEqual({ width: 100, height: 50 });
  expect((await pngPixels(page, zoomed, [[97, 47]])).opaque).toBe(1);

  // What cannot be framed is sent without a screenshot, saying why: a shape inside a drawing, or an inline box that
  // a transform around it scales.
  for (const [id, reason] of [
    ["shape", "only HTML elements and whole SVG drawings can be captured, not <rect>"],
    ["inline", "the element is an inline box inside a scaled or turned one; pick a box around it"],
  ] as const) {
    const { draft, screenshot } = await comment(page, daemon, page.getByTestId(id), id);
    expect(screenshot, id).toBeNull();
    expect(draft.screenshotUnavailableReason).toBe(`The screenshot failed: ${reason}`);
  }
  // The live elements were never changed.
  expect(await styles()).toEqual(before);
});

const SHOWN_COLOURS = [[0, 255, 0], [255, 0, 0], [0, 0, 255], [0, 0, 0]] as const;

/** Expects `sent` to have each colour of {@link SHOWN_COLOURS} in each quadrant as `live` does, within 2% (or 3 pixels). */
async function expectLike(page: Page, sent: Buffer, live: Buffer, id: string): Promise<void> {
  const [have, want] = [await quadrantColourCounts(page, sent, SHOWN_COLOURS), await quadrantColourCounts(page, live, SHOWN_COLOURS)];
  want.forEach((counts, quadrant) => counts.forEach((count, which) => {
    expect(Math.abs(have[quadrant]![which]! - count), `${id} quadrant ${quadrant} colour ${which}: ${have[quadrant]![which]} vs ${count}`)
      .toBeLessThanOrEqual(Math.max(3, count * 0.02));
  }));
  expect(have.flat().reduce((sum, count) => sum + count, 0), id).toBeGreaterThan(0);
}

test("draws an <svg> only as the page shows it, and sends none, saying why, when the page styles it or it loads an outside resource", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  // A style sheet from another origin, which the page cannot read, followed by a rule it can.
  const elsewhere = `${fixtureServer.origin.replace("127.0.0.1", "localhost")}/elsewhere.css`;
  await page.route(elsewhere, (route) => route.fulfill({ status: 200, contentType: "text/css", body: ".elsewhere { color: red }" }));
  await openFixture();
  const green = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="rgb(0,255,0)"/></svg>')}`;
  await page.evaluate(({ green, elsewhere }) => document.querySelector("main")!.insertAdjacentHTML("afterbegin", `
    <style>@import url("${elsewhere}"); .imported rect { fill: rgb(255, 0, 0) }</style>
    <style>.icon rect { fill: rgb(255, 0, 0) } .dcss { d: path("M0 0H100V50H0Z") } .dnone { d: none } .vis { opacity: 1 } .shift { translate: 50px 0 }
      .reset, .reset * { box-sizing: border-box; border: 0 solid rgb(229, 231, 235) } .tw * { --spin: 0deg } .tw.flip { --spin: 180deg }
      .sprite-blue { fill: rgb(0, 0, 255) } .r { fill: rgb(0, 0, 0) } .sizing circle { box-sizing: border-box }
      body { cursor: url(/pointer.png), auto } :root { --logo: url(/logo.svg) } .themed { fill: rgb(255, 0, 0) } .ico rect { fill: currentColor }
      html { box-sizing: border-box } *, *::before, *::after { box-sizing: inherit; --tw-pan-x: ; } @media (max-width: 1px) { #dot rect { fill: rgb(255, 0, 0) } }
      .tile { fill: rgb(255, 0, 0) !important } .trans rect { fill: rgb(0, 0, 255) } @keyframes spin { to { transform: rotate(360deg) } }
      .spin { animation: spin 1s linear infinite; transform-origin: 50px 50px } @container (min-width: 1px) { .contained-shape { fill: rgb(255, 0, 0) } }
      .nest { & .inner { fill: rgb(255, 0, 0) } } .nest-miss { & .absent { fill: rgb(255, 0, 0) } }
      @media (max-width: 1px) { .media rect { fill: rgb(255, 0, 0) } } .red-use { --tone: rgb(255, 0, 0) } .backed { background: rgb(0, 0, 255) }</style>
    <svg width="0" height="0" style="position: absolute; fill: rgb(0, 0, 255)">
      <symbol id="dot" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="10" height="10"/></symbol>
      <symbol id="two-tone" viewBox="0 0 100 50" preserveAspectRatio="none"><rect width="50" height="50" fill="#000"/><rect x="50" width="50" height="50" fill="currentColor"/></symbol>
      <symbol id="toned" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="10" height="10" style="fill: var(--tone, rgb(0, 0, 255))"/></symbol>
      <symbol id="ruled" viewBox="0 0 10 10" preserveAspectRatio="none"><rect class="sprite-blue" width="10" height="10"/></symbol>
      <symbol id="outer-icon" viewBox="0 0 10 10" preserveAspectRatio="none">
        <linearGradient id="inner-green"><stop offset="0" stop-color="rgb(0, 255, 0)"/><stop offset="1" stop-color="rgb(0, 255, 0)"/></linearGradient>
        <rect width="10" height="10" fill="url(#inner-green)"/></symbol>
      <linearGradient id="blue"><stop offset="0" stop-color="rgb(0, 0, 255)"/><stop offset="1" stop-color="rgb(0, 0, 255)"/></linearGradient></svg>
    <svg style="display: none"><g class="themed"><symbol id="themed-shape" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="10" height="10"/></symbol></g>
      <symbol id="ico" class="ico" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="10" height="10"/></symbol>
      <symbol id="contained" viewBox="0 0 10 10" preserveAspectRatio="none"><rect class="contained-shape" width="10" height="10"/></symbol></svg>
    <svg style="display: none"><linearGradient id="hidden-green"><stop offset="0" stop-color="rgb(0, 255, 0)"/><stop offset="1" stop-color="rgb(0, 255, 0)"/></linearGradient></svg>
    <div style="color: rgb(0, 0, 255)">
      <svg data-testid="plain" tabindex="0" width="100" height="50" style="display: block">
        <defs><symbol id="half" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="50%" height="50%" fill="rgb(0, 255, 0)"/></symbol></defs>
        <use href="#half" width="100" height="50"/><rect x="50" width="50" height="50" fill="currentColor"/></svg>
      <svg data-testid="styled" class="icon" tabindex="0" width="20" height="20" style="display: block"><rect width="20" height="20"/></svg>
    </div>
    <svg data-testid="instances" tabindex="0" width="100" height="50" color="rgb(255, 0, 0)" style="display: block">
      <defs><g id="shape"><rect width="50" height="50" fill="currentColor"/></g></defs>
      <use href="#shape" color="rgb(0, 0, 255)"/><use href="#shape" x="50" color="rgb(0, 255, 0)"/></svg>
    <svg data-testid="literal" tabindex="0" width="150" height="50" style="display: block; color: rgb(0, 0, 0); fill: rgb(0, 255, 0)">
      <use href="#two-tone" width="100" height="50" style="color: rgb(255, 0, 0)"/><use href="#dot" x="100" width="50" height="50"/></svg>
    <svg data-testid="referring" tabindex="0" width="125" height="50" style="display: block">
      <defs><linearGradient id="local-green"><stop offset="0" stop-color="rgb(0, 255, 0)"/><stop offset="1" stop-color="rgb(0, 255, 0)"/></linearGradient></defs>
      <rect width="25" height="50" fill="url(#local-green)"/><rect x="25" width="25" height="50" fill="url(#blue)"/>
      <image x="50" width="25" height="50" preserveAspectRatio="none" href="${green}"/><rect x="75" width="25" height="50" fill="url(#hidden-green)"/>
      <use href="#toned" x="100" width="25" height="50" style="--tone: rgb(255, 0, 0)"/></svg>
    <svg data-testid="variable" tabindex="0" width="20" height="20" color="rgb(255, 0, 0)" style="display: block; --paint: currentColor">
      <defs><rect id="var-tile" width="20" height="20" style="fill: var(--paint)"/></defs><use href="#var-tile" color="rgb(0, 0, 255)"/></svg>
    <svg data-testid="backed" class="backed" tabindex="0" width="100" height="50" style="display: block"><rect width="50" height="50" fill="rgb(0, 255, 0)"/></svg>
    <svg data-testid="unmatched" class="media nest-miss" tabindex="0" width="20" height="20" style="display: block"><rect width="20" height="20" fill="rgb(0, 255, 0)"/></svg>
    <svg data-testid="data-font" tabindex="0" width="20" height="20" style="display: block">
      <style>@font-face { font-family: inline-face; src: url(data:font/woff2;base64,AAAA) }</style><rect width="20" height="20" fill="rgb(0, 255, 0)"/></svg>
    <svg data-testid="dcss" tabindex="0" width="100" height="50" style="display: block">
      <path class="dcss" d="M0 0H1V1H0Z" fill="rgb(0, 255, 0)"/><path class="dnone" d="M0 0H100V50H0Z" fill="rgb(255, 0, 0)"/></svg>
    <svg data-testid="vis" tabindex="0" width="100" height="50" style="display: block"><g opacity="0" class="vis"><rect width="100" height="50" fill="rgb(0, 255, 0)"/></g></svg>
    <svg data-testid="shift" tabindex="0" width="100" height="50" style="display: block"><rect class="shift" width="50" height="50" fill="rgb(0, 255, 0)"/></svg>
    <svg data-testid="reset" class="reset" tabindex="0" width="100" height="50" fill="none" stroke="rgb(0, 0, 255)" stroke-width="4"
      shape-rendering="crispEdges" style="display: block"><rect x="2" y="2" width="46" height="46"/><path d="M60 10H90V40H60Z"/></svg>
    <svg data-testid="nest" class="nest" tabindex="0" width="20" height="20" style="display: block"><rect class="inner" width="20" height="20"/></svg>
    <svg data-testid="imported" class="imported" tabindex="0" width="20" height="20" style="display: block"><rect width="20" height="20"/></svg>
    <svg data-testid="red-use" tabindex="0" width="20" height="20" style="display: block"><use class="red-use" href="#toned" width="20" height="20"/></svg>
    <svg data-testid="tokens" class="tw flip" tabindex="0" width="20" height="20" style="display: block"><rect width="20" height="20" fill="rgb(0, 255, 0)"/></svg>
    <svg data-testid="nested-ids" tabindex="0" width="100" height="50" style="display: block">
      <rect width="50" height="50" fill="url(#inner-green)"/><use href="#outer-icon" x="50" width="50" height="50"/></svg>
    <svg data-testid="ruled" tabindex="0" width="20" height="20" style="display: block; fill: rgb(0, 255, 0)"><use href="#ruled" width="20" height="20"/></svg>
    <svg data-testid="themed" tabindex="0" width="20" height="20" style="display: block"><use href="#themed-shape" fill="rgb(0, 255, 0)" width="20" height="20"/></svg>
    <svg data-testid="ico" tabindex="0" width="20" height="20" style="display: block; color: rgb(255, 0, 0)"><use href="#ico" width="20" height="20"/></svg>
    <svg data-testid="important" tabindex="0" width="20" height="20" color="rgb(255, 0, 0)" style="display: block">
      <defs><rect id="tile" class="tile" width="20" height="20" style="fill: currentColor"/></defs><use href="#tile" color="rgb(0, 0, 255)"/></svg>
    <svg data-testid="trans" id="trans-drawing" class="trans" tabindex="0" width="20" height="20" style="display: block">
      <style>#trans-drawing rect { transition: fill 0.2s }</style><rect width="20" height="20"/></svg>
    <svg data-testid="spin" tabindex="0" width="100" height="100" style="display: block"><g class="spin"><circle cx="50" cy="50" r="45" fill="rgb(0, 255, 0)"/></g></svg>
    <svg data-testid="contained" tabindex="0" width="20" height="20"><use href="#contained" width="20" height="20"/></svg>
    <svg data-testid="root-has" id="root-has" tabindex="0" width="20" height="20" style="display: block">
      <style>#root-has:has(rect[style]) { opacity: 0 }</style><rect width="20" height="20" fill="rgb(0, 255, 0)"/></svg>
    <div style="width: 400px"><svg data-testid="capped" tabindex="0" viewBox="0 0 300 100" preserveAspectRatio="none" width="300" height="100"
      style="display: block; max-width: 50%"><rect width="300" height="100" fill="rgb(0, 255, 0)"/></svg></div>
    <svg data-testid="local-ruled" tabindex="0" width="20" height="20" style="display: block">
      <defs><g id="local-shape"><rect class="r" width="20" height="20"/></g></defs><use href="#local-shape" fill="rgb(0, 255, 0)"/></svg>
    <svg data-testid="has" id="has-drawing" class="sizing" tabindex="0" width="100" height="50">
      <style>#has-drawing rect:has(+ circle[style]) { opacity: 0 }</style><rect width="100" height="50"/><circle cx="25" cy="25" r="10"/></svg>
    <svg data-testid="padded" tabindex="0" width="20" height="20" style="padding: 5px; border: 1px solid #000"><rect width="20" height="20"/></svg>
    <svg data-testid="html" tabindex="0" width="20" height="20"><foreignObject width="20" height="20"><div>Hi</div></foreignObject></svg>
    <svg data-testid="sprite" tabindex="0" width="20" height="20"><use href="/sprite.svg#x"/></svg>
    <svg data-testid="linked-sprite" tabindex="0" width="20" height="20"><use xlink:href="/sprite.svg#x"/></svg>
    <svg data-testid="image" tabindex="0" width="20" height="20"><image href="/missing.png" width="20" height="20"/></svg>
    <svg data-testid="fill-url" tabindex="0" width="20" height="20"><rect width="20" height="20" style="fill: url(/paint.svg#p)"/></svg>
    <svg data-testid="font" tabindex="0" width="40" height="20">
      <style>@font-face { font-family: outside-face; src: url(/face.woff2) }</style><text y="15" font-family="outside-face">Hi</text></svg>
    <svg data-testid="import" tabindex="0" width="20" height="20"><style>@import url(/drawing.css);</style><rect width="20" height="20"/></svg>
    <svg data-testid="upper" tabindex="0" width="20" height="20"><style>#upper-shape { fill: URL(/upper.svg#p) }</style><rect id="upper-shape" width="20" height="20"/></svg>
    <svg data-testid="escaped" tabindex="0" width="20" height="20"><style>#escaped-shape { fill: u\\72l(/escaped.svg#p) }</style><rect id="escaped-shape" width="20" height="20"/></svg>
    <svg data-testid="split" tabindex="0" width="40" height="20"><style id="split-sheet"></style><text y="15" font-family="split-face">Hi</text></svg>`),
  { green, elsewhere });
  // A style sheet whose text is split across two nodes, neither of which refers to anything alone.
  await page.evaluate(() => document.getElementById("split-sheet")!.append("@font-face { font-family: split-face; src: u", "rl(/split.woff2) }"));
  const faithful = [
    "backed", "unmatched", "data-font", "dcss", "vis", "shift", "reset", "styled", "nest", "imported", "tokens", "trans", "spin", "root-has",
    "capped",
  ] as const;
  // What the page shows of each drawing, before the bar is on it.
  const live = new Map<string, Buffer>();
  for (const id of faithful) live.set(id, await page.getByTestId(id).screenshot());
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  const markup = () => page.evaluate(() => [...document.querySelectorAll("svg, svg *")].map((element) => element.outerHTML));
  const before = await markup();

  // Drawings without a <use> are drawn as the page shows them, on a page whose cursor and a custom property refer to
  // images: a data: font, the page's background on the drawing, page rules that do not apply, and page rules on its
  // shapes: CSS d and d: none over the d attribute, an opacity attribute reset, an individual transform, a CSS reset's
  // box-sizing and borders, a custom property a rule resets, and a fill from a rule, a nested rule and a rule after a
  // style sheet the page cannot read. A shape with a transition, and one a running animation turns (a circle, which
  // looks the same at every turn), are drawn as they are now. A page whose universal rule declares an empty custom
  // property, a drawing whose own rule on its root depends on its shapes' style attributes, and one whose maximum
  // width is a share of its parent's are drawn as the page shows them too.
  for (const id of faithful) {
    const { draft, screenshot } = await commentFromKeyboard(page, daemon, id);
    expect(draft.screenshotUnavailableReason, id).toBeNull();
    await expectLike(page, screenshot!, live.get(id)!, id);
  }

  // A drawing with a <use> is not drawn on this page: its universal rules (and others) match what the <use>s show,
  // which the copy cannot check for each <use>. Nor is a drawing whose own selectors would match differently once its
  // copy's shapes carry their values.
  for (const id of ["plain", "instances", "literal", "referring", "variable", "red-use", "nested-ids", "ruled", "local-ruled", "themed", "ico", "important", "contained"]) {
    const { draft, screenshot } = await commentFromKeyboard(page, daemon, id);
    expect(screenshot, id).toBeNull();
    expect(draft.screenshotUnavailableReason, id).toMatch(/^The screenshot failed: the page has a style rule for the <\w+> that a <use> in the drawing shows, which a screenshot cannot draw for each <use> yet$/u);
  }
  for (const [id, reason] of [
    ["has", "the page styles the drawing's <rect> (its opacity) in a way its copy cannot reproduce yet"],
  ] as const) {
    const { draft, screenshot } = await commentFromKeyboard(page, daemon, id);
    expect(screenshot, id).toBeNull();
    expect(draft.screenshotUnavailableReason, id).toBe(`The screenshot failed: ${reason}`);
  }

  // What the copy cannot hold, and what would load from outside the page, in markup or in its style sheet text.
  for (const [id, reason] of [
    ["html", "the drawing holds HTML (<foreignObject>), which a screenshot cannot copy with its styles yet"],
    ["padded", "the drawing has padding or a border, which its copy cannot frame yet"],
    ["import", "the drawing imports a style sheet, which a screenshot cannot embed yet"],
    ...([["sprite", "/sprite.svg#x"], ["linked-sprite", "/sprite.svg#x"], ["image", "/missing.png"], ["fill-url", "/paint.svg#p"],
      ["font", "/face.woff2"], ["upper", "/upper.svg#p"], ["escaped", "/escaped.svg#p"], ["split", "/split.woff2"]] as const)
      .map(([id, url]) => [id, `the drawing loads ${url}, which a screenshot cannot embed yet`] as const),
  ]) {
    const { draft, screenshot } = await commentFromKeyboard(page, daemon, id);
    expect(screenshot, id).toBeNull();
    expect(draft.screenshotUnavailableReason, id).toBe(`The screenshot failed: ${reason}`);
  }
  expect(await markup()).toEqual(before);
  // The frames the copies were checked in are gone.
  expect(await page.evaluate(() => document.querySelector("iterbar-bar")!.shadowRoot!.querySelectorAll("iframe").length)).toBe(0);
});

test("draws what a <use> shows only when nothing on the page but the <use> styles it, and text only in its own fonts", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  const block = blockFontUrl("Block");
  const green = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="rgb(0,255,0)"/></svg>')}`;
  await page.evaluate(({ block, green }) => {
    // A page whose rules reach a <use> or a definition's ancestor, but none of what a <use> shows, except where named.
    document.querySelector("main")!.insertAdjacentHTML("afterbegin", `
    <style>.red-use { --tone: rgb(255, 0, 0) } .themed { fill: rgb(255, 0, 0) } .sprite-blue { fill: rgb(0, 0, 255) } .ico rect { fill: currentColor }
      .tile { fill: rgb(255, 0, 0) !important } .r { fill: rgb(0, 0, 0) } @container (min-width: 1px) { .contained-shape { fill: rgb(255, 0, 0) } }
      .wrap { .nested-r { fill: rgb(255, 0, 0) } } .sprite-wrap { .nested-in { fill: rgb(255, 0, 0) } } .r2 { fill: rgb(0, 0, 255) } .ec, .ec-plain { --c: ; }
      @property --reg-tone { syntax: "<color>"; inherits: false; initial-value: rgb(255, 0, 0) }
      @font-face { font-family: page-face; src: url(${block}) } .neg { :not(&) > .negated { fill: currentColor } } @scope (.scoped) { fill: currentColor }</style>
    <svg width="0" height="0" style="position: absolute; fill: rgb(0, 0, 255)">
      <symbol id="dot" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="10" height="10"/></symbol>
      <symbol id="two-tone" viewBox="0 0 100 50" preserveAspectRatio="none"><rect width="50" height="50" fill="#000"/><rect x="50" width="50" height="50" fill="currentColor"/></symbol>
      <symbol id="toned" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="10" height="10" style="fill: var(--tone, rgb(0, 0, 255))"/></symbol>
      <symbol id="ruled" viewBox="0 0 10 10" preserveAspectRatio="none"><rect class="sprite-blue" width="10" height="10"/></symbol>
      <symbol id="outer-icon" viewBox="0 0 10 10" preserveAspectRatio="none">
        <linearGradient id="inner-green"><stop offset="0" stop-color="rgb(0, 255, 0)"/><stop offset="1" stop-color="rgb(0, 255, 0)"/></linearGradient>
        <rect width="10" height="10" fill="url(#inner-green)"/></symbol>
      <linearGradient id="blue"><stop offset="0" stop-color="rgb(0, 0, 255)"/><stop offset="1" stop-color="rgb(0, 0, 255)"/></linearGradient>
      <g id="inner"><rect width="50" height="50" fill="rgb(0, 255, 0)"/></g>
      <symbol id="outer" viewBox="0 0 50 50" width="50" height="50"><use href="#inner"/></symbol>
      <g id="inner-ruled"><rect class="r2" width="50" height="50" fill="rgb(0, 255, 0)"/></g>
      <rect id="nested-rect" class="nested-r" width="100" height="50" fill="rgb(0, 255, 0)"/>
      <rect id="empty-tile" class="ec" width="100" height="50" style="fill: var(--c, rgb(255, 0, 0))"/></svg>
    <svg style="display: none"><g class="themed"><symbol id="themed-shape" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="10" height="10"/></symbol></g>
      <symbol id="ico" class="ico" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="10" height="10"/></symbol>
      <symbol id="contained" viewBox="0 0 10 10" preserveAspectRatio="none"><rect class="contained-shape" width="10" height="10"/></symbol>
      <linearGradient id="hidden-green"><stop offset="0" stop-color="rgb(0, 255, 0)"/><stop offset="1" stop-color="rgb(0, 255, 0)"/></linearGradient></svg>
    <div style="color: rgb(0, 0, 255)">
      <svg data-testid="plain" tabindex="0" width="100" height="50" style="display: block">
        <defs><symbol id="half" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="50%" height="50%" fill="rgb(0, 255, 0)"/></symbol></defs>
        <use href="#half" width="100" height="50"/><rect x="50" width="50" height="50" fill="currentColor"/></svg></div>
    <svg data-testid="instances" tabindex="0" width="100" height="50" color="rgb(255, 0, 0)" style="display: block">
      <defs><g id="shape"><rect width="50" height="50" fill="currentColor"/></g></defs>
      <use href="#shape" color="rgb(0, 0, 255)"/><use href="#shape" x="50" color="rgb(0, 255, 0)"/></svg>
    <svg data-testid="literal" tabindex="0" width="150" height="50" style="display: block; color: rgb(0, 0, 0); fill: rgb(0, 255, 0)">
      <use href="#two-tone" width="100" height="50" style="color: rgb(255, 0, 0)"/><use href="#dot" x="100" width="50" height="50"/></svg>
    <svg data-testid="referring" tabindex="0" width="125" height="50" style="display: block">
      <defs><linearGradient id="local-green"><stop offset="0" stop-color="rgb(0, 255, 0)"/><stop offset="1" stop-color="rgb(0, 255, 0)"/></linearGradient></defs>
      <rect width="25" height="50" fill="url(#local-green)"/><rect x="25" width="25" height="50" fill="url(#blue)"/>
      <image x="50" width="25" height="50" preserveAspectRatio="none" href="${green}"/><rect x="75" width="25" height="50" fill="url(#hidden-green)"/>
      <use href="#toned" x="100" width="25" height="50" style="--tone: rgb(255, 0, 0)"/></svg>
    <svg data-testid="variable" tabindex="0" width="20" height="20" color="rgb(255, 0, 0)" style="display: block; --paint: currentColor">
      <defs><rect id="var-tile" width="20" height="20" style="fill: var(--paint)"/></defs><use href="#var-tile" color="rgb(0, 0, 255)"/></svg>
    <svg data-testid="red-use" tabindex="0" width="20" height="20" style="display: block"><use class="red-use" href="#toned" width="20" height="20"/></svg>
    <svg data-testid="nested-ids" tabindex="0" width="100" height="50" style="display: block">
      <rect width="50" height="50" fill="url(#inner-green)"/><use href="#outer-icon" x="50" width="50" height="50"/></svg>
    <svg data-testid="themed" tabindex="0" width="20" height="20" style="display: block"><use href="#themed-shape" fill="rgb(0, 255, 0)" width="20" height="20"/></svg>
    <svg data-testid="copied-twice" tabindex="0" width="100" height="50" style="display: block"><use href="#inner"/><use href="#outer" x="50"/></svg>
    <svg data-testid="root-current" tabindex="0" width="100" height="50" style="display: block; color: rgb(255, 0, 0); fill: currentColor">
      <defs><rect id="current-tile" width="50" height="50"/></defs>
      <use href="#current-tile" style="color: rgb(0, 255, 0)"/><use href="#current-tile" x="50" style="color: rgb(0, 0, 255)"/></svg>
    <svg data-testid="empty-var" tabindex="0" width="100" height="50" style="display: block; fill: rgb(0, 255, 0)">
      <rect class="ec-plain" width="100" height="50" style="fill: var(--c, rgb(255, 0, 0))"/></svg>
    <svg data-testid="noted" tabindex="0" width="100" height="50" style="display: block">
      <rect data-note="see url(http://example.invalid/x)" aria-label="url(http://example.invalid/y)" width="100" height="50" fill="rgb(0, 255, 0)"/></svg>
    <svg data-testid="own-font" tabindex="0" width="120" height="50" style="display: block">
      <style>@font-face { font-family: own-face; src: url(${block}) }</style><text x="0" y="40" font-family="own-face" font-size="40">WW</text></svg>
    <svg data-testid="generic-font" tabindex="0" width="120" height="50" style="display: block"><text x="0" y="40" font-family="monospace" font-size="40">WW</text></svg>

    <svg data-testid="ruled" tabindex="0" width="20" height="20" style="display: block; fill: rgb(0, 255, 0)"><use href="#ruled" width="20" height="20"/></svg>
    <svg data-testid="ico" tabindex="0" width="20" height="20" style="display: block; color: rgb(255, 0, 0)"><use href="#ico" width="20" height="20"/></svg>
    <svg data-testid="important" tabindex="0" width="20" height="20" color="rgb(255, 0, 0)" style="display: block">
      <defs><rect id="tile" class="tile" width="20" height="20" style="fill: currentColor"/></defs><use href="#tile" color="rgb(0, 0, 255)"/></svg>
    <svg data-testid="local-ruled" tabindex="0" width="20" height="20" style="display: block">
      <defs><g id="local-shape"><rect class="r" width="20" height="20"/></g></defs><use href="#local-shape" fill="rgb(0, 255, 0)"/></svg>
    <svg data-testid="contained" tabindex="0" width="20" height="20" style="display: block"><use href="#contained" width="20" height="20"/></svg>
    <svg data-testid="nested" tabindex="0" width="100" height="50" style="display: block"><use href="#nested-rect"/></svg>
    <svg class="sprite-wrap" width="0" height="0" style="position: absolute"><rect id="nested-in-rect" class="nested-in" width="100" height="50"/></svg>
    <svg data-testid="nested-applies" tabindex="0" width="100" height="50" style="display: block; fill: rgb(0, 255, 0)"><use href="#nested-in-rect"/></svg>
    <svg data-testid="copied-twice-ruled" tabindex="0" width="100" height="50" style="display: block"><use href="#inner-ruled"/><use href="#inner-ruled" x="50"/></svg>
    <svg data-testid="empty-use" tabindex="0" width="100" height="50" style="display: block; fill: rgb(0, 255, 0)"><use href="#empty-tile"/></svg>
    <svg data-testid="registered" tabindex="0" width="40" height="40" style="display: block">
      <defs><g id="reg-shape"><rect width="40" height="40" style="fill: var(--reg-tone)"/></g></defs><use href="#reg-shape" style="--reg-tone: rgb(0, 0, 255)"/></svg>
    <svg data-testid="script-registered" tabindex="0" width="40" height="40" style="display: block">
      <defs><g id="js-shape"><rect width="40" height="40" style="fill: var(--js-tone)"/></g></defs><use href="#js-shape" style="--js-tone: rgb(0, 0, 255)"/></svg>
    <svg data-testid="page-font" tabindex="0" width="120" height="50" style="display: block"><text x="0" y="40" font-family="page-face" font-size="40">WW</text></svg>
    <svg data-testid="script-font" tabindex="0" width="120" height="50" style="display: block"><text x="0" y="40" font-family="script-face" font-size="40">WW</text></svg>
    <svg data-testid="linked-set" tabindex="0" width="20" height="20" style="display: block">
      <defs><rect id="set-a" width="20" height="20" fill="rgb(0, 255, 0)"/></defs><use href="#set-a"><set attributeName="href" to="/elsewhere.svg#b"/></use></svg>
    <svg data-testid="xlinked-set" tabindex="0" width="20" height="20" style="display: block">
      <defs><rect id="xset-a" width="20" height="20" fill="rgb(0, 255, 0)"/></defs><use href="#xset-a"><animate attributeName="xlink:href" values="#xset-a;/far.svg#c" dur="2s"/>
      <set attributeName="xlink:href" to="#xset-a"/></use></svg>
    <svg data-testid="animated-paint" tabindex="0" width="20" height="20" style="display: block">
      <rect width="20" height="20" fill="rgb(0, 255, 0)"><animate attributeName="fill" values="rgb(0, 255, 0);url(/paint.svg#p)" dur="2s"/></rect></svg>
    <svg data-testid="fragment-set" tabindex="0" width="20" height="20" style="display: block">
      <defs><rect id="frag-a" width="20" height="20" fill="rgb(0, 255, 0)"/><rect id="frag-b" width="20" height="20" fill="rgb(0, 0, 255)"/></defs>
      <use href="#frag-a"><set attributeName="href" to="#frag-b"/></use></svg>
    <svg data-testid="commented-var" tabindex="0" width="40" height="40" style="display: block">
      <defs><g id="reg-shape-2"><rect width="40" height="40" style="fill: var(/**/--reg-tone)"/></g></defs><use href="#reg-shape-2" style="--reg-tone: rgb(0, 0, 255)"/></svg>
    <svg data-testid="negated" tabindex="0" width="20" height="20" style="display: block">
      <defs><g id="neg-shape"><rect class="negated" width="20" height="20"/></g></defs><use href="#neg-shape" color="rgb(0, 0, 255)"/></svg>
    <svg width="0" height="0" style="position: absolute"><symbol id="scoped" class="scoped" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol></svg>
    <svg data-testid="scoped" tabindex="0" width="20" height="20" style="display: block"><use href="#scoped" width="20" height="20" color="rgb(0, 0, 255)"/></svg>
    <svg data-testid="linked-text" tabindex="0" width="120" height="50" style="display: block">
      <text x="0" y="40" font-family="monospace" font-size="40"><a href="#" font-family="page-face">WW</a></text></svg>
    <svg data-testid="media-font" tabindex="0" width="120" height="50" style="display: block">
      <style>@media (min-width: 500px) { @font-face { font-family: media-face; src: url(${block}) } }</style>
      <text x="0" y="40" font-family="media-face" font-size="40">WW</text></svg>
    <svg data-testid="scripted-rule" tabindex="0" width="100" height="50" style="display: block; fill: rgb(0, 255, 0)">
      <style id="scripted-sheet"></style><defs><g id="scripted-shape"><rect class="scripted" width="50" height="50"/></g></defs>
      <use href="#scripted-shape"/><use href="#scripted-shape" x="50"/></svg>
    <svg data-testid="scripted-font" tabindex="0" width="120" height="50" style="display: block">
      <style id="scripted-face"></style><text x="0" y="40" font-family="scripted-face" font-size="40">WW</text></svg>`);
    // Rules a script adds to a drawing's own style sheets, which its text does not have.
    const scripted = (document.getElementById("scripted-sheet") as unknown as { sheet: CSSStyleSheet }).sheet;
    scripted.insertRule(".scripted { fill: rgb(255, 0, 0) }");
    (document.getElementById("scripted-face") as unknown as { sheet: CSSStyleSheet }).sheet.insertRule(`@font-face { font-family: scripted-face; src: url(${block}) }`);
    CSS.registerProperty({ name: "--js-tone", syntax: "<color>", inherits: false, initialValue: "rgb(255, 0, 0)" });
  }, { block, green });
  await page.evaluate(async (block) => {
    const face = new FontFace("script-face", await (await fetch(block)).arrayBuffer());
    document.fonts.add(face);
    await face.load();
    await document.fonts.ready;
  }, block);
  const faithful = [
    "plain", "instances", "literal", "referring", "variable", "red-use", "nested-ids", "themed", "copied-twice", "root-current", "empty-var",
    "noted", "own-font", "generic-font", "scripted-rule", "scripted-font", "nested",
  ] as const;
  const live = new Map<string, Buffer>();
  for (const id of faithful) live.set(id, await page.getByTestId(id).screenshot());
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });

  // What a <use> shows, styled by nothing on the page but the <use> (its colour, a custom property inline or by a
  // rule on the <use>, a rule on the definition's ancestor, the drawing's root, a nested page rule whose parent does
  // not match), drawn per quadrant as the page shows it;
  // and drawings with text in a font of their own or a generic family, or attributes whose text reads like a url(). A
  // drawing's own rule or font face that a script added is drawn too.
  for (const id of faithful) {
    const { draft, screenshot } = await commentFromKeyboard(page, daemon, id);
    expect(draft.screenshotUnavailableReason, id).toBeNull();
    await expectLike(page, screenshot!, live.get(id)!, id);
  }
  const shownRule = (element: string) => `the page has a style rule for the <${element}> that a <use> in the drawing shows, which a screenshot cannot draw for each <use> yet`;
  for (const [id, reason] of [
    // A page rule on what a <use> shows, plain, as currentColor, important, on a definition in the drawing, under a
    // condition, nested, on a source shown twice, or declaring an empty custom property.
    ...["ruled", "ico", "important", "local-ruled", "contained", "nested-applies", "copied-twice-ruled", "empty-use"].map((id) => [id, shownRule("rect")] as const),
    // A custom property the page registers (by @property or from a script), which shown content uses.
    ["registered", "what a <use> in the drawing shows uses --reg-tone, which the page registers, and a screenshot cannot reproduce yet"],
    ["commented-var", "what a <use> in the drawing shows uses --reg-tone, which the page registers, and a screenshot cannot reproduce yet"],
    // A nested page rule under a negation, and declarations directly in @scope.
    ["negated", shownRule("rect")],
    ["scoped", shownRule("symbol")],
    ["script-registered", "what a <use> in the drawing shows uses --js-tone, which the page registers, and a screenshot cannot reproduce yet"],
    // Text in a font the page has a face for, from a style sheet or a script.
    ["page-font", "the drawing's text uses the page's font page-face, which a screenshot cannot embed yet"],
    ["script-font", "the drawing's text uses the page's font script-face, which a screenshot cannot embed yet"],
    // Text in a link in the text, and a face of the drawing's own that only applies under a media query.
    ["linked-text", "the drawing's text uses the page's font page-face, which a screenshot cannot embed yet"],
    ["media-font", "the drawing's text uses the page's font media-face, which a screenshot cannot embed yet"],
    // A link an animation sets.
    ["linked-set", "the drawing loads /elsewhere.svg#b, which a screenshot cannot embed yet"],
    ["xlinked-set", "the drawing loads /far.svg#c, which a screenshot cannot embed yet"],
    ["animated-paint", "the drawing loads /paint.svg#p, which a screenshot cannot embed yet"],
    // Even to a #fragment.
    ["fragment-set", "the drawing animates a link, which a screenshot cannot check yet"],
  ] as const) {
    const { draft, screenshot } = await commentFromKeyboard(page, daemon, id);
    expect(screenshot, id).toBeNull();
    expect(draft.screenshotUnavailableReason, id).toBe(`The screenshot failed: ${reason}`);
  }

  // A style sheet from another origin, which the page cannot read, may style what a <use> shows, and its font faces
  // are the page's too; a drawing without a <use> or text is still drawn.
  const elsewhere = `${fixtureServer.origin.replace("127.0.0.1", "localhost")}/elsewhere.css`;
  await page.route(elsewhere, (route) => route.fulfill({
    status: 200, contentType: "text/css", body: `.far { fill: rgb(0, 0, 0) } @font-face { font-family: far-face; src: url(${block}) }`,
  }));
  await page.evaluate(async (elsewhere) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = elsewhere;
    const loaded = new Promise((resolve) => link.addEventListener("load", resolve, { once: true }));
    document.head.append(link);
    await loaded;
    document.querySelector("main")!.insertAdjacentHTML("afterbegin",
      '<svg data-testid="far-font" tabindex="0" width="120" height="50" style="display: block"><text x="0" y="40" font-family="far-face" font-size="40">WW</text></svg>');
    await document.fonts.ready;
  }, elsewhere);
  for (const [id, reason] of [
    ["plain", "the page has a style sheet it cannot read (another origin's), whose rules may style what a <use> in the drawing shows, which a screenshot cannot check yet"],
    ["far-font", "the drawing's text uses the page's font far-face, which a screenshot cannot embed yet"],
  ] as const) {
    const { draft, screenshot } = await commentFromKeyboard(page, daemon, id);
    expect(screenshot, id).toBeNull();
    expect(draft.screenshotUnavailableReason, id).toBe(`The screenshot failed: ${reason}`);
  }
  const { draft, screenshot } = await commentFromKeyboard(page, daemon, "noted");
  expect(draft.screenshotUnavailableReason).toBeNull();
  await expectLike(page, screenshot!, live.get("noted")!, "noted");
});

test("a large drawing on a page with many style rules is copied well within the time limit", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = Array.from({ length: 2_000 }, (_, index) => `.rule-${index} { color: rgb(1, 2, 3); font-size: 13px; letter-spacing: 1px }`).join("\n");
    document.head.append(style);
    document.querySelector("main")!.insertAdjacentHTML("afterbegin",
      `<svg data-testid="chart" tabindex="0" width="300" height="40" style="display: block">${'<rect width="1" height="1"/>'.repeat(5_000)}</svg>`);
  });
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  const started = Date.now();
  const { draft, screenshot } = await commentFromKeyboard(page, daemon, "chart");
  expect(draft.screenshotUnavailableReason).toBeNull();
  expect(screenshot).not.toBeNull();
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("a drawing is copied only while its capture holds the render slot, and not at all once withdrawn", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openCases(page, openFixture, daemon);
  await page.evaluate(() => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.dataset.big = "s";
    svg.dataset.testid = "big-svg";
    svg.setAttribute("tabindex", "0");
    svg.setAttribute("width", "300");
    svg.setAttribute("height", "40");
    svg.innerHTML = '<rect width="1" height="1"/>'.repeat(20_000);
    document.querySelector("main")!.prepend(svg);
    // Encodes wait for the test; their count and the reads of the drawing's markup are recorded.
    const state = window as unknown as { encodes: number; releaseEncodes: () => void; markupReads: number };
    state.encodes = 0;
    state.markupReads = 0;
    let released = false;
    const waiting: (() => void)[] = [];
    state.releaseEncodes = () => {
      released = true;
      for (const resume of waiting.splice(0)) resume();
    };
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
      state.encodes += 1;
      const encode = () => toBlob.call(this, callback, ...rest);
      if (released) encode();
      else waiting.push(encode);
    };
    const markup = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
    Object.defineProperty(Element.prototype, "innerHTML", {
      ...markup,
      get(this: Element) {
        if (this.isConnected && this.closest("[data-big]")) state.markupReads += 1;
        return markup.get!.call(this);
      },
    });
  });
  await countClones(page);
  // Each of the drawing's nodes takes 0.1 ms to copy, so the copy lasts long enough to be withdrawn midway.
  await page.evaluate(() => {
    const cloneNode = Node.prototype.cloneNode;
    Node.prototype.cloneNode = function (this: Node, deep?: boolean) {
      if (this instanceof SVGElement && this.closest("[data-big]")) for (const start = performance.now(); performance.now() - start < 0.1;);
      return cloneNode.call(this, deep);
    };
  });
  const counts = () => page.evaluate(() => {
    const state = window as unknown as { encodes: number; markupReads: number; cloned: Record<string, number> };
    return { clones: state.cloned.s ?? 0, encodes: state.encodes, markupReads: state.markupReads };
  });
  const pickDrawing = async () => {
    await page.getByTestId("big-svg").focus();
    await page.keyboard.press("Enter");
  };
  await enterCommentMode(page);
  // A capture that reaches drawing keeps the slot when the drawing is picked instead: the drawing's capture waits.
  await page.locator('[data-case="testid"]').click();
  await expect.poll(async () => (await counts()).encodes).toBe(1);
  await pickDrawing();
  await page.waitForTimeout(500);
  expect(await counts()).toEqual({ clones: 0, encodes: 1, markupReads: 0 });
  // Withdrawn while it waits, it never copies the drawing.
  await inBar(page, "[data-role=composer-cancel]").click();
  await page.evaluate(() => (window as unknown as { releaseEncodes: () => void }).releaseEncodes());
  await page.waitForTimeout(500);
  expect(await counts()).toEqual({ clones: 0, encodes: 1, markupReads: 0 });
  // Withdrawn while copying it, it stops there and draws nothing.
  await pickDrawing();
  await expect.poll(async () => (await counts()).clones).toBeGreaterThan(0);
  await inBar(page, "[data-role=composer-cancel]").click();
  const atCancel = (await counts()).clones;
  await page.waitForTimeout(1000);
  const after = await counts();
  expect(after.clones).toBeLessThan(atCancel + 50);
  expect(after.clones).toBeLessThan(10_000);
  expect(after.encodes).toBe(1);
  expect(after.markupReads).toBe(0);
});

/**
 * Adds a `[data-big=name]` drawing of `count` shapes, and records in `window.work` the nodes copied and the styles read
 * from each such drawing on the page, by its name, and in `window.workRuns` the order the drawings were worked on, one
 * entry per run. Each style read takes `window.readDelay` milliseconds.
 */
async function addBigDrawings(page: Page, names: readonly string[], count: number): Promise<void> {
  await page.evaluate(({ names, count }) => {
    for (const name of names) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.dataset.big = name;
      svg.dataset.testid = `drawing-${name}`;
      svg.setAttribute("tabindex", "0");
      svg.setAttribute("width", "300");
      svg.setAttribute("height", "20");
      svg.style.display = "block";
      svg.innerHTML = '<rect width="1" height="1"/>'.repeat(count);
      document.querySelector("main")!.prepend(svg);
    }
    const state = window as unknown as { work: Record<string, { clones: number; reads: number }>; workRuns: string[]; readDelay: number };
    state.work = {};
    state.workRuns = [];
    state.readDelay = 0;
    const note = (node: Node | null, kind: "clones" | "reads"): boolean => {
      const element = node instanceof Element ? node : node?.parentElement;
      const big = element?.ownerDocument === document ? element.closest<SVGElement>("[data-big]")?.dataset.big : undefined;
      if (!big) return false;
      const work = state.work[big] ??= { clones: 0, reads: 0 };
      work[kind] += 1;
      if (state.workRuns.at(-1) !== big) state.workRuns.push(big);
      return true;
    };
    const cloneNode = Node.prototype.cloneNode;
    Node.prototype.cloneNode = function (this: Node, deep?: boolean) {
      note(this, "clones");
      return cloneNode.call(this, deep);
    };
    const read = window.getComputedStyle;
    window.getComputedStyle = (element: Element, pseudo?: string | null) => {
      if (note(element, "reads")) for (const start = performance.now(); performance.now() - start < state.readDelay;);
      return read.call(window, element, pseudo);
    };
  }, { names, count });
}

function work(page: Page): Promise<{ work: Record<string, { clones: number; reads: number }>; workRuns: string[]; frames: number; blobs: number }> {
  return page.evaluate(() => {
    const { work, workRuns } = window as unknown as { work: Record<string, { clones: number; reads: number }>; workRuns: string[] };
    return { work, workRuns, frames: document.querySelector("iterbar-bar")!.shadowRoot!.querySelectorAll("iframe").length, blobs: window.canvasBlobs };
  });
}

test("a drawing's copy is checked only while its capture is current: a withdrawal stops it at once, the time limit ends it", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await addBigDrawings(page, ["w", "t"], 4_000);
  // A page with 20,000 fill and stroke rules, none of which applies to the drawings.
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = Array.from({ length: 20_000 }, (_, index) => `.rule-${index} rect { fill: rgb(255, 0, 0); stroke: rgb(0, 0, 255) }`).join("\n");
    document.head.append(style);
  });
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await countCanvasBlobs(page);
  const pick = async (name: string) => {
    await page.getByTestId(`drawing-${name}`).focus();
    await page.keyboard.press("Enter");
  };
  await enterCommentMode(page);

  // Each style read takes 0.5 ms, so checking the 4,000 shapes would take 2 seconds: Cancel stops it within a read.
  await page.evaluate(() => {
    (window as unknown as { readDelay: number }).readDelay = 0.5;
  });
  // The page records the longest it goes without running a timer while the capture works.
  await page.evaluate(() => {
    const state = window as unknown as { longestStall: number; stallTimer: number };
    state.longestStall = 0;
    let last = performance.now();
    state.stallTimer = window.setInterval(() => {
      state.longestStall = Math.max(state.longestStall, performance.now() - last);
      last = performance.now();
    }, 5);
  });
  await pick("w");
  await expect.poll(async () => (await work(page)).work.w?.reads ?? 0, { timeout: 15_000 }).toBeGreaterThan(50);
  await inBar(page, "[data-role=composer-cancel]").click();
  const atCancel = (await work(page)).work.w!.reads;
  const longestStall = await page.evaluate(() => {
    const state = window as unknown as { longestStall: number; stallTimer: number };
    window.clearInterval(state.stallTimer);
    return state.longestStall;
  });
  expect(longestStall).toBeLessThan(100);
  // The frame the copy was checked in goes as soon as the check reaches its next element.
  await expect.poll(async () => (await work(page)).frames, { intervals: [10], timeout: 200 }).toBe(0);
  await page.waitForTimeout(300);
  const withdrawn = await work(page);
  expect(withdrawn.work.w!.reads).toBeLessThan(atCancel + 3);
  expect(withdrawn.work.w!.reads).toBeLessThan(4_000);
  expect(withdrawn.blobs).toBe(0);

  // At 3 ms a read the check would take 12 seconds: the time limit ends it, and the comment is sent without one.
  await page.evaluate(() => {
    (window as unknown as { readDelay: number }).readDelay = 3;
  });
  await pick("t");
  await inBar(page, "[data-role=composer-text]").fill("Slow drawing");
  await inBar(page, "[data-role=composer-send]").click();
  await expect.poll(() => daemon.posts.length, { timeout: 15_000 }).toBe(1);
  expect(daemon.posts[0]!.screenshot).toBeNull();
  expect(daemon.posts[0]!.draft.screenshotUnavailableReason).toBe("The screenshot failed: it took longer than 10 seconds");
  const timedOut = await work(page);
  expect(timedOut.work.t!.reads).toBeGreaterThan(1_000);
  expect(timedOut.work.t!.reads).toBeLessThan(4_000);
  expect(timedOut.frames).toBe(0);
  expect(timedOut.blobs).toBe(0);
});

test("the page's rules for what a <use> shows are matched a step at a time: a withdrawal stops them, the time limit ends them", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  // Two drawings that each show a 2,000-shape symbol, on a page with 20,000 rules; each match takes 0.01 ms, so
  // matching them all would take minutes.
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = Array.from({ length: 20_000 }, (_, index) => `.rule-${index} rect { fill: rgb(255, 0, 0) }`).join("\n");
    document.head.append(style);
    for (const name of ["u", "v"]) {
      document.querySelector("main")!.insertAdjacentHTML("afterbegin", `<svg data-big="${name}" data-testid="shows-${name}" tabindex="0" width="100" height="20"
        style="display: block"><defs><symbol id="symbol-${name}">${'<rect width="1" height="1"/>'.repeat(2_000)}</symbol></defs><use href="#symbol-${name}"/></svg>`);
    }
    const state = window as unknown as { matched: Record<string, number> };
    state.matched = {};
    const matches = Element.prototype.matches;
    Element.prototype.matches = function (this: Element, selector: string) {
      const big = this.ownerDocument === document ? this.closest<SVGElement>("[data-big]")?.dataset.big : undefined;
      if (big) {
        state.matched[big] = (state.matched[big] ?? 0) + 1;
        for (const start = performance.now(); performance.now() - start < 0.01;);
      }
      return matches.call(this, selector);
    };
  });
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await countCanvasBlobs(page);
  const matched = (name: string) => page.evaluate((name) => (window as unknown as { matched: Record<string, number> }).matched[name] ?? 0, name);
  const frames = () => page.evaluate(() => document.querySelector("iterbar-bar")!.shadowRoot!.querySelectorAll("iframe").length);
  await enterCommentMode(page);
  await page.evaluate(() => {
    const state = window as unknown as { longestStall: number; stallTimer: number };
    state.longestStall = 0;
    let last = performance.now();
    state.stallTimer = window.setInterval(() => {
      state.longestStall = Math.max(state.longestStall, performance.now() - last);
      last = performance.now();
    }, 5);
  });
  await page.getByTestId("shows-u").focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => matched("u"), { timeout: 15_000 }).toBeGreaterThan(5_000);
  // While the rules are matched, the page keeps running its timers.
  await page.evaluate(() => {
    (window as unknown as { longestStall: number }).longestStall = 0;
  });
  await page.waitForTimeout(300);
  await inBar(page, "[data-role=composer-cancel]").click();
  const atCancel = await matched("u");
  expect(await page.evaluate(() => (window as unknown as { longestStall: number }).longestStall)).toBeLessThan(100);
  await expect.poll(frames, { intervals: [10], timeout: 200 }).toBe(0);
  await page.waitForTimeout(300);
  expect(await matched("u")).toBeLessThan(atCancel + 50);

  // The time limit ends the matching, and the comment is sent without a screenshot.
  await page.getByTestId("shows-v").focus();
  await page.keyboard.press("Enter");
  await inBar(page, "[data-role=composer-text]").fill("Many rules");
  await inBar(page, "[data-role=composer-send]").click();
  await expect.poll(() => daemon.posts.length, { timeout: 15_000 }).toBe(1);
  expect(daemon.posts[0]!.screenshot).toBeNull();
  expect(daemon.posts[0]!.draft.screenshotUnavailableReason).toBe("The screenshot failed: it took longer than 10 seconds");
  const atLimit = await matched("v");
  await page.waitForTimeout(300);
  expect(await matched("v")).toBeLessThan(atLimit + 50);
  expect(await frames()).toBe(0);
  expect(await page.evaluate(() => window.canvasBlobs)).toBe(0);
});

test("a drawing whose style sheet is in many pieces is copied without holding up the page", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await page.evaluate(() => {
    document.querySelector("main")!.insertAdjacentHTML("afterbegin",
      '<svg data-testid="pieces" tabindex="0" width="100" height="20" style="display: block"><style id="pieces-sheet"></style><rect width="100" height="20" fill="rgb(0, 255, 0)"/></svg>');
    const sheet = document.getElementById("pieces-sheet")!;
    for (let index = 0; index < 5_000; index++) sheet.append(`#pieces-sheet ~ .piece-${index} { fill: rgb(255, 0, 0) }\n`);
  });
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await page.evaluate(() => {
    const state = window as unknown as { longestStall: number };
    state.longestStall = 0;
    let last = performance.now();
    window.setInterval(() => {
      state.longestStall = Math.max(state.longestStall, performance.now() - last);
      last = performance.now();
    }, 5);
  });
  const { draft, screenshot } = await commentFromKeyboard(page, daemon, "pieces");
  expect(draft.screenshotUnavailableReason).toBeNull();
  expect(screenshot).not.toBeNull();
  // The sheet is parsed once (taking it a piece at a time held the page up for seconds); drawing and encoding are in
  // this window too.
  expect(await page.evaluate(() => (window as unknown as { longestStall: number }).longestStall)).toBeLessThan(500);
});

test("rapid re-picks of drawings copy and check one at a time and draw only the last", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  const names = ["a", "b", "c", "d", "e"];
  await addBigDrawings(page, names, 2_000);
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await countCanvasBlobs(page);
  await page.evaluate(() => {
    (window as unknown as { readDelay: number }).readDelay = 0.2;
  });
  await enterCommentMode(page);
  for (const name of names) {
    await page.getByTestId(`drawing-${name}`).focus();
    await page.keyboard.press("Enter");
  }
  await inBar(page, "[data-role=composer-text]").fill("Last");
  await inBar(page, "[data-role=composer-send]").click();
  await expect.poll(() => daemon.posts.length, { timeout: 15_000 }).toBe(1);
  const done = await work(page);
  // Never two at once: each drawing's work is one run, in pick order, and only the last was checked through.
  expect(done.workRuns).toEqual(names.filter((name) => done.work[name]));
  for (const name of names.slice(0, -1)) expect(done.work[name]?.reads ?? 0, name).toBeLessThan(2_000);
  expect(done.work.e!.reads).toBeGreaterThanOrEqual(2_000);
  expect(done.blobs).toBe(1);
  expect(done.frames).toBe(0);
  expect(daemon.posts[0]!.draft.target?.selector).toBe('[data-testid="drawing-e"]');
  expect(daemon.posts[0]!.screenshot).not.toBeNull();
});

test("a capture withdrawn while its element is being copied stops there, and draws nothing", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await addBigBox(page, "a", 20_000);
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await countCanvasBlobs(page);
  await countClones(page);
  const cloned = () => page.evaluate(() => (window as unknown as { cloned: Record<string, number> }).cloned.a ?? 0);
  await enterCommentMode(page);
  await page.getByTestId("big-a").click();
  await expect.poll(cloned).toBeGreaterThan(0);
  await inBar(page, "[data-role=composer-cancel]").click();
  await expect(inBar(page, "[data-section=composer]")).toBeHidden();
  const atCancel = await cloned();
  await page.waitForTimeout(1000);
  // The copy stopped within a node or two of the Cancel, far short of the 20,001 nodes, and nothing was drawn.
  expect(await cloned()).toBeLessThan(atCancel + 50);
  expect(await cloned()).toBeLessThan(10_000);
  expect(await page.evaluate(() => window.canvasBlobs)).toBe(0);
});

test("rapid re-picks copy one element at a time and draw only the last", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  const names = ["a", "b", "c", "d", "e"];
  for (const name of names) await addBigBox(page, name, 6_000);
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await countCanvasBlobs(page);
  await countClones(page);
  await enterCommentMode(page);
  for (const name of names) await page.getByTestId(`big-${name}`).click({ position: { x: 5, y: 5 } });
  await inBar(page, "[data-role=composer-text]").fill("Last");
  await inBar(page, "[data-role=composer-send]").click();
  await expect.poll(() => daemon.posts.length, { timeout: 15_000 }).toBe(1);
  const { cloned, clonedRuns } = await page.evaluate(() => {
    const { cloned, clonedRuns } = window as unknown as { cloned: Record<string, number>; clonedRuns: string[] };
    return { cloned, clonedRuns };
  });
  // Never two copies at once: each element's copying is one run, in pick order, and each replaced one stopped early.
  expect(clonedRuns).toEqual(names.filter((name) => cloned[name]));
  for (const name of names.slice(0, -1)) expect(cloned[name] ?? 0, name).toBeLessThan(6_001);
  expect(cloned.e).toBe(6_001);
  expect(await page.evaluate(() => window.canvasBlobs)).toBe(1);
  expect(daemon.posts[0]!.draft.target?.selector).toBe('[data-testid="big-e"]');
  expect(daemon.posts[0]!.screenshot).not.toBeNull();
});

test("a capture withdrawn while it is drawn finishes before another draws, so encodes never overlap", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openCases(page, openFixture, daemon);
  // Every encode takes 300 ms; the page records how many run at once.
  await page.evaluate(() => {
    const state = window as unknown as { encoding: number; maxEncoding: number };
    state.encoding = 0;
    state.maxEncoding = 0;
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
      state.encoding += 1;
      state.maxEncoding = Math.max(state.maxEncoding, state.encoding);
      toBlob.call(this, (blob) => setTimeout(() => {
        state.encoding -= 1;
        callback(blob);
      }, 300), ...rest);
    };
  });
  const encoding = () => page.evaluate(() => (window as unknown as { encoding: number }).encoding);
  await enterCommentMode(page);
  // Each pick replaces, or Cancel withdraws, a capture that is being encoded.
  for (const target of ['[data-case="testid"]', '[data-case="id"]', '[data-case="stamped"]', '[data-case="slot"]']) {
    await page.locator(target).click();
    await expect.poll(encoding).toBe(1);
  }
  await inBar(page, "[data-role=composer-cancel]").click();
  await page.locator('[data-case="root"]').click();
  await expect.poll(encoding).toBe(1);
  await inBar(page, "[data-role=composer-text]").fill("Last");
  await inBar(page, "[data-role=composer-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(1);
  expect(daemon.posts[0]!.screenshot).not.toBeNull();
  expect(await page.evaluate(() => (window as unknown as { maxEncoding: number }).maxEncoding)).toBe(1);
});

test("a withdrawn capture still waiting inside its render holds up no later capture", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  // The background image is fetched while the copy is embedded, inside the render; it never arrives in time.
  const release = await heldImage(page, `${fixtureServer.origin}/stalled.svg`, 40, 40);
  await openCases(page, openFixture, daemon);
  await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("afterbegin",
    '<div data-testid="stalled" style="width: 80px; height: 40px; background: url(/stalled.svg)"></div>'));
  await enterCommentMode(page);
  await page.getByTestId("stalled").click();
  await page.waitForTimeout(500);
  const started = Date.now();
  await page.locator('[data-case="testid"]').click();
  await inBar(page, "[data-role=composer-text]").fill("Not held up");
  await inBar(page, "[data-role=composer-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(1);
  const { draft, screenshot } = daemon.posts[0]!;
  expect(draft.target?.selector).toBe('[data-testid="save"]');
  expect(draft.screenshotUnavailableReason).toBeNull();
  expect(screenshot).not.toBeNull();
  expect(Date.now() - started).toBeLessThan(5_000);
  release();
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

test("Enter or Space on a focused page control, the context menu and the document root reach no page handler while picking", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openFixture();
  await page.evaluate(() => {
    document.querySelector("main")!.insertAdjacentHTML("beforeend",
      '<form data-testid="form"><input data-testid="field" name="q"><button data-testid="go">Go</button></form>'
      + '<div role="button" tabindex="0" data-testid="custom">Custom</div>');
    window.pageEvents = [];
    for (const type of ["pointerdown", "click", "keydown", "keyup", "contextmenu", "auxclick", "focusin", "submit"]) {
      document.addEventListener(type, (event) => {
        window.pageEvents.push(`${type}:${(event.target as Element).localName}`);
        if (type === "submit") event.preventDefault();
      }, true);
    }
  });
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  // Focus moving into the bar reaches the page as a focusin on the bar itself, which is not the page's input.
  const events = () => page.evaluate(() => window.pageEvents.splice(0).filter((entry) => !entry.endsWith(":iterbar-bar")));
  const field = page.getByTestId("field");
  // A point where nothing but the document root is hit.
  const root = await page.evaluate(() => {
    const point = { x: 20, y: innerHeight - 20 };
    return document.elementFromPoint(point.x, point.y)?.localName === "html" ? point : null;
  });
  expect(root).not.toBeNull();

  // Comment mode off: the page gets all of it.
  await field.focus();
  await field.press("Enter");
  await page.getByTestId("custom").press(" ");
  await page.getByTestId("go").click({ button: "right" });
  await page.mouse.click(root!.x, root!.y);
  expect(await events()).toEqual(expect.arrayContaining([
    "keydown:input", "submit:form", "keyup:input", "keydown:div", "keyup:div", "contextmenu:button", "click:html",
  ]));

  await enterCommentMode(page);
  await field.focus();
  await events();
  await page.keyboard.press("Enter");
  await expect(inBar(page, "[data-role=composer-target]")).toHaveText("On input");
  await expect(inBar(page, "[data-role=pick-picked]")).toBeVisible();
  await page.getByTestId("go").click({ button: "right" });
  await page.mouse.click(root!.x, root!.y);
  // Neither a key, a submit, a menu, a focus change nor a press on the root reached the page; the composer kept focus.
  expect(await events()).toEqual([]);
  await expect(inBar(page, "[data-role=composer-target]")).toHaveText("On input");

  // Space, the other activation key, picks a focused control the same way.
  await page.getByTestId("custom").focus();
  await events();
  await page.keyboard.press(" ");
  await expect(inBar(page, "[data-role=composer-target]")).toHaveText("On div");
  expect(await events()).toEqual([]);

  // Holding the key: its repeats and release, which follow focus into the composer, reach neither it nor the page.
  await inBar(page, "[data-role=composer-cancel]").click();
  await page.getByTestId("custom").focus();
  await events();
  await page.keyboard.down(" ");
  await page.keyboard.down(" ");
  await page.keyboard.down(" ");
  await page.keyboard.up(" ");
  await expect(inBar(page, "[data-role=composer-target]")).toHaveText("On div");
  await expect(inBar(page, "[data-role=composer-text]")).toHaveValue("");
  expect(await page.evaluate(() => window.pageEvents.splice(0).filter((entry) => !entry.startsWith("focusin:")))).toEqual([]);

  // Keys inside the bar are its own: Enter in the composer types a line break.
  await inBar(page, "[data-role=composer-text]").press("Enter");
  await expect(inBar(page, "[data-role=composer-text]")).toHaveValue("\n");
  expect(daemon.posts).toEqual([]);
});

test("the key that picked is no longer swallowed once its press ends without a keyup reaching the page", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openCases(page, openFixture, daemon);
  const button = page.locator('[data-case="testid"]');
  const text = inBar(page, "[data-role=composer-text]");
  await enterCommentMode(page);
  // Each way the press can end unseen: the window losing focus, the page being hidden, or a fresh press of the key.
  const endings: Record<string, () => Promise<void>> = {
    blur: () => page.evaluate(() => void window.dispatchEvent(new FocusEvent("blur"))),
    hidden: () => page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      delete (document as { visibilityState?: unknown }).visibilityState;
    }),
    "fresh press": () => text.evaluate((field) => void field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, composed: true }))),
  };
  for (const [ending, end] of Object.entries(endings)) {
    await button.focus();
    await page.keyboard.down("Enter");
    await expect(inBar(page, "[data-role=composer-target]")).toHaveText("On button");
    // While the press lasts its repeats are swallowed, even in the composer.
    await text.focus();
    await page.keyboard.down("Enter");
    await expect(text, ending).toHaveValue("");
    await end();
    // Then the key is the composer's again: held down there, it repeats into the text.
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await expect(text, ending).toHaveValue("\n\n");
    await page.keyboard.up("Enter");
    await inBar(page, "[data-role=composer-cancel]").click();
  }
  expect(daemon.posts).toEqual([]);
});

test("outlines the hovered and picked elements in place under an inherited page zoom", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openCases(page, openFixture, daemon);
  await page.addStyleTag({ content: "html { zoom: 2; } body { zoom: 0.75; }" });
  const save = page.locator('[data-case="testid"]');
  await enterCommentMode(page);
  await save.hover();
  await expect(inBar(page, "[data-role=pick-hover]")).toBeVisible();
  const expected = await save.boundingBox();
  expect(await inBar(page, "[data-role=pick-hover]").boundingBox()).toEqual(expected);
  await save.click();
  await expect(inBar(page, "[data-role=pick-picked]")).toBeVisible();
  expect(await inBar(page, "[data-role=pick-picked]").boundingBox()).toEqual(expected);
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
  daemon.failFeedback = 409;
  await inBar(page, "[data-role=composer-send]").click();
  await expect(inBar(page, "[data-role=composer-error]")).toHaveText("The daemon refused it (409): The store is locked");
  await expect(inBar(page, "[data-role=composer-text]")).toHaveValue("Retry me");
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "true");

  daemon.failFeedback = null;
  await inBar(page, "[data-role=composer-text]").press("Control+Enter");
  await expect.poll(() => daemon.posts.length).toBe(1);
  expect(daemon.posts[0]!.draft.target?.selector).toBe('[data-iterbar-src="src/Card.tsx:4:3"] > p.lead:nth-of-type(2)');
  await expect(inBar(page, '[data-feedback-id="posted-1"] .thread-text')).toHaveText("Retry me");
});

test("a send that gets no answer says the comment may already be stored", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openCases(page, openFixture, daemon);
  daemon.dropFeedbackAnswer = true;
  await comment(page, daemon, page.locator('[data-case="testid"]'), "Stored, unanswered");
  // The daemon stored it before the connection dropped; the bar cannot know that, so it says so instead of
  // "cannot reach the daemon", and a refusal (which stores nothing) keeps its own message (see the retry test).
  await expect(inBar(page, "[data-role=composer-error]")).toHaveText(
    /^The daemon did not answer \(.+\), so the comment may already be stored\. Check the threads before sending it again\.$/u);
  await expect(inBar(page, "[data-role=composer-text]")).toHaveValue("Stored, unanswered");
  // The bar lists the threads again, so the stored comment is there to check.
  await expect(inBar(page, '[data-feedback-id="posted-1"] .thread-text')).toHaveText("Stored, unanswered");
  expect(daemon.posts).toHaveLength(1);
});

test("a send the daemon fails with a 5xx after storing it says the comment may already be stored", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin);
  await openCases(page, openFixture, daemon);
  daemon.failFeedbackAfterStore = 500;
  await comment(page, daemon, page.locator('[data-case="testid"]'), "Stored, then failed");
  // Not a refusal: the daemon's reason is kept, and the user is told to check the threads before sending again.
  await expect(inBar(page, "[data-role=composer-error]")).toHaveText(
    "The daemon failed (500): The store is unavailable, so the comment may already be stored. Check the threads before sending it again.");
  await expect(inBar(page, "[data-role=composer-text]")).toHaveValue("Stored, then failed");
  // The daemon announced nothing; the bar lists the threads again, so the stored comment is there to check.
  await expect(inBar(page, '[data-feedback-id="posted-1"] .thread-text')).toHaveText("Stored, then failed");
  expect(daemon.sockets).toHaveLength(1);
  expect(daemon.posts).toHaveLength(1);
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
  // Picking another element withdraws the capture of the one it replaces.
  await slow.click();
  await page.locator('[data-case="id"]').click();
  await expect.poll(() => page.evaluate(() => window.canvasBlobs)).toBe(1);
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

  // The withdrawn captures, still waiting for their image, hold nothing up: another comment gets its screenshot now.
  const kept = await comment(page, daemon, page.locator('[data-case="testid"]'), "Kept");
  expect(kept.draft.text).toBe("Kept");
  expect(kept.screenshot).not.toBeNull();
  expect(await page.evaluate(() => window.canvasBlobs)).toBe(2);

  // Once their image loads they stop without rendering, and nothing withdrawn is posted.
  release();
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>("[data-testid=slow] img")!.complete);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.canvasBlobs)).toBe(2);
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
  daemon.failFeedback = 409;
  await enterCommentMode(page);
  await save.click();
  await text.fill("Refused later");
  await send.click();
  await expect.poll(() => feedbackPosts(daemon)).toBe(2);
  await page.keyboard.press("Escape");
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "false");
  answer();
  await expect(inBar(page, "[data-role=composer-error]")).toHaveText("The daemon refused it (409): The store is locked");
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
