import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Feedback, FeedbackListQuery } from "iterbar";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_CURSOR_SEEN, MAX_CURSOR_TIME_MS } from "./cursor.js";
import type { DaemonClient } from "./daemon-client.js";
import { feedbackItem } from "./test-support/feedback.js";
import { MAX_BATCH_INLINE_BYTES, registerTools } from "./tools.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** The official SDK client connected in memory to the Iterbar tools over a daemon client whose listings the test supplies. */
async function connect(
  list: (query: FeedbackListQuery, signal?: AbortSignal) => Feedback[] | Promise<Feedback[]>,
  extra: Partial<Record<keyof DaemonClient, unknown>> = {},
): Promise<Client> {
  const daemon = {
    listFeedback: async (query: FeedbackListQuery = {}, signal?: AbortSignal) => list(query, signal),
    openEvents: async () => Object.assign(new EventEmitter(), { terminate: () => undefined }),
    ...extra,
  } as unknown as DaemonClient;
  const server = new McpServer({ name: "iterbar", version: "0.0.0" });
  registerTools({ server, client: daemon, closing: new AbortController().signal, heartbeatMs: 60_000, onError: (error) => { throw error; } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "iterbar-tools-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(() => client.close(), () => server.close());
  return client;
}

async function ok(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })) as CallToolResult;
  expect(result.isError, JSON.stringify(result.content).slice(0, 500)).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

describe("list_feedback cursors after a burst", { timeout: 60_000 }, () => {
  const base = Date.now() - 600_000;
  const count = 2 * MAX_CURSOR_SEEN + 1;
  /** feedback-a with `replies` user replies, one millisecond apart. */
  const answered = (replies: number) => feedbackItem("feedback-a", base, Array.from({ length: replies }, (_, index) =>
    [`reply-${String(index).padStart(5, "0")}`, "user", base + 1_000 + index] as const));
  const keyOf = (index: number) => `reply-${String(index).padStart(5, "0")}`;

  it("reports more events than a cursor holds through an unfiltered listing, and the next call accepts its cursor", async () => {
    let items = [answered(0)];
    const client = await connect(() => items);
    const start = await ok(client, "list_feedback", {});
    items = [answered(count)];
    const burst = await ok(client, "list_feedback", { cursor: start.cursor });
    expect(burst.events).toHaveLength(count);
    const again = await ok(client, "list_feedback", { cursor: burst.cursor });
    expect(again.events).toEqual([]);
    items = [answered(count + 1)];
    const waited = await ok(client, "wait_for_feedback", { cursor: again.cursor, timeoutSeconds: 1 });
    expect(waited).toMatchObject({ outcome: "feedback", events: [{ kind: "user_reply", replyId: keyOf(count) }] });
    const quiet = await ok(client, "wait_for_feedback", { cursor: waited.cursor, timeoutSeconds: 0 });
    expect(quiet).toMatchObject({ outcome: "timeout", events: [] });
  });

  it("issues an accepted cursor without one, filtered or not, when a burst lands between its listings", async () => {
    for (const filters of [{}, { status: "open" }]) {
      let listings = 0;
      const client = await connect(() => (++listings === 1 ? [answered(0)] : [answered(count)]));
      const listed = await ok(client, "list_feedback", filters);
      const next = await ok(client, "list_feedback", { cursor: listed.cursor });
      expect(next.events).toEqual([]);
    }
  });
});

describe("wait_for_feedback at its deadline", { timeout: 30_000 }, () => {
  it("returns no cursor when its second baseline listing stalls, and an unfiltered listing then shows what arrived once", async () => {
    const base = Date.now() - 60_000;
    const a = feedbackItem("feedback-a", base);
    const b = feedbackItem("feedback-b", base + 10);
    let listings = 0;
    const client = await connect(async (_query, signal) => {
      listings += 1;
      if (listings === 1) return [a];
      if (listings === 2) {
        // feedback-b commits while the second baseline listing stalls far past the deadline.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 4_000);
          signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason as Error)), { once: true });
        });
      }
      return [a, b];
    });
    const started = Date.now();
    const first = await ok(client, "wait_for_feedback", { timeoutSeconds: 1 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(first).toEqual({ outcome: "timeout", items: [], events: [] });
    // The documented recovery: an unfiltered listing shows every item, and its cursor counts them as seen.
    const listed = await ok(client, "list_feedback", {});
    expect((listed.items as Feedback[]).map((item) => item.id)).toEqual(["feedback-a", "feedback-b"]);
    const quiet = await ok(client, "wait_for_feedback", { cursor: listed.cursor, timeoutSeconds: 0 });
    expect(quiet).toMatchObject({ outcome: "timeout", events: [] });
  });
});

describe("a cursor whose times are past the end of year 9999", () => {
  it("is refused as invalid_request by list_feedback and wait_for_feedback, not reported as internal", async () => {
    const client = await connect(() => []);
    const encode = (w: number, c: number) => Buffer.from(JSON.stringify({ v: 1, w, c, s: [] })).toString("base64url");
    for (const name of ["list_feedback", "wait_for_feedback"]) {
      const args = (cursor: string) => (name === "wait_for_feedback" ? { cursor, timeoutSeconds: 0 } : { cursor });
      const latest = await ok(client, name, args(encode(MAX_CURSOR_TIME_MS, MAX_CURSOR_TIME_MS)));
      expect(latest.cursor).toEqual(expect.any(String));
      for (const cursor of [encode(0, MAX_CURSOR_TIME_MS + 1), encode(MAX_CURSOR_TIME_MS + 1, MAX_CURSOR_TIME_MS + 1)]) {
        const result = (await client.callTool({ name, arguments: args(cursor) })) as CallToolResult;
        expect([name, result.isError, result.structuredContent]).toEqual([
          name, true, { error: expect.objectContaining({ code: "invalid_request" }) },
        ]);
      }
    }
  });
});

