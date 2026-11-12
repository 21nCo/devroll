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

/** The RGBA of `png` at each CSS-pixel `[x, y]` point, and the share of its pixels that are opaque, decoded in the page. */
function pngPixels(page: Page, png: Buffer, points: readonly (readonly [number, number])[]): Promise<{ at: number[][]; opaque: number }> {
  return page.evaluate(async ({ base64, points }) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let opaque = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index] === 255) opaque += 1;
    const at = points.map(([x, y]) => [...data.subarray((y * bitmap.width + x) * 4, (y * bitmap.width + x) * 4 + 4)]);
    return { at, opaque: opaque / (bitmap.width * bitmap.height) };
  }, { base64: png.toString("base64"), points });
}

/** How many pixels of `png` are opaque and dark (text drawn in black), decoded in the page. */
function darkPixels(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let dark = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index + 3] === 255 && data[index]! + data[index + 1]! + data[index + 2]! < 300) dark += 1;
    return dark;
  }, png.toString("base64"));
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

  // A translated <svg> drawing (which its shape covers, so it is picked from the keyboard) fills its image.
  await enterCommentMode(page);
  await page.getByTestId("svg").focus();
  await page.keyboard.press("Enter");
  await inBar(page, "[data-role=composer-text]").fill("Drawing");
  await inBar(page, "[data-role=composer-send]").click();
  await expect.poll(() => daemon.posts.length).toBe(4);
  expect(daemon.posts[3]!.draft.target?.selector).toBe('[data-testid="svg"]');
  const svg = daemon.posts[3]!.screenshot!;
  expect(pngSize(svg)).toEqual({ width: 100, height: 50 });
  expect(await pngPixels(page, svg, [[2, 2], [50, 25], [97, 47]])).toEqual({ at: [[0, 255, 0, 255], [0, 255, 0, 255], [0, 255, 0, 255]], opaque: 1 });

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
