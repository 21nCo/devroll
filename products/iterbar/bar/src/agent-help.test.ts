import { describe, expect, it } from "vitest";
import { agentSteps } from "./agent-help.js";

describe("setup steps", () => {
  it("are plain commands that run alike in every shell, with the folder to run them in named in the caption", () => {
    const steps = agentSteps("claude", "/work/shop").init;
    expect(steps.map((snippet) => snippet.text)).toEqual([
      "npx iterbar init --agent claude",
      "pnpm add -D iterbar\npnpm exec iterbar init --agent claude",
    ]);
    for (const snippet of steps) expect(snippet.caption).toContain("(/work/shop)");
    // Nothing that Windows PowerShell 5.1 rejects, and a Windows CLI path in PowerShell's quotes.
    const windows = agentSteps("codex", "C:\\work\\shop[1]", { path: "C:\\work\\it's\\dist\\cli.js" }).init.map((snippet) => snippet.text);
    expect(windows.join("\n")).not.toMatch(/&&|\bcd\b/u);
    expect(windows[2]).toBe("node 'C:\\work\\it''s\\dist\\cli.js' init --agent codex");
  });
});
