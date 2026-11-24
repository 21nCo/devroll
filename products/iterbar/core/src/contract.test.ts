import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as api from "./index.js";
import {
  bearerAuthorization,
  absolutePathSchema,
  assertSafeId,
  daemonEventSchema,
  daemonInfoSchema,
  daemonPath,
  feedbackListResponseSchema,
  feedbackSchema,
  formatSourceLocation,
  formatVariantParam,
  InvalidMessageError,
  isAbsolutePath,
  MAX_ABSOLUTE_PATH_LENGTH,
  isIterbarContractError,
  IterbarContractError,
  MAX_ATTACHMENT_BYTES,
  PAGE_API_GLOBAL,
  parseMessage,
  parseMessageJson,
  parseSourceLocation,
  parseVariantParam,
  readPageApi,
  registrySnapshotSchema,
  safeParseMessage,
  sourceLocationSchema,
  statusRequestSchema,
  tokenFromAuthorization,
  tokenFromWebSocketProtocols,
  UnsupportedSchemaVersionError,
  webSocketProtocols,
  WEBSOCKET_SUBPROTOCOL,
} from "./index.js";

const token = "0123456789abcdef".repeat(4);
const digest = "f".repeat(64);
const createdAt = "2026-11-03T10:00:30.000Z";
const updatedAt = "2026-11-03T10:05:00.000Z";
const screenshot = { id: "at_0001", kind: "screenshot", mediaType: "image/png", byteLength: 2048, sha256: digest } as const;
const evidenceAttachment = { id: "at_0002", kind: "evidence", mediaType: "application/json", byteLength: 512, sha256: digest } as const;
const evidenceWindow = { start: "2026-11-03T10:00:00.000Z", end: "2026-11-03T10:00:35.000Z", eventCount: 4 };
const sourceLocation = { path: "src/routes/Pricing.tsx", line: 12, column: 5 };
const boundingBox = { x: 16, y: -40, width: 320, height: 48 };
const target = { selector: "[data-testid=\"buy\"]", textExcerpt: "Buy now", boundingBox, sourceLocation };
const reply = { id: "rp_0001", author: { kind: "agent", name: "Claude Code" }, text: "Working on it.", createdAt: updatedAt };
const comment = {
  schemaVersion: 2,
  id: "fb_0001",
  kind: "comment",
  text: "Make the button larger.",
  pageUrl: "http://localhost:5173/pricing?iterbar=pricing:v2",
  target,
  activeVariants: [{ slot: "pricing", variant: "v2" }],
  screenshot,
  screenshotUnavailableReason: null,
  evidence: { window: evidenceWindow, attachment: evidenceAttachment },
  replies: [reply],
  status: "working",
  createdAt,
  updatedAt,
};
const chooseVariant = {
  ...comment,
  id: "fb_0002",
  kind: "choose_variant",
  text: "",
  choice: { slot: "pricing", variant: "v2" },
  target: null,
  screenshot: null,
  evidence: null,
  replies: [],
  status: "open",
  updatedAt: createdAt,
};
const draft = {
  schemaVersion: 2,
  kind: "comment",
  text: "Too much padding.",
  pageUrl: "http://localhost:5173/",
  target,
  activeVariants: [],
  screenshotUnavailableReason: "Screenshot exceeded 4 MP",
  evidenceWindow,
};
const slotState = { slot: "pricing", variants: ["v1", "v2"], defaultVariant: "v1", activeVariant: "v2", mounts: 2 };
const snapshot = {
  schemaVersion: 2,
  slots: [slotState],
  warnings: [{ code: "unknown_variant", source: "url", value: "pricing:v9", message: "pricing has no variant v9; using v1" }],
};
const slotReport = { schemaVersion: 2, pageUrl: "http://localhost:5173/pricing", reportedAt: createdAt, slots: [slotState] };
const daemonInfo = {
  schemaVersion: 2,
  host: "127.0.0.1",
  port: 47_123,
  token,
  pid: 4242,
  projectRoot: "/Users/dev/app",
  startedAt: createdAt,
};

const warning = snapshot.warnings[0];
const draftChoice = { ...draft, kind: "choose_variant", text: "", choice: { slot: "pricing", variant: "v2" } };

type SchemaName = Extract<keyof typeof api, `${string}Schema`>;

interface Case {
  /** The root-entry export under test. */
  readonly schema: SchemaName;
  /** Distinguishes several cases for one schema, such as union branches. */
  readonly variant?: string;
  readonly valid: unknown;
  readonly invalid: unknown;
  /** Dot-joined path every reported issue must sit on (or under); `""` is the value itself. */
  readonly path: string;
  /** Message of the issue at `path`, when the path alone does not pin the failing rule. */
  readonly message?: RegExp;
}

