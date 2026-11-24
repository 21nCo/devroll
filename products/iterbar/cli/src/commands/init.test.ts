import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

  it("never writes through a linked config or a linked folder, and refuses a config that is not an object", async () => {
    const shared = join(base, "dotfiles");
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    await symlink(join(shared, "mcp.json"), join(root, ".mcp.json"));
    await symlink(shared, join(root, ".cursor"));
    await mkdir(home, { recursive: true });
    await symlink(shared, join(home, ".claude"));
    const run = capture();
    expect(await runInit(["--root", root, "--agent", "all", "--force"], run.io, { home, skillSource: skill })).toBe(0);
    expect(run.out()).toContain(`${join(root, ".mcp.json")} is a link`);
    expect(run.out()).toContain(`${join(root, ".cursor")} is a link`);
    expect(run.out()).toContain(`${join(home, ".claude")} is a link`);
    expect(JSON.parse(await readFile(join(shared, "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
    await expect(readFile(join(shared, "skills/iterbar/SKILL.md"), "utf8")).rejects.toThrow();

    await rm(join(root, ".mcp.json"));
    await writeFile(join(root, ".mcp.json"), "[1, 2]");
    const refused = capture();
    expect(await runInit(["--root", root], refused.io, { home: join(base, "other-home"), skillSource: skill })).toBe(1);
    expect(refused.err()).toContain("is not an object");
  });

  it("keeps a config's permissions, refuses an option where a value belongs, and leaves a linked Codex home alone", async () => {
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x", env: { TOKEN: "test-api-token" } } } }), { mode: 0o600 });
    const run = capture();
    expect(await runInit(["--root", root], run.io, { home, skillSource: skill })).toBe(0);
    expect((await stat(join(root, ".mcp.json"))).mode & 0o777).toBe(0o600);

    expect(() => parseInitArgs(["--root", "--dry-run"])).toThrow(/needs a value/);
    await symlink(root, join(base, "project-link"));
    const linked = capture();
    expect(await runInit(["--root", join(base, "project-link")], linked.io, { home, skillSource: skill })).toBe(1);
    expect(linked.err()).toContain("is a link");
    expect(parseInitArgs(["--root=-odd"])).toMatchObject({ root: "-odd" });

    const realCodex = join(base, "real-codex");
    await mkdir(realCodex, { recursive: true });
    await symlink(realCodex, join(base, "codex-link"));
    const codex = capture();
    expect(await runInit(["--root", root, "--agent", "codex"], codex.io, { home, codexHome: `${join(base, "codex-link")}/`, skillSource: skill })).toBe(0);
    expect(codex.out()).toContain("is a link");
    await expect(readFile(join(realCodex, "skills/iterbar/SKILL.md"), "utf8")).rejects.toThrow();
    // CODEX_HOME under the home, through a linked folder on the way (~/.config pointing at shared dotfiles).
    const dotfiles = join(base, "dotfiles");
    await mkdir(join(dotfiles, "codex"), { recursive: true });
    await symlink(dotfiles, join(home, ".config"));
    const nested = capture();
    expect(await runInit(["--root", root, "--agent", "codex"], nested.io, { home, codexHome: join(home, ".config", "codex"), skillSource: skill })).toBe(0);
    expect(nested.out()).toContain(`${join(home, ".config")} is a link`);
    await expect(readFile(join(dotfiles, "codex", "skills/iterbar/SKILL.md"), "utf8")).rejects.toThrow();
    // A folder whose name only starts with ".." is inside the home too.
    const dotted = join(base, "dotted");
    await mkdir(join(dotted, "codex"), { recursive: true });
    await symlink(dotted, join(home, "..config"));
    const odd = capture();
    expect(await runInit(["--root", root, "--agent", "codex", "--force"], odd.io, { home, codexHome: join(home, "..config", "codex"), skillSource: skill })).toBe(0);
    expect(odd.out()).toContain(`${join(home, "..config")} is a link`);
    await expect(readFile(join(dotted, "codex", "skills/iterbar/SKILL.md"), "utf8")).rejects.toThrow();
  });

  it("registers the running CLI with node when the package is neither installed in the project nor fetched by npx", async () => {
    const cli = join(base, "checkout", "products", "iterbar", "cli", "dist", "cli.js");
    const run = capture();
    expect(await runInit(["--root", root, "--agent", "all"], run.io, { home, skillSource: skill, cliPath: cli })).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.iterbar).toEqual({ command: "node", args: [cli, "mcp"] });
    expect(run.out()).toContain(`command = "node"`);
    // Installed in the project, or fetched by npx: npx runs it.
    // The earlier contracts package installed under the name does not count: it has no iterbar command.
    await mkdir(join(root, "node_modules", "iterbar"), { recursive: true });
    await writeFile(join(root, "node_modules", "iterbar", "package.json"), JSON.stringify({ name: "iterbar", version: "0.0.1" }));
    const contracts = capture();
    expect(await runInit(["--root", root, "--force"], contracts.io, { home, skillSource: skill, cliPath: cli })).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.iterbar).toEqual({ command: "node", args: [cli, "mcp"] });
    // Run through npx with that package in the way, the entry names this CLI's version so npx fetches it instead.
    const viaNpx = capture();
    const npxCli = join(base, "cache", "_npx", "1", "node_modules", "iterbar", "dist", "cli.js");
    expect(await runInit(["--root", root, "--force"], viaNpx.io, { home, skillSource: skill, cliPath: npxCli })).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.iterbar.args[1]).toMatch(/^iterbar@\d+\.\d+\.\d+/);
    expect(viaNpx.out()).not.toContain("with node");
    // A pin an earlier init wrote is init's own: a later init moves it to the version it runs.
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { iterbar: { command: "npx", args: ["-y", "iterbar@0.0.9", "mcp"] } } }));
    expect(await runInit(["--root", root], capture().io, { home, skillSource: skill, cliPath: npxCli })).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.iterbar.args[1]).not.toBe("iterbar@0.0.9");
    // npx installed it from a tarball: it cannot be fetched by version, so it runs by its path.
    await mkdir(join(base, "cache", "_npx", "1", "node_modules"), { recursive: true });
    await writeFile(join(base, "cache", "_npx", "1", "node_modules", ".package-lock.json"), JSON.stringify({ packages: { "node_modules/iterbar": { resolved: "file:../iterbar-0.1.0.tgz" } } }));
    expect(await runInit(["--root", root, "--force"], capture().io, { home, skillSource: skill, cliPath: npxCli })).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.iterbar).toEqual({ command: "node", args: [npxCli, "mcp"] });
    // A tarball from any https URL is not the registry's copy either; the registry's own tarball of this version is.
    const lockResolved = (resolved: string) => writeFile(join(base, "cache", "_npx", "1", "node_modules", ".package-lock.json"),
      JSON.stringify({ packages: { "node_modules/iterbar": { resolved } } }));
    await lockResolved("https://example.com/iterbar-preview.tgz");
    expect(await runInit(["--root", root, "--force"], capture().io, { home, skillSource: skill, cliPath: npxCli })).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.iterbar).toEqual({ command: "node", args: [npxCli, "mcp"] });
    const { version } = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    await lockResolved(`https://registry.npmjs.org/iterbar/-/iterbar-${version}.tgz`);
    expect(await runInit(["--root", root, "--force"], capture().io, { home, skillSource: skill, cliPath: npxCli })).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.iterbar.args[1]).toBe(`iterbar@${version}`);
    // A URL request is not a registry install, even when the URL looks like the registry's tarball.
    await writeFile(join(base, "cache", "_npx", "1", "package.json"), JSON.stringify({ dependencies: { iterbar: `https://example.com/preview/iterbar/-/iterbar-${version}.tgz` } }));
    expect(await runInit(["--root", root, "--force"], capture().io, { home, skillSource: skill, cliPath: npxCli })).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.iterbar).toEqual({ command: "node", args: [npxCli, "mcp"] });
    await writeFile(join(base, "cache", "_npx", "1", "package.json"), JSON.stringify({ dependencies: { iterbar: "^0.1.0" } }));
    // A pinned entry is kept by an init that does not pin itself (run from a checkout): the user may have pinned it.
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { iterbar: { command: "npx", args: ["-y", "iterbar@0.0.9", "mcp"] } } }));
    const checkout = capture();
    expect(await runInit(["--root", root], checkout.io, { home, skillSource: skill, cliPath: cli })).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.iterbar.args[1]).toBe("iterbar@0.0.9");
    expect(checkout.out()).toContain("kept it");
    await writeFile(join(root, "node_modules", "iterbar", "package.json"), JSON.stringify({ name: "iterbar", bin: { iterbar: "./dist/cli.js" } }));
    const installed = capture();
    expect(await runInit(["--root", root, "--force"], installed.io, { home, skillSource: skill, cliPath: cli })).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.iterbar).toEqual(MCP_COMMAND);
    // Codex starts the server from any folder, so its config names the project's install by its absolute path.
    const projectCli = join(root, "node_modules", "iterbar", "dist", "cli.js");
    await mkdir(join(root, "node_modules", "iterbar", "dist"), { recursive: true });
    await writeFile(projectCli, "");
    const codex = capture();
    expect(await runInit(["--root", root, "--agent", "codex"], codex.io, { home, skillSource: skill, cliPath: cli })).toBe(0);
    expect(codex.out()).toContain(`command = "node"\n    args = [${JSON.stringify(projectCli)}, "mcp", "--root", ${JSON.stringify(root)}]`);
  });

  it("moves an entry an earlier init wrote under @iterbar/cli to the new name, and keeps a customized one", async () => {
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { iterbar: { command: "npx", args: ["-y", "@iterbar/cli", "mcp"] } } }));
    const run = capture();
    expect(await runInit(["--root", root], run.io, { home, skillSource: skill })).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.iterbar).toEqual(MCP_COMMAND);
    // Also when this init registers a checkout's CLI with node.
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { iterbar: { command: "npx", args: ["-y", "@iterbar/cli", "mcp"] } } }));
    const fromCheckout = capture();
    expect(await runInit(["--root", root], fromCheckout.io, { home, skillSource: skill, cliPath: "/checkout/cli/dist/cli.js" })).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.iterbar).toEqual({ command: "node", args: ["/checkout/cli/dist/cli.js", "mcp"] });
    // Keys in another order are the same entry.
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { iterbar: { args: ["-y", "@iterbar/cli", "mcp"], command: "npx" } } }));
    expect(await runInit(["--root", root], capture().io, { home, skillSource: skill })).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.iterbar).toEqual(MCP_COMMAND);
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { iterbar: { command: "npx", args: ["-y", "@iterbar/cli", "mcp", "--verbose"] } } }));
    const custom = capture();
    expect(await runInit(["--root", root], custom.io, { home, skillSource: skill })).toBe(0);
    expect(custom.out()).toContain("kept it");
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
    expect(config.mcpServers.iterbar.args).toEqual(["-y", "iterbar", "mcp", "--root", "${workspaceFolder}"]);
  });
});
