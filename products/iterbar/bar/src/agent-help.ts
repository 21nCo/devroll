import { h } from "./dom.js";

/** The agents the help covers; "other" is any MCP client. */
export type AgentName = "claude" | "codex" | "cursor" | "other";

export const AGENTS: readonly AgentName[] = ["claude", "codex", "cursor", "other"];

const AGENT_LABELS: Readonly<Record<AgentName, string>> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", other: "Other" };

/** What the user pastes into their agent once its MCP server is registered. */
export const AGENT_PROMPT =
  "Use the iterbar MCP tools to read my open Iterbar feedback (with get_batch for comments I sent together), make the changes, and reply on each item when done.";

interface Snippet {
  /** What the snippet is: a command to run, or a file and what to put in it. */
  readonly caption: string;
  readonly text: string;
}

interface AgentSteps {
  /** The one command that installs the skill and registers the MCP server. */
  readonly init: Snippet;
  /** The same by hand: registering the server, and installing the skill. */
  readonly connect: readonly Snippet[];
  readonly skill: readonly Snippet[];
}

/** A path as a shell word, quoted when it needs to be. */
function shellWord(path: string): string {
  return /^[\w@%+=:,./-]+$/u.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

/** The skill as the installed `iterbar` package carries it, relative to the project root. */
const PACKAGED_SKILL = "node_modules/iterbar/skills/iterbar";

/**
 * The setup steps for each agent, as products/iterbar/skills/iterbar/references/setup.md gives them: `iterbar init`
 * (from the `iterbar` package, which carries the skill) does both in one go; the manual steps register the MCP
 * server and copy the skill out of the installed package. `root` is the project's absolute path when the bar knows
 * it; otherwise the snippets keep the references' placeholders.
 */
export function agentSteps(agent: AgentName, root: string | null): AgentSteps {
  const where = root ? `cd ${shellWord(root)}\n` : "";
  const init = (name: string): Snippet => ({
    caption: "Run in the project's folder. It installs the iterbar skill and registers the MCP server:",
    text: `${where}npx iterbar init --agent ${name}`,
  });
  const copySkill = (folder: string): Snippet => ({
    caption: "Copy the skill out of the installed package, in the project's folder:",
    text: `mkdir -p ${folder}\ncp -R ${PACKAGED_SKILL} ${folder}/`,
  });
  switch (agent) {
    case "claude":
      return {
        init: init("claude"),
        connect: [{
          caption: "Register the server, in the project's folder:",
          text: `claude mcp add iterbar -- npx -y iterbar mcp --root ${root ? shellWord(root) : '"$PWD"'}`,
        }],
        skill: [copySkill('"$HOME/.claude/skills"')],
      };
    case "codex":
      return {
        init: init("codex"),
        connect: [{
          caption: "Add to ~/.codex/config.toml:",
          text: `[mcp_servers.iterbar]\ncommand = "npx"\nargs = ["-y", "iterbar", "mcp", "--root", ${JSON.stringify(root ?? "/absolute/path/to/project")}]\n`
            + "# Long enough for the longest wait_for_feedback you use (at most 1,800 seconds).\ntool_timeout_sec = 1900",
        }],
        skill: [copySkill('"${CODEX_HOME:-$HOME/.codex}/skills"')],
      };
    case "cursor":
      return {
        init: init("cursor"),
        connect: [{
          caption: "Add to the project's .cursor/mcp.json:",
          // The project's own path when the bar knows it, so the server serves the daemon the bar talks to even when
          // Cursor's workspace folder is another one; otherwise the reference's ${workspaceFolder}.
          text: `{\n  "mcpServers": {\n    "iterbar": { "command": "npx", "args": ["-y", "iterbar", "mcp", "--root", ${JSON.stringify(root ?? "${workspaceFolder}")}] }\n  }\n}`,
        }],
        skill: [copySkill('"$HOME/.cursor/skills"')],
      };
    case "other":
      return {
        init: {
          caption: "Your agent needs an MCP server; the skill is optional. Register a stdio MCP server named iterbar that runs:",
          text: `npx -y iterbar mcp --root ${root ? shellWord(root) : "/absolute/path/to/project"}`,
        },
        connect: [],
        skill: [{
          caption: "If your agent reads skills, copy this folder (from the installed package) into its skills folder:",
          text: PACKAGED_SKILL,
        }],
      };
  }
}

export interface AgentHelpOptions {
  /** A copy button was pressed; resolves once the text is on the clipboard, rejects when it could not be copied. */
  readonly copy: (text: string) => Promise<void>;
  /** The chosen agent changed, to be remembered. */
  readonly onAgent: (agent: AgentName) => void;
}

/** How long a copy button says "Copied". */
const COPIED_MS = 1600;

/**
 * "Use with your agent": how to get the bar's comments into a coding agent. Tabs for Claude Code, Codex, Cursor and
 * other MCP clients, each with the one-time `iterbar init` command (skill and MCP server), a prompt to paste, and the
 * same setup by hand, every snippet with a copy button.
 */
export class AgentHelp {
  readonly element: HTMLElement;
  readonly #options: AgentHelpOptions;
  readonly #tabs = h("div", { class: "agent-tabs", role: "tablist", "aria-label": "Your agent" });
  readonly #body = h("div", { class: "agent-body", role: "tabpanel", id: "iterbar-agent-panel", "data-role": "agent-steps" });
  readonly #buttons = new Map<AgentName, HTMLButtonElement>();
  #agent: AgentName = "claude";
  #root: string | null = null;

  constructor(options: AgentHelpOptions) {
    this.#options = options;
    for (const agent of AGENTS) {
      const button = h("button", {
        type: "button", class: "chip", role: "tab", id: `iterbar-agent-${agent}`, "data-agent": agent,
        "aria-controls": "iterbar-agent-panel",
      }, AGENT_LABELS[agent]);
      button.addEventListener("click", () => this.#choose(agent, false));
      button.addEventListener("keydown", (event) => this.#onTabKey(event, agent));
      this.#buttons.set(agent, button);
      this.#tabs.append(button);
    }
    this.element = h("section", { class: "section agent-help", "data-section": "agent", "aria-labelledby": "iterbar-agent-title" },
      h("h2", { class: "sr-only", id: "iterbar-agent-title" }, "Use with your agent"),
      h("p", { class: "muted agent-intro" },
        "Comments you send are saved for your coding agent. Set it up once, then paste the prompt."),
      this.#tabs, this.#body);
    this.#render();
  }

  get agent(): AgentName {
    return this.#agent;
  }

  set agent(value: AgentName) {
    if (!AGENTS.includes(value) || value === this.#agent) return;
    this.#agent = value;
    this.#render();
  }

  /** The project's absolute path, filled into the setup snippets; `null` keeps their placeholders. */
  set root(value: string | null) {
    if (value === this.#root) return;
    this.#root = value;
    this.#render();
  }

  #choose(agent: AgentName, focus: boolean): void {
    this.agent = agent;
    this.#options.onAgent(agent);
    if (focus) this.#buttons.get(agent)?.focus();
  }

  #onTabKey(event: KeyboardEvent, agent: AgentName): void {
    const index = AGENTS.indexOf(agent);
    const next = event.key === "ArrowRight" ? AGENTS[(index + 1) % AGENTS.length]
      : event.key === "ArrowLeft" ? AGENTS[(index + AGENTS.length - 1) % AGENTS.length]
        : event.key === "Home" ? AGENTS[0] : event.key === "End" ? AGENTS[AGENTS.length - 1] : undefined;
    if (!next) return;
    event.preventDefault();
    this.#choose(next, true);
  }

  #render(): void {
    for (const [agent, button] of this.#buttons) {
      const selected = agent === this.#agent;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    this.#body.setAttribute("aria-labelledby", `iterbar-agent-${this.#agent}`);
    const steps = agentSteps(this.#agent, this.#root);
    const manual = [...steps.connect, ...steps.skill];
    this.#body.replaceChildren(
      this.#step("1", "Set up (one-time)", [steps.init], "init"),
      this.#step("2", "Prompt to paste", [{ caption: "Paste into your agent:", text: AGENT_PROMPT }], "prompt"),
      ...(this.#agent === "other" ? [] : [h("details", { class: "agent-manual", "data-role": "agent-manual" },
        h("summary", {}, "Set it up by hand instead"),
        ...manual.flatMap((snippet, index) => [
          h("p", { class: "muted agent-caption" }, snippet.caption),
          this.#snippet(snippet.text, index < steps.connect.length ? "connect" : "skill", snippet.caption),
        ]))]),
    );
  }

  #step(number: string, title: string, snippets: readonly Snippet[], role: string): HTMLElement {
    return h("div", { class: "agent-step", "data-step": role },
      h("h3", { class: "agent-step-title" }, h("span", { class: "agent-step-number", "aria-hidden": "true" }, number), title),
      ...snippets.flatMap((snippet) => [
        h("p", { class: "muted agent-caption" }, snippet.caption),
        this.#snippet(snippet.text, role, title),
      ]));
  }

  #snippet(text: string, role: string, title: string): HTMLElement {
    const copy = h("button", {
      type: "button", class: "icon copy", "data-role": `copy-${role}`, "aria-label": `Copy: ${title}`,
      "data-tip": "Copy", "data-tip-detail": role === "prompt" ? "Copies the prompt to paste into your agent" : null,
    }, "Copy");
    let timer: ReturnType<typeof setTimeout> | null = null;
    copy.addEventListener("click", () => {
      this.#options.copy(text).then(() => {
        copy.textContent = "Copied";
        copy.dataset.copied = "";
        copy.dataset.tip = "Copied";
        copy.setAttribute("aria-label", "Copied");
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          copy.textContent = "Copy";
          delete copy.dataset.copied;
          copy.dataset.tip = "Copy";
          copy.setAttribute("aria-label", `Copy: ${title}`);
        }, COPIED_MS);
      }, () => {
        copy.textContent = "Select and copy";
        copy.dataset.tip = "The browser refused the clipboard; select the text and copy it";
      });
    });
    return h("div", { class: "snippet", "data-kind": role }, h("pre", { class: "snippet-text", tabindex: "0" }, text), copy);
  }
}