const cases: Case[] = [
  // primitives
  { schema: "schemaVersionSchema", valid: 2, invalid: "2", path: "" },
  { schema: "idSchema", valid: "fb_0001", invalid: "_fb_0001", path: "", message: /starting with a letter or digit/ },
  { schema: "slotNameSchema", valid: "pricing.hero", invalid: "pricing:v2", path: "", message: /1-64 letters/ },
  { schema: "variantNameSchema", valid: "v2-b", invalid: "v,2", path: "", message: /1-64 letters/ },
  { schema: "versionNameSchema", valid: "v2-b", invalid: "v,2", path: "", message: /1-64 letters/ },
  { schema: "timestampSchema", valid: "2026-11-03T10:00:30+02:00", invalid: "2026-11-03 10:00:30", path: "" },
  { schema: "pageUrlSchema", valid: "https://app.localhost/pricing", invalid: "javascript:alert(1)", path: "" },
  { schema: "originSchema", valid: "http://localhost:5173", invalid: "http://localhost:5173/", path: "", message: /http\(s\) origin/ },
  { schema: "tokenSchema", valid: token, invalid: token.toUpperCase(), path: "", message: /lowercase hex/ },
  { schema: "sha256Schema", valid: digest, invalid: digest.slice(1), path: "", message: /SHA-256/ },
  { schema: "pidSchema", valid: 4242, invalid: 0, path: "" },
  { schema: "absolutePathSchema", valid: "C:\\Users\\dev\\app", invalid: "Users/dev/app", path: "", message: /absolute path/ },
  { schema: "absolutePathSchema", variant: "NUL", valid: "/Users/dev/app", invalid: "/Users/dev\0app", path: "", message: /absolute path/ },
  { schema: "absolutePathSchema", variant: "UNC", valid: "\\\\server\\share\\app", invalid: "\\\\server", path: "", message: /absolute path/ },
  // registry
  { schema: "activeVariantSchema", valid: { slot: "pricing", variant: "v2" }, invalid: { slot: "pricing", variant: "" }, path: "variant" },
  {
    schema: "activeVariantsSchema",
    valid: comment.activeVariants,
    invalid: [{ slot: "pricing", variant: "v1" }, { slot: "pricing", variant: "v2" }],
    path: "",
    message: /each slot may appear only once/,
  },
  { schema: "slotStateSchema", valid: slotState, invalid: { ...slotState, activeVariant: "v3" }, path: "activeVariant" },
  {
    schema: "slotStateSchema",
    variant: "descriptions",
    valid: { ...slotState, descriptions: { v1: "The current layout", v2: "Prices first" } },
    invalid: { ...slotState, descriptions: { v1: "The current layout", v9: "No such variant" } },
    path: "descriptions.v9",
    message: /does not have/,
  },
  { schema: "registryWarningSchema", valid: warning, invalid: { ...warning, source: "cookie" }, path: "source" },
  {
    schema: "registryWarningSchema",
    variant: "api selection",
    valid: { code: "unknown_slot", source: "api", value: "pricing", message: "No slot pricing on this page" },
    invalid: { code: "unknown_slot", source: "window", value: "pricing", message: "No slot pricing on this page" },
    path: "source",
  },
  {
    schema: "registrySnapshotSchema",
    valid: snapshot,
    invalid: { ...snapshot, slots: [slotState, slotState] },
    path: "slots",
    message: /slot names must be unique/,
  },
  {
    schema: "variantSelectionSchema",
    valid: { schemaVersion: 2, slot: "pricing", variant: "v2" },
    invalid: { schemaVersion: 2, slot: "pricing:v2", variant: "v2" },
    path: "slot",
  },
  { schema: "slotReportSchema", valid: slotReport, invalid: { ...slotReport, pageUrl: "javascript:alert(1)" }, path: "pageUrl" },
  // feedback
  { schema: "feedbackKindSchema", valid: "choose_variant", invalid: "vote", path: "" },
  { schema: "feedbackStatusSchema", valid: "needs-info", invalid: "closed", path: "" },
  { schema: "boundingBoxSchema", valid: boundingBox, invalid: { ...boundingBox, width: -1 }, path: "width" },
  {
    schema: "sourceLocationSchema",
    valid: sourceLocation,
    invalid: { ...sourceLocation, path: "src/../../etc/passwd" },
    path: "path",
    message: /project-relative/,
  },
  {
    schema: "sourceLocationSchema",
    variant: "line break",
    valid: { ...sourceLocation, path: "src/a:b c/ü.tsx" },
    invalid: { ...sourceLocation, path: "src/App\n.tsx" },
    path: "path",
    message: /control characters/,
  },
  { schema: "feedbackTargetSchema", valid: target, invalid: { ...target, selector: "" }, path: "selector" },
  { schema: "screenshotAttachmentSchema", valid: screenshot, invalid: { ...screenshot, mediaType: "image/jpeg" }, path: "mediaType" },
  {
    schema: "evidenceAttachmentSchema",
    valid: evidenceAttachment,
    invalid: { ...evidenceAttachment, byteLength: MAX_ATTACHMENT_BYTES + 1 },
    path: "byteLength",
  },
  {
    schema: "attachmentRefSchema",
    variant: "screenshot",
    valid: screenshot,
    invalid: { ...screenshot, mediaType: "application/json" },
    path: "mediaType",
  },
  {
    schema: "attachmentRefSchema",
    variant: "evidence",
    valid: evidenceAttachment,
    invalid: { ...evidenceAttachment, sha256: digest.toUpperCase() },
    path: "sha256",
  },
  {
    schema: "evidenceWindowSchema",
    valid: evidenceWindow,
    invalid: { ...evidenceWindow, end: "2026-11-03T09:59:59.000Z" },
    path: "end",
    message: /end must not precede start/,
  },
  {
    schema: "evidenceRefSchema",
    valid: { window: evidenceWindow, attachment: evidenceAttachment },
    invalid: { window: evidenceWindow, attachment: screenshot },
    path: "attachment",
  },
  { schema: "replyAuthorSchema", valid: reply.author, invalid: { kind: "bot", name: null }, path: "kind" },
  { schema: "replySchema", valid: reply, invalid: { ...reply, id: "../rp_0001" }, path: "id" },
  {
    schema: "feedbackDraftSchema",
    variant: "comment",
    valid: draft,
    invalid: { ...draft, target: { ...target, textExcerpt: "x".repeat(201) } },
    path: "target.textExcerpt",
  },
  {
    schema: "feedbackDraftSchema",
    variant: "comment, blank unavailable reason",
    valid: { ...draft, screenshotUnavailableReason: null },
    invalid: { ...draft, screenshotUnavailableReason: "   " },
    path: "screenshotUnavailableReason",
    message: /must not be blank/,
  },
  {
    schema: "feedbackDraftSchema",
    variant: "choose_variant",
    valid: draftChoice,
    invalid: { ...draftChoice, choice: { slot: "pricing" } },
    path: "choice.variant",
  },
  {
    schema: "feedbackSchema",
    variant: "comment",
    valid: comment,
    invalid: { ...comment, text: "   " },
    path: "text",
    message: /must not be blank/,
  },
  {
    schema: "feedbackSchema",
    variant: "choose_variant",
    valid: chooseVariant,
    invalid: { ...chooseVariant, choice: undefined },
    path: "choice",
  },
  {
    schema: "feedbackSchema",
    variant: "choose_variant, blank unavailable reason",
    valid: { ...chooseVariant, screenshotUnavailableReason: "Page was hidden" },
    invalid: { ...chooseVariant, screenshotUnavailableReason: "\t\n" },
    path: "screenshotUnavailableReason",
    message: /must not be blank/,
  },
  // daemon
  { schema: "daemonInfoSchema", valid: daemonInfo, invalid: { ...daemonInfo, host: "0.0.0.0" }, path: "host" },
  {
    schema: "storeLockSchema",
    valid: { schemaVersion: 2, pid: 4242, startedAt: createdAt },
    invalid: { schemaVersion: 2, pid: 0, startedAt: createdAt },
    path: "pid",
  },
  {
    schema: "registerOriginsRequestSchema",
    valid: { schemaVersion: 2, origins: ["http://localhost:5173", "http://127.0.0.1:5173"] },
    invalid: { schemaVersion: 2, origins: ["http://localhost:5173", "http://localhost:5173/"] },
    path: "origins.1",
  },
  {
    schema: "registerOriginsResponseSchema",
    valid: { schemaVersion: 2, origins: ["https://app.localhost"] },
    invalid: { schemaVersion: 2, origins: ["file:///tmp"] },
    path: "origins.0",
  },
  {
    schema: "feedbackListQuerySchema",
    valid: { status: "needs-info", kind: "comment", since: createdAt },
    invalid: { kind: "comment", status: "closed" },
    path: "status",
  },
  {
    schema: "feedbackListResponseSchema",
    valid: { schemaVersion: 2, items: [comment, chooseVariant] },
    invalid: { schemaVersion: 2, items: [comment, { ...chooseVariant, status: "pending" }] },
    path: "items.1.status",
  },
  {
    schema: "replyRequestSchema",
    valid: { schemaVersion: 2, author: { kind: "user", name: null }, text: "Try v3." },
    invalid: { schemaVersion: 2, author: { kind: "user", name: null }, text: "\n" },
    path: "text",
    message: /must not be blank/,
  },
  {
    schema: "statusRequestSchema",
    valid: { schemaVersion: 2, status: "resolved" },
    invalid: { schemaVersion: 2, status: "closed" },
    path: "status",
  },
  {
    schema: "slotListResponseSchema",
    valid: { schemaVersion: 2, pages: [slotReport] },
    invalid: { schemaVersion: 2, pages: [{ ...slotReport, reportedAt: undefined }] },
    path: "pages.0.reportedAt",
  },
  {
    schema: "slotListResponseSchema",
    variant: "one report per page URL",
    valid: { schemaVersion: 2, pages: [slotReport, { ...slotReport, pageUrl: "http://localhost:5173/" }] },
    invalid: { schemaVersion: 2, pages: [slotReport, { ...slotReport, reportedAt: updatedAt }] },
    path: "pages",
    message: /page URLs must be unique/,
  },
  {
    schema: "deleteAllFeedbackResponseSchema",
    valid: { schemaVersion: 2, deleted: 3, failed: 1, leftover: 0 },
    invalid: { schemaVersion: 2, deleted: -1 },
    path: "deleted",
  },
  {
    schema: "daemonStatusSchema",
    valid: { schemaVersion: 2, pid: 4242, startedAt: createdAt, projectRoot: "/work/app", feedbackDirectory: "/work/app/.iterbar/feedback" },
    invalid: { schemaVersion: 2, pid: 4242, startedAt: createdAt, projectRoot: "/work/app", feedbackDirectory: "relative/feedback" },
    path: "feedbackDirectory",
  },
  { schema: "daemonErrorCodeSchema", valid: "store_locked", invalid: "teapot", path: "" },
  {
    schema: "daemonErrorResponseSchema",
    valid: { schemaVersion: 2, error: { code: "forbidden_origin", message: "Origin not allowed" } },
    invalid: { schemaVersion: 2, error: { code: "teapot", message: "Origin not allowed" } },
    path: "error.code",
  },
  {
    schema: "daemonEventSchema",
    variant: "feedback.created",
    valid: { schemaVersion: 2, type: "feedback.created", feedback: chooseVariant },
    invalid: { schemaVersion: 2, type: "feedback.created", feedback: { ...chooseVariant, kind: "vote" } },
    path: "feedback.kind",
  },
  {
    schema: "daemonEventSchema",
    variant: "feedback.updated",
    valid: { schemaVersion: 2, type: "feedback.updated", feedback: comment },
    invalid: { schemaVersion: 2, type: "feedback.updated", report: slotReport },
    path: "feedback",
  },
  {
    schema: "daemonEventSchema",
    variant: "feedback.deleted",
    valid: { schemaVersion: 2, type: "feedback.deleted", feedbackId: comment.id },
    invalid: { schemaVersion: 2, type: "feedback.deleted", feedbackId: "../x" },
    path: "feedbackId",
  },
  {
    schema: "daemonEventSchema",
    variant: "slots.reported",
    valid: { schemaVersion: 2, type: "slots.reported", report: slotReport },
    invalid: { schemaVersion: 2, type: "slots.reported", report: { ...slotReport, slots: [{ ...slotState, mounts: 0 }] } },
    path: "report.slots.0.mounts",
  },
];