describe("batches from a daemon that predates them", () => {
  it("still returns only the batch's items when the daemon ignores the batchId filter", async () => {
    const base = Date.now() - 60_000;
    const inBatch = { ...feedbackItem("feedback-a", base), batchId: "batch-1", batchSize: 1, batchIndex: 0 };
    const other = feedbackItem("feedback-b", base + 10);
    // The daemon ignores every filter and lists everything.
    const client = await connect(() => [inBatch, other]);
    const batch = await ok(client, "get_batch", { batchId: "batch-1", includeAttachments: false });
    expect(batch).toMatchObject({ count: 1, expectedCount: 1, complete: true });
    expect((batch.items as { feedback: Feedback }[]).map((entry) => entry.feedback.id)).toEqual(["feedback-a"]);
    const listed = await ok(client, "list_feedback", { batchId: "batch-1" });
    expect((listed.items as Feedback[]).map((item) => item.id)).toEqual(["feedback-a"]);
    const none = (await client.callTool({ name: "get_batch", arguments: { batchId: "batch-2" } })) as CallToolResult;
    expect(none.structuredContent).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("batch completeness", () => {
  it("counts a comment stored twice once, by its batch index, and says when the newest arrived", async () => {
    const base = Date.now() - 60_000;
    const first = { ...feedbackItem("feedback-a", base), batchId: "batch-1", batchSize: 2, batchIndex: 0 };
    const retried = { ...feedbackItem("feedback-b", base + 10), batchId: "batch-1", batchSize: 2, batchIndex: 0 };
    let items = [first, retried];
    const client = await connect(() => items);
    const partial = await ok(client, "get_batch", { batchId: "batch-1", includeAttachments: false });
    expect(partial).toMatchObject({ count: 2, expectedCount: 2, complete: false, lastArrivedAt: retried.createdAt });
    // The newest copy of a comment sent again is the one to act on, whatever its text.
    expect((partial.items as { supersededBy?: string }[]).map((entry) => entry.supersededBy)).toEqual(["feedback-b", undefined]);
    const third = { ...feedbackItem("feedback-d", base + 15), text: "Edited, then sent a third time", batchId: "batch-1", batchSize: 2, batchIndex: 0 };
    items = [first, retried, third];
    const resent = await ok(client, "get_batch", { batchId: "batch-1", includeAttachments: false });
    expect((resent.items as { supersededBy?: string }[]).map((entry) => entry.supersededBy)).toEqual(["feedback-d", "feedback-d", undefined]);
    items = [first, retried, { ...feedbackItem("feedback-c", base + 20), batchId: "batch-1", batchSize: 2, batchIndex: 1 }];
    expect(await ok(client, "get_batch", { batchId: "batch-1", includeAttachments: false })).toMatchObject({ count: 3, complete: true });
  });

  it("takes the expected size from the newest item, which a withdrawn comment lowers", async () => {
    const base = Date.now() - 60_000;
    // A was stored as one of two; B failed and was withdrawn; C, added later, says the batch now holds two.
    const items = [
      { ...feedbackItem("feedback-a", base), batchId: "batch-1", batchSize: 2, batchIndex: 0 },
      { ...feedbackItem("feedback-c", base + 10), batchId: "batch-1", batchSize: 2, batchIndex: 2 },
    ];
    const client = await connect(() => items);
    expect(await ok(client, "get_batch", { batchId: "batch-1", includeAttachments: false })).toMatchObject({ expectedCount: 2, complete: true });
  });
});

describe("a large batch", () => {
  it("inlines screenshots up to the batch limit and references the rest by path", async () => {
    const base = Date.now() - 60_000;
    const byteLength = 7 * 1024 * 1024;
    const shot = (index: number) => ({ id: `shot-${index}`, kind: "screenshot" as const, mediaType: "image/png" as const, byteLength, sha256: "0".repeat(64) });
    const items = Array.from({ length: 5 }, (_, index) => ({
      ...feedbackItem(`feedback-${index}`, base + index), batchId: "batch-1", batchSize: 5, batchIndex: index, screenshot: shot(index),
      screenshotUnavailableReason: null,
    }));
    const client = await connect(() => items, {
      paths: { projectRoot: "/tmp/iterbar-test-project" },
      getAttachment: async () => new Uint8Array(byteLength),
    });
    const result = (await client.callTool({ name: "get_batch", arguments: { batchId: "batch-1" } }, undefined, { timeout: 60_000 })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const inlined = (result.structuredContent as { items: { attachments: { inlined: boolean }[] }[] }).items.map((entry) => entry.attachments[0]!.inlined);
    const fits = Math.floor(MAX_BATCH_INLINE_BYTES / byteLength);
    expect(inlined).toEqual(Array.from({ length: 5 }, (_, index) => index < fits));
    expect(result.content.filter((block) => block.type === "image")).toHaveLength(fits);
  });
});
