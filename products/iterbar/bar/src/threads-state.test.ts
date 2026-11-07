import type { Feedback } from "iterbar";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadsState } from "./threads-state.js";

function feedback(id: string, createdAt: string, updatedAt: string, status: Feedback["status"] = "open"): Feedback {
  return {
    schemaVersion: 1, id, kind: "comment", text: id, pageUrl: "http://localhost:5173/", target: null, activeVariants: [],
    screenshotUnavailableReason: null, screenshot: null, evidence: null, replies: [], status, createdAt, updatedAt,
  };
}

const ids = (state: ThreadsState) => state.shown().map((item) => item.id);

describe("merge", () => {
  it("keeps the newer copy whichever order a listing and an event arrive in", () => {
    const older = feedback("a", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "open");
    const newer = feedback("a", "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z", "working");
    const eventFirst = new ThreadsState(100);
    expect(eventFirst.merge(newer)).toBe("changed");
    expect(eventFirst.merge(older)).toBe("stale");
    expect(eventFirst.get("a")?.status).toBe("working");

    const listFirst = new ThreadsState(100);
    listFirst.applyListing([older], new Set());
    expect(listFirst.merge(newer)).toBe("changed");
    expect(listFirst.get("a")?.status).toBe("working");
  });

  it("applies a change that shares the held copy's timestamp, and reports an identical copy as no change", () => {
    const held = feedback("a", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "open");
    const state = new ThreadsState(100);
    state.merge(held);
    expect(state.merge({ ...held })).toBe("unchanged");
    expect(state.merge({ ...held, status: "done" })).toBe("changed");
    expect(state.get("a")?.status).toBe("done");
  });
});

describe("applyListing", () => {
  const at = "2026-01-01T00:00:00Z";
  const listed = (state: ThreadsState, items: Feedback[], touched: string[] = []) => state.applyListing(items, new Set(touched));

  it("replaces held items with the listing and drops what it no longer lists", () => {
    const state = new ThreadsState(100);
    listed(state, [feedback("a", at, at), feedback("gone", at, at)]);
    expect(listed(state, [feedback("a", at, at, "done"), feedback("b", at, at)])).toBe(true);
    expect(ids(state)).toEqual(["a", "b"]);
    expect(state.total).toBe(2);
    expect(state.get("a")?.status).toBe("done");
    expect(listed(state, [feedback("a", at, at, "done"), feedback("b", at, at)])).toBe(false);
  });

  it("keeps what events delivered during the listing, ties and unlisted items included", () => {
    const state = new ThreadsState(100);
    state.merge(feedback("a", at, at, "working"));
    state.merge(feedback("new", at, at));
    listed(state, [feedback("a", at, at, "open")], ["a", "new"]);
    expect(state.get("a")?.status).toBe("working");
    expect(state.get("new")).toBeDefined();
  });

  it("lets a strictly newer listed copy beat a touched held copy", () => {
    const state = new ThreadsState(100);
    state.merge(feedback("a", at, at, "working"));
    listed(state, [feedback("a", at, "2026-01-01T00:05:00Z", "done")], ["a"]);
    expect(state.get("a")?.status).toBe("done");
  });

  it("never replaces a newer held copy with an older listed one", () => {
    const state = new ThreadsState(100);
    state.merge(feedback("a", at, "2026-01-01T00:05:00Z", "done"));
    listed(state, [feedback("a", at, at, "open")]);
    expect(state.get("a")?.status).toBe("done");
  });
});

