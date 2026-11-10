import { SCHEMA_VERSION, type Feedback, type SlotReport, type SlotState } from "iterbar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonConnection, parseDaemonConfig, REQUEST_TIMEOUT_MS } from "./connection.js";
import { ThreadsState } from "./threads-state.js";

const token = "a".repeat(64);

describe("parseDaemonConfig", () => {
  it("accepts the daemon's loopback origin and normalizes a trailing slash", () => {
    expect(parseDaemonConfig("http://127.0.0.1:4555/", token)).toEqual({ ok: true, config: { url: "http://127.0.0.1:4555", token } });
  });

  it("refuses the default HTTP port, which browsers leave out of the Host header the daemon checks", () => {
    for (const url of ["http://127.0.0.1:80", "http://127.0.0.1"]) {
      expect(parseDaemonConfig(url, token)).toMatchObject({ ok: false, status: { kind: "invalid" } });
    }
  });

  it("reports nothing configured separately from a bad configuration", () => {
    expect(parseDaemonConfig(null, null)).toEqual({ ok: false, status: { kind: "unconfigured" } });
    expect(parseDaemonConfig("", "")).toEqual({ ok: false, status: { kind: "unconfigured" } });
  });

  it("never sends the token anywhere but 127.0.0.1", () => {
    for (const url of [
      "http://localhost:4555", "https://127.0.0.1:4555", "http://127.0.0.1", "http://127.0.0.1:4555/events",
      "http://127.0.0.1:4555/?x=1", "http://user:pw@127.0.0.1:4555", "http://evil.example:4555", "nonsense",
    ]) {
      expect(parseDaemonConfig(url, token)).toMatchObject({ ok: false, status: { kind: "invalid" } });
    }
  });

  it("refuses a malformed token", () => {
    expect(parseDaemonConfig("http://127.0.0.1:4555", "A".repeat(64))).toMatchObject({ ok: false, status: { kind: "invalid" } });
    expect(parseDaemonConfig("http://127.0.0.1:4555", null)).toMatchObject({ ok: false, status: { kind: "invalid" } });
  });
});

/** A WebSocket the test opens, feeds and closes by hand. */
class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = [];
  closed = false;
  constructor(readonly url: string, readonly protocols: string[]) {
    super();
    FakeSocket.instances.push(this);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
  open(): void {
    this.dispatchEvent(new Event("open"));
  }
  receive(event: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
}

interface PendingRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  respond(status: number, body?: unknown): void;
}

function feedback(id: string, status: Feedback["status"], updatedAt = "2026-01-01T00:00:00.000Z"): Feedback {
  return {
    schemaVersion: SCHEMA_VERSION, id, kind: "comment", text: id, pageUrl: "http://localhost:5173/", target: null,
    activeVariants: [], screenshotUnavailableReason: null, screenshot: null, evidence: null, replies: [], status,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt,
  } as Feedback;
}

const slot = (activeVersion: string): SlotState => ({
  slot: "pricing", versions: ["v1", "v2"], defaultVersion: "v1", activeVersion, mounts: 1,
});

