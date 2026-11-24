import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import {
  feedbackKindSchema,
  feedbackStatusSchema,
  idSchema,
  timestampSchema,
  type AttachmentRef,
  type Feedback,
  type ReplyAuthor,
} from "iterbar";
import { attachmentPath } from "iterbar/node";
import { z } from "zod";
import { cursorProvenBy, decodeCursor, encodeCursor, observe, type FeedbackEvent } from "./cursor.js";
import type { DaemonClient } from "./daemon-client.js";
import { IterbarToolError } from "./errors.js";
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, waitForFeedback } from "./wait.js";

/**
 * Most attachment bytes one `get_batch` returns inline; the rest are referenced by their file paths, so a large batch
 * still fits in one tool result.
 */
export const MAX_BATCH_INLINE_BYTES = 24 * 1024 * 1024;

/** Largest evidence attachment returned inline by `get_feedback`; a larger one is referenced by its file path. */
export const MAX_INLINE_EVIDENCE_BYTES = 1024 * 1024;

/** Statuses an agent posts. `open` is where new feedback starts; agents never reopen a thread. */
export const AGENT_STATUSES = ["working", "needs-info", "done", "resolved"] as const;

export interface ToolContext {
  readonly server: McpServer;
  readonly client: DaemonClient;
  /** Aborted when the MCP server closes, which ends every wait. */
  readonly closing: AbortSignal;
  /** How often a waiting `wait_for_feedback` sends a progress notification, when the client asked for progress. */
  readonly heartbeatMs: number;
  readonly onError: (error: unknown) => void;
}

function success(structured: Record<string, unknown>, extra: readonly ContentBlock[] = []): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured, null, 2) }, ...extra], structuredContent: structured };
}

function failure(error: IterbarToolError): CallToolResult {
  const body = { error: { code: error.code, message: error.message }, ...error.details };
  const details = Object.keys(error.details).length ? `\n${JSON.stringify(error.details)}` : "";
  return { isError: true, content: [{ type: "text", text: `${error.code}: ${error.message}${details}` }], structuredContent: body };
}

/** Runs a tool body, turning every failure into a typed tool error; unexpected ones are also reported. */
async function run(context: ToolContext, body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof IterbarToolError) return failure(error);
    context.onError(error);
    return failure(new IterbarToolError("internal", `Unexpected error: ${error instanceof Error ? error.message : String(error)}`));
  }
}

/** The reply author for this connection: the agent, named after the MCP client when it says who it is. */
function agentAuthor(server: McpServer): ReplyAuthor {
  const name = server.server.getClientVersion()?.name?.trim().slice(0, 100);
  return { kind: "agent", name: name || null };
}

function attachmentsOf(feedback: Feedback): AttachmentRef[] {
  return [feedback.screenshot, feedback.evidence?.attachment].filter((ref): ref is AttachmentRef => Boolean(ref));
}

function describeEvents(events: readonly FeedbackEvent[]) {
  return events.map((event) => ({
    feedbackId: event.feedbackId,
    kind: event.kind,
    at: new Date(event.at).toISOString(),
    ...(event.replyId ? { replyId: event.replyId } : {}),
  }));
}

/**
 * How an agent recognises an event it already handled. Delivery is at least once: when a cursor cannot keep every key
 * (a very large burst, or a wait whose timeout cut its compaction short), it keeps its watermark and forgets keys, so
 * events come back rather than being skipped. Only the event's own id proves it was handled: a later agent reply does
 * not, since a user may have replied while the agent worked. Shared by the server instructions and tool descriptions.
 */
export const HANDLED_EVENT_RULE =
  "Events are delivered at least once: after a very large burst, or when a wait's timeout cuts its cursor upkeep " +
  "short, an event you already got can come back. A created event is identified by its feedbackId and a user_reply " +
  "event by its replyId: remember the ones you have handled (a user reply you read and answered counts) and skip an " +
  "event you already handled. Any other event is new, including a user reply that arrived while you were working, " +
  "even when your own reply now comes after it.";

/**
 * What still needs the agent when a session starts or ends. A listing without a cursor counts everything as seen, a
 * user reply leaves a thread's status as it was, and who wrote a thread's last reply does not show whether an earlier
 * user reply was read: a user can reply on a resolved thread, or between the agent's get_feedback and its reply, and
 * the session can end before a cursor call returns that reply. So a session starts by checking the replies of every
 * listed item, whatever its status, re-reads a thread right before finishing it, and makes one more unfiltered cursor
 * call before it stops. Shared by the server instructions and tool descriptions.
 */
