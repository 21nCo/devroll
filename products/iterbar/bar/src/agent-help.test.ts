import { describe, expect, it } from "vitest";
import { agentSteps } from "./agent-help.js";

describe("setup steps", () => {
  it("stop at the first failing step: && for POSIX shells, if ($?) for a Windows project (PowerShell 5.1)", () => {
    const posix = agentSteps("claude", "/work/shop").init.map((snippet) => snippet.text);
    expect(posix).toEqual([
      "cd /work/shop && npx iterbar init --agent claude",
      "cd /work/shop && pnpm add -D iterbar && pnpm exec iterbar init --agent claude",
    ]);
    const windows = agentSteps("codex", "C:\\work\\it's", { path: "C:\\work\\cli\\dist\\cli.js" }).init.map((snippet) => snippet.text);
    expect(windows).toEqual([
      "cd 'C:\\work\\it''s'; if ($?) { npx iterbar init --agent codex }",
      "cd 'C:\\work\\it''s'; if ($?) { pnpm add -D iterbar; if ($?) { pnpm exec iterbar init --agent codex } }",
      "cd 'C:\\work\\it''s'; if ($?) { node 'C:\\work\\cli\\dist\\cli.js' init --agent codex }",
    ]);
  });
});