describe("DaemonConnection", () => {
  let requests: PendingRequest[];
  let threads: ThreadsState;
  let statuses: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    requests = [];
    threads = new ThreadsState(100);
    statuses = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => new Promise<Response>((resolve) => {
      requests.push({
        method: init.method ?? "GET",
        path: new URL(url).pathname,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        respond: (status, body) => resolve(new Response(body === undefined ? null : JSON.stringify(body), { status })),
      });
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function connect(): DaemonConnection {
    const connection = new DaemonConnection({ url: "http://127.0.0.1:4555", token }, {
      onStatus: (status) => statuses.push(status.kind),
      // As ThreadsPanel.merge does.
      onFeedback: (item) => threads.merge(item) !== "stale",
      // As ThreadsPanel.replace does, passing on everything the connection gives.
      onListing: (...listing: Parameters<ThreadsState["applyListing"]>) => threads.applyListing(...listing).complete,
      isComplete: () => threads.complete,
    });
    connection.start();
    return connection;
  }

  const socket = (index = -1) => FakeSocket.instances.at(index)!;
  const pending = (path: string) => requests.filter((request) => request.path === path);
  const list = (items: Feedback[]) => ({ schemaVersion: SCHEMA_VERSION, items });
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const versions = () => pending("/slots").map((request) => (request.body as SlotReport).slots[0]?.activeVersion);

  it("never lets a listing in flight undo an event with the same updatedAt, and still applies later events", async () => {
    connect();
    socket().open();
    const [listing] = pending("/feedback");
    // The daemon stored and published the update after it answered the listing; both carry the same timestamp.
    socket().receive({ schemaVersion: SCHEMA_VERSION, type: "feedback.updated", feedback: feedback("a", "working") });
    socket().receive({ schemaVersion: SCHEMA_VERSION, type: "feedback.created", feedback: feedback("b", "open") });
    listing!.respond(200, list([feedback("a", "open")]));
    await settle();
    expect(threads.get("a")?.status).toBe("working");
    expect(threads.get("b")?.status).toBe("open");

    socket().receive({ schemaVersion: SCHEMA_VERSION, type: "feedback.updated", feedback: feedback("a", "done") });
    expect(threads.get("a")?.status).toBe("done");
  });

  /** Lists `first`, reconnects, delivers `events` while the second listing is in flight, then answers it with `second`. */
  async function relist(first: Feedback[], events: Feedback[], second: Feedback[]) {
    connect();
    socket().open();
    pending("/feedback")[0]!.respond(200, list(first));
    await settle();
    socket().close();
    await vi.advanceTimersByTimeAsync(1000);
    socket().open();
    for (const item of events) socket().receive({ schemaVersion: SCHEMA_VERSION, type: "feedback.updated", feedback: item });
    pending("/feedback")[1]!.respond(200, list(second));
    await settle();
    return threads.shown().map((item) => [item.id, item.status]);
  }

  it("gives no precedence to a stale event over a newer or omitting listing", async () => {
    const at = (minute: number) => `2026-01-01T00:0${minute}:00.000Z`;
    expect(await relist(
      [feedback("a", "done", at(2)), feedback("b", "open", at(1))],
      [feedback("a", "open", at(0)), feedback("b", "open", at(0))],
      [feedback("a", "working", at(3))],
    )).toEqual([["a", "working"]]);
  });

  it("lets an event identical to the held copy keep it against an equal-timestamp listing in flight", async () => {
    expect(await relist([feedback("a", "done")], [feedback("a", "done")], [feedback("a", "working")])).toEqual([["a", "done"]]);
  });

  it("requests a fresh listing after an incomplete one, at once twice and then with backoff, keeping events in flight", async () => {
    const calls: { ids: string[]; touched: string[] }[] = [];
    new DaemonConnection({ url: "http://127.0.0.1:4555", token }, {
      onStatus: () => {},
      onFeedback: () => true,
      isComplete: () => false,
      onListing: (items, touched) => {
        calls.push({ ids: items.map((item) => item.id), touched: [...touched] });
        return false;
      },
    }).start();
    socket().open();
    pending("/feedback")[0]!.respond(200, list([feedback("a", "open")]));
    await settle();
    // The fresh listing tracks the events that arrive while it is in flight.
    socket().receive({ schemaVersion: SCHEMA_VERSION, type: "feedback.updated", feedback: feedback("b", "working") });
    pending("/feedback")[1]!.respond(200, list([feedback("a", "working")]));
    await settle();
    pending("/feedback")[2]!.respond(200, list([]));
    await settle();
    expect(calls).toEqual([{ ids: ["a"], touched: [] }, { ids: ["a"], touched: ["b"] }, { ids: [], touched: [] }]);
    // Later listings wait for the reconnect backoff: never a request storm, however long the listings stay incomplete.
    await vi.advanceTimersByTimeAsync(999);
    expect(pending("/feedback")).toHaveLength(3);
    const answered = new Set<PendingRequest>();
    for (let second = 0; second < 120; second += 1) {
      for (const request of pending("/feedback").filter((request) => !answered.has(request))) {
        answered.add(request);
        request.respond(200, list([]));
      }
      await vi.advanceTimersByTimeAsync(1000);
    }
    // 1, 2, 4, 8, 15 and 30 s apart: by 120 s the fourth to eleventh listings.
    expect(pending("/feedback")).toHaveLength(11);
    expect(socket().closed).toBe(false);
    // A closed socket cancels the pending relist; the next open lists again.
    socket().close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pending("/feedback")).toHaveLength(11);
  });

  const at = (n: number, minutes = 0) => new Date(Date.UTC(2026, 0, 1) + n * 60_000 + minutes * 30_000).toISOString();
  const entry = (n: number, status: Feedback["status"], minutes = 0): Feedback =>
    ({ ...feedback(`f${String(n).padStart(3, "0")}`, status, at(n, minutes)), createdAt: at(n) });
  const send = (item: Feedback) => socket().receive({ schemaVersion: SCHEMA_VERSION, type: "feedback.updated", feedback: item });
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

  it("never rolls back or drops an event, however many listings in a row come back without its content", async () => {
    connect();
    socket().open();
    pending("/feedback")[0]!.respond(200, list(range(0, 249).map((n) => entry(n, "open"))));
    await settle();
    socket().close();
    await vi.advanceTimersByTimeAsync(1000);
    socket().open();
    // While the listing is in flight, more hidden threads are updated than the bar keeps copies of; f100 goes first.
    for (const n of range(0, 100).reverse()) send(entry(n, "working", 2));
    // The daemon keeps answering with f100's copy from before the event.
    const lagging = [entry(100, "open"), ...range(0, 99).map((n) => entry(n, "working", 2))];
    pending("/feedback")[1]!.respond(200, list(lagging.slice(0, 1)));
    await settle();
    pending("/feedback")[2]!.respond(200, list(lagging));
    await settle();
    // An event arrives during the last immediate listing, which predates it.
    send(entry(50, "done", 4));
    pending("/feedback")[3]!.respond(200, list(lagging));
    await settle();
    expect(threads.get("f100")).toBeUndefined();
    expect(threads.total).toBe(101);
    expect(threads.get("f050")?.status).toBe("done");
    expect(threads.merge(entry(100, "open", 1))).toBe("stale");
    expect(threads.complete).toBe(false);
    expect(pending("/feedback")).toHaveLength(4);
    // The next listing, after the backoff, carries the current copy.
    await vi.advanceTimersByTimeAsync(1000);
    pending("/feedback")[4]!.respond(200, list([entry(100, "working", 2), ...range(0, 99).map((n) => entry(n, n === 50 ? "done" : "working", n === 50 ? 4 : 2))]));
    await settle();
    expect(threads.complete).toBe(true);
    expect(threads.get("f100")?.status).toBe("working");
    expect(threads.get("f050")?.status).toBe("done");
    expect(threads.total).toBe(101);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending("/feedback")).toHaveLength(5);
  });

  it("sends no relist that events have made unnecessary, whether they fill the row or push it out of view", async () => {
    for (const complete of [() => send(entry(100, "working", 2)), () => range(250, 349).forEach((n) => send(entry(n, "open")))]) {
      const connection = connect();
      socket().open();
      const first = pending("/feedback").length;
      pending("/feedback")[first - 1]!.respond(200, list(range(0, 249).map((n) => entry(n, "open"))));
      await settle();
      socket().close();
      await vi.advanceTimersByTimeAsync(1000);
      socket().open();
      // f100's copy is pushed out by the hidden updates that follow it, and the daemon keeps listing it as it was.
      for (const n of range(0, 100).reverse()) send(entry(n, "working", 2));
      const lagging = list([entry(100, "open"), ...range(0, 99).map((n) => entry(n, "working", 2))]);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        pending("/feedback")[first + attempt - 1]!.respond(200, lagging);
        await settle();
      }
      expect(threads.complete).toBe(false);
      complete();
      expect(threads.complete).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(pending("/feedback")).toHaveLength(first + 3);
      connection.stop();
      threads.clear();
    }
  });

  it("fails a stalled listing, diagnosis or slot report after the deadline, with the socket open", async () => {
    const connection = connect();
    socket().open();
    connection.reportSlots("http://localhost:5173/", [slot("v1")]);
    // Neither the listing nor the report is ever answered.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(socket().closed).toBe(true);
    expect(statuses.at(-1)).toBe("retrying");
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    socket().open();
    pending("/feedback")[1]!.respond(200, list([]));
    await settle();
    // The pending report goes out again, and this time it is accepted.
    expect(versions()).toEqual(["v1", "v1"]);
    pending("/slots")[1]!.respond(204);
    await settle();

    // A refused upgrade is diagnosed over HTTP; a diagnosis that hangs ends in a retry too.
    socket().close();
    await vi.advanceTimersByTimeAsync(1000);
    socket().close();
    const before = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 2000);
    expect(FakeSocket.instances.length).toBeGreaterThan(before);
    expect(versions()).toEqual(["v1", "v1"]);
  });

  it("drops threads that a new listing no longer includes", async () => {
    connect();
    socket().open();
    pending("/feedback")[0]!.respond(200, list([feedback("a", "open"), feedback("b", "open")]));
    await settle();
    socket().close();
    await vi.advanceTimersByTimeAsync(1000);
    socket().open();
    pending("/feedback")[1]!.respond(200, list([feedback("b", "done")]));
    await settle();
    expect(threads.shown().map((item) => item.id)).toEqual(["b"]);
    expect(threads.get("b")?.status).toBe("done");
  });

  it("never retries a slot report that a newer one superseded, even when it fails last", async () => {
    const connection = connect();
    socket().open();
    pending("/feedback")[0]!.respond(200, list([]));
    connection.reportSlots("http://localhost:5173/", [slot("v1")]);
    connection.reportSlots("http://localhost:5173/", [slot("v2")]);
    const [first, second] = pending("/slots");
    second!.respond(204);
    await settle();
    first!.respond(500);
    await settle();

    socket().close();
    await vi.advanceTimersByTimeAsync(1000);
    socket().open();
    await settle();
    expect(pending("/slots").map((request) => (request.body as SlotReport).slots[0]?.activeVersion)).toEqual(["v1", "v2"]);
  });

  it("retries the latest slot report after it fails", async () => {
    const connection = connect();
    socket().open();
    connection.reportSlots("http://localhost:5173/", [slot("v2")]);
    pending("/slots")[0]!.respond(503);
    await settle();
    socket().close();
    await vi.advanceTimersByTimeAsync(1000);
    socket().open();
    await settle();
    expect(pending("/slots").map((request) => (request.body as SlotReport).slots[0]?.activeVersion)).toEqual(["v2", "v2"]);
  });

  it("resends the latest slot report with backoff while the socket stays open", async () => {
    const connection = connect();
    socket().open();
    pending("/feedback")[0]!.respond(200, list([]));
    connection.reportSlots("http://localhost:5173/", [slot("v1")]);
    connection.reportSlots("http://localhost:5173/", [slot("v2")]);
    const [first, second] = pending("/slots");
    second!.respond(503);
    await settle();
    first!.respond(500);
    await settle();

    await vi.advanceTimersByTimeAsync(999);
    expect(versions()).toEqual(["v1", "v2"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(versions()).toEqual(["v1", "v2", "v2"]);
    pending("/slots")[2]!.respond(500);
    await settle();
    await vi.advanceTimersByTimeAsync(1999);
    expect(versions()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(versions()).toEqual(["v1", "v2", "v2", "v2"]);
    pending("/slots")[3]!.respond(204);
    await settle();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(versions()).toEqual(["v1", "v2", "v2", "v2"]);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("resends the latest slot report when it fails after a reconnect has already completed", async () => {
    const connection = connect();
    socket().open();
    pending("/feedback")[0]!.respond(200, list([]));
    connection.reportSlots("http://localhost:5173/", [slot("v1")]);
    connection.reportSlots("http://localhost:5173/", [slot("v2")]);
    const [superseded, latest] = pending("/slots");
    socket().close();
    await vi.advanceTimersByTimeAsync(1000);
    socket().open();
    pending("/feedback")[1]!.respond(200, list([]));
    await settle();
    // Both reports were already sent, so the reconnect had nothing to flush.
    expect(versions()).toEqual(["v1", "v2"]);

    latest!.respond(503);
    await settle();
    superseded!.respond(500);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(versions()).toEqual(["v1", "v2", "v2"]);
    pending("/slots")[2]!.respond(204);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(versions()).toEqual(["v1", "v2", "v2"]);
  });

  it("gives a resend and a newer report made in the same millisecond strictly increasing reportedAt", async () => {
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    const connection = connect();
    socket().open();
    pending("/feedback")[0]!.respond(200, list([]));
    connection.reportSlots("http://localhost:5173/", [slot("v1")]);
    pending("/slots")[0]!.respond(503);
    await settle();
    // The resend fires, and the element's debounced report of a newer snapshot lands in the same millisecond.
    await vi.advanceTimersByTimeAsync(1000);
    connection.reportSlots("http://localhost:5173/", [slot("v2")]);
    const [, resend, newer] = pending("/slots") as [PendingRequest, PendingRequest, PendingRequest];
    expect(versions()).toEqual(["v1", "v1", "v2"]);
    const stamp = (request: PendingRequest) => Date.parse((request.body as SlotReport).reportedAt);
    expect(stamp(newer)).toBeGreaterThan(stamp(resend));

    // The daemon keeps the last-arriving report on a tie; the newer report arrives first and must still win.
    const current = new Map<string, SlotReport>();
    for (const report of [newer.body, resend.body] as SlotReport[]) {
      const held = current.get(report.pageUrl);
      if (!held || Date.parse(held.reportedAt) <= Date.parse(report.reportedAt)) current.set(report.pageUrl, report);
    }
    expect(current.get("http://localhost:5173/")?.slots[0]?.activeVersion).toBe("v2");

    // A connection that replaces this one for the same daemon, still in the same millisecond, stays later too.
    connection.stop();
    const replacement = connect();
    socket().open();
    pending("/feedback")[1]!.respond(200, list([]));
    replacement.reportSlots("http://localhost:5173/", [slot("v1")]);
    expect(stamp(pending("/slots").at(-1)!)).toBeGreaterThan(stamp(newer));
  });

  it("stops resending a slot report once the connection stops or the token is rejected", async () => {
    const connection = connect();
    socket().open();
    pending("/feedback")[0]!.respond(200, list([]));
    connection.reportSlots("http://localhost:5173/", [slot("v1")]);
    pending("/slots")[0]!.respond(503);
    await settle();
    connection.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(versions()).toEqual(["v1"]);

    const rejected = connect();
    socket().open();
    pending("/feedback")[1]!.respond(200, list([]));
    rejected.reportSlots("http://localhost:5173/", [slot("v2")]);
    pending("/slots")[1]!.respond(401);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(versions()).toEqual(["v1", "v2"]);
    expect(statuses.at(-1)).toBe("unauthorized");
  });

  it("keeps backing off while the socket opens but the listing fails, and resets once a listing succeeds", async () => {
    connect();
    const delays: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      socket().open();
      pending("/feedback").at(-1)!.respond(500);
      await settle();
      const before = FakeSocket.instances.length;
      let waited = 0;
      while (FakeSocket.instances.length === before) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 4000]);

    socket().open();
    pending("/feedback").at(-1)!.respond(200, list([]));
    await settle();
    socket().close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(5);
    expect(statuses.at(-1)).toBe("retrying");
  });
});
