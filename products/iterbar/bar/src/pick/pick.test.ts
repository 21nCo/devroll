import { describe, expect, it } from "vitest";
import { MAX_SCREENSHOT_PIXELS, screenshotScale, unavailableReason } from "./screenshot.js";
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
