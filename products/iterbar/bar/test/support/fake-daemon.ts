import { createHash } from "node:crypto";
import type { Page, Request, WebSocketRoute } from "@playwright/test";
import { feedbackDraftSchema, SCHEMA_VERSION, type DaemonEvent, type Feedback, type FeedbackDraft, type SlotReport } from "iterbar";

export const FAKE_TOKEN = "0123456789abcdef".repeat(4);

let nextPort = 47_100;

export interface FakeDaemon {
  readonly url: string;
  readonly token: string;
  /** What `GET /feedback` returns. */
  items: Feedback[];
  /** `401` makes every request (and the socket) fail as with a wrong token. */
  rejectToken: boolean;
  readonly requests: { method: string; path: string; authorization: string | undefined }[];
  readonly slotReports: SlotReport[];
  /** Every `POST /feedback`: the parsed draft and the screenshot part's bytes, if one was sent. */
  readonly posts: { draft: FeedbackDraft; screenshot: Buffer | null }[];
  /** A status to answer `POST /feedback` with instead of storing it. */
  failFeedback: number | null;
  /** While set, `POST /feedback` (already in `requests`) waits for it before it is stored and answered. */
  holdFeedback: Promise<void> | null;
  /** When set, `POST /feedback` is stored and then the connection drops without an answer. */
  dropFeedbackAnswer: boolean;
  /** A 5xx status to answer `POST /feedback` with after storing it, as when the daemon fails after its write. */
  failFeedbackAfterStore: number | null;
  readonly sockets: WebSocketRoute[];
  readonly closedSockets: WebSocketRoute[];
  send(event: DaemonEvent | string): void;
}

/** A daemon answered by Playwright routes: `GET /feedback`, `POST /feedback`, `POST /slots` and the `/events` WebSocket. */
export async function fakeDaemon(
  page: Page,
  origin: string,
  items: Feedback[] = [],
  options: { readonly socket?: boolean } = {},
): Promise<FakeDaemon> {
  const port = nextPort++;
  const url = `http://127.0.0.1:${port}`;
  const cors = { "access-control-allow-origin": origin };
  const daemon: FakeDaemon = {
    url,
    token: FAKE_TOKEN,
    items,
    rejectToken: false,
    requests: [],
    slotReports: [],
    posts: [],
    failFeedback: null,
    holdFeedback: null,
    dropFeedbackAnswer: false,
    failFeedbackAfterStore: null,
    sockets: [],
    closedSockets: [],
    send(event) {
      const data = typeof event === "string" ? event : JSON.stringify(event);
      for (const socket of daemon.sockets) socket.send(data);
    },
  };
  await page.route(`${url}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, content-type" },
      });
      return;
    }
    const authorization = await request.headerValue("authorization") ?? undefined;
    daemon.requests.push({ method: request.method(), path, authorization });
    if (daemon.rejectToken || authorization !== `Bearer ${FAKE_TOKEN}`) {
      await route.fulfill({
        status: 401, headers: cors, contentType: "application/json",
        body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, error: { code: "unauthorized", message: "bad token" } }),
      });
      return;
    }
    if (request.method() === "GET" && path === "/feedback") {
      await route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, items: daemon.items }) });
      return;
    }
    if (request.method() === "POST" && path === "/feedback") {
      if (daemon.holdFeedback) await daemon.holdFeedback;
      const fail = async (status: number): Promise<void> => {
        const error = status < 500 ? { code: "store_locked", message: "The store is locked" } : { code: "internal", message: "The store is unavailable" };
        await route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, error }) });
      };
      if (daemon.failFeedback !== null) {
        await fail(daemon.failFeedback);
        return;
      }
      const post = await readFeedbackPost(request);
      daemon.posts.push(post);
      const stored = storedFeedback(post.draft, post.screenshot, daemon.posts.length);
      // Stored, but neither answered nor announced: only a listing shows it.
      if (daemon.failFeedbackAfterStore !== null || daemon.dropFeedbackAnswer) daemon.items = [stored, ...daemon.items];
      if (daemon.failFeedbackAfterStore !== null) {
        await fail(daemon.failFeedbackAfterStore);
        return;
      }
      if (daemon.dropFeedbackAnswer) {
        await route.abort("connectionreset");
        return;
      }
      await route.fulfill({ status: 201, headers: cors, contentType: "application/json", body: JSON.stringify(stored) });
      return;
    }
    if (request.method() === "POST" && path === "/slots") {
      daemon.slotReports.push(JSON.parse(request.postData() ?? "null") as SlotReport);
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    await route.fulfill({ status: 404, headers: cors });
  });
  // Without a socket route the browser connects for real, finds nothing listening, and the socket never opens.
  if (options.socket === false) return daemon;
  await page.routeWebSocket(`ws://127.0.0.1:${port}/events`, (socket) => {
    daemon.sockets.push(socket);
    socket.onClose(() => {
      daemon.sockets.splice(daemon.sockets.indexOf(socket), 1);
      daemon.closedSockets.push(socket);
    });
  });
  return daemon;
}

/** Reads a multipart `POST /feedback` as the daemon does: a `feedback` JSON part and an optional `screenshot` file. */
async function readFeedbackPost(request: Request): Promise<{ draft: FeedbackDraft; screenshot: Buffer | null }> {
  const body = request.postDataBuffer() ?? Buffer.alloc(0);
  const form = await new Response(new Uint8Array(body), { headers: { "content-type": await request.headerValue("content-type") ?? "" } }).formData();
  const part = form.get("feedback");
  const text = typeof part === "string" ? part : await part?.text();
  const draft = feedbackDraftSchema.parse(JSON.parse(text ?? "null"));
  const screenshot = form.get("screenshot");
  return { draft, screenshot: screenshot instanceof Blob ? Buffer.from(await screenshot.arrayBuffer()) : null };
}

function storedFeedback(draft: FeedbackDraft, screenshot: Buffer | null, index: number): Feedback {
  // A stored item has no evidence window; this fake never stores evidence.
  const content: Partial<FeedbackDraft> = { ...draft };
  delete content.evidenceWindow;
  const at = new Date().toISOString();
  return {
    ...content,
    id: `posted-${index}`,
    screenshot: screenshot && {
      id: `shot-${index}`, kind: "screenshot", mediaType: "image/png", byteLength: screenshot.byteLength,
      sha256: createHash("sha256").update(screenshot).digest("hex"),
    },
    evidence: null,
    replies: [],
    status: "open",
    createdAt: at,
    updatedAt: at,
  } as Feedback;
}

let sequence = 0;

/** A stored comment, valid against the v1 feedback schema. */
export function comment(text: string, overrides: Partial<Feedback> = {}): Feedback {
  sequence += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, sequence)).toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: `fb-${sequence}`,
    kind: "comment",
    text,
    pageUrl: "http://127.0.0.1/page",
    target: null,
    activeVariants: [],
    screenshotUnavailableReason: null,
    screenshot: null,
    evidence: null,
    replies: [],
    status: "open",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  } as Feedback;
}
