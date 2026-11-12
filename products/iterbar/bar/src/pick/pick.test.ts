import { describe, expect, it } from "vitest";
import { MAX_SCREENSHOT_PIXELS, pngDimensions, RenderSlot, screenshotScale, unavailableReason } from "./screenshot.js";
import { cssString } from "./selector.js";
import { textExcerpt } from "./target.js";

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