export const SESSION_RULE =
  "A listing without a cursor counts everything sent before it as seen, so at the start of a session check every " +
  "item it returns, whatever its status, resolved and done ones included, using the replies each item carries: " +
  "handle open and working items, and answer any user reply that no later agent reply answers, judged by what the " +
  "replies say, not by who wrote last. Such a reply on a resolved or done thread reopens it: set_status working and " +
  "handle it like new feedback. For that check, call get_feedback only when you need an item's detail, with " +
  "includeAttachments: false unless you need its screenshot or evidence. Right before you reply and set a thread " +
  "done or needs-info, read it again with get_feedback so your reply covers every user reply in it. Before you stop, " +
  "call list_feedback without filters and with your latest cursor once more, and handle what it returns.";

const cursorInput = z.string().max(1_000_000).optional();

const feedbackId = idSchema.describe("The feedback item's id, as returned by list_feedback or wait_for_feedback.");

/** The items of `items` in batch `batchId`. */
function inBatch(items: readonly Feedback[], batchId: string): Feedback[] {
  return items.filter((item) => item.batchId === batchId);
}

/** Reads `feedback`'s attachment references and, when `inline`, their contents as content blocks. */
async function readAttachments(
  client: DaemonClient, feedback: Feedback, inline: boolean, budget: { remaining: number } = { remaining: Infinity },
) {
  const blocks: ContentBlock[] = [];
  const attachments = [];
  for (const ref of attachmentsOf(feedback)) {
    const path = attachmentPath(client.paths.projectRoot, feedback.id, ref);
    let inlined = false;
    if (inline && (ref.kind === "screenshot" || ref.byteLength <= MAX_INLINE_EVIDENCE_BYTES) && ref.byteLength <= budget.remaining) {
      budget.remaining -= ref.byteLength;
      const data = Buffer.from(await client.getAttachment(feedback.id, ref.id));
      blocks.push(ref.kind === "screenshot"
        ? { type: "image", data: data.toString("base64"), mimeType: ref.mediaType }
        : { type: "resource", resource: { uri: pathToFileURL(path).href, mimeType: ref.mediaType, text: data.toString("utf8") } });
      inlined = true;
    }
    attachments.push({ id: ref.id, kind: ref.kind, mediaType: ref.mediaType, byteLength: ref.byteLength, path, inlined });
  }
  return { attachments, blocks };
}

