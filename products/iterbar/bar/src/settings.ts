import type { DaemonStatus } from "iterbar";
import { h } from "./dom.js";
import type { BarTheme } from "./position.js";

/** What the dev server tells the bar about the Iterbar it runs (see `@iterbar/vite`'s client module). */
export interface DevServerAbout {
  readonly packages: readonly { readonly name: string; readonly version: string }[];
  /** The CLI the daemon runs from; `node <path>` runs its commands. */
  readonly cli: { readonly path: string; readonly version: string } | null;
}

/** A package's newest version on the npm registry; `latest` is `null` when it is not published. */
export interface PackageUpdate {
  readonly name: string;
  readonly installed: string;
  readonly latest: string | null;
  readonly error?: string;
}

/** The dev server's side of the bar, when the Iterbar Vite plugin mounted it. */
export interface DevServerLink {
  readonly about: DevServerAbout | null;
  /** Asks the dev server for the daemon again; it starts one when none runs. */
  reconnect(): Promise<{ daemonUrl: string | null; token: string | null; about?: DevServerAbout | null }>;
  /** Asks the npm registry, through the dev server, for each package's latest version. */
  checkUpdates(): Promise<{ packages: readonly PackageUpdate[] }>;
}

/** The settings the sheet changes, as the bar stores them. */
export interface SettingsValues {
  readonly x: number;
  readonly theme: BarTheme;
  readonly shortcuts: boolean;
  readonly screenshots: boolean;
  readonly pins: boolean;
}

export interface SettingsOptions {
  /** One setting changed. */
  readonly onChange: (change: Partial<SettingsValues>) => void;
  /** The daemon's process, start time and store; rejects when it can't be asked. */
  readonly daemonInfo: () => Promise<DaemonStatus>;
  readonly stopDaemon: () => Promise<void>;
  /** Starts the daemon through the dev server (also after a stop); resolves once the bar has it again. */
  readonly startDaemon: () => Promise<void>;
  readonly restartDaemon: () => Promise<void>;
  /** Deletes every item in the store; resolves with how many went. */
  readonly deleteAll: () => Promise<number>;
  readonly clearDrafts: () => void;
  readonly openSetup: () => void;
  /** Copies a command; resolves once it is on the clipboard. */
  readonly copy: (text: string) => Promise<void>;
}

/** What the bar knows when the sheet renders. */
export interface SettingsContext {
  readonly values: SettingsValues;
  readonly connected: boolean;
  readonly connectionLabel: string;
  readonly threadCount: number;
  readonly draftCount: number;
  readonly devServer: DevServerLink | null;
}

const POSITIONS: readonly { readonly label: string; readonly x: number }[] = [
  { label: "Left", x: 0 }, { label: "Centre", x: 0.5 }, { label: "Right", x: 1 },
];

const THEMES: readonly { readonly label: string; readonly value: BarTheme }[] = [
  { label: "System", value: "auto" }, { label: "Light", value: "light" }, { label: "Dark", value: "dark" },
];

function section(title: string, ...children: Node[]): HTMLElement {
  return h("section", { class: "settings-section" }, h("h3", { class: "section-title" }, title), ...children);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Iterbar's settings, in the right-hand sheet: the daemon (status, stop, start, restart) and the agent's MCP server,
 * updates, the toolbar (position, colours, shortcuts, screenshots, pins) and the project's data (clear drafts, delete
 * everything). Nothing runs until the user presses its button, and every destructive action asks first, saying what
 * it removes.
 */
export class SettingsPanel {
  readonly element: HTMLElement;
  readonly #options: SettingsOptions;
  readonly #daemon = h("div", { class: "settings-group", "data-role": "settings-daemon" });
  readonly #updates = h("div", { class: "settings-group", "data-role": "settings-updates" });
  readonly #toolbar = h("div", { class: "settings-group", "data-role": "settings-toolbar" });
  readonly #data = h("div", { class: "settings-group", "data-role": "settings-data" });
  /** How the last action went. */
  readonly #status = h("p", { class: "settings-status", role: "status", "data-role": "settings-message", hidden: true });
  #context: SettingsContext | null = null;
  #info: DaemonStatus | null = null;
  #infoError: string | null = null;
  #busy: string | null = null;
  #message: { text: string; error: boolean } | null = null;
  /** The confirmation open now, if any. */
  #confirming: "stop" | "drafts" | "data" | null = null;
  #updatesResult: readonly PackageUpdate[] | null = null;
  #updatesError: string | null = null;
  #checking = false;

