import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundledSkill, MCP_COMMAND, parseInitArgs, runInit } from "./init.js";

let base: string;
let home: string;
let root: string;
let skill: string;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: { write: (text: string) => out.push(text) > 0 }, stderr: { write: (text: string) => err.push(text) > 0 } },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "iterbar-init-test-"));
  home = join(base, "home");
  root = join(base, "project");
  skill = join(base, "skill");
  await mkdir(join(skill, "references"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: iterbar\n---\n");
  await writeFile(join(skill, "references", "setup.md"), "setup\n");
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("iterbar init", () => {
  it("parses agents, scope and flags", () => {
    expect(parseInitArgs([])).toMatchObject({ help: false, agents: ["claude"], scope: "user", force: false, dryRun: false });
    expect(parseInitArgs(["--agent", "all", "--scope=project", "--dry-run"])).toMatchObject({ agents: ["claude", "codex", "cursor"], scope: "project", dryRun: true });
    expect(() => parseInitArgs(["--agent", "vim"])).toThrow(/claude, codex, cursor or all/);
    expect(() => parseInitArgs(["--bogus"])).toThrow(/Unknown argument/);
  });

  it("finds the skill bundled with the package", async () => {
    expect(await readFile(join(await bundledSkill(), "SKILL.md"), "utf8")).toMatch(/^---\nname: iterbar/);
  });

  it("installs the skill and registers the server for Claude Code, keeping other servers", async () => {
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const run = capture();
    expect(await runInit(["--root", root], run.io, { home, skillSource: skill })).toBe(0);
    expect(await readFile(join(home, ".claude/skills/iterbar/references/setup.md"), "utf8")).toBe("setup\n");
    const config = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    expect(config.mcpServers).toEqual({ other: { command: "x" }, iterbar: MCP_COMMAND });
    expect(run.out()).toContain("Skill: installed");
    // A second run changes nothing.
    const again = capture();
    expect(await runInit(["--root", root], again.io, { home, skillSource: skill })).toBe(0);
    expect(again.out()).toContain("Skill: up to date");
    expect(again.out()).toContain("MCP server: already in");
  });

  it("keeps a different skill or server entry unless forced", async () => {
    await mkdir(join(home, ".claude/skills/iterbar"), { recursive: true });
    await writeFile(join(home, ".claude/skills/iterbar/SKILL.md"), "mine\n");
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { iterbar: { command: "iterbar", args: ["mcp"] } } }));
    const kept = capture();
    expect(await runInit(["--root", root], kept.io, { home, skillSource: skill })).toBe(0);
    expect(kept.out()).toContain("already exists and differs; kept it");
    expect(await readFile(join(home, ".claude/skills/iterbar/SKILL.md"), "utf8")).toBe("mine\n");
    const forced = capture();
    expect(await runInit(["--root", root, "--force"], forced.io, { home, skillSource: skill })).toBe(0);
    expect(await readFile(join(home, ".claude/skills/iterbar/SKILL.md"), "utf8")).toMatch(/name: iterbar/);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.iterbar).toEqual(MCP_COMMAND);
  });

  it("never writes through a linked skill folder, and replaces only the link on --force", async () => {
    const checkout = join(base, "checkout-skill");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "SKILL.md"), "checkout\n");
    await mkdir(join(home, ".claude/skills"), { recursive: true });
    await symlink(checkout, join(home, ".claude/skills/iterbar"));
    const kept = capture();
    expect(await runInit(["--root", root], kept.io, { home, skillSource: skill })).toBe(0);
    expect(kept.out()).toContain("links to");
    const forced = capture();
    expect(await runInit(["--root", root, "--force"], forced.io, { home, skillSource: skill })).toBe(0);
    expect(await readFile(join(checkout, "SKILL.md"), "utf8")).toBe("checkout\n");
    expect(await readFile(join(home, ".claude/skills/iterbar/SKILL.md"), "utf8")).toMatch(/name: iterbar/);
  });

  it("writes nothing on a dry run, and prints Codex's config instead of editing it", async () => {
    const run = capture();
    expect(await runInit(["--root", root, "--agent", "all", "--dry-run"], run.io, { home, skillSource: skill })).toBe(0);
    expect(run.out()).toContain("would install");
    expect(run.out()).toContain("[mcp_servers.iterbar]");
    await expect(readFile(join(root, ".mcp.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(home, ".claude/skills/iterbar/SKILL.md"), "utf8")).rejects.toThrow();
  });

  it("installs project-scope skills inside the project", async () => {
    const run = capture();
    expect(await runInit(["--root", root, "--agent", "cursor", "--scope", "project"], run.io, { home, skillSource: skill })).toBe(0);
    expect(await readFile(join(root, ".cursor/skills/iterbar/SKILL.md"), "utf8")).toMatch(/name: iterbar/);
    const config = JSON.parse(await readFile(join(root, ".cursor/mcp.json"), "utf8"));
    expect(config.mcpServers.iterbar.args).toEqual(["-y", "@iterbar/cli", "mcp", "--root", "${workspaceFolder}"]);
  });
});
