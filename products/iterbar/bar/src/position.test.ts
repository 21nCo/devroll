import { describe, expect, it } from "vitest";
import {
  anchorPopover, BAR_MARGIN_PX, BAR_STATE_STORAGE_KEY, barStateStorageKey, DEFAULT_BAR_STATE, describePosition, formatBarState,
  leftForPosition, parseBarState, positionForKey, positionForLeft,
} from "./position.js";

describe("stored toolbar state", () => {
  it("round-trips a valid state", () => {
    const state = { x: 0.3, expanded: true, panel: "drafts", filter: "progress", agent: "codex" } as const;
    expect(parseBarState(formatBarState(state))).toEqual(state);
    expect(parseBarState(formatBarState({ ...state, panel: null }))).toEqual({ ...state, panel: null });
    expect(parseBarState(formatBarState({ ...state, panel: "agent" })).panel).toBe("agent");
  });

  it("falls back field by field for malformed values", () => {
    expect(parseBarState(null)).toEqual(DEFAULT_BAR_STATE);
    expect(parseBarState("{not json")).toEqual(DEFAULT_BAR_STATE);
    expect(parseBarState("[]")).toEqual(DEFAULT_BAR_STATE);
    expect(parseBarState(JSON.stringify({ x: "left", dock: "top", expanded: 1, panel: "nope", filter: 3, agent: "vim" })))
      .toEqual(DEFAULT_BAR_STATE);
    expect(parseBarState(JSON.stringify({ x: 0.2, panel: "inbox" })))
      .toEqual({ x: 0.2, expanded: false, panel: "inbox", filter: "all", agent: "claude" });
  });

  it("keeps the position within 0 and 1", () => {
    expect(parseBarState(JSON.stringify({ x: -3 })).x).toBe(0);
    expect(parseBarState(JSON.stringify({ x: 7 })).x).toBe(1);
    expect(parseBarState(JSON.stringify({ x: Number.NaN })).x).toBe(0.5);
  });

  it("reads the earlier left, centre and right docks as positions", () => {
    expect(parseBarState(JSON.stringify({ dock: "left" })).x).toBe(0);
    expect(parseBarState(JSON.stringify({ dock: "center" })).x).toBe(0.5);
    expect(parseBarState(JSON.stringify({ dock: "right" })).x).toBe(1);
    expect(parseBarState(JSON.stringify({ dock: "right", x: 0.25 })).x).toBe(0.25);
  });

  it("sleeps at the bottom centre by default", () => {
    expect(DEFAULT_BAR_STATE).toEqual({ x: 0.5, expanded: false, panel: null, filter: "all", agent: "claude" });
  });

  it("keeps one state per project", () => {
    expect(barStateStorageKey(null)).toBe(BAR_STATE_STORAGE_KEY);
    expect(barStateStorageKey("/work/app")).toBe(`${BAR_STATE_STORAGE_KEY}:/work/app`);
  });
});

describe("position along the bottom edge", () => {
  it("shares the room between the margins", () => {
    expect(leftForPosition(0, 200, 1000)).toBe(BAR_MARGIN_PX);
    expect(leftForPosition(1, 200, 1000)).toBe(1000 - BAR_MARGIN_PX - 200);
    expect(leftForPosition(0.5, 200, 1000)).toBe(400);
  });

  it("stays in view at any width, and at the left margin when the toolbar is wider than the room", () => {
    expect(leftForPosition(1, 200, 300)).toBe(300 - BAR_MARGIN_PX - 200);
    expect(leftForPosition(0.7, 500, 300)).toBe(BAR_MARGIN_PX);
  });

  it("turns a dropped left edge back into a position, clamped", () => {
    expect(positionForLeft(400, 200, 1000)).toBeCloseTo(0.5);
    expect(positionForLeft(-50, 200, 1000)).toBe(0);
    expect(positionForLeft(5000, 200, 1000)).toBe(1);
    expect(positionForLeft(10, 500, 300)).toBe(0.5);
    // Rounded to thousandths, as stored: a drag shows the side of two thirds that dropping it saves.
    expect(positionForLeft(12 + (2 / 3 - 0.00004) * 776, 200, 1000)).toBe(0.667);
  });

  it("moves with the arrow keys, Shift for bigger steps, and Home and End", () => {
    expect(positionForKey(0.5, "ArrowLeft", false)).toBe(0.45);
    expect(positionForKey(0.5, "ArrowRight", true)).toBe(0.75);
    expect(positionForKey(0.02, "ArrowLeft", false)).toBe(0);
    expect(positionForKey(0.98, "ArrowRight", false)).toBe(1);
    expect(positionForKey(0.5, "Home", false)).toBe(0);
    expect(positionForKey(0.5, "End", false)).toBe(1);
    expect(positionForKey(0.5, "ArrowUp", false)).toBeNull();
  });

  it("reads as left, centre, right or a percentage", () => {
    expect([0, 0.5, 1, 0.3].map(describePosition)).toEqual(["left", "centre", "right", "30% from the left"]);
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

  it("stays inside the viewport for an element scrolled out of view", () => {
    expect(anchorPopover({ left: 100, top: 1000, width: 200, height: 40 }, size, viewport).top).toBe(800 - BAR_MARGIN_PX - 160);
    expect(anchorPopover({ left: 100, top: -500, width: 200, height: 40 }, size, viewport).top).toBe(BAR_MARGIN_PX);
  });

  it("stays inside the margins for an element at the right edge or taller than the viewport", () => {
    expect(anchorPopover({ left: 950, top: 100, width: 40, height: 20 }, size, viewport).left).toBe(1000 - BAR_MARGIN_PX - 300);
    const tall = anchorPopover({ left: -50, top: -100, width: 2000, height: 2000 }, size, viewport);
    expect(tall).toEqual({ left: BAR_MARGIN_PX, top: 800 - BAR_MARGIN_PX - 160 });
  });
});
