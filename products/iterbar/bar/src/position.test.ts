import { describe, expect, it } from "vitest";
import { anchorPopover, BAR_MARGIN_PX, DEFAULT_BAR_STATE, dockForKey, formatBarState, nextDock, parseBarState } from "./position.js";

describe("stored toolbar state", () => {
  it("round-trips a valid state", () => {
    const state = { dock: "right", expanded: true, panel: "drafts", filter: "progress" } as const;
    expect(parseBarState(formatBarState(state))).toEqual(state);
    expect(parseBarState(formatBarState({ ...state, panel: null }))).toEqual({ ...state, panel: null });
  });

  it("falls back field by field for malformed values", () => {
    expect(parseBarState(null)).toEqual(DEFAULT_BAR_STATE);
    expect(parseBarState("{not json")).toEqual(DEFAULT_BAR_STATE);
    expect(parseBarState("[]")).toEqual(DEFAULT_BAR_STATE);
    expect(parseBarState(JSON.stringify({ dock: "top", expanded: 1, panel: "nope", filter: 3 }))).toEqual(DEFAULT_BAR_STATE);
    expect(parseBarState(JSON.stringify({ dock: "left", panel: "inbox" })))
      .toEqual({ dock: "left", expanded: false, panel: "inbox", filter: "all" });
  });

  it("sleeps at the bottom centre by default", () => {
    expect(DEFAULT_BAR_STATE).toEqual({ dock: "center", expanded: false, panel: null, filter: "all" });
  });
});

describe("docks", () => {
  it("cycles left, centre, right", () => {
    expect([nextDock("left"), nextDock("center"), nextDock("right")]).toEqual(["center", "right", "left"]);
  });

  it("moves one dock per arrow key and stops at the ends", () => {
    expect(dockForKey("center", "ArrowLeft")).toBe("left");
    expect(dockForKey("center", "ArrowRight")).toBe("right");
    expect(dockForKey("left", "ArrowLeft")).toBeNull();
    expect(dockForKey("right", "ArrowRight")).toBeNull();
    expect(dockForKey("center", "ArrowUp")).toBeNull();
  });
});

describe("anchorPopover", () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 300, height: 160 };

  it("opens below the element, aligned with its left edge", () => {
    expect(anchorPopover({ left: 100, top: 100, width: 200, height: 40 }, size, viewport)).toEqual({ left: 100, top: 148 });
  });

  it("opens above an element too low for it, keeping clear of the toolbar", () => {
    expect(anchorPopover({ left: 100, top: 600, width: 200, height: 40 }, size, viewport, 60)).toEqual({ left: 100, top: 432 });
  });

  it("stays inside the margins for an element at the right edge or taller than the viewport", () => {
    expect(anchorPopover({ left: 950, top: 100, width: 40, height: 20 }, size, viewport).left).toBe(1000 - BAR_MARGIN_PX - 300);
    const tall = anchorPopover({ left: -50, top: -100, width: 2000, height: 2000 }, size, viewport);
    expect(tall).toEqual({ left: BAR_MARGIN_PX, top: 800 - BAR_MARGIN_PX - 160 });
  });
});