  constructor(options: SettingsOptions) {
    this.#options = options;
    this.element = h("div", { class: "settings", "data-role": "settings" },
      this.#status,
      section("Daemon and MCP server", this.#daemon),
      section("Updates", this.#updates),
      section("Toolbar", this.#toolbar),
      section("Data", this.#data));
  }

  /** Renders with what the bar knows now; `refreshInfo` asks the daemon for its process and store again. */
  render(context: SettingsContext, refreshInfo = false): void {
    this.#context = context;
    if (refreshInfo) void this.#loadInfo();
    this.#renderDaemon();
    this.#renderUpdates();
    this.#renderToolbar();
    this.#renderData();
    this.#status.hidden = !this.#message;
    this.#status.textContent = this.#message?.text ?? "";
    this.#status.classList.toggle("composer-error", Boolean(this.#message?.error));
  }

  async #loadInfo(): Promise<void> {
    if (!this.#context?.connected) {
      this.#info = null;
      this.#infoError = null;
      return;
    }
    try {
      this.#info = await this.#options.daemonInfo();
      this.#infoError = null;
    } catch (error) {
      this.#info = null;
      this.#infoError = (error as Error).message;
    }
    this.#renderDaemon();
    this.#renderData();
  }

  /** Runs one of the sheet's actions, showing that it runs and then how it went. */
  async #run(name: string, action: () => Promise<string>): Promise<void> {
    this.#busy = name;
    this.#message = null;
    this.#confirming = null;
    this.#renderAll();
    try {
      this.#message = { text: await action(), error: false };
    } catch (error) {
      this.#message = { text: (error as Error).message, error: true };
    } finally {
      this.#busy = null;
      this.#renderAll();
      void this.#loadInfo();
    }
  }

  #renderAll(): void {
    if (this.#context) this.render(this.#context);
  }

  #button(label: string, role: string, onClick: () => void, extra: { danger?: boolean; primary?: boolean } = {}): HTMLButtonElement {
    const button = h("button", {
      type: "button", "data-role": role, class: extra.danger ? "danger" : extra.primary ? "primary" : "",
      disabled: this.#busy !== null,
    }, label);
    button.addEventListener("click", onClick);
    return button;
  }

  /** A confirmation: what will happen, and the button that does it next to Cancel (which takes focus). */
  #confirm(text: string, action: HTMLButtonElement): HTMLElement {
    const cancel = this.#button("Cancel", "settings-cancel", () => {
      this.#confirming = null;
      this.#renderAll();
    });
    queueMicrotask(() => {
      if (cancel.isConnected) cancel.focus();
    });
    return h("div", { class: "settings-confirm", role: "alertdialog", "aria-label": "Confirm" },
      h("p", {}, text), h("div", { class: "composer-actions" }, h("span", { class: "spacer" }), cancel, action));
  }

  #renderDaemon(): void {
    const context = this.#context;
    if (!context) return;
    const lines: Node[] = [h("p", { class: "settings-line" }, h("strong", {}, "Daemon: "), context.connectionLabel)];
    if (this.#info) {
      const started = new Date(this.#info.startedAt);
      lines.push(h("p", { class: "muted settings-line" }, `Process ${this.#info.pid}, running since ${started.toLocaleString()}.`));
    } else if (this.#infoError) {
      lines.push(h("p", { class: "muted settings-line" }, `Its details are unavailable: ${this.#infoError}`));
    }
    const dev = context.devServer;
    const actions = h("div", { class: "settings-actions" });
    if (context.connected) {
      if (dev) actions.append(this.#button(this.#busy === "restart" ? "Restarting…" : "Restart", "daemon-restart", () => void this.#run("restart", async () => {
        await this.#options.restartDaemon();
        return "The daemon restarted.";
      })));
      actions.append(this.#button("Stop…", "daemon-stop", () => {
        this.#confirming = "stop";
        this.#renderAll();
      }));
    } else if (dev) {
      actions.append(this.#button(this.#busy === "start" ? "Starting…" : "Start", "daemon-start", () => void this.#run("start", async () => {
        await this.#options.startDaemon();
        return "The daemon is running.";
      }), { primary: true }));
    }
    const children: Node[] = [...lines, actions];
    if (!dev) {
      children.push(h("p", { class: "muted settings-line" },
        "This page has no Iterbar dev-server plugin, so the bar can't start the daemon. Run iterbar dev, or restart your dev server."));
    }
    if (this.#confirming === "stop") {
      children.push(this.#confirm(
        "Stop the daemon? The bar and your agent's MCP server lose it until it starts again"
          + (dev ? " (Start here, or reload the page)" : " (restart your dev server or iterbar dev)")
          + ". Comments you write meanwhile stay as drafts. Nothing stored is removed.",
        this.#button("Stop the daemon", "daemon-stop-confirm", () => void this.#run("stop", async () => {
          await this.#options.stopDaemon();
          return "The daemon stopped.";
        }), { danger: true })));
    }
    children.push(h("p", { class: "muted settings-line" },
      "The MCP server runs inside your coding agent (iterbar mcp) and connects to this daemon on its own; restart it from your agent."));
    const setup = h("button", { type: "button", class: "link", "data-role": "settings-setup" }, "Set up your agent");
    setup.addEventListener("click", () => this.#options.openSetup());
    children.push(h("p", { class: "settings-line" }, setup));
    this.#daemon.replaceChildren(...children);
  }

  #renderUpdates(): void {
    const dev = this.#context?.devServer ?? null;
    const about = dev?.about ?? null;
    if (!dev || !about || about.packages.length === 0) {
      this.#updates.replaceChildren(h("p", { class: "muted settings-line" }, "The installed versions show when the Iterbar Vite plugin serves the page."));
      return;
    }
    const results = new Map((this.#updatesResult ?? []).map((each) => [each.name, each]));
    const rows = about.packages.map((pkg) => {
      const result = results.get(pkg.name);
      const latest = !result ? "" : result.error ? `couldn't check (${result.error})`
        : result.latest === null ? "not on npm yet" : result.latest === pkg.version ? "up to date" : `${result.latest} available`;
      return h("li", { class: "settings-package" }, h("code", {}, pkg.name), h("span", {}, pkg.version), h("span", { class: "muted" }, latest));
    });
    const check = this.#button(this.#checking ? "Checking…" : "Check for updates", "updates-check", () => void this.#checkUpdates());
    check.disabled = this.#checking;
    const command = `npm install -D ${about.packages.map((pkg) => `${pkg.name}@latest`).join(" ")}`;
    const pnpm = `pnpm add -D ${about.packages.map((pkg) => `${pkg.name}@latest`).join(" ")}`;
    const children: Node[] = [h("ul", { class: "settings-packages" }, ...rows), h("div", { class: "settings-actions" }, check)];
    if (this.#updatesError) children.push(h("p", { class: "composer-error" }, this.#updatesError));
    children.push(h("p", { class: "muted settings-line" }, "To update, run in the project's folder (then restart the dev server):"),
      this.#snippet(command, "updates-npm"), this.#snippet(pnpm, "updates-pnpm"));
    this.#updates.replaceChildren(...children);
  }

  async #checkUpdates(): Promise<void> {
    const dev = this.#context?.devServer;
    if (!dev) return;
    this.#checking = true;
    this.#updatesError = null;
    this.#renderUpdates();
    try {
      this.#updatesResult = (await dev.checkUpdates()).packages;
    } catch (error) {
      this.#updatesError = `The update check failed: ${(error as Error).message}`;
    } finally {
      this.#checking = false;
      this.#renderUpdates();
    }
  }

  #snippet(text: string, role: string): HTMLElement {
    const copy = h("button", { type: "button", class: "icon copy", "data-role": `${role}-copy` }, "Copy");
    copy.addEventListener("click", () => {
      this.#options.copy(text).then(() => {
        copy.textContent = "Copied";
        copy.toggleAttribute("data-copied", true);
        setTimeout(() => {
          copy.textContent = "Copy";
          copy.removeAttribute("data-copied");
        }, 1600);
      }, () => undefined);
    });
    return h("div", { class: "snippet", "data-role": role }, h("pre", { class: "snippet-text" }, text), copy);
  }

  #renderToolbar(): void {
    const context = this.#context;
    if (!context) return;
    const { values } = context;
    const choice = <T>(label: string, role: string, options: readonly { label: string; value: T }[], current: T, set: (value: T) => void) => {
      const group = h("div", { class: "segmented settings-choice", role: "radiogroup", "aria-label": label, "data-role": role });
      for (const option of options) {
        const button = h("button", {
          type: "button", class: "segment", role: "radio", "aria-checked": String(option.value === current), "data-value": String(option.value),
        }, option.label);
        button.addEventListener("click", () => set(option.value));
        group.append(button);
      }
      return h("div", { class: "settings-row" }, h("span", { class: "settings-label" }, label), group);
    };
    const toggle = (label: string, detail: string, role: string, checked: boolean, set: (value: boolean) => void) => {
      const input = h("input", { type: "checkbox", "data-role": role });
      input.checked = checked;
      input.addEventListener("change", () => set(input.checked));
      return h("label", { class: "settings-toggle" }, input, h("span", {}, h("span", { class: "settings-label" }, label), h("span", { class: "muted settings-detail" }, detail)));
    };
    const nearest = POSITIONS.reduce((best, each) => (Math.abs(each.x - values.x) < Math.abs(best.x - values.x) ? each : best));
    this.#toolbar.replaceChildren(
      choice("Position", "settings-position", POSITIONS.map((each) => ({ label: each.label, value: each.x })), Math.abs(nearest.x - values.x) < 0.01 ? nearest.x : -1,
        (x) => this.#options.onChange({ x })),
      choice("Colours", "settings-theme", THEMES, values.theme, (theme) => this.#options.onChange({ theme })),
      toggle("Keyboard shortcuts", "C for comment mode, Ctrl/Cmd+. to show or hide the toolbar.", "settings-shortcuts", values.shortcuts,
        (shortcuts) => this.#options.onChange({ shortcuts })),
      toggle("Screenshots", "Each comment takes a screenshot of its element for your agent.", "settings-screenshots", values.screenshots,
        (screenshots) => this.#options.onChange({ screenshots })),
      toggle("Pins on the page", "Pins on the elements of open threads and drafts.", "settings-pins", values.pins,
        (pins) => this.#options.onChange({ pins })),
    );
  }

  #renderData(): void {
    const context = this.#context;
    if (!context) return;
    const children: Node[] = [];
    const drafts = context.draftCount;
    children.push(h("div", { class: "settings-actions" },
      this.#button("Clear drafts…", "drafts-clear", () => {
        this.#confirming = "drafts";
        this.#renderAll();
      }),
      this.#button("Delete all Iterbar data…", "data-delete", () => {
        this.#confirming = "data";
        this.#renderAll();
      }, { danger: true })));
    (children[0] as HTMLElement).querySelector<HTMLButtonElement>("[data-role=drafts-clear]")!.disabled = this.#busy !== null || drafts === 0;
    (children[0] as HTMLElement).querySelector<HTMLButtonElement>("[data-role=data-delete]")!.disabled = this.#busy !== null || !context.connected;
    if (this.#confirming === "drafts") {
      children.push(this.#confirm(`Remove ${plural(drafts, "draft")} from this tab? They were never sent, so they can't be brought back.`,
        this.#button("Clear drafts", "drafts-clear-confirm", () => {
          this.#confirming = null;
          this.#options.clearDrafts();
          this.#message = { text: `Cleared ${plural(drafts, "draft")}.`, error: false };
          this.#renderAll();
        }, { danger: true })));
    }
    if (this.#confirming === "data") {
      const where = this.#info ? this.#info.feedbackDirectory : "the project's .iterbar/feedback folder";
      children.push(this.#confirm(
        `Delete all of this project's Iterbar data? This removes every comment and variant choice (${plural(context.threadCount, "thread")} the bar knows of), `
          + `with their replies, screenshots and evidence: everything in ${where}. Your agent can't read them afterwards, and they can't be brought back. `
          + "It leaves your code, your agent's setup (skill and MCP config), the drafts in this tab and these settings alone.",
        this.#button("Delete everything", "data-delete-confirm", () => void this.#run("data", async () => {
          const deleted = await this.#options.deleteAll();
          return `Deleted ${plural(deleted, "item")}.`;
        }), { danger: true })));
    }
    this.#data.replaceChildren(...children);
  }
}