const label = "msg";
const caseName = ({ schema, variant }: Case) => (variant ? `${schema} (${variant})` : schema);
const schemaOf = (name: SchemaName) => api[name] as z.ZodType;
const isVersioned = (value: unknown) => typeof value === "object" && value !== null && "schemaVersion" in value;

function issueOnPath(issue: string, path: string): boolean {
  const prefix = path ? `${label}.${path}` : label;
  return issue.startsWith(`${prefix}:`) || issue.startsWith(`${prefix}.`);
}

describe.each(cases.map((testCase) => ({ ...testCase, name: caseName(testCase) })))("$name", (testCase) => {
  const schema = schemaOf(testCase.schema);

  it("accepts the valid fixture", () => {
    expect(parseMessage(schema, testCase.valid, label)).toEqual(testCase.valid);
  });

  it("rejects the invalid fixture on the field it targets", () => {
    const result = safeParseMessage(schema, testCase.invalid, label);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(InvalidMessageError);
    const { issues } = result.error as InvalidMessageError;
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issueOnPath(issue, testCase.path), issue).toBe(true);
    if (testCase.message) expect(issues.some((issue) => testCase.message?.test(issue)), issues.join("\n")).toBe(true);
  });

  it.runIf(isVersioned(testCase.valid))("rejects an unknown major version before reading the shape", () => {
    for (const input of [{ ...(testCase.valid as object), schemaVersion: 3 }, { schemaVersion: 3, renamedEverything: true }]) {
      const result = safeParseMessage(schema, input, label);
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error).toBeInstanceOf(UnsupportedSchemaVersionError);
      expect(result.error.code).toBe("unsupported_schema_version");
      expect((result.error as UnsupportedSchemaVersionError).receivedVersion).toBe(3);
    }
  });
});