/** Registers the seven Iterbar tools on `context.server`; each one is a client of the project's daemon. */
export function registerTools(context: ToolContext): void {
  const { server, client } = context;

  server.registerTool("list_feedback", {
    title: "List Iterbar feedback",
    description:
      "List feedback items (comments and variant choices) that users sent from the Iterbar dev bar, oldest first, each " +
      "with its thread of replies, status and attachment references. Filters are optional. Also returns a cursor for " +
      "wait_for_feedback. Pass your latest cursor in: without filters, the result says what is new since that cursor " +
      "and the cursor moves past it; with filters, your cursor comes back unchanged, so nothing the filters hid is " +
      "skipped, but the items it shows come back too: take work only from an unfiltered listing (or a wait) and use " +
      "filters to look things up. " + SESSION_RULE + " " + HANDLED_EVENT_RULE,
    inputSchema: {
      status: feedbackStatusSchema.optional().describe("Only items with this status (a lookup; it leaves your cursor unchanged)."),
      kind: feedbackKindSchema.optional().describe("\"comment\" or \"choose_variant\"."),
      since: timestampSchema.optional().describe("Only items updated at or after this ISO 8601 timestamp."),
      batchId: idSchema.optional().describe(
        "Only items the user sent together in this batch (an item's batchId). Use get_batch to read a batch in full.",
      ),
      cursor: cursorInput.describe("Your latest cursor from list_feedback or wait_for_feedback."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => run(context, async () => {
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const filtered = input.status !== undefined || input.kind !== undefined || input.since !== undefined
      || input.batchId !== undefined;
    // Lists every item updated at or after `since`; observe() uses it to keep a cursor small enough to issue.
    const relist = (since: string | undefined) => client.listFeedback(since === undefined ? {} : { since });
    if (!filtered) {
      const items = await client.listFeedback();
      if (cursor) {
        // Every listed event is shown to the agent, so the cursor may move past all of them.
        const observed = await observe(cursor, items, relist);
        return success({ items: observed.items, events: describeEvents(observed.events), cursor: encodeCursor(observed.cursor) });
      }
      // A second listing proves when the first was committed, so the cursor keeps only the newest events by key.
      const observed = await observe(cursorProvenBy(items), await client.listFeedback(), relist);
      return success({ items: observed.items, cursor: encodeCursor(observed.cursor) });
    }
    // The agent sees only the filtered items, so the cursor must not count anything else as seen: an agent's cursor
    // comes back unchanged. Without one, the cursor starts now; it is taken before the filtered listing, so an item
    // that arrives in between is handed over again by the next wait, never skipped.
    const next = cursor ?? (await observe(cursorProvenBy(await client.listFeedback()), await client.listFeedback(), relist)).cursor;
    const listed = await client.listFeedback({
      ...(input.status ? { status: input.status } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.since ? { since: input.since } : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
    });
    // A daemon from before batches ignores the batchId filter, so it is applied here as well.
    const items = input.batchId ? inBatch(listed, input.batchId) : listed;
    return success({ items, cursor: encodeCursor(next) });
  }));

  server.registerTool("get_feedback", {
    title: "Read Iterbar feedback",
    description:
      "Read one feedback item with its thread, target element, source location and active variants. By default its " +
      "attachments are included: the screenshot as an image and the runtime evidence (console, network and errors " +
      "around the moment it was sent) as JSON. Each attachment's file path is also given.",
    inputSchema: {
      feedbackId,
      includeAttachments: z.boolean().default(true).describe("Return the screenshot and evidence contents (default true)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => run(context, async () => {
    const feedback = await client.getFeedback(input.feedbackId);
    const { attachments, blocks } = await readAttachments(client, feedback, input.includeAttachments);
    return success({ feedback, attachments }, blocks);
  }));

  server.registerTool("get_batch", {
    title: "Read an Iterbar batch",
    description:
      "Read every feedback item the user sent together in one batch from the bar's draft tray, in the order they were " +
      "put in the tray, each with its thread, target element, source location and active variants. Items share a batchId (shown on " +
      "each item by list_feedback and wait_for_feedback). By default each item's screenshot is included as an image, " +
      "labelled with the item's id, and evidence as JSON, up to 24 MiB in all; past that an attachment has inlined: " +
      "false and is read from its path. The bar posts a batch one comment at a time: expectedCount is " +
      "how many it holds once all are sent, and complete says whether all have arrived. When complete is false and " +
      "lastArrivedAt is under a minute ago, wait_for_feedback with timeoutSeconds no longer than what is left of that " +
      "minute and call get_batch again; otherwise the rest was " +
      "not sent (the user may have dropped a failed comment), so work on the items present. Work through the batch as one change: read all of it " +
      "first, then set each unfinished item working, make the edits, reply on each of those items and set each one " +
      "done. Leave items already done alone: a comment retried later arrives on its own. An entry with supersededBy " +
      "is an earlier copy of a comment the user sent again (perhaps edited): act on the copy it names, and on this one " +
      "reply that it was sent again and set it resolved. Judge the newest copy against the code as it is now: if the " +
      "code already does what it asks, reply that it is done and set it done; otherwise make the change.",
    inputSchema: {
      batchId: idSchema.describe("The batch's id: the batchId of any item in it."),
      includeAttachments: z.boolean().default(true).describe("Return each item's screenshot and evidence contents (default true)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => run(context, async () => {
    // A daemon from before batches ignores the filter and lists everything, so membership is checked here too.
    const items = inBatch(await client.listFeedback({ batchId: input.batchId }), input.batchId);
    if (items.length === 0) throw new IterbarToolError("not_found", `No feedback has batchId ${input.batchId}`);
    // The newest item's size is the latest the bar knew: a draft withdrawn after a failed send lowers it.
    // Items come in the store's time order, oldest first, whatever offsets their timestamps carry.
    const expectedCount = [...items].reverse().find((item) => item.batchSize !== undefined)?.batchSize ?? null;
    // A comment stored twice (a retry after a lost answer) keeps its index, so it is counted once.
    // Copies of one comment share its index and count once; comments without an index count each.
    const indexes = new Set(items.flatMap((item) => (item.batchIndex === undefined ? [] : [item.batchIndex])));
    const arrived = indexes.size + items.filter((item) => item.batchIndex === undefined).length;
    const lastArrivedAt = items.at(-1)!.createdAt;
    const blocks: ContentBlock[] = [];
    const entries = [];
    // A comment sent again after a lost answer (perhaps edited) shares its batchIndex with the earlier copies; the
    // newest copy (items come oldest first) is the one the user means, and it supersedes the others.
    const newestOfIndex = new Map<number, string>();
    for (const feedback of items) if (feedback.batchIndex !== undefined) newestOfIndex.set(feedback.batchIndex, feedback.id);
    const budget = { remaining: MAX_BATCH_INLINE_BYTES };
    // In the order the user put them in the tray (by index), so a retried comment does not move; items without an
    // index keep their arrival order, after the indexed ones.
    const ordered = items.map((item, arrival) => ({ item, arrival })).sort((left, right) =>
      (left.item.batchIndex ?? Infinity) - (right.item.batchIndex ?? Infinity) || left.arrival - right.arrival)
      .map(({ item }) => item);
    for (const feedback of ordered) {
      const read = await readAttachments(client, feedback, input.includeAttachments, budget);
      if (read.blocks.length) blocks.push({ type: "text", text: `Attachments of ${feedback.id}:` }, ...read.blocks);
      const newest = feedback.batchIndex === undefined ? undefined : newestOfIndex.get(feedback.batchIndex);
      entries.push({ feedback, attachments: read.attachments, ...(newest && newest !== feedback.id ? { supersededBy: newest } : {}) });
    }
    return success({
      batchId: input.batchId,
      count: items.length,
      expectedCount,
      complete: expectedCount === null ? null : arrived >= expectedCount,
      lastArrivedAt,
      items: entries,
    }, blocks);
  }));

  server.registerTool("reply", {
    title: "Reply to Iterbar feedback",
    description:
      "Post a reply in a feedback item's thread, shown to the user in the dev bar. Use it to say what you changed, or " +
      "to ask a question (then set the status to needs-info).",
    inputSchema: {
      feedbackId,
      text: z.string().max(20_000).refine((text) => text.trim().length > 0, "must not be blank").describe("The reply, plain text."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (input) => run(context, async () => {
    const feedback = await client.reply(input.feedbackId, agentAuthor(server), input.text);
    return success({ feedback });
  }));

  server.registerTool("set_status", {
    title: "Set Iterbar feedback status",
    description:
      "Post a feedback item's status, shown live in the dev bar: \"working\" when you start on it, \"needs-info\" when " +
      "you asked a question, \"done\" when the change is made or nothing more is needed. \"resolved\" is an older " +
      "name for \"done\"; the bar shows both as Done.",
    inputSchema: {
      feedbackId,
      status: z.enum(AGENT_STATUSES).describe("working, needs-info or done (resolved is an older name for done)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => run(context, async () => {
    const feedback = await client.setStatus(input.feedbackId, input.status);
    return success({ feedback });
  }));

  server.registerTool("list_slots", {
    title: "List Iterbar slots",
    description:
      "List the variant slots that dev-bar pages reported, per page URL: each slot's versions, default version, the " +
      "version currently shown and how many times it is mounted.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => run(context, async () => success({ pages: await client.listSlots() })));

  server.registerTool("wait_for_feedback", {
    title: "Wait for Iterbar feedback",
    description:
      "Block until a user sends new feedback or replies in a thread, or until the timeout passes. Returns the items with " +
      "something new, what is new in each, and a cursor. Pass the cursor from the previous list_feedback or " +
      "wait_for_feedback call so nothing in between is missed, and continue with the cursor it returns; without one, " +
      "only what arrives after the call counts. " +
      "Your own replies and status changes never end the wait. " + SESSION_RULE + " " + HANDLED_EVENT_RULE,
    inputSchema: {
      cursor: cursorInput.describe("The cursor from the previous list_feedback or wait_for_feedback result."),
      timeoutSeconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(DEFAULT_WAIT_SECONDS)
        .describe(`How long to wait, in seconds (default ${DEFAULT_WAIT_SECONDS}, at most ${MAX_WAIT_SECONDS}).`),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input, extra) => run(context, async () => {
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const progressToken = extra._meta?.progressToken;
    const result = await waitForFeedback(client, {
      ...(cursor ? { cursor } : {}),
      timeoutMs: input.timeoutSeconds * 1000,
      signal: AbortSignal.any([extra.signal, context.closing]),
      heartbeatMs: context.heartbeatMs,
      // Progress keeps clients that reset their request timeout on progress waiting for the whole timeout.
      ...(progressToken === undefined ? {} : {
        onHeartbeat: (elapsedMs: number) => {
          void extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              // Seconds waited; strictly increasing, as progress must be.
              progress: elapsedMs / 1000,
              total: input.timeoutSeconds,
              message: "Waiting for feedback",
            },
          }).catch(() => undefined);
        },
      }),
    });
    return success({
      outcome: result.outcome,
      items: result.items,
      events: describeEvents(result.events),
      // Missing only when a wait without a cursor timed out before its baseline listings: nothing was handed over.
      ...(result.cursor ? { cursor: encodeCursor(result.cursor) } : {}),
    });
  }));
}
