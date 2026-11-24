import { chmod, cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The npm package that carries the `iterbar` command, the MCP server and the agent skill. */
export const CLI_PACKAGE = "iterbar";

/** What the MCP configs run: the package's own command through npx, so nothing has to be on `PATH`. */
export const MCP_COMMAND = { command: "npx", args: ["-y", CLI_PACKAGE, "mcp"] } as const;

/** What the user pastes into the agent once it is set up; the bar's "Use with your agent" shows the same. */
export const INIT_PROMPT =
  "Use the iterbar MCP tools to read my open Iterbar feedback (with get_batch for comments I sent together), make the changes, and reply on each item when done.";

export const INIT_USAGE = `Usage: iterbar init [--agent <name>] [--scope user|project] [--root <directory>] [--force] [--dry-run]

Sets a project up for Iterbar and a coding agent, once:
  1. installs the iterbar agent skill, which ships in this package, into the agent's skills folder;
  2. registers the iterbar MCP server for the agent (it runs "npx -y ${CLI_PACKAGE} mcp");
  3. prints the prompt to paste into the agent.

Options:
  --agent <name>       claude, codex, cursor or all (default: claude)
  --scope user|project Install the skill for you (default: ~/.claude/skills, ~/.codex/skills,
                       ~/.cursor/skills) or for the project (.claude/skills, .cursor/skills);
                       Codex only reads skills from your user folder
  --root <directory>   Project root (default: the current directory)
  --force              Replace an existing iterbar skill or MCP entry that differs
  --dry-run            Print what would change without writing anything
  -h, --help           Show this help

Claude Code's server goes in <root>/.mcp.json and Cursor's in <root>/.cursor/mcp.json. Codex keeps
MCP servers in ~/.codex/config.toml, which init does not edit: it prints the lines to add.
`;

export type InitAgent = "claude" | "codex" | "cursor";

const AGENTS: readonly InitAgent[] = ["claude", "codex", "cursor"];

export interface InitOptions {
  readonly agents: readonly InitAgent[];
  readonly scope: "user" | "project";
  readonly root: string | undefined;
  readonly force: boolean;
  readonly dryRun: boolean;
}

export interface InitIo {
  readonly stdout: Pick<NodeJS.WritableStream, "write">;
  readonly stderr: Pick<NodeJS.WritableStream, "write">;
}

export interface InitEnvironment {
  /** The user's home folder; the user-scope skills folders live under it. */
  readonly home?: string;
  /** Codex's home folder (`CODEX_HOME`), when set. */
  readonly codexHome?: string;
  /** The skill folder to install; defaults to the one bundled with this package. */
  readonly skillSource?: string;
  readonly cwd?: string;
}

type Parsed = { readonly help: true } | ({ readonly help: false } & InitOptions);

export function parseInitArgs(args: readonly string[]): Parsed {
  let agents: InitAgent[] | undefined;
  let scope: "user" | "project" = "user";
  let root: string | undefined;
  let force = false;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!["--agent", "--scope", "--root"].includes(name)) throw new Error(`Unknown argument ${JSON.stringify(arg)}`);
    const value = inline ?? args[++index];
    if (!value) throw new Error(`${name} needs a value`);
    // A separate value that looks like an option is a missing value, not a folder or agent named like one.
    if (inline === undefined && value.startsWith("-")) throw new Error(`${name} needs a value (use ${name}=<value> for one that starts with "-")`);
    if (name === "--agent") {
      if (value === "all") agents = [...AGENTS];
      else if ((AGENTS as readonly string[]).includes(value)) agents = [...new Set([...(agents ?? []), value as InitAgent])];
      else throw new Error(`--agent must be claude, codex, cursor or all, not ${JSON.stringify(value)}`);
    } else if (name === "--scope") {
      if (value !== "user" && value !== "project") throw new Error("--scope must be user or project");
      scope = value;
    } else {
      if (root !== undefined) throw new Error("--root was given more than once");
      root = value;
    }
  }
  return { help: false, agents: agents ?? ["claude"], scope, root, force, dryRun };
}

/**
 * The skill bundled with this package: `skills/iterbar` next to `dist/` once packed (the build copies it there), or
 * the monorepo's `products/iterbar/skills/iterbar` when run from a checkout.
 */