describe("fixture coverage", () => {
  it("has a case for every schema the root entry exports", () => {
    const exported = Object.keys(api).filter((name) => name.endsWith("Schema")).sort();
    const covered = new Set(cases.map((testCase) => testCase.schema));
    expect(exported.filter((name) => !covered.has(name as SchemaName))).toEqual([]);
    expect(exported.length).toBeGreaterThanOrEqual(43);
  });

  it("has a valid and an invalid fixture for every discriminated-union branch", () => {
    const unions = Object.entries(api).flatMap(([name, value]): [string, z.ZodDiscriminatedUnion][] =>
      value instanceof z.ZodDiscriminatedUnion ? [[name, value]] : []);
    expect(unions.map(([name]) => name).sort())
      .toEqual(["attachmentRefSchema", "daemonEventSchema", "feedbackDraftSchema", "feedbackSchema"]);
    for (const [name, union] of unions) {
      const key = union.def.discriminator;
      const unionCases = cases.filter((testCase) => testCase.schema === name);
      for (const option of union.options as z.ZodObject[]) {
        const tag = (option.shape[key] as z.ZodLiteral).value;
        const branch = unionCases.filter((testCase) => (testCase.valid as Record<string, unknown>)[key] === tag);
        expect(branch.map((testCase) => option.safeParse(testCase.valid).success), `${name} ${String(tag)} valid`)
          .toContain(true);
        expect(branch.map((testCase) => (testCase.invalid as Record<string, unknown>)[key]), `${name} ${String(tag)} invalid`)
          .toContain(tag);
      }
    }
  });
});

describe("nested records", () => {
  it("rejects a v1 envelope holding a record from another major version as an invalid message", () => {
    const event = { schemaVersion: 2, type: "feedback.created", feedback: { ...comment, schemaVersion: 3 } };
    const list = { schemaVersion: 2, items: [comment, { ...chooseVariant, schemaVersion: 3 }] };
    for (const [schema, input, path] of [
      [daemonEventSchema, event, "feedback.schemaVersion"],
      [feedbackListResponseSchema, list, "items.1.schemaVersion"],
    ] as const) {
      const result = safeParseMessage(schema, input, label);
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error).toBeInstanceOf(InvalidMessageError);
      expect(result.error.code).toBe("invalid_message");
      const { issues } = result.error as InvalidMessageError;
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) expect(issueOnPath(issue, path), issue).toBe(true);
    }
  });

  it("rejects an unknown daemon event type on the discriminator", () => {
    const result = safeParseMessage(daemonEventSchema, { schemaVersion: 2, type: "feedback.removed", feedback: comment }, label);
    expect(result.success).toBe(false);
    if (!result.success) {
      for (const issue of (result.error as InvalidMessageError).issues) expect(issueOnPath(issue, "type"), issue).toBe(true);
    }
  });
});

describe("schema versions", () => {
  it("treats a missing or malformed version as an invalid message, not an unknown version", () => {
    for (const schemaVersion of [undefined, "1", 1.5, 0, -1]) {
      const result = safeParseMessage(statusRequestSchema, { schemaVersion, status: "open" });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("invalid_message");
    }
  });

  it("reads an inherited schemaVersion the same way the schema does", () => {
    const inheriting = (schemaVersion: unknown) => Object.assign(Object.create({ schemaVersion }), { status: "open" });
    const future = safeParseMessage(statusRequestSchema, inheriting(3), label);
    expect(future.success || future.error.code).toBe("unsupported_schema_version");
    expect(parseMessage(statusRequestSchema, inheriting(2))).toEqual({ schemaVersion: 2, status: "open" });
    // An inherited version 1 is upgraded like an own one.
    expect(parseMessage(statusRequestSchema, inheriting(1))).toEqual({ schemaVersion: 2, status: "open" });
    const malformed = safeParseMessage(statusRequestSchema, inheriting("1"), label);
    expect(malformed.success || malformed.error.code).toBe("invalid_message");
    class FutureRegistry {
      get schemaVersion() { return 3; }
    }
    expect(() => readPageApi({ [PAGE_API_GLOBAL]: new FutureRegistry() })).toThrow(UnsupportedSchemaVersionError);
  });

  it("drops unknown v1 properties so additive fields are tolerated", () => {
    const parsed = parseMessage(statusRequestSchema, { schemaVersion: 2, status: "done", note: "later field" });
    expect(parsed).toEqual({ schemaVersion: 2, status: "done" });
  });

  it("reports malformed JSON as an invalid message", () => {
    expect(() => parseMessageJson(daemonEventSchema, "{\"schemaVersion\":1,", "event")).toThrow(InvalidMessageError);
    expect(() => parseMessageJson(daemonEventSchema, JSON.stringify({ schemaVersion: 3, type: "x" }), "event"))
      .toThrow(UnsupportedSchemaVersionError);
  });

  it("recognizes contract errors from another bundle by code", () => {
    const foreign = Object.assign(new Error("copy"), { code: "unsupported_schema_version" });
    expect(isIterbarContractError(foreign)).toBe(true);
    expect(isIterbarContractError(Object.assign(new Error("other"), { code: "ENOENT" }))).toBe(false);
  });
});

