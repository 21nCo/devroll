import { describe, expect, it } from "vitest";
import { MAX_SCREENSHOT_PIXELS, pngDimensions, RenderSlot, screenshotScale, unavailableReason } from "./screenshot.js";
import { cssString } from "./selector.js";
import { formatLabel, labelTarget, labelTooltip, lastSelectorStep, textExcerpt } from "./target.js";

describe("textExcerpt", () => {
  it("collapses whitespace and keeps short text whole", () => {
    expect(textExcerpt("  Save\n\n  changes\t now ")).toBe("Save changes now");
  });

  it("cuts long text to the limit with an ellipsis", () => {
    const excerpt = textExcerpt("word ".repeat(100));
    expect(excerpt).toHaveLength(200);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("never splits a surrogate pair at the cut", () => {
    const excerpt = textExcerpt(`${"a".repeat(8)}😀😀`, 10);
    expect(excerpt).toBe(`${"a".repeat(8)}…`);
    expect(excerpt.length).toBeLessThanOrEqual(10);
  });
});

describe("screenshotScale", () => {
  it("uses the device pixel ratio when the image stays within 4 MP", () => {
    expect(screenshotScale(300, 200, 2)).toBe(2);
  });

  it("lowers the scale so the image stays within 4 MP", () => {
    const scale = screenshotScale(4000, 3000, 2)!;
    expect(scale).toBeLessThan(1);
    expect(Math.floor(4000 * scale) * Math.floor(3000 * scale)).toBeLessThanOrEqual(MAX_SCREENSHOT_PIXELS);
  });

  it("refuses an element without area and falls back to 1 for a bad ratio", () => {
    expect(screenshotScale(0, 100, 1)).toBeNull();
    expect(screenshotScale(100, Number.NaN, 1)).toBeNull();
    expect(screenshotScale(100, 100, 0)).toBe(1);
  });
});

describe("unavailableReason", () => {
  it("stays within the contract's 500 characters and is never blank", () => {
    expect(unavailableReason("x".repeat(2000))).toHaveLength(500);
    expect(unavailableReason("   ")).toBe("The screenshot failed: unknown error");
  });
});

describe("cssString", () => {
  it("leaves stamp punctuation readable and escapes quotes, backslashes and controls", () => {
    expect(cssString("src/App.tsx:12:5")).toBe('"src/App.tsx:12:5"');
    expect(cssString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(cssString("a\nb")).toBe('"a\\a b"');
  });
});

describe("pngDimensions", () => {
  const header = (width: number, height: number): Uint8Array => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
  };

  it("reads the size from the IHDR chunk", () => {
    expect(pngDimensions(header(2001, 2000))).toEqual({ width: 2001, height: 2000 });
  });

  it("refuses bytes that are not a PNG header", () => {
    const notPng = header(10, 10);
    notPng[1] = 0;
    expect(pngDimensions(notPng)).toBeNull();
    expect(pngDimensions(header(10, 10).subarray(0, 20))).toBeNull();
  });
});

describe("RenderSlot", () => {
  it("lets one holder at a time in, in the order they asked, each once the one before has released it", async () => {
    const slot = new RenderSlot();
    const order: string[] = [];
    const take = async (name: string) => {
      const release = await slot.acquire();
      order.push(`+${name}`);
      return () => {
        order.push(`-${name}`);
        release();
      };
    };
    const first = take("a");
    const second = take("b");
    const third = take("c");
    const releaseA = await first;
    await Promise.resolve();
    expect(order).toEqual(["+a"]);
    releaseA();
    (await second)();
    (await third)();
    expect(order).toEqual(["+a", "-a", "+b", "-b", "+c", "-c"]);
  });
});

describe("target labels", () => {
  const box = { x: 0, y: 0, width: 10, height: 10 };

  it("names a stored target by its text and source file and line, with the full location and selector for a tooltip", () => {
    const label = labelTarget({
      selector: '[data-testid="card"]', textExcerpt: "Fresh start card", boundingBox: box,
      sourceLocation: { path: "src/components/home/FreshStart.svelte", line: 70, column: 7 },
    })!;
    expect(formatLabel(label)).toBe("“Fresh start card” · FreshStart.svelte:70");
    expect(labelTooltip(label)).toBe('Source: src/components/home/FreshStart.svelte:70:7\nSelector: [data-testid="card"]');
  });

  it("falls back to the last selector step without text, and to nothing without a target", () => {
    const label = labelTarget({ selector: ":root > body > main > div.text-[12px]", textExcerpt: "", boundingBox: box, sourceLocation: null })!;
    expect(formatLabel(label)).toBe("div.text-[12px]");
    expect(labelTarget(null)).toBeNull();
  });

  it("finds the last selector step outside quoted attribute values", () => {
    expect(lastSelectorStep('[data-testid="menu > save"]')).toBe('[data-testid="menu > save"]');
    expect(lastSelectorStep('main > [aria-label="a > b"] > span.x')).toBe("span.x");
    expect(lastSelectorStep(":root > body > p:nth-of-type(2)")).toBe("p:nth-of-type(2)");
  });

  it("cuts a long excerpt", () => {
    const label = labelTarget({ selector: "p", textExcerpt: "word ".repeat(40), boundingBox: box, sourceLocation: null })!;
    expect(label.name.length).toBeLessThanOrEqual(50);
    expect(label.name.endsWith("…”")).toBe(true);
  });
});