it("orders threads newest first by creation, independent of updates", () => {
  const state = new ThreadsState(100);
  state.applyListing([
    feedback("b", "2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z"),
    feedback("a", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z"),
    feedback("c", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
  ], new Set());
  expect(ids(state)).toEqual(["a", "b", "c"]);
});

describe("a long feedback history", () => {
  const HISTORY = 5000;
  const LIMIT = 100;
  /** Item `n` was created at minute `n`, so higher numbers are newer. */
  const created = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
  const item = (n: number, status: Feedback["status"] = "open", updatedMinutes = 0) =>
    feedback(`f${String(n).padStart(5, "0")}`, created(n), new Date(Date.parse(created(n)) + updatedMinutes * 60_000).toISOString(), status);
  /** The whole history, in an order unrelated to creation. */
  const history = () => Array.from({ length: HISTORY }, (_, index) => item((index * 7919) % HISTORY));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps only the shown window in full, with an exact total", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const state = new ThreadsState(LIMIT);
    // The listing is referenced only inside this function, as a response body would be.
    const refs = (() => {
      const items = history();
      state.applyListing(items, new Set());
      return items.map((entry) => new WeakRef(entry));
    })();
    // WeakRefs stay alive until the current job ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    const alive = refs.filter((ref) => ref.deref() !== undefined).length;
    expect(alive).toBeLessThanOrEqual(LIMIT);
    expect(state.total).toBe(HISTORY);
    expect(state.shown()).toHaveLength(LIMIT);
    expect(state.shown()[0]!.id).toBe(item(HISTORY - 1).id);
    expect(state.shown().at(-1)!.id).toBe(item(HISTORY - LIMIT).id);
  });

  it("does work per event bounded by the window, not the history, and keeps the total exact", () => {
    const state = new ThreadsState(LIMIT);
    state.applyListing(history(), new Set());
    const parse = vi.spyOn(Date, "parse");
    const perEvent = (event: Feedback) => {
      parse.mockClear();
      const result = state.merge(event);
      expect(parse.mock.calls.length).toBeLessThanOrEqual(4);
      return result;
    };

    // A shown thread changes in place.
    expect(perEvent(item(HISTORY - 1, "working", 1))).toBe("changed");
    expect(state.get(item(HISTORY - 1).id)?.status).toBe("working");
    // A hidden thread's update creates no row and keeps the total.
    expect(perEvent(item(3, "done", 1))).toBe("unchanged");
    expect(state.get(item(3).id)).toBeUndefined();
    expect(state.total).toBe(HISTORY);
    // A stale copy of a hidden thread is recognised as stale.
    expect(perEvent(item(3, "open", 0))).toBe("stale");
    // A new newest thread comes first and evicts exactly the oldest shown.
    expect(perEvent(item(HISTORY, "open"))).toBe("changed");
    expect(state.total).toBe(HISTORY + 1);
    expect(ids(state)[0]).toBe(item(HISTORY).id);
    expect(state.shown()).toHaveLength(LIMIT);
    expect(state.get(item(HISTORY - LIMIT).id)).toBeUndefined();
    expect(state.shown().at(-1)!.id).toBe(item(HISTORY - LIMIT + 1).id);
    // A new thread older than the window is only counted.
    expect(perEvent(item(-1))).toBe("changed");
    expect(state.total).toBe(HISTORY + 2);
    expect(state.shown()).toHaveLength(LIMIT);
  });

  it("keeps listing precedence for hidden threads and drops omitted untouched ones from the total", () => {
    const state = new ThreadsState(LIMIT);
    const all = history();
    state.applyListing(all, new Set());
    // A stale event for a hidden thread gains nothing; a current one keeps it through a listing that omits it.
    expect(state.merge(item(3, "open", -1))).toBe("stale");
    expect(state.merge(item(4, "done", 1))).toBe("unchanged");
    const omitting = all.filter((entry) => entry.id !== item(3).id && entry.id !== item(4).id && entry.id !== item(5).id);
    state.applyListing(omitting, new Set([item(4).id]));
    expect(state.total).toBe(HISTORY - 2);
    // Listed again with the same time, it stays as recent as the event made it.
    state.applyListing([...omitting, item(4, "open", 1)], new Set([item(4).id]));
    expect(state.merge(item(4, "open", 0))).toBe("stale");
    expect(state.total).toBe(HISTORY - 2);
  });
});