describe("feedback invariants", () => {
  it("accepts feedback with or without a batchId, and only a safe id as one", () => {
    expect(parseMessage(feedbackSchema, comment)).not.toHaveProperty("batchId");
    expect(parseMessage(feedbackSchema, { ...comment, batchId: "batch-1" }).batchId).toBe("batch-1");
    expect(() => parseMessage(feedbackSchema, { ...comment, batchId: "Batch 1" })).toThrow(InvalidMessageError);
    expect(() => parseMessage(feedbackSchema, { ...comment, batchId: null })).toThrow(InvalidMessageError);
    expect(parseMessage(feedbackSchema, { ...comment, batchId: "batch-1", batchSize: 3 }).batchSize).toBe(3);
    expect(() => parseMessage(feedbackSchema, { ...comment, batchId: "batch-1", batchSize: 0 })).toThrow(InvalidMessageError);
  });

  it("rejects a screenshot together with a reason it is unavailable", () => {
    expect(() => parseMessage(feedbackSchema, { ...comment, screenshotUnavailableReason: "failed" })).toThrow(InvalidMessageError);
  });

  it("rejects an update earlier than creation and duplicated reply ids", () => {
    expect(() => parseMessage(feedbackSchema, { ...comment, updatedAt: "2026-11-03T09:00:00.000Z" })).toThrow(/updatedAt/);
    expect(() => parseMessage(feedbackSchema, { ...comment, replies: [reply, reply] })).toThrow(/reply ids/);
  });

  it("round-trips the source location attribute and refuses paths outside the project", () => {
    expect(parseSourceLocation(formatSourceLocation(sourceLocation))).toEqual(sourceLocation);
    expect(parseSourceLocation("src/a:b.tsx:3:9")).toEqual({ path: "src/a:b.tsx", line: 3, column: 9 });
    for (const value of ["/abs/App.tsx:1:1", "../App.tsx:1:1", "src/App.tsx:0:1", "src/App.tsx:1", null]) {
      expect(parseSourceLocation(value)).toBeNull();
    }
  });

  it("round-trips every source location the schema accepts", () => {
    const codePoints = [...Array.from({ length: 0xa0 }, (_, index) => index), 0x2028, 0x2029, 0xfeff, 0x1f600];
    for (const codePoint of codePoints) {
      const location = { path: `src/a${String.fromCodePoint(codePoint)}b.tsx`, line: 7, column: 3 };
      if (!sourceLocationSchema.safeParse(location).success) continue;
      expect(parseSourceLocation(formatSourceLocation(location)), `U+${codePoint.toString(16)}`).toEqual(location);
    }
    for (const character of ["\r", "\n", "\u2028", "\u2029", "\0"]) {
      expect(sourceLocationSchema.safeParse({ ...sourceLocation, path: `src/a${character}b.tsx` }).success).toBe(false);
    }
  });

  it("rejects a blank screenshotUnavailableReason on every feedback shape, keeping null and real reasons", () => {
    for (const [schema, base] of [
      [feedbackSchema, chooseVariant],
      [api.feedbackDraftSchema, draft],
      [api.feedbackDraftSchema, draftChoice],
    ] as const) {
      expect(safeParseMessage(schema, { ...base, screenshotUnavailableReason: " " }).success).toBe(false);
      expect(safeParseMessage(schema, { ...base, screenshotUnavailableReason: null }).success).toBe(true);
      expect(safeParseMessage(schema, { ...base, screenshotUnavailableReason: "Capture timed out" }).success).toBe(true);
    }
  });
});

describe("variant URL parameter", () => {
  it("parses selections, lets a later entry win and keeps malformed entries aside", () => {
    expect(parseVariantParam(" pricing:v1,hero:b,,pricing:v2,bad,x:y:z,:v1")).toEqual({
      selections: [{ slot: "hero", variant: "b" }, { slot: "pricing", variant: "v2" }],
      invalid: ["bad", "x:y:z", ":v1"],
    });
    expect(parseVariantParam(null)).toEqual({ selections: [], invalid: [] });
  });

  it("keeps malformed entries verbatim and ignores blank ones", () => {
    expect(parseVariantParam(" bad , \t,hero: b ,pricing:v2 ")).toEqual({
      selections: [{ slot: "pricing", variant: "v2" }],
      invalid: [" bad ", "hero: b "],
    });
  });

  it("formats selections and refuses names that would break the format", () => {
    expect(formatVariantParam([{ slot: "hero", variant: "b" }, { slot: "pricing", variant: "v2" }])).toBe("hero:b,pricing:v2");
    expect(() => formatVariantParam([{ slot: "a,b", variant: "v1" }])).toThrow(InvalidMessageError);
    expect(() => formatVariantParam([{ slot: "a", variant: "v1" }, { slot: "a", variant: "v2" }])).toThrow(InvalidMessageError);
  });
});