export async function bundledSkill(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, "../skills/iterbar"), resolve(here, "../../skills/iterbar"), resolve(here, "../../../skills/iterbar")]) {
    try {
      if ((await lstat(join(candidate, "SKILL.md"))).isFile()) return candidate;
    } catch {
      // Not this one.
    }
  }
  throw new Error(`The iterbar skill is missing from this copy of ${CLI_PACKAGE}; reinstall the package.`);
}

/** Every file under `directory`, as sorted paths relative to it. */
async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) files.push(relative(directory, join(entry.parentPath, entry.name)));
  }
  return files.sort();
}

/** Whether two folders hold the same files with the same bytes. */
async function sameTree(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([listFiles(left), listFiles(right).catch(() => null)]);
  if (!b || a.join("\n") !== b.join("\n")) return false;
  for (const file of a) {
    const [x, y] = await Promise.all([readFile(join(left, file)), readFile(join(right, file))]);
    if (!x.equals(y)) return false;
  }
  return true;
}

/** Where `path` links to, or `null` when it is not a symbolic link. */
async function linkTarget(path: string): Promise<string | null> {
  try {
    return (await lstat(path)).isSymbolicLink() ? await readlink(path) : null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function skillDirectory(agent: InitAgent, options: InitOptions, root: string, env: Required<Pick<InitEnvironment, "home">> & InitEnvironment): string {
  if (agent === "codex") return join(env.codexHome ?? join(env.home, ".codex"), "skills", "iterbar");
  const base = options.scope === "project" ? root : env.home;
  return join(base, agent === "claude" ? ".claude" : ".cursor", "skills", "iterbar");
}

/**
 * The first linked folder between `base` and `path` (both absolute, `path` inside `base`), the final part excluded:
 * writing there would land wherever the link points. `null` when there is none.
 */
async function linkedParent(base: string, path: string): Promise<string | null> {
  const parts = relative(base, dirname(path)).split(sep).filter((part) => part && part !== ".");
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    if ((await linkTarget(current)) !== null) return current;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Writes `text` to `path` through a temporary file in the same folder and a rename, so a crash never truncates it. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.iterbar-${process.pid}-${Date.now()}.tmp`;
  // The new file keeps the old one's permissions (a config can hold credentials); a new one is private to the user.
  let mode = 0o600;
  try {
    mode = (await lstat(path)).mode & 0o777;
  } catch {
    // A new config.
  }
  try {
    await writeFile(temporary, text, { flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Adds the iterbar server to a JSON config's `mcpServers`, keeping every other entry. A config that is a link, or sits
 * in a linked folder, is never written (it may be shared, such as a dotfiles checkout): the entry is printed instead.
 */
async function registerJson(base: string, path: string, entry: object, options: InitOptions, say: (line: string) => void): Promise<void> {
  const manual = `{ "mcpServers": { "iterbar": ${JSON.stringify(entry)} } }`;
  const link = (await linkTarget(path)) !== null ? path : await linkedParent(base, path);
  if (link !== null) {
    say(`  MCP server: ${link} is a link, so init leaves it alone. Add this to ${path} yourself:\n    ${manual}`);
    return;
  }
  let config: Record<string, unknown> = {};
  if (await exists(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new Error(`${path} is not valid JSON; fix it or add the iterbar server by hand.`);
    }
    if (!isPlainObject(parsed) || (parsed.mcpServers !== undefined && !isPlainObject(parsed.mcpServers))) {
      throw new Error(`${path} is not an object with an "mcpServers" object; fix it or add the iterbar server by hand.`);
    }
    config = parsed;
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const current = servers.iterbar;
  if (JSON.stringify(current) === JSON.stringify(entry)) {
    say(`  MCP server: already in ${path}`);
    return;
  }
  if (current !== undefined && !options.force) {
    say(`  MCP server: ${path} already has a different iterbar entry; kept it (--force replaces it)`);
    return;
  }
  say(`  MCP server: ${options.dryRun ? "would add" : "added"} iterbar to ${path}`);
  if (options.dryRun) return;
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, `${JSON.stringify({ ...config, mcpServers: { ...servers, iterbar: entry } }, null, 2)}\n`);
}

/** `iterbar init`: installs the skill and registers the MCP server for each agent. Resolves with the exit code. */
export async function runInit(args: readonly string[], io: InitIo = process, environment: InitEnvironment = {}): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseInitArgs(args);
  } catch (error) {
    io.stderr.write(`iterbar init: ${(error as Error).message}\n\n${INIT_USAGE}`);
    return 2;
  }
  if (parsed.help) {
    io.stdout.write(INIT_USAGE);
    return 0;
  }
  // Normalized, so a trailing slash never makes a check follow a link: the same path is checked and written.
  const codexHome = environment.codexHome ?? process.env.CODEX_HOME;
  const env = { ...environment, home: resolve(environment.home ?? homedir()), codexHome: codexHome ? resolve(codexHome) : undefined };
  const root = resolve(env.cwd ?? process.cwd(), parsed.root ?? ".");
  const say = (line: string): void => {
    io.stdout.write(`${line}\n`);
  };
  try {
    // A --root that is itself a link is refused (name the folder it points to), like every other link init could write
    // through. Its ancestors are not checked: they are the user's own path to the project (/tmp is a link on macOS).
    const rootLink = await linkTarget(root);
    if (rootLink !== null) throw new Error(`${root} is a link to ${rootLink}; run init with --root set to the folder it points to.`);
    const source = env.skillSource ?? await bundledSkill();
    say(`Setting up Iterbar in ${root}${parsed.dryRun ? " (dry run: nothing is written)" : ""}`);
    for (const agent of parsed.agents) {
      say(`\n${{ claude: "Claude Code", codex: "Codex", cursor: "Cursor" }[agent]}`);
      const target = skillDirectory(agent, parsed, root, env);
      // Codex's home (CODEX_HOME or ~/.codex) is checked too: a link there would redirect the skill as well.
      const skillBase = agent === "codex" ? (env.codexHome ?? env.home) : parsed.scope === "project" ? root : env.home;
      const codexHomeLink = agent === "codex" && env.codexHome && (await linkTarget(env.codexHome)) !== null ? env.codexHome : null;
      const linkedFolder = codexHomeLink ?? await linkedParent(skillBase, target);
      const link = await linkTarget(target);
      if (linkedFolder !== null) {
        // A linked folder on the way would put the skill wherever it points: never written, even on --force.
        say(`  Skill: ${linkedFolder} is a link, so init leaves it alone. Copy the skill into ${target} yourself from ${source}`);
      } else if (link !== null && !parsed.force) {
        // A link (to a checkout, say) is the user's own setup: it is never written through, and replaced only on --force.
        say(`  Skill: ${target} links to ${link}; kept it (--force replaces the link with a copy)`);
      } else if (link === null && await sameTree(source, target)) {
        say(`  Skill: up to date in ${target}`);
      } else if (link === null && (await exists(target)) && !parsed.force) {
        say(`  Skill: ${target} already exists and differs; kept it (--force replaces it)`);
      } else {
        say(`  Skill: ${parsed.dryRun ? "would install" : "installed"} in ${target}`);
        if (!parsed.dryRun) {
          // Removing a link removes only the link; a replaced folder goes first, so no stale file stays behind.
          await rm(target, { recursive: true, force: true });
          await mkdir(dirname(target), { recursive: true });
          await cp(source, target, { recursive: true, dereference: true });
        }
      }
      if (agent === "claude") {
        await registerJson(root, join(root, ".mcp.json"), MCP_COMMAND, parsed, say);
      } else if (agent === "cursor") {
        await registerJson(root, join(root, ".cursor", "mcp.json"), { ...MCP_COMMAND, args: [...MCP_COMMAND.args, "--root", "${workspaceFolder}"] }, parsed, say);
      } else {
        say(`  MCP server: add to ${join(env.codexHome ?? join(env.home, ".codex"), "config.toml")}:`);
        say(`    [mcp_servers.iterbar]\n    command = "npx"\n    args = ["-y", "${CLI_PACKAGE}", "mcp", "--root", ${JSON.stringify(root)}]\n    tool_timeout_sec = 1900`);
      }
    }
    say("\nNext: start your dev server with the Iterbar plugin, open the page, and paste this into your agent:");
    say(`  ${INIT_PROMPT}`);
    if (parsed.agents.includes("claude")) say("Claude Code asks once to approve the project's iterbar server; accept it.");
    return 0;
  } catch (error) {
    io.stderr.write(`iterbar init: ${(error as Error).message}\n`);
    return 1;
  }
}