describe("page API", () => {
  const api = { schemaVersion: 2, getSnapshot: () => snapshot, select: () => undefined, subscribe: () => () => undefined };

  it("returns null without a registry and the API when one is installed", () => {
    expect(readPageApi({})).toBeNull();
    expect(readPageApi({ [PAGE_API_GLOBAL]: api })).toBe(api);
  });

  it("rejects a registry from another major version or without the v1 methods", () => {
    expect(() => readPageApi({ [PAGE_API_GLOBAL]: { ...api, schemaVersion: 3 } })).toThrow(UnsupportedSchemaVersionError);
    expect(() => readPageApi({ [PAGE_API_GLOBAL]: { ...api, subscribe: undefined } })).toThrow(/subscribe/);
  });

  it("puts a version 1 registry behind a version 2 adapter: upgraded snapshots, translated selections", () => {
    const legacySnapshot = {
      schemaVersion: 1,
      slots: [{ slot: "pricing", versions: ["v1", "v2"], defaultVersion: "v1", activeVersion: "v2", mounts: 1 }],
      warnings: [{ code: "unknown_version", source: "api", value: "pricing:v9", message: "No such version" }],
    };
    const selections: unknown[] = [];
    const received: unknown[] = [];
    let notify: (snapshot: unknown) => void = () => undefined;
    const legacy = {
      schemaVersion: 1,
      getSnapshot: () => legacySnapshot,
      select: (selection: unknown) => selections.push(selection),
      subscribe: (listener: (snapshot: unknown) => void) => {
        notify = listener;
        return () => undefined;
      },
    };
    const adapted = readPageApi({ [PAGE_API_GLOBAL]: legacy })!;
    expect(adapted.schemaVersion).toBe(2);
    const read = adapted.getSnapshot();
    expect(read.slots[0]).toMatchObject({ variants: ["v1", "v2"], defaultVariant: "v1", activeVariant: "v2" });
    expect(read.warnings[0]?.code).toBe("unknown_variant");
    expect(registrySnapshotSchema.parse(read).schemaVersion).toBe(2);
    adapted.select({ schemaVersion: 2, slot: "pricing", variant: "v1" });
    expect(selections).toEqual([{ schemaVersion: 1, slot: "pricing", version: "v1" }]);
    adapted.subscribe((snapshot) => received.push(snapshot));
    notify(legacySnapshot);
    expect((received[0] as typeof read).slots[0]?.variants).toEqual(["v1", "v2"]);
  });

  it("upgrades a version 1 snapshot made in another realm, as an iframe's registry hands it over", () => {
    const foreign = runInNewContext(`({
      schemaVersion: 1,
      slots: [{ slot: "pricing", versions: ["v1", "v2"], defaultVersion: "v1", activeVersion: "v1", mounts: 1 }],
      warnings: [],
    })`) as unknown;
    const adapted = readPageApi({ [PAGE_API_GLOBAL]: { schemaVersion: 1, getSnapshot: () => foreign, select: () => undefined, subscribe: () => () => undefined } })!;
    expect(registrySnapshotSchema.parse(adapted.getSnapshot()).slots[0]).toMatchObject({ variants: ["v1", "v2"], activeVariant: "v1" });
  });
});

describe("portable ids", () => {
  const unportable = ["fb_A", "FB_0001", "con", "CON", "nul", "aux", "prn", "com1", "lpt9", "com0"];

  it("rejects ids that alias on case-insensitive filesystems or name a Windows device", () => {
    for (const id of unportable) {
      expect(safeParseMessage(api.idSchema, id).success, id).toBe(false);
      expect(() => assertSafeId(id), id).toThrow(expect.objectContaining({ code: "invalid_path_segment" }));
      expect(() => daemonPath("getFeedback", { feedbackId: id }), id).toThrow(IterbarContractError);
      expect(() => api.attachmentFileName({ id, kind: "screenshot" }), id).toThrow(IterbarContractError);
      expect(safeParseMessage(feedbackSchema, { ...comment, id }).success, id).toBe(false);
    }
    for (const id of ["console", "com10", "nul_1", "lpt", "fb_0001"]) expect(assertSafeId(id)).toBe(id);
  });

  it("accepts only project roots that name the same directory in every process", () => {
    const accepted = [
      "/", "/Users/dev/app", "C:\\", "C:\\Users\\dev\\app", "c:/Users/dev/app",
      "\\\\server\\share", "\\\\server\\share\\", "\\\\server\\share\\app", "//server/share/app",
      "//server/share/x", "\\\\server/share", "//server\\share", "\\\\my-server.local\\share$\\app",
    ];
    const rejected = [
      // relative or drive-relative on Windows
      "Users/dev/app", "\\Users\\dev", "C:Users", "C:",
      // UNC without both a server and a share
      "\\\\", "\\\\server", "\\\\server\\", "//server", "//server/", "/\\server", "\\\\\\server\\share", "///Users/dev",
      "\\\\..\\share", "\\\\server\\..\\app",
      // device namespace: use the equivalent drive or UNC path
      "\\\\?\\C:\\app", "\\\\?\\UNC\\server\\share", "\\\\.\\C:\\app", "\\\\.\\pipe\\iterbar", "//./pipe/iterbar",
      // a UNC server or share name containing a character Windows forbids in names, or a control character
      ...[..."<>:\"|?*", "\u0001", "\u001f"].flatMap((bad) => [
        `\\\\ser${bad}ver\\share`, `\\\\server\\sh${bad}are\\app`, `//server${bad}/share`, `//server/share${bad}`,
      ]),
    ];
    for (const root of accepted) {
      expect(safeParseMessage(absolutePathSchema, root).success, root).toBe(true);
      expect(safeParseMessage(daemonInfoSchema, { ...daemonInfo, projectRoot: root }, label).success, root).toBe(true);
    }
    for (const root of rejected) {
      expect(safeParseMessage(absolutePathSchema, root).success, root).toBe(false);
      const result = safeParseMessage(daemonInfoSchema, { ...daemonInfo, projectRoot: root }, label);
      expect(result.success, root).toBe(false);
      if (!result.success) {
        for (const issue of (result.error as InvalidMessageError).issues) expect(issueOnPath(issue, "projectRoot"), issue).toBe(true);
      }
    }
    expect(isAbsolutePath("C:\\app", "posix")).toBe(false);
    expect(isAbsolutePath("/app", "win32")).toBe(false);
    expect([isAbsolutePath("/app", "posix"), isAbsolutePath("C:\\app", "win32"), isAbsolutePath("\\\\s\\sh", "win32")])
      .toEqual([true, true, true]);
  });

  it("bounds a project root at MAX_ABSOLUTE_PATH_LENGTH characters in every accepted form", () => {
    expect(MAX_ABSOLUTE_PATH_LENGTH).toBe(4096);
    const padded = (prefix: string, length: number) => prefix + "a".repeat(length - prefix.length);
    for (const prefix of ["/", "C:\\", "c:/", "\\\\server\\share\\", "//server/share/"]) {
      const longest = padded(prefix, MAX_ABSOLUTE_PATH_LENGTH);
      const tooLong = padded(prefix, MAX_ABSOLUTE_PATH_LENGTH + 1);
      expect(isAbsolutePath(longest), prefix).toBe(true);
      expect(isAbsolutePath(tooLong), prefix).toBe(false);
      expect(safeParseMessage(absolutePathSchema, longest).success, prefix).toBe(true);
      expect(safeParseMessage(daemonInfoSchema, { ...daemonInfo, projectRoot: longest }, label).success, prefix).toBe(true);
      expect(safeParseMessage(absolutePathSchema, tooLong).success, prefix).toBe(false);
      const result = safeParseMessage(daemonInfoSchema, { ...daemonInfo, projectRoot: tooLong }, label);
      expect(result.success, prefix).toBe(false);
      if (!result.success) {
        const { issues } = result.error as InvalidMessageError;
        expect(issues.length, prefix).toBeGreaterThan(0);
        for (const issue of issues) expect(issueOnPath(issue, "projectRoot"), issue).toBe(true);
      }
    }
  });

  it("rejects a daemon project root containing NUL", () => {
    expect(safeParseMessage(absolutePathSchema, "C:\\app\0x").success).toBe(false);
    const result = safeParseMessage(daemonInfoSchema, { ...daemonInfo, projectRoot: "/Users/dev\0/app" }, label);
    expect(result.success).toBe(false);
    if (!result.success) {
      for (const issue of (result.error as InvalidMessageError).issues) expect(issueOnPath(issue, "projectRoot"), issue).toBe(true);
    }
  });
});

describe("daemon transport", () => {
  it("fills endpoint paths with safe ids only", () => {
    expect(daemonPath("getAttachment", { feedbackId: "fb_0001", attachmentId: "at_0001" }))
      .toBe("/feedback/fb_0001/attachments/at_0001");
    expect(daemonPath("listFeedback")).toBe("/feedback");
    expect(() => daemonPath("getFeedback", { feedbackId: ".." })).toThrow(IterbarContractError);
    expect(() => daemonPath("reply", { feedbackId: "fb/../x" })).toThrow(/not a safe Iterbar id/);
    expect(() => daemonPath("setStatus")).toThrow(TypeError);
  });

  it("carries the token in an Authorization header", () => {
    expect(tokenFromAuthorization(bearerAuthorization(token))).toBe(token);
    for (const header of [undefined, `Basic ${token}`, `Bearer ${token.toUpperCase()}`, `Bearer ${token} `]) {
      expect(tokenFromAuthorization(header)).toBeNull();
    }
    expect(() => bearerAuthorization("short")).toThrow(InvalidMessageError);
  });

  it("carries the token in the WebSocket subprotocol offer", () => {
    const protocols = webSocketProtocols(token);
    expect(protocols[0]).toBe(WEBSOCKET_SUBPROTOCOL);
    expect(tokenFromWebSocketProtocols(protocols.join(", "))).toBe(token);
    expect(tokenFromWebSocketProtocols(protocols[1])).toBeNull();
    expect(tokenFromWebSocketProtocols(`${protocols.join(",")},${webSocketProtocols("1".repeat(64))[1]}`)).toBeNull();
    expect(tokenFromWebSocketProtocols(`${WEBSOCKET_SUBPROTOCOL}, iterbar.token.nothex`)).toBeNull();
  });
});

describe("protocol version 1 input", () => {
  it("upgrades a version 1 slot report, snapshot, selection and stored choice to the version 2 names", () => {
    const slot = { slot: "pricing", versions: ["v1", "v2"], defaultVersion: "v1", activeVersion: "v2", mounts: 1 };
    expect(api.parseMessage(api.slotReportSchema, {
      schemaVersion: 1, pageUrl: "http://localhost:5173/", reportedAt: "2026-01-01T00:00:00Z", slots: [slot],
    }, "report")).toEqual({
      schemaVersion: 2, pageUrl: "http://localhost:5173/", reportedAt: "2026-01-01T00:00:00Z",
      slots: [{ slot: "pricing", variants: ["v1", "v2"], defaultVariant: "v1", activeVariant: "v2", mounts: 1 }],
    });
    const snapshot = api.parseMessage(api.registrySnapshotSchema, {
      schemaVersion: 1, slots: [slot], warnings: [{ code: "unknown_version", source: "url", value: "pricing:v9", message: "No v9" }],
    }, "snapshot");
    expect(snapshot.warnings[0]?.code).toBe("unknown_variant");
    expect(api.parseMessage(api.variantSelectionSchema, { schemaVersion: 1, slot: "pricing", version: "v2" }, "selection"))
      .toEqual({ schemaVersion: 2, slot: "pricing", variant: "v2" });
    const stored = {
      schemaVersion: 1, id: "feedback-1", kind: "choose_variant", text: "", pageUrl: "http://localhost:5173/", target: null,
      activeVariants: [{ slot: "pricing", version: "v2" }], screenshotUnavailableReason: null, choice: { slot: "pricing", version: "v2" },
      screenshot: null, evidence: null, replies: [], status: "open", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    };
    const feedback = api.parseMessage(api.feedbackSchema, stored, "feedback");
    expect(feedback).toMatchObject({ schemaVersion: 2, activeVariants: [{ slot: "pricing", variant: "v2" }], choice: { slot: "pricing", variant: "v2" } });
  });

  it("keeps the version 1 field when a version 1 message also carries its version 2 name", () => {
    for (const choice of [{ slot: "pricing", version: "v2", variant: "metadata" }, { variant: "metadata", slot: "pricing", version: "v2" }]) {
      expect(api.parseMessage(api.activeVariantsSchema, [{ ...choice }], "x")).toBeDefined();
      expect(api.upgradeMessage({ schemaVersion: 1, kind: "choose_variant", choice }, api.feedbackSchema)).toEqual({ schemaVersion: 2, kind: "choose_variant", choice: { slot: "pricing", variant: "v2" } });
    }
  });

  it("renames only protocol fields, never an extension field with the same name", () => {
    const stored = {
      schemaVersion: 1, kind: "choose_variant", metadata: { version: "design-3", versions: ["a"], extra: { slot: "sidebar", version: "x" } },
      choice: { slot: "pricing", version: "v2" },
    };
    expect(api.upgradeMessage(stored, api.feedbackSchema)).toEqual({
      schemaVersion: 2, kind: "choose_variant", metadata: { version: "design-3", versions: ["a"], extra: { slot: "sidebar", version: "x" } },
      choice: { slot: "pricing", variant: "v2" },
    });
    // A feedback record's own extension fields named like a selection's, or like a listing's, stay as they are.
    const record = { schemaVersion: 1, kind: "comment", slot: "sidebar", version: "design-3", items: [{ slot: "x", version: "y" }] };
    expect(api.upgradeMessage(record, api.feedbackSchema)).toEqual({ ...record, schemaVersion: 2 });
    // An active variant's or a choice's extension named like a slot state field keeps its name.
    expect(api.upgradeMessage({ schemaVersion: 1, kind: "choose_variant", activeVariants: [{ slot: "pricing", version: "b", versions: ["m"] }], choice: { slot: "pricing", version: "b", activeVersion: "m" } }, api.feedbackSchema))
      .toEqual({ schemaVersion: 2, kind: "choose_variant", activeVariants: [{ slot: "pricing", variant: "b", versions: ["m"] }], choice: { slot: "pricing", variant: "b", activeVersion: "m" } });
    // A field named __proto__ (valid JSON) stays an own field through the rename.
    const proto = api.upgradeMessage(JSON.parse('{"schemaVersion":1,"kind":"choose_variant","choice":{"slot":"p","version":"b","__proto__":{"x":1}}}'), api.feedbackSchema) as { choice: object };
    expect(Object.hasOwn(proto.choice, "__proto__")).toBe(true);
    expect(JSON.stringify(proto.choice)).toBe('{"slot":"p","variant":"b","__proto__":{"x":1}}');
    // A comment's extension named `choice` is not a variant choice: its fields stay.
    expect(api.upgradeMessage({ schemaVersion: 1, kind: "comment", choice: { version: "design-3" } }, api.feedbackSchema))
      .toEqual({ schemaVersion: 2, kind: "comment", choice: { version: "design-3" } });
    // A selection with an extra field is still a selection; an event with an extra `kind` is still an event.
    expect(api.parseMessage(api.variantSelectionSchema, { schemaVersion: 1, slot: "pricing", version: "b", source: "toolbar" }))
      .toEqual({ schemaVersion: 2, slot: "pricing", variant: "b" });
    const feedbackV1 = { ...(api.upgradeMessage(stored, api.feedbackSchema) as object) };
    expect(api.upgradeMessage({ schemaVersion: 1, type: "feedback.updated", kind: "x", feedback: { ...stored } }, api.daemonEventSchema))
      .toEqual({ schemaVersion: 2, type: "feedback.updated", kind: "x", feedback: feedbackV1 });
    // Nested messages (an event's feedback, a slot list's pages) are upgraded at their own paths.
    expect(api.upgradeMessage({ schemaVersion: 1, type: "slots.reported", report: { schemaVersion: 1, slots: [{ slot: "a", versions: ["x"] }] } }, api.daemonEventSchema))
      .toEqual({ schemaVersion: 2, type: "slots.reported", report: { schemaVersion: 2, slots: [{ slot: "a", variants: ["x"] }] } });
  });

  it("leaves version 2 input as it is and still refuses a later major version", () => {
    const input = { schemaVersion: 2, slot: "pricing", variant: "v2" };
    expect(api.upgradeMessage(input)).toBe(input);
    // Version 2 messages use only the new names.
    expect(api.safeParseMessage(api.variantSelectionSchema, { schemaVersion: 2, slot: "pricing", version: "v2" }, "selection").success).toBe(false);
    expect(() => api.parseMessage(api.variantSelectionSchema, { schemaVersion: 3, slot: "pricing", variant: "v2" }, "selection"))
      .toThrow(api.UnsupportedSchemaVersionError);
  });
});
