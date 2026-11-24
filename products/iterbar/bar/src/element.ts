import { SCHEMA_VERSION, type ActiveVariant, type FeedbackDraft, type FeedbackStatus, type FeedbackTarget, type SlotState } from "iterbar";
import { Composer } from "./composer.js";
import { DaemonConnection, DaemonRequestError, parseDaemonConfig, type ConnectionStatus } from "./connection.js";
import { h, isRendered } from "./dom.js";
import { AgentHelp } from "./agent-help.js";
import { DraftTray, type DraftView } from "./drafts.js";
import { registerBarFonts } from "./fonts.js";
import { icon, logoMark } from "./icons.js";
import {
  anchorPopover,
  BAR_MARGIN_PX,
  barStateStorageKey,
  describePosition,
  formatBarState,
  leftForPosition,
  parseBarState,
  positionForKey,
  positionForLeft,
  toolbarLeft,
  type BarState,
  type PanelName,
} from "./position.js";
import { reportPageUrl, SlotsPanel } from "./slots.js";
import { applyBarStyles } from "./theme.js";
import { ElementPicker } from "./pick/picker.js";
import { captureScreenshot, RenderSlot, type ScreenshotResult } from "./pick/screenshot.js";
import { describeTarget, labelElement, readActiveVariants, type TargetLabel } from "./pick/target.js";
import { PinLayer } from "./pins.js";
import { SettingsPanel, type DevServerLink } from "./settings.js";
import { ThreadsPanel } from "./threads.js";

/** The bar's tag name. */
export const BAR_TAG = "iterbar-bar";

/** Dispatched on the bar (bubbling, composed) when comment mode turns on or off; `detail.active` is the new state. */
export const COMMENT_MODE_EVENT = "iterbar-comment-mode";

export interface CommentModeEventDetail {
  readonly active: boolean;
}

/** Most comments in one batch; the protocol numbers them 0 to 999. */
const MAX_BATCH = 1000;

/** Most drafts the tray holds at once. */
const MAX_DRAFTS = 100;

/** Delay that coalesces bursts of registry changes into one slot report. */
const REPORT_DELAY_MS = 150;

/** How often the bar checks for a changed page URL where the Navigation API is unavailable. */
const URL_POLL_MS = 1000;

/** The Navigation API, where the browser has it; it reports `pushState`, `replaceState` and traversals. */
interface NavigationTarget {
  addEventListener(type: "currententrychange", listener: () => void): void;
  removeEventListener(type: "currententrychange", listener: () => void): void;
}

const STATUS_TEXT: Readonly<Record<ConnectionStatus["kind"], string>> = {
  unconfigured: "Offline",
  invalid: "Offline",
  connecting: "Connecting…",
  connected: "Connected",
  retrying: "Reconnecting…",
  unauthorized: "Token rejected",
};

/**
 * What each connection state means, for the status's tooltip. "Connected" is the bar's link to the project's Iterbar
 * daemon (the one the dev server starts or finds); agents reach the same daemon on their own, through `iterbar mcp`.
 */
const STATUS_DETAIL: Readonly<Record<ConnectionStatus["kind"], string>> = {
  unconfigured: "Offline: comments stay as drafts. The page has no Iterbar daemon; start the dev server with the Iterbar plugin.",
  invalid: "Offline: comments stay as drafts. The bar was given a daemon address it cannot use.",
  connecting: "Connecting to the project's Iterbar daemon…",
  connected: "Connected to Iterbar: comments are saved for your coding agent.",
  retrying: "Reconnecting to the Iterbar daemon. Comments stay as drafts until it is back.",
  unauthorized: "The Iterbar daemon refused the bar's token. Reload the page.",
};

const PANEL_TITLES: Readonly<Record<PanelName, string>> = {
  inbox: "Inbox", drafts: "Drafts", variants: "Variants", settings: "Iterbar settings", agent: "Set up your agent",
};

/** The Variants popover's smallest width; the toolbar widens to it while the popover is open. */
const VARIANTS_MIN_WIDTH_PX = 340;

/** Hovering a control shows its tooltip after this delay; keyboard focus shows it at once. */
const TOOLTIP_DELAY_MS = 400;

/** The platform's name for the Ctrl or Cmd modifier, for tooltips. */
function modKey(): string {
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad/iu.test(platform) ? "⌘" : "Ctrl";
}

/** Gives a control its tooltip: a short label, an optional shortcut and an optional line that explains it. */
function tip(element: HTMLElement, label: string, keys?: string | null, detail?: string | null): void {
  element.dataset.tip = label;
  if (keys) element.dataset.tipKeys = keys;
  else delete element.dataset.tipKeys;
  if (detail) element.dataset.tipDetail = detail;
  else delete element.dataset.tipDetail;
}

/** Ctrl+. or Cmd+. toggles the full toolbar; Alt+Shift+I, the earlier shortcut, still does. */
function isToggleShortcut(event: KeyboardEvent): boolean {
  if (event.key === "." && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) return true;
  // `code`, not `key`: with Alt held, macOS turns the I key into another character.
  return event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "KeyI";
}

/** The built-in elements that may host a shadow root (`attachShadow`). */
const SHADOW_HOSTS = new Set([
  "article", "aside", "blockquote", "body", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "main", "nav",
  "p", "section", "span",
]);

/**
 * Whether a key typed at `target` may be text entry, which shortcuts must leave alone. A custom element whose shadow
 * root is closed hides what has focus inside it, so it counts as text entry too.
 */
function isTextEntry(target: EventTarget | undefined): boolean {
  if (!(target instanceof Element)) return false;
  // Focus inside a closed shadow root shows as its host, a custom element or a built-in one such as a <div>. So a
  // focused custom element with no readable shadow root may hold a field, tabindex or not, and so may a built-in
  // element that can host a shadow root and has no tabindex. Other elements (a dialog, a list item, media) cannot host
  // one, so their focus is their own. A shortcut never takes a keystroke that might be typing; the toolbar's buttons
  // still work.
  if (target.localName !== BAR_TAG && target.shadowRoot === null && target.matches(":focus")) {
    if (target.localName.includes("-")) return true;
    // Only these built-in elements can host a shadow root. One focused without a tabindex may hold focus through its
    // shadow tree. (A scroll container the keyboard focused to scroll it looks the same; it gives up the shortcuts.)
    if (SHADOW_HOSTS.has(target.localName) && !target.hasAttribute("tabindex")) return true;
  }
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target.localName === "textarea" || target.localName === "select") return true;
  if (target.localName !== "input") return false;
  return !["button", "checkbox", "radio", "range", "color", "file", "image", "reset", "submit"].includes((target as HTMLInputElement).type);
}

/** Whether a key typed at one of the bar's own elements is text entry, which must never reach the page's shortcuts. */
function isOwnTextEntry(target: EventTarget | undefined): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target.localName === "textarea" || target.localName === "select") return true;
  if (target.localName !== "input") return false;
  return !["button", "checkbox", "radio", "range", "color", "file", "image", "reset", "submit"].includes((target as HTMLInputElement).type);
}

/** Pointer travel, in CSS pixels, after which a press on the logo moves the toolbar instead of clicking it. */
const DRAG_THRESHOLD_PX = 4;

function readStoredState(project: string | null): BarState {
  try {
    // A project with nothing stored yet starts from the origin's state, which a bar without a project kept.
    const stored = localStorage.getItem(barStateStorageKey(project))
      ?? (project ? localStorage.getItem(barStateStorageKey(null)) : null);
    return parseBarState(stored);
  } catch {
    return parseBarState(null);
  }
}

/**
 * Puts `text` on the clipboard: the Clipboard API, or, where it is missing (a page that is not a secure context), a
 * selected text area and the copy command. That text area lives in `container`, inside the bar's shadow root, so page
 * styles and focus handling never see it, and focus goes back to where it was in `root`.
 */
async function copyText(text: string, root: ShadowRoot, container: Element): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Falls back below.
    }
  }
  const focused = root.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.tabIndex = -1;
  area.className = "copy-buffer";
  container.append(area);
  let copied: boolean;
  try {
    area.select();
    copied = document.execCommand("copy");
  } finally {
    area.remove();
    focused?.focus();
  }
  if (!copied) throw new Error("The browser refused to copy");
}

/** A lowercase id that is unique enough for a page's batches and drafts. */
function localId(prefix: string): string {
  // getRandomValues works on plain http origins too, where randomUUID is missing.
  const random = [...crypto.getRandomValues(new Uint8Array(6))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

// Lets the module load where there is no DOM (a server render importing it by accident); defining the element
// still needs a browser.
const ElementBase: typeof HTMLElement = (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement
  ?? (class {} as unknown as typeof HTMLElement);

/** A picked element, described when it was picked so the comment matches what the user saw. */
interface Pick {
  readonly element: Element;
  readonly target: FeedbackTarget | null;
  readonly label: TargetLabel;
  /** The page URL as slot reports file it, or `null` for a page the contract cannot name (such as `file:`). */
  readonly pageUrl: string | null;
  readonly activeVariants: readonly ActiveVariant[];
  /** Started at the pick, so it shows what was picked; it never rejects. */
  readonly screenshot: Promise<ScreenshotResult>;
  /** Aborted when the pick is replaced, cancelled or left: a screenshot still being taken for it stops. */
  readonly withdraw: AbortController;
}

/** A comment in the draft tray, kept in the page until Send all. */
interface Draft {
  readonly id: string;
  readonly pick: Pick;
  text: string;
  state: DraftView["state"];
  error: string | null;
  /** The batch a Send all first tried it in, and its place there; kept while it is not sent, so a retry stays put. */
  batchId: string | null;
  batchIndex: number | null;
  /** A send of it failed in a way that may have stored it anyway, so it may already count toward its batch. */
  mayBeStored: boolean;
}

/**
 * `<iterbar-bar>`: the Iterbar dev bar, a toolbar docked at the bottom of the page. Give it the daemon's URL and token
 * through the `daemonUrl` and `token` properties (or the `daemon-url` and `token` attributes); without them it still
 * switches slots, but shows no feedback. Everything it renders lives in its shadow root.
 *
 * Collapsed it shows only the Iterbar logo; clicking the logo (or Ctrl/Cmd+.) expands it, and dragging the logo moves
 * it along the bottom edge. C enters comment mode. The inbox, draft tray and variants open as a panel above it.
 */
export class IterbarBarElement extends ElementBase {
  static get observedAttributes(): string[] {
    return ["daemon-url", "token", "project"];
  }

  readonly #root: ShadowRoot;
  readonly #dock: HTMLDivElement;
  readonly #panel: HTMLDivElement;
  readonly #panelTitle = h("h2", { class: "panel-title", id: "iterbar-panel-title" });
  readonly #panelClose = h("button", { type: "button", class: "icon", "data-role": "panel-close", "aria-label": "Close panel", title: "Close (Esc)" }, icon("close"));
  /** The connection's label, at the top of the help sheet. */
  readonly #status = h("span", { class: "status-label", role: "status", "data-role": "status" });
  /** The connection's colour, next to its label. */
  readonly #statusDot = h("span", { class: "status-dot", "aria-hidden": "true", "data-role": "status-dot" });
  /** What the connection state means. */
  readonly #statusExplain = h("p", { class: "muted connection-explain", "data-role": "status-explain" });
  /** The connection, at the top of the help sheet: its dot, label and what they mean, and any detail. */
  readonly #connectionBox = h("div", { class: "connection", "data-role": "connection" },
    h("div", { class: "connection-head" }, this.#statusDot, this.#status), this.#statusExplain);
  /** Iterbar's settings, just before the help button. */
  readonly #settingsButton = h("button", {
    type: "button", class: "tool help", "data-role": "settings-toggle", "aria-expanded": "false", "aria-controls": "iterbar-panel",
    "aria-label": "Settings",
  }, icon("settings"));
  /** The help button at the toolbar's end: the setup sheet, with the connection at its top. */
  readonly #helpButton = h("button", {
    type: "button", class: "tool help", "data-role": "help-toggle", "aria-expanded": "false", "aria-controls": "iterbar-panel",
  }, icon("help"));
  /**
   * The Iterbar logo: the whole toolbar while it is collapsed. Clicking it (Enter, Space) expands or collapses the
   * toolbar; dragging it (or the arrow keys, Home and End on it) moves the toolbar along the bottom edge.
   */
  readonly #logo = h("button", {
    type: "button", class: "logo", "data-role": "logo", "aria-controls": "iterbar-toolbar",
    "aria-keyshortcuts": "Control+. Meta+. ArrowLeft ArrowRight Home End",
  }, logoMark());
  readonly #tooltip = h("div", { class: "tooltip", role: "tooltip", id: "iterbar-tooltip", "data-role": "tooltip", hidden: true });
  #tooltipFor: HTMLElement | null = null;
  #tooltipTimer: ReturnType<typeof setTimeout> | null = null;
  /** A press on the logo: a drag once it travels past {@link DRAG_THRESHOLD_PX}, otherwise a click. */
  #drag: { pointerId: number; startX: number; startLeft: number; logoWidth: number; moved: boolean } | null = null;
  /** A drag just ended on the logo: the click its release makes must not expand or collapse the toolbar. */
  #swallowLogoClick = false;
  #project: string | null = null;
  #heightObserver: ResizeObserver | null = null;
  readonly #detail = h("p", { class: "detail", "data-role": "status-detail", hidden: true });
  readonly #announcer = h("div", { class: "sr-only", "aria-live": "polite", "data-role": "announce" });
  readonly #comment = h("button", {
    type: "button", class: "tool", "data-role": "comment", "aria-pressed": "false", "aria-label": "Comment", "aria-keyshortcuts": "C",
  }, icon("comment"));
  /** The inbox and the draft tray share one button and one sheet, switched by the tabs at the sheet's top. */
  readonly #inboxButton = h("button", {
    type: "button", class: "tool", "data-role": "inbox-toggle", "aria-expanded": "false", "aria-controls": "iterbar-panel",
    "aria-label": "Inbox",
  }, icon("inbox"), h("span", { class: "tool-label", "aria-hidden": "true" }, "Inbox"));
  readonly #openCount = h("span", { class: "count", "data-role": "open-count", hidden: true });
  /** Drafts not sent yet, next to the open count, dashed like a draft's pin. */
  readonly #draftCount = h("span", { class: "count draft-count", "data-role": "draft-count", hidden: true });
  readonly #inboxTabCount = h("span", { class: "tab-count", "data-role": "inbox-tab-count" });
  readonly #draftsTabCount = h("span", { class: "tab-count", "data-role": "drafts-tab-count" });
  readonly #inboxTab = h("button", {
    type: "button", class: "segment", role: "tab", "data-role": "inbox-tab", "aria-selected": "false", "aria-controls": "iterbar-panel-body",
  }, "Inbox", this.#inboxTabCount);
  readonly #draftsTab = h("button", {
    type: "button", class: "segment", role: "tab", "data-role": "drafts-tab", "aria-selected": "false", "aria-controls": "iterbar-panel-body",
  }, "Drafts", this.#draftsTabCount);
  /** Inbox | Drafts, at the top of their shared sheet. */
  readonly #tabs = h("div", { class: "segmented", role: "tablist", "aria-label": "Inbox or drafts", "data-role": "inbox-tabs" },
    this.#inboxTab, this.#draftsTab);
  readonly #variantsButton = h("button", {
    type: "button", class: "tool", "data-role": "variants-toggle", "aria-expanded": "false", "aria-controls": "iterbar-panel",
    "aria-label": "Variants",
  }, icon("layers"), h("span", { class: "tool-label", "aria-hidden": "true" }, "Variants"));
  readonly #slotCount = h("span", { class: "count", "data-role": "slot-count", hidden: true });
  /** Inherits the page's effective `zoom`, which the bar cancels; see {@link #fitZoom}. */
  readonly #zoomProbe = h("span", { class: "zoom-probe", "aria-hidden": "true" });
  #zoomObserver: ResizeObserver | null = null;
  readonly #slots: SlotsPanel;
  readonly #pins: PinLayer;
  readonly #threads: ThreadsPanel;
  readonly #tray: DraftTray;
  readonly #agentHelp: AgentHelp;
  readonly #settings: SettingsPanel;
  /** The dev server that mounted the bar (the Iterbar Vite plugin), when one did. */
  #devServer: DevServerLink | null = null;
  #connectionKind: ConnectionStatus["kind"] = "unconfigured";
  readonly #composer = new Composer({
    onSend: (text) => void this.#send(text),
    onDraft: (text) => this.#addDraft(text),
    onCancel: () => this.#cancelPick(),
  });
  readonly #picker: ElementPicker;
  /** Lets one of this bar's screenshot captures render at a time. */
  readonly #renderSlot = new RenderSlot();
  #pick: Pick | null = null;
  /** The pick whose comment is being sent; another element cannot be picked meanwhile. */
  #sendingPick: Pick | null = null;
  /**
   * The pick whose comment has been posted to the daemon and not yet answered. It can no longer be withdrawn, so
   * Cancel is disabled and leaving comment mode keeps the composer open, saying "Sending…", until the answer.
   */
  #postingPick: Pick | null = null;
  #drafts: Draft[] = [];
  /**
   * How many comments each batch not yet fully sent holds: its size as last posted. A retry keeps the indexes it
   * gave and numbers drafts new to the batch after them.
   */
  readonly #batches = new Map<string, { next: number; size: number }>();
  #sendingBatch = false;
  /** The daemon (origin and token) the tray's batches were sent to. */
  #batchStore: string | null = null;
  #batchError: string | null = null;
  #daemonUrl: string | null = null;
  #token: string | null = null;
  #connection: DaemonConnection | null = null;
  /** The daemon URL and token `#connection` was opened with. */
  #connectionKey: string | null = null;
  #reconnectQueued = false;
  #state: BarState = parseBarState(null);
  /** An `expanded` assigned while disconnected, applied over the stored state on the next connection. */
  #pendingExpanded: boolean | undefined;
  #commentMode = false;
  /** The page root's inline `cursor` before comment mode set the crosshair, and whether it had a `style` attribute. */
  #savedCursor: { value: string; priority: string; hadStyle: boolean } | null = null;
  #slotsForReport: readonly SlotState[] | null = null;
  #reportTimer: ReturnType<typeof setTimeout> | null = null;
  /** The page URL of the last slot report, so a single-page navigation that keeps the slots is reported too. */
  #reportedUrl: string | null = null;
  #urlPoll: ReturnType<typeof setInterval> | null = null;
  #composerFrame: number | null = null;
  #composerObserver: ResizeObserver | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });
    applyBarStyles(this.#root);
    registerBarFonts();
    this.#slots = new SlotsPanel({
      onSlots: (slots) => this.#onSlots(slots),
      listPages: () => (this.#connection ? this.#connection.listSlots() : Promise.resolve(null)),
    });
    this.#threads = new ThreadsPanel({
      onChange: () => {
        this.#renderCounts();
        this.#pins?.update(this.#threads.threads);
      },
      onFilter: (filter) => this.#saveState({ ...this.#state, filter }),
      onStatus: (ids, status) => this.#setStatuses(ids, status),
      onDelete: (ids) => this.#deleteThreads(ids),
      announce: (text) => this.#announce(text),
      onNeedListing: () => this.#connection?.refresh(),
    });
    this.#tray = new DraftTray({
      onSendAll: () => void this.#sendAll(),
      onRemove: (id) => this.#removeDraft(id),
      onEdit: (id, text) => this.#editDraft(id, text),
      onHighlight: (id) => this.#picker.mark(this.#drafts.find((draft) => draft.id === id)?.pick.element ?? null),
      onAgentHelp: () => this.#openPanel("agent", true),
    });
    this.#agentHelp = new AgentHelp({
      copy: (text) => copyText(text, this.#root, this.#panel),
      onAgent: (agent) => this.#saveState({ ...this.#state, agent }),
    });
    this.#settings = new SettingsPanel({
      onChange: (change) => this.#saveState({ ...this.#state, ...change }),
      daemonInfo: () => this.#requireConnection().info(),
      stopDaemon: () => this.#stopDaemon(),
      startDaemon: () => this.#startDaemon(),
      restartDaemon: async () => {
        // The dev server and project the restart began with: set up again for another one meanwhile, it stops there.
        const dev = this.#devServer;
        const project = this.#project;
        await this.#stopDaemon();
        if (this.#devServer !== dev || this.#project !== project) throw new Error("The bar was set up again meanwhile; nothing was started.");
        await this.#startDaemon();
      },
      deleteAll: () => this.#requireConnection().deleteAll(),
      clearDrafts: () => {
        if (this.#sendingBatch) return 0;
        const before = this.#drafts.length;
        for (const draft of [...this.#drafts]) this.#removeDraft(draft.id);
        return before - this.#drafts.length;
      },
      openSetup: () => this.#openPanel("agent", true),
      copy: (text) => copyText(text, this.#root, this.#panel),
    });
    this.#inboxButton.append(this.#openCount, this.#draftCount);
    this.#variantsButton.append(this.#slotCount);
    this.#panel = h("div", {
      class: "panel", id: "iterbar-panel", role: "region", "aria-labelledby": "iterbar-panel-title", "data-role": "panel", hidden: true,
    },
    h("div", { class: "panel-header" }, this.#panelTitle, this.#tabs, this.#panelClose),
    h("div", { class: "panel-body", id: "iterbar-panel-body" }, this.#connectionBox, this.#tray.element, this.#threads.element, this.#slots.element, this.#settings.element, this.#agentHelp.element));
    this.#connectionBox.append(this.#detail);
    const toolbar = h("div", { class: "toolbar", id: "iterbar-toolbar", role: "group", "aria-label": "Iterbar toolbar" },
      // The logo comes first and stays where it is when the toolbar expands (see #layout); the rest grows away from it.
      this.#logo, this.#comment, this.#inboxButton,
      h("span", { class: "divider", "aria-hidden": "true" }),
      this.#variantsButton, this.#settingsButton, this.#helpButton);
    this.#dock = h("div", { class: "dock bar", role: "region", "aria-label": "Iterbar", popover: "manual" }, toolbar, this.#panel, this.#tooltip);
    const mod = modKey();
    tip(this.#comment, "Comment", "C", "Pick an element and write a comment on it. Esc leaves.");
    tip(this.#variantsButton, "Variants", null, "Switch between the variants of each slot on this page");
    tip(this.#settingsButton, "Settings", null, "The daemon, updates, the toolbar and this project's Iterbar data");
    this.#toggleKeys = `${mod} .`;
    this.#pins = new PinLayer({
      container: this.#root,
      host: this,
      pageUrl: () => (/^https?:$/.test(location.protocol) ? reportPageUrl(location.href) : null),
      // Pins never sit on the toolbar or an open panel, so they never take a click meant for the bar.
      avoid: () => [this.#logo.parentElement!, this.#panel]
        .filter((element) => !element.hidden && isRendered(element))
        .map((element) => element.getBoundingClientRect()),
      onOpen: (ids) => {
        this.#openPanel("inbox", false);
        this.#threads.reveal(ids[0]!);
      },
      onOpenDraft: (ids) => {
        this.#openPanel("drafts", false);
        this.#tray.reveal(ids[0]!);
      },
    });
    this.#root.append(this.#zoomProbe, this.#dock, this.#composer.element, this.#announcer);
    this.#picker = new ElementPicker({
      host: this,
      container: this.#root,
      onPick: (element) => this.#onPick(element),
      onEscape: (event) => {
        // A draft being edited in the tray takes Escape itself, to cancel the edit.
        const path = event.composedPath();
        const target = path[0];
        if (path.includes(this.#tray.element) && target instanceof Element && target.matches("[data-role=draft-text]")) return false;
        this.commentMode = false;
        return true;
      },
    });

    this.#logo.addEventListener("click", (event) => {
      if (this.#swallowLogoClick) {
        this.#swallowLogoClick = false;
        event.preventDefault();
        return;
      }
      this.#setExpanded(!this.#state.expanded);
    });
    this.#helpButton.addEventListener("click", () => this.#togglePanel("agent"));
    this.#settingsButton.addEventListener("click", () => this.#togglePanel("settings"));
    this.#logo.addEventListener("pointerdown", (event) => this.#startDrag(event));
    this.#logo.addEventListener("pointermove", (event) => this.#moveDrag(event));
    this.#logo.addEventListener("pointerup", (event) => this.#endDrag(event, true));
    this.#logo.addEventListener("pointercancel", (event) => this.#endDrag(event, false));
    this.#logo.addEventListener("lostpointercapture", (event) => this.#endDrag(event, true));
    this.#logo.addEventListener("keydown", (event) => this.#moveWithKey(event));
    // Keys typed into the bar's own fields (the composer, a draft being edited, the slot list) are the user's text:
    // they stop at the bar, so the page's shortcuts never see them. The bar's own shortcuts, listening on the window in
    // the capture phase, skip text entry themselves.
    for (const type of ["keydown", "keyup", "keypress"] as const) {
      this.#root.addEventListener(type, (event) => {
        if (isOwnTextEntry(event.composedPath()[0])) event.stopPropagation();
      });
    }
    this.#dock.addEventListener("pointerover", (event) => this.#onTipEnter(event, false));
    this.#dock.addEventListener("pointerout", (event) => this.#onTipLeave(event));
    this.#dock.addEventListener("focusin", (event) => this.#onTipEnter(event, true));
    this.#dock.addEventListener("focusout", (event) => this.#onTipLeave(event));
    this.#dock.addEventListener("pointerdown", () => this.#hideTooltip(), true);
    this.#comment.addEventListener("click", () => {
      this.commentMode = !this.#commentMode;
    });
    this.#inboxButton.addEventListener("click", () => {
      if (this.#state.panel === "inbox" || this.#state.panel === "drafts") this.#closePanel(false);
      else this.#openPanel("inbox", false);
    });
    this.#inboxTab.addEventListener("click", () => this.#openPanel("inbox", false));
    this.#draftsTab.addEventListener("click", () => this.#openPanel("drafts", false));
    this.#tabs.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = this.#state.panel === "drafts" ? "inbox" : "drafts";
      this.#openPanel(next, false);
      (next === "drafts" ? this.#draftsTab : this.#inboxTab).focus();
    });
    this.#variantsButton.addEventListener("click", () => this.#togglePanel("variants"));
    this.#panelClose.addEventListener("click", () => this.#closePanel(true));
    this.#dock.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.#tooltipFor) this.#hideTooltip();
      if (event.key !== "Escape" || event.isComposing || this.#state.panel === null || this.#commentMode) return;
      event.preventDefault();
      // Escape first clears an inbox selection, then closes the panel.
      if (this.#state.panel === "inbox" && this.#threads.selectionSize > 0) {
        this.#threads.clearSelection();
        return;
      }
      this.#closePanel(true);
    });
    this.#applyState();
    this.#renderStatus({ kind: "unconfigured" });
    this.#renderDrafts();
    this.#renderCounts();
  }

  /** `http://127.0.0.1:<port>` of the daemon. */
  get daemonUrl(): string | null {
    return this.#daemonUrl;
  }

  set daemonUrl(value: string | null) {
    this.#daemonUrl = value ?? null;
    this.#queueReconnect();
  }

  /**
   * The project's root folder, as the dev server knows it. The toolbar keeps its place and state per project, and "Use
   * with your agent" fills the path into its setup commands. `null` keeps one state per origin.
   */
  get project(): string | null {
    return this.#project;
  }

  set project(value: string | null) {
    const root = typeof value === "string" && value ? value : null;
    if (root === this.#project) return;
    this.#project = root;
    this.#agentHelp.root = root;
    if (this.isConnected) {
      this.#state = readStoredState(this.#project);
      this.#threads.filter = this.#state.filter;
      this.#applyState();
    }
  }

  /** The daemon's per-start token. It is never written to an attribute. */
  get token(): string | null {
    return this.#token;
  }

  set token(value: string | null) {
    this.#token = value ?? null;
    this.#queueReconnect();
  }

  /**
   * Whether comment mode is on: the pointer is a crosshair, hovering outlines page elements and clicking one opens the
   * composer instead of reaching the page. Escape turns it off, as does sending a comment on its own. Changing it
   * dispatches {@link COMMENT_MODE_EVENT}.
   */
  get commentMode(): boolean {
    return this.#commentMode;
  }

  set commentMode(value: boolean) {
    const active = Boolean(value);
    if (active === this.#commentMode) return;
    this.#commentMode = active;
    this.#comment.setAttribute("aria-pressed", String(active));
    if (active && this.isConnected) this.#picker.start();
    if (!active) this.#leavePicking();
    this.#setCrosshair(active && this.isConnected);
    this.#applyAwake();
    this.dispatchEvent(new CustomEvent<CommentModeEventDetail>(COMMENT_MODE_EVENT, {
      bubbles: true, composed: true, detail: { active },
    }));
  }

  /** Whether the full toolbar shows; when `false` it is collapsed to its logo. Clicking the logo or Ctrl/Cmd+. toggles it. */
  get expanded(): boolean {
    return this.#state.expanded;
  }

  set expanded(value: boolean) {
    const expanded = Boolean(value);
    if (this.isConnected) {
      this.#setExpanded(expanded);
      return;
    }
    // The stored state is read on connection and would replace this, so remember it, even when it equals the default.
    this.#pendingExpanded = expanded;
    this.#state = { ...this.#state, expanded };
    this.#applyState();
  }

  /** The opposite of {@link expanded}, kept for pages written against the earlier, collapsible bar. */
  get collapsed(): boolean {
    return !this.expanded;
  }

  set collapsed(value: boolean) {
    this.expanded = !value;
  }

  /** How many comments wait in the draft tray. */
  get draftCount(): number {
    return this.#drafts.length;
  }

  attributeChangedCallback(name: string, _previous: string | null, value: string | null): void {
    if (name === "project") {
      this.project = value;
      return;
    }
    if (name === "daemon-url") this.#daemonUrl = value;
    else if (name === "token") this.#token = value;
    this.#queueReconnect();
  }

  connectedCallback(): void {
    this.#state = readStoredState(this.#project);
    this.#threads.filter = this.#state.filter;
    this.#applyState();
    const pending = this.#pendingExpanded;
    this.#pendingExpanded = undefined;
    if (pending !== undefined) this.#saveState({ ...this.#state, expanded: pending });
    // Properties set on the element before it was upgraded are own properties that hide the accessors. They are
    // applied after the stored state, so an assigned `expanded` or `collapsed` wins over the saved one.
    for (const property of ["project", "daemonUrl", "token", "commentMode", "expanded", "collapsed"] as const) {
      if (!Object.hasOwn(this, property)) continue;
      const value = (this as Record<string, unknown>)[property];
      delete (this as Record<string, unknown>)[property];
      (this as Record<string, unknown>)[property] = value;
    }
    // The pins enter the top layer before the toolbar, so the toolbar and its sheet always paint over them.
    this.#pins.attach();
    this.#raise();
    if (this.#commentMode) {
      this.#picker.start();
      this.#setCrosshair(true);
    }
    this.#watchZoom();
    window.addEventListener("keydown", this.#onKeydown, true);
    window.addEventListener("resize", this.#queueLayout);
    window.addEventListener("pagehide", this.#onPageHide);
    // The panel's height cap leaves room for the toolbar as tall as it is (it wraps on a narrow screen), and the
    // toolbar and panel are placed again whenever either changes size.
    if (typeof ResizeObserver === "function" && !this.#heightObserver) {
      this.#heightObserver = new ResizeObserver(() => {
        this.#dock.style.setProperty("--ib-toolbar-height", `${this.#dock.getBoundingClientRect().height}px`);
        this.#layout();
      });
      this.#heightObserver.observe(this.#dock);
      this.#heightObserver.observe(this.#panel);
    }
    this.#layout();
    this.#watchUrl(true);
    this.#slots.attach();
    this.#pins.update(this.#threads.threads);
    this.#reconnect();
  }

  disconnectedCallback(): void {
    // Leaving comment mode withdraws a screenshot still being taken (see #leavePicking).
    this.commentMode = false;
    this.#setCrosshair(false);
    this.#picker.mark(null);
    // A drag in progress ends here (its pointer capture went with the element), unsaved.
    if (this.#drag) {
      try {
        this.#logo.releasePointerCapture(this.#drag.pointerId);
      } catch {
        // Already released.
      }
    }
    this.#drag = null;
    this.#dock.removeAttribute("data-dragging");
    // A delete waiting for its undo is sent rather than lost with the bar.
    this.#threads.flushDeletes();
    window.removeEventListener("keydown", this.#onKeydown, true);
    window.removeEventListener("resize", this.#queueLayout);
    window.removeEventListener("pagehide", this.#onPageHide);
    this.#heightObserver?.disconnect();
    this.#heightObserver = null;
    if (this.#layoutFrame !== null) cancelAnimationFrame(this.#layoutFrame);
    this.#layoutFrame = null;
    this.#hideTooltip();
    this.#watchUrl(false);
    this.#pins.detach();
    this.#zoomObserver?.disconnect();
    this.#zoomObserver = null;
    this.#slots.detach();
    this.#connection?.stop();
    this.#connection = null;
    if (this.#reportTimer) clearTimeout(this.#reportTimer);
    this.#reportTimer = null;
    this.#followComposer(false);
  }

  /** Leaving the page sends a delete still waiting for its undo, so a reload does not bring the threads back. */
  readonly #onPageHide = (): void => {
    this.#threads.flushDeletes();
  };

  #layoutFrame: number | null = null;

  readonly #queueLayout = (): void => {
    if (this.#layoutFrame !== null) return;
    this.#layoutFrame = requestAnimationFrame(() => {
      this.#layoutFrame = null;
      this.#layout();
    });
  };

  readonly #onKeydown = (event: KeyboardEvent): void => {
    if (event.repeat || event.defaultPrevented) return;
    // Text fields keep both shortcuts: Ctrl/Cmd+. is an editor command in some (Quick Fix), C is a letter.
    if (isTextEntry(event.composedPath()[0])) return;
    // Turned off in the settings: the page keeps both keys.
    if (!this.#state.shortcuts) return;
    if (isToggleShortcut(event)) {
      event.preventDefault();
      const focusInside = this.#root.activeElement !== null;
      this.#setExpanded(!this.#state.expanded);
      // Expanding moves focus into the toolbar so keyboard users can carry on; collapsing moves focus that was inside to
      // the logo, the one control left (unless a panel or comment mode keeps the toolbar showing).
      if (this.#state.expanded) this.#comment.focus();
      else if (focusInside && (!this.#root.activeElement || !isRendered(this.#root.activeElement))) this.#logo.focus();
      return;
    }
    if (event.key !== "c" && event.key !== "C") return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    event.preventDefault();
    this.commentMode = !this.#commentMode;
  };

  /** Takes a click in comment mode; refused while the current pick's comment is being sent. */
  #onPick(element: Element): boolean {
    if (this.#sendingPick !== null && this.#sendingPick === this.#pick) return false;
    this.#pick?.withdraw.abort();
    const withdraw = new AbortController();
    const target = describeTarget(element);
    this.#pick = {
      element,
      target,
      label: labelElement(element, target),
      pageUrl: /^https?:$/.test(location.protocol) ? reportPageUrl(location.href) : null,
      activeVariants: readActiveVariants(),
      screenshot: this.#state.screenshots
        ? captureScreenshot(element, this, this.#renderSlot, withdraw.signal)
        : Promise.resolve({ ok: false, reason: "Screenshots are turned off in Iterbar's settings." }),
      withdraw,
    };
    this.#composer.show(this.#pick.label);
    this.#placeComposer();
    this.#followComposer(true);
    this.#applyAwake();
    return true;
  }

  /**
   * Drops the pick and closes the composer; comment mode stays on. A send still waiting for its screenshot is
   * withdrawn (see {@link #send}); one already posted cannot be, and Cancel is disabled meanwhile.
   */
  #cancelPick(): void {
    if (this.#postingPick !== null && this.#postingPick === this.#pick) return;
    this.#pick?.withdraw.abort();
    this.#pick = null;
    this.#closeComposer();
    this.#picker.clearPick();
  }

  /**
   * Stops picking. The pick and the composer go too, withdrawing a send still waiting for its screenshot, unless
   * the comment is already posted: then the composer stays until the daemon answers, so it never looks discarded.
   */
  #leavePicking(): void {
    this.#picker.stop();
    if (this.#postingPick !== null && this.#postingPick === this.#pick) return;
    this.#pick?.withdraw.abort();
    this.#pick = null;
    this.#closeComposer();
  }

  /** The comment on `pick` was stored: comment mode ends, and the pick and composer go. */
  #finishPick(pick: Pick): void {
    if (this.#pick !== pick) return;
    if (this.#commentMode) {
      this.commentMode = false;
      return;
    }
    this.#pick = null;
    this.#closeComposer();
  }

  /** Closes the composer; focus inside it moves to the comment button rather than being lost with it. */
  #closeComposer(): void {
    const focused = this.#root.activeElement;
    this.#composer.close();
    this.#followComposer(false);
    if (focused && this.#composer.element.contains(focused)) this.#comment.focus();
    this.#applyAwake();
  }

  /**
   * Puts the composer next to the picked element: below it, or above when there is no room below. The composer cancels
   * any page zoom it inherits (see {@link #fitZoom}), so its CSS pixels are viewport pixels, as the rectangles are.
   */
  #placeComposer(): void {
    const pick = this.#pick;
    if (!pick || !this.#composer.open) return;
    const rect = pick.element.isConnected ? pick.element.getBoundingClientRect() : null;
    // The visual viewport is what the user sees: it leaves out scrollbars, is not scaled by a page zoom, and when
    // pinch-zoomed is a panned part of the layout viewport that rectangles and fixed positions are measured in. So
    // placement happens in its coordinates and is translated back.
    const visual = window.visualViewport;
    const offset = { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0 };
    const viewport = { width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight };
    // It never outgrows what is visible, so none of it is cut off where panning cannot reach.
    this.#composer.element.style.maxWidth = `${Math.max(0, viewport.width - 2 * BAR_MARGIN_PX)}px`;
    this.#composer.element.style.maxHeight = `${Math.max(0, viewport.height - 2 * BAR_MARGIN_PX)}px`;
    const box = this.#composer.element.getBoundingClientRect();
    // The toolbar, and the panel above it when one is open, are kept clear.
    const popover = !this.#panel.hidden && this.#panel.dataset.mode === "popover";
    const barTop = Math.min(this.#logo.parentElement!.getBoundingClientRect().top, popover ? this.#panel.getBoundingClientRect().top : Infinity);
    // An open sheet takes the right of the screen: the composer keeps to its left when it fits there. On a screen too
    // narrow for both, it shows over the sheet (it is above it in the top layer), so the comment stays reachable.
    if (!this.#panel.hidden && !popover) {
      const room = this.#panel.getBoundingClientRect().left - offset.left - BAR_MARGIN_PX;
      if (room >= box.width + BAR_MARGIN_PX) viewport.width = Math.min(viewport.width, room);
    }
    const reserved = Math.max(0, offset.top + viewport.height - barTop);
    const target = rect
      ? { left: rect.left - offset.left, top: rect.top - offset.top, width: rect.width, height: rect.height }
      : { left: viewport.width / 2 - box.width / 2, top: viewport.height / 3, width: 0, height: 0 };
    const { left, top } = anchorPopover(target, { width: box.width, height: box.height }, viewport, reserved + 8);
    this.#composer.moveTo(left + offset.left, top + offset.top);
  }

  readonly #queuePlaceComposer = (): void => {
    if (this.#composerFrame !== null) return;
    this.#composerFrame = requestAnimationFrame(() => {
      this.#composerFrame = null;
      this.#placeComposer();
    });
  };

  /** Keeps the composer next to its element while the page scrolls or resizes. */
  #followComposer(on: boolean): void {
    window.removeEventListener("scroll", this.#queuePlaceComposer, true);
    window.removeEventListener("resize", this.#queuePlaceComposer);
    window.visualViewport?.removeEventListener("scroll", this.#queuePlaceComposer);
    window.visualViewport?.removeEventListener("resize", this.#queuePlaceComposer);
    this.#composerObserver?.disconnect();
    this.#composerObserver = null;
    if (this.#composerFrame !== null) cancelAnimationFrame(this.#composerFrame);
    this.#composerFrame = null;
    if (!on) return;
    window.addEventListener("scroll", this.#queuePlaceComposer, { capture: true, passive: true });
    window.addEventListener("resize", this.#queuePlaceComposer, { passive: true });
    // Pinch-zooming and panning move the visual viewport without scrolling the page.
    window.visualViewport?.addEventListener("scroll", this.#queuePlaceComposer, { passive: true });
    window.visualViewport?.addEventListener("resize", this.#queuePlaceComposer, { passive: true });
    // An error or a resized text area changes its height, which can change where it fits.
    if (typeof ResizeObserver === "function") {
      this.#composerObserver = new ResizeObserver(this.#queuePlaceComposer);
      this.#composerObserver.observe(this.#composer.element);
      // A panel opening, closing or changing size above the toolbar changes the room the composer must keep clear.
      this.#composerObserver.observe(this.#panel);
    }
  }

  /**
   * Sends a comment on the current pick on its own, with its screenshot or the reason there is none. On success the
   * thread is shown and comment mode ends; on failure the composer keeps the text and shows why. Cancel or Escape while
   * the screenshot is being taken stops it and withdraws the comment before anything is posted.
   */
  async #send(text: string): Promise<void> {
    const pick = this.#pick;
    if (!pick || this.#sendingPick === pick) return;
    const connection = this.#connection;
    const problem = this.#sendProblem(pick);
    if (!connection || problem) {
      this.#composer.showError(problem ?? "");
      return;
    }
    this.#sendingPick = pick;
    this.#composer.setBusy(true);
    try {
      const screenshot = await pick.screenshot;
      // Cancelled, Escaped or replaced while the screenshot was being taken: the comment was withdrawn.
      if (this.#pick !== pick) return;
      this.#postingPick = pick;
      this.#composer.setBusy(true, false);
      const feedback = await connection.sendFeedback(this.#feedbackDraft(pick, text, screenshot, null), screenshot.ok ? screenshot.png : null);
      this.#postingPick = null;
      if (this.#connection === connection) this.#threads.merge(feedback);
      this.#announce("Comment sent.");
      this.#finishPick(pick);
    } catch (error) {
      if (this.#pick === pick) this.#composer.showError((error as Error).message);
    } finally {
      if (this.#postingPick === pick) this.#postingPick = null;
      if (this.#sendingPick === pick) this.#sendingPick = null;
      if (this.#pick === pick) this.#composer.setBusy(false);
    }
  }

  /** Why a comment on `pick` cannot be sent, or `null` when it can. */
  #sendProblem(pick: Pick): string | null {
    if (!this.#connection) {
      return "Comments need the Iterbar daemon, and the bar has none. Start the dev server with the Iterbar plugin.";
    }
    if (pick.pageUrl === null) return "This page's URL is not http or https, so the daemon cannot file a comment for it.";
    return null;
  }

  #feedbackDraft(
    pick: Pick, text: string, screenshot: ScreenshotResult,
    batch: { readonly id: string; readonly size: number; readonly index: number } | null,
  ): FeedbackDraft {
    return {
      schemaVersion: SCHEMA_VERSION,
      kind: "comment",
      text,
      pageUrl: pick.pageUrl!,
      target: pick.target,
      activeVariants: [...pick.activeVariants],
      screenshotUnavailableReason: screenshot.ok ? null : screenshot.reason,
      evidenceWindow: null,
      ...(batch ? { batchId: batch.id, batchSize: batch.size, batchIndex: batch.index } : {}),
    };
  }

  /** Moves the current pick and `text` into the draft tray; comment mode stays on for the next pick. */
  #addDraft(text: string): void {
    const pick = this.#pick;
    if (!pick || this.#sendingPick === pick) return;
    if (pick.pageUrl === null) {
      this.#composer.showError("This page's URL is not http or https, so the daemon cannot file a comment for it.");
      return;
    }
    if (this.#drafts.length >= MAX_DRAFTS) {
      this.#composer.showError(`The tray holds ${MAX_DRAFTS} drafts. Send them, or remove some, before adding more.`);
      return;
    }
    this.#drafts.push({ id: localId("draft"), pick, text, state: "draft", error: null, batchId: null, batchIndex: null, mayBeStored: false });
    // The pick now belongs to the draft: its screenshot carries on.
    this.#pick = null;
    this.#closeComposer();
    this.#picker.clearPick();
    this.#batchError = null;
    this.#renderDrafts();
    const count = this.#drafts.length;
    this.#announce(`Draft added. ${count} ${count === 1 ? "draft" : "drafts"} waiting; Send all is in the draft tray.`);
  }

  #removeDraft(id: string): void {
    if (this.#sendingBatch) return;
    const index = this.#drafts.findIndex((draft) => draft.id === id);
    if (index < 0) return;
    const [draft] = this.#drafts.splice(index, 1);
    draft!.pick.withdraw.abort();
    if (draft!.batchId) {
      // A withdrawn draft no longer counts toward its batch; once none of the batch is left, the batch is forgotten.
      // One that may be stored already still counts: the batch may hold it.
      const batch = this.#batches.get(draft!.batchId);
      if (batch && !draft!.mayBeStored) batch.size -= 1;
      if (!this.#drafts.some((each) => each.batchId === draft!.batchId)) this.#batches.delete(draft!.batchId);
    }
    this.#picker.mark(null);
    this.#renderDrafts();
    this.#announce("Draft removed.");
    // Focus goes to the next draft's Remove (or the previous one's), or to the panel when the tray is empty.
    const next = this.#drafts[Math.min(index, this.#drafts.length - 1)];
    const button = next
      ? this.#tray.element.querySelector<HTMLElement>(`[data-draft-id="${CSS.escape(next.id)}"] [data-role=draft-remove]`)
      : null;
    (button ?? this.#panelClose).focus();
  }

  #editDraft(id: string, text: string): void {
    const draft = this.#drafts.find((each) => each.id === id);
    if (!draft || this.#sendingBatch || text.trim().length === 0) return;
    draft.text = text;
    this.#renderDrafts();
    this.#tray.element.querySelector<HTMLElement>(`[data-draft-id="${CSS.escape(id)}"] [data-role=draft-edit]`)?.focus();
  }

  /**
   * Posts every draft, in tray order, as one batch: each with the same `batchId` and the batch's size, its screenshot or
   * the reason there is none. A sent draft leaves the tray; a failed one stays with its reason and its batch, and Send
   * all retries it in that batch, together with drafts added since. A draft added while a batch is being sent waits for
   * the next Send all.
   */
  async #sendAll(): Promise<void> {
    if (this.#sendingBatch || this.#drafts.length === 0) return;
    const connection = this.#connection;
    const problem = this.#sendProblem(this.#drafts[0]!.pick);
    if (!connection || problem) {
      this.#batchError = problem;
      this.#renderDrafts();
      return;
    }
    const submitted = [...this.#drafts];
    let batchId = submitted.find((draft) => draft.batchId !== null)?.batchId ?? localId("batch");
    // Drafts new to the batch take places after every one it has given out (stored, failed and kept, or withdrawn),
    // and count toward its size, which a withdrawn draft no longer does.
    let batch = this.#batches.get(batchId) ?? { next: 0, size: 0 };
    // The protocol numbers a batch's comments below 1,000; one that would pass that starts afresh.
    if (batch.next + submitted.filter((draft) => draft.batchIndex === null).length > MAX_BATCH) {
      batchId = localId("batch");
      batch = { next: 0, size: 0 };
      for (const draft of submitted) draft.batchIndex = null;
    }
    for (const draft of submitted) {
      draft.batchId = batchId;
      if (draft.batchIndex !== null) continue;
      draft.batchIndex = batch.next++;
      batch.size += 1;
    }
    this.#batches.set(batchId, batch);
    const size = batch.size;
    let ungrouped = false;
    this.#sendingBatch = true;
    this.#batchError = null;
    let sent = 0;
    for (const draft of submitted) {
      draft.state = "sending";
      draft.error = null;
      this.#renderDrafts();
      try {
        const screenshot = await draft.pick.screenshot;
        const feedback = await connection.sendFeedback(this.#feedbackDraft(draft.pick, draft.text, screenshot,
          { id: batchId, size, index: draft.batchIndex! }), screenshot.ok ? screenshot.png : null);
        // A daemon from before batches stores the comment but drops its batch.
        if (feedback.batchId !== batchId) ungrouped = true;
        if (this.#connection === connection) this.#threads.merge(feedback);
        this.#drafts = this.#drafts.filter((each) => each !== draft);
        sent += 1;
      } catch (error) {
        draft.state = "failed";
        draft.error = (error as Error).message;
        // Only for this attempt's batch: switching to another daemon meanwhile has taken the draft out of it, while a
        // reconnection to the same daemon leaves it there, where the comment may be stored.
        if (error instanceof DaemonRequestError && error.mayBeStored && draft.batchId === batchId) {
          draft.mayBeStored = true;
        }
      }
    }
    this.#sendingBatch = false;
    const failed = submitted.length - sent;
    if (failed === 0) this.#batches.delete(batchId);
    if (ungrouped) {
      // The daemon drops batches, so what is left is not part of one either: a retry starts afresh.
      this.#batches.delete(batchId);
      for (const draft of this.#drafts) {
        if (draft.batchId !== batchId) continue;
        draft.batchId = null;
        draft.batchIndex = null;
      }
    }
    // A send that got no clear answer may have been stored: the user checks the inbox before sending it again.
    const unconfirmed = submitted.filter((draft) => draft.state === "failed" && draft.mayBeStored).length;
    const refused = failed - unconfirmed;
    const where = ungrouped ? "" : " in the same batch";
    const notSent = [
      refused ? `${refused} of ${submitted.length} not sent; Send all tries ${refused === 1 ? "it" : "them"} again${where}.` : "",
      unconfirmed ? `${unconfirmed} may already be stored; check the inbox before sending ${unconfirmed === 1 ? "it" : "them"} again.` : "",
    ].filter(Boolean).join(" ");
    const old = ungrouped
      ? "The daemon is older than the draft tray, so the comments were filed one by one, not as a batch. Restart the dev server to update it."
      : "";
    this.#batchError = [notSent, old].filter(Boolean).join(" ") || null;
    this.#picker.mark(null);
    this.#renderDrafts();
    if (this.#batchError) {
      this.#announce(this.#batchError);
    } else {
      this.#announce(`Sent ${sent} ${sent === 1 ? "comment" : "comments"} as one batch.`);
      // Focus moves with the switch only if it was in the panel; a user who went on to write a comment keeps it.
      const focused = this.#root.activeElement;
      const inPanel = focused !== null && this.#panel.contains(focused);
      if (this.#state.panel === "drafts" && this.#drafts.length === 0) this.#openPanel("inbox", inPanel);
    }
  }

  /** Sets `status` on each thread through the daemon, merging what it answers; rejects saying how many failed. */
  async #setStatuses(ids: readonly string[], status: FeedbackStatus): Promise<void> {
    const connection = this.#connection;
    if (!connection) throw new Error("The bar is not connected to the Iterbar daemon.");
    const results = await Promise.allSettled(ids.map((id) => connection.setStatus(id, status)));
    const failed = results.filter((result) => result.status === "rejected");
    // The answers are not merged as they are: a reply the event stream already delivered can share the answer's
    // updatedAt (the store's timestamps are milliseconds), and the older answer would replace it. The daemon announces
    // each change on the stream; a listing reconciles anything the stream missed.
    if (results.some((result) => result.status === "fulfilled") && this.#connection === connection) connection.refresh();
    if (failed.length > 0) {
      const reason = ((failed[0] as PromiseRejectedResult).reason as Error).message;
      throw new Error(`${failed.length} of ${ids.length} could not be changed. ${reason}`);
    }
  }

  /** Deletes each thread through the daemon; rejects saying how many failed. */
  /** Deletes each thread through the daemon; resolves with the ones that failed and why, so the rest go at once. */
  async #deleteThreads(ids: readonly string[]): Promise<{ failed: readonly string[]; message: string | null }> {
    const connection = this.#connection;
    if (!connection) return { failed: ids, message: "The bar is not connected to the Iterbar daemon, so nothing was deleted." };
    const results = await Promise.allSettled(ids.map((id) => connection.deleteFeedback(id)));
    const failed = ids.filter((_id, index) => results[index]!.status === "rejected");
    if (failed.length === 0) return { failed, message: null };
    const reason = ((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason as Error).message;
    return { failed, message: `${failed.length} of ${ids.length} could not be deleted. ${reason}` };
  }

  #renderDrafts(): void {
    this.#tray.render(this.#drafts.map((draft) => ({
      id: draft.id, label: draft.pick.label, text: draft.text, state: draft.state, error: draft.error,
    })), this.#sendingBatch, this.#batchError);
    this.#pins.updateDrafts(this.#drafts.map((draft) => ({ id: draft.id, element: draft.pick.element })));
    this.#renderCounts();
    // The settings' Clear drafts follows the drafts and whether a batch is being sent.
    if (this.#state.panel === "settings") this.#renderSettings(false);
  }

  /** Updates the toolbar's open-feedback count from the inbox. */
  #renderCounts(): void {
    // The inbox renders once while it is being constructed, before it is assigned.
    if (!this.#threads) return;
    const open = this.#threads.openCount;
    const drafts = this.#drafts.length;
    this.#openCount.textContent = String(open);
    this.#openCount.hidden = open === 0;
    this.#draftCount.textContent = String(drafts);
    this.#draftCount.hidden = drafts === 0;
    this.#inboxTabCount.textContent = String(open);
    this.#draftsTabCount.textContent = String(drafts);
    this.#draftsTab.setAttribute("aria-label", `Drafts, ${drafts} not sent`);
    this.#inboxTab.setAttribute("aria-label", `Inbox, ${open} open`);
    const parts = [open ? `${open} open` : "", drafts ? `${drafts} ${drafts === 1 ? "draft" : "drafts"}` : ""].filter(Boolean);
    this.#inboxButton.setAttribute("aria-label", parts.length ? `Inbox, ${parts.join(", ")}` : "Inbox");
    tip(this.#inboxButton, parts.length ? `Inbox: ${parts.join(", ")}` : "Inbox", null,
      drafts ? "Sent comments with your agent's replies, and the drafts waiting to be sent together" : "Sent comments, their status and your agent's replies");
    this.#renderLogoTip();
  }

  /** The logo's tooltip: what clicking does, how to move it, and (collapsed) what the hidden toolbar would show. */
  #renderLogoTip(): void {
    const expanded = this.#state.expanded;
    const open = this.#threads?.openCount ?? 0;
    const status = STATUS_TEXT[(this.#dock?.dataset.status ?? "unconfigured") as ConnectionStatus["kind"]] ?? "";
    const parts = [open ? `${open} open in the inbox` : "", status].filter(Boolean).join(" · ");
    this.#logo.setAttribute("aria-label", expanded ? "Iterbar: collapse the toolbar" : "Iterbar: expand the toolbar");
    this.#logo.setAttribute("aria-expanded", String(expanded));
    tip(this.#logo, expanded ? "Collapse Iterbar" : "Expand Iterbar", this.#toggleKeys, `${parts ? `${parts}. ` : ""}Drag to move it.`);
    if (this.#tooltipFor === this.#logo) this.#showTooltip(this.#logo);
  }

  #onSlots(slots: readonly SlotState[]): void {
    this.#slotCount.textContent = String(slots.length);
    this.#slotCount.hidden = slots.length === 0;
    this.#variantsButton.toggleAttribute("data-has", slots.length > 0);
    this.#pins.setActiveVariants(slots.map((slot) => ({ slot: slot.slot, variant: slot.activeVariant })));
    this.#variantsButton.setAttribute("aria-label", slots.length ? `Variants, ${slots.length} ${slots.length === 1 ? "slot" : "slots"}` : "Variants");
    this.#queueReport(slots);
  }

  #settingsWasOpen = false;

  /** Renders the settings sheet with what the bar knows now; `refreshInfo` asks the daemon for its details again. */
  #renderSettings(refreshInfo: boolean): void {
    const { x, theme, shortcuts, screenshots, pins } = this.#state;
    this.#settings.render({
      values: { x, theme, shortcuts, screenshots, pins },
      connected: this.#connectionKind === "connected",
      connectionLabel: STATUS_TEXT[this.#connectionKind],
      threadCount: this.#threads.threads.length,
      draftCount: this.#drafts.length,
      sending: this.#sendingBatch,
      devServer: this.#devServer,
    }, refreshInfo);
  }

  #requireConnection(): DaemonConnection {
    if (!this.#connection) throw new Error("The bar is not connected to the Iterbar daemon.");
    return this.#connection;
  }

  /** Asks the daemon to stop, and waits (a few seconds at most) until the bar has seen it go. */
  async #stopDaemon(): Promise<void> {
    await this.#requireConnection().shutdown();
    const until = Date.now() + 5000;
    while (this.#connectionKind === "connected" && Date.now() < until) await new Promise((done) => setTimeout(done, 100));
  }

  /** Asks the dev server for the daemon again (it starts one when none runs) and connects to what it answers. */
  async #startDaemon(): Promise<void> {
    const dev = this.#devServer;
    if (!dev) throw new Error("This page has no Iterbar dev-server plugin to start the daemon.");
    const project = this.#project;
    const config = await dev.reconnect();
    // Mounted again meanwhile (another dev server or project): this answer is for the bar as it was.
    if (this.#devServer !== dev || this.#project !== project) throw new Error("The bar was set up again meanwhile; nothing was changed.");
    if (!config.daemonUrl || !config.token) throw new Error("The dev server could not start the daemon. Its terminal says why.");
    if (config.about) this.devServer = { ...dev, about: config.about };
    this.daemonUrl = config.daemonUrl;
    this.token = config.token;
    const until = Date.now() + 5000;
    while (this.#connectionKind !== "connected" && Date.now() < until) await new Promise((done) => setTimeout(done, 100));
    if (this.#connectionKind !== "connected") throw new Error("The daemon started, but the bar has not connected to it yet.");
  }

  /** The dev server that mounted the bar, for the settings (daemon controls, versions) and the setup steps. */
  get devServer(): DevServerLink | null {
    return this.#devServer;
  }

  set devServer(value: DevServerLink | null) {
    this.#devServer = value;
    this.#agentHelp.cli = value?.about?.cli ?? null;
    if (this.#state.panel === "settings") this.#renderSettings(false);
  }

  /** Says `text` to screen readers through a polite live region. */
  #announce(text: string): void {
    this.#announcer.textContent = "";
    if (!text) return;
    // A fresh text node in a later task, so the same message twice is read twice.
    setTimeout(() => {
      this.#announcer.textContent = text;
    }, 50);
  }

  #togglePanel(panel: PanelName): void {
    if (this.#state.panel === panel) this.#closePanel(false);
    else this.#openPanel(panel, false);
  }

  #openPanel(panel: PanelName, focus: boolean): void {
    this.#saveState({ ...this.#state, panel });
    if (focus) this.#panelClose.focus();
  }

  /** Closes the panel; with `refocus`, focus goes back to the toolbar button that opens it. */
  #closePanel(refocus: boolean): void {
    const panel = this.#state.panel;
    if (panel === null) return;
    this.#saveState({ ...this.#state, panel: null });
    if (!refocus) return;
    // The toolbar may have collapsed with the panel (it was opened from a comment pin): then the logo takes focus.
    const button = this.#panelButton(panel);
    (isRendered(button) ? button : this.#logo).focus();
  }

  #panelButton(panel: PanelName): HTMLButtonElement {
    switch (panel) {
      case "drafts":
      case "inbox": return this.#inboxButton;
      case "variants": return this.#variantsButton;
      case "settings": return this.#settingsButton;
      case "agent": return this.#helpButton;
    }
  }

  /** Sets (or restores) the crosshair pointer on the page root while comment mode is on. */
  #setCrosshair(on: boolean): void {
    const style = document.documentElement?.style;
    if (!style) return;
    if (on && this.#savedCursor === null) {
      this.#savedCursor = {
        value: style.getPropertyValue("cursor"),
        priority: style.getPropertyPriority("cursor"),
        hadStyle: document.documentElement.hasAttribute("style"),
      };
      style.setProperty("cursor", "crosshair", "important");
    } else if (!on && this.#savedCursor !== null) {
      const { value, priority, hadStyle } = this.#savedCursor;
      this.#savedCursor = null;
      // The page changed the cursor itself meanwhile: its value stays.
      if (style.getPropertyValue("cursor") !== "crosshair" || style.getPropertyPriority("cursor") !== "important") return;
      if (value) style.setProperty("cursor", value, priority);
      else style.removeProperty("cursor");
      if (style.length === 0 && !hadStyle) document.documentElement.removeAttribute("style");
    }
  }

  readonly #onUrlChange = (): void => {
    // Pins belong to the page they were left on.
    this.#pins.update(this.#threads.threads);
    if (this.#slotsForReport && reportPageUrl(location.href) !== this.#reportedUrl) this.#queueReport(this.#slotsForReport);
  };

  /** Follows single-page navigation through the Navigation API, or by polling `location` without it. */
  #watchUrl(on: boolean): void {
    const navigation = (globalThis as { navigation?: NavigationTarget }).navigation;
    if (navigation && typeof navigation.addEventListener === "function") {
      if (on) navigation.addEventListener("currententrychange", this.#onUrlChange);
      else navigation.removeEventListener("currententrychange", this.#onUrlChange);
      return;
    }
    if (this.#urlPoll) clearInterval(this.#urlPoll);
    this.#urlPoll = on ? setInterval(this.#onUrlChange, URL_POLL_MS) : null;
  }

  /**
   * Shows the toolbar in the top layer, outside every page stacking context and containing block, so a `transform`,
   * `filter`, `opacity`, `contain` or `will-change` on an ancestor cannot move, clip or hide it. Removing the element
   * from the page takes it out of the top layer, so this runs on every connect. Without popover support the toolbar
   * stays an ordinary fixed-position element.
   */
  #raise(): void {
    const dock = this.#dock;
    if (typeof dock.showPopover !== "function" || dock.matches(":popover-open")) return;
    try {
      dock.showPopover();
    } catch {
      // Left as a fixed-position element.
    }
  }

  /** The top layer still inherits `zoom`, so the toolbar, composer and pick layer apply the inverse of what the page gives them. */
  #fitZoom(): void {
    const zoom = (this.#zoomProbe as { currentCSSZoom?: number }).currentCSSZoom;
    if (typeof zoom !== "number" || !Number.isFinite(zoom) || zoom <= 0) return;
    const inverse = zoom === 1 ? "" : String(1 / zoom);
    this.#dock.style.zoom = inverse;
    this.#composer.element.style.zoom = inverse;
    // The pick layer outlines viewport rectangles, so it cancels the inherited zoom too.
    this.#picker.setZoom(inverse);
    this.#pins.setZoom(inverse);
    this.#placeComposer();
  }

  /** Refits on every change of the page's zoom, which changes the probe's size in device pixels. */
  #watchZoom(): void {
    this.#fitZoom();
    if (this.#zoomObserver || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => this.#fitZoom());
    try {
      observer.observe(this.#zoomProbe, { box: "device-pixel-content-box" });
    } catch {
      // Without device-pixel boxes the zoom is fitted once per connect.
      return;
    }
    this.#zoomObserver = observer;
  }

  #queueReconnect(): void {
    if (this.#reconnectQueued) return;
    this.#reconnectQueued = true;
    queueMicrotask(() => {
      this.#reconnectQueued = false;
      if (this.isConnected) this.#reconnect();
    });
  }

  /** Opens a connection for the current URL and token, unless one for them is already open. */
  #reconnect(): void {
    const parsed = parseDaemonConfig(this.#daemonUrl, this.#token);
    // A daemon is identified as parsed (its origin and token), so a URL written differently keeps the connection.
    const key = JSON.stringify(parsed.ok ? [parsed.config.url, parsed.config.token] : [this.#daemonUrl, this.#token]);
    if (this.#connection && key === this.#connectionKey) return;
    this.#connection?.stop();
    this.#connection = null;
    // Threads belong to the daemon that listed them; another daemon (or none) must not show them.
    if (key !== this.#connectionKey) {
      this.#threads.clear();
      // The page list came from the old daemon (or none): drop it, and any answer still on its way.
      this.#slots.resetPages();
    }
    this.#connectionKey = key;
    if (parsed.ok) {
      // A batch lives in one daemon's store: drafts waiting to be retried start a new batch with another daemon. The
      // daemon is compared as parsed (its origin and token), so a URL written differently is still the same one.
      const store = JSON.stringify([parsed.config.url, parsed.config.token]);
      if (this.#batchStore !== null && store !== this.#batchStore) {
        this.#batches.clear();
        for (const draft of this.#drafts) {
          draft.batchId = null;
          draft.batchIndex = null;
          draft.mayBeStored = false;
        }
      }
      this.#batchStore = store;
    }
    if (!parsed.ok) {
      this.#renderStatus(parsed.status);
      return;
    }
    // Whatever the settings showed or were about to do concerned the earlier daemon.
    this.#settings.resetForConnection();
    const connection = new DaemonConnection(parsed.config, {
      onStatus: (status) => {
        if (this.#connection !== connection) return;
        this.#renderStatus(status);
        // A page list asked for before the connection opened comes from this daemon now.
        if (status.kind === "connected" && this.#state.panel === "variants") void this.#slots.refreshPages();
      },
      onFeedback: (item): boolean => this.#connection === connection && this.#threads.merge(item),
      onDeleted: (feedbackId) => {
        if (this.#connection === connection) this.#threads.remove(feedbackId);
      },
      onSlotsReported: () => {
        if (this.#connection === connection && this.#state.panel === "variants") void this.#slots.refreshPages();
      },
      onListing: (items, touched): boolean => this.#connection !== connection || this.#threads.replace(items, touched),
      isComplete: (): boolean => this.#connection !== connection || this.#threads.complete,
    });
    this.#connection = connection;
    connection.start();
    if (this.#slotsForReport) this.#queueReport(this.#slotsForReport);
  }

  #renderStatus(status: ConnectionStatus): void {
    this.#connectionKind = status.kind;
    if (this.#state.panel === "settings") this.#renderSettings(status.kind === "connected");
    this.#status.dataset.status = status.kind;
    this.#statusDot.dataset.status = status.kind;
    this.#status.textContent = STATUS_TEXT[status.kind];
    this.#dock.dataset.status = status.kind;
    const detail = "message" in status ? status.message
      : status.kind === "unconfigured" ? "No daemon URL and token were given, so feedback is unavailable." : "";
    this.#detail.textContent = detail;
    this.#detail.hidden = !detail;
    this.#statusExplain.textContent = STATUS_DETAIL[status.kind];
    this.#helpButton.setAttribute("aria-label", `Help and setup. ${STATUS_TEXT[status.kind]}`);
    tip(this.#helpButton, "Help and setup", null, `${STATUS_TEXT[status.kind]}. How to connect your coding agent.`);
    if (this.#tooltipFor === this.#helpButton) this.#showTooltip(this.#helpButton);
    this.#pins.enabled = status.kind === "connected" || status.kind === "retrying" || status.kind === "connecting";
    this.#renderLogoTip();
  }

  #queueReport(slots: readonly SlotState[]): void {
    this.#slotsForReport = slots;
    if (this.#reportTimer || !this.#connection) return;
    this.#reportTimer = setTimeout(() => {
      this.#reportTimer = null;
      const pageUrl = reportPageUrl(location.href);
      if (!pageUrl || !this.#slotsForReport || !this.#connection) return;
      this.#reportedUrl = pageUrl;
      this.#connection.reportSlots(pageUrl, this.#slotsForReport);
    }, REPORT_DELAY_MS);
  }

  #setExpanded(expanded: boolean): void {
    if (expanded === this.#state.expanded) return;
    this.#saveState({ ...this.#state, expanded });
  }

  #saveState(state: BarState): void {
    this.#state = state;
    this.#applyState();
    try {
      localStorage.setItem(barStateStorageKey(this.#project), formatBarState(state));
    } catch {
      // Without storage the state simply is not remembered.
    }
  }

  readonly #toggleKeys: string;

  #applyState(): void {
    const { x, expanded, panel } = this.#state;
    this.#setPosition(x);
    this.#dock.toggleAttribute("data-expanded", expanded);
    this.#renderLogoTip();
    this.#agentHelp.agent = this.#state.agent;
    this.#panel.hidden = panel === null;
    this.#panelTitle.textContent = panel ? PANEL_TITLES[panel] : "";
    // Inbox and drafts show their tabs instead of a title; the title stays for assistive technology.
    const tabbed = panel === "inbox" || panel === "drafts";
    this.#tabs.hidden = !tabbed;
    this.#panelTitle.classList.toggle("sr-only", tabbed);
    this.#inboxTab.setAttribute("aria-selected", String(panel === "inbox"));
    this.#draftsTab.setAttribute("aria-selected", String(panel === "drafts"));
    this.#inboxTab.tabIndex = panel === "drafts" ? -1 : 0;
    this.#draftsTab.tabIndex = panel === "drafts" ? 0 : -1;
    this.#tray.element.hidden = panel !== "drafts";
    this.#threads.element.hidden = panel !== "inbox";
    this.#slots.element.hidden = panel !== "variants";
    this.#agentHelp.element.hidden = panel !== "agent";
    this.#settings.element.hidden = panel !== "settings";
    if (panel === "settings") this.#renderSettings(this.#settingsWasOpen !== true);
    this.#settingsWasOpen = panel === "settings";
    // The colours the settings choose, on each of the bar's top-level boxes (the host's attributes are the page's).
    for (const box of [this.#dock, this.#composer.element]) box.dataset.theme = this.#state.theme;
    this.#pins.theme = this.#state.theme;
    this.#pins.visible = this.#state.pins;
    // An open composer keeps clear of the panel, which may just have opened or closed.
    if (this.#composer.open) this.#queuePlaceComposer();
    // Inbox, drafts and setup open as a full-height sheet on the right; variants as a popover above the toolbar.
    this.#panel.dataset.panel = panel ?? "";
    this.#panel.dataset.mode = panel === "variants" ? "popover" : "sheet";
    this.#connectionBox.hidden = panel !== "agent";
    if (panel === "variants") void this.#slots.refreshPages();
    for (const name of ["inbox", "variants", "settings", "agent"] as const) {
      const open = name === "inbox" ? panel === "inbox" || panel === "drafts" : panel === name;
      this.#panelButton(name).setAttribute("aria-expanded", String(open));
    }
    this.#applyAwake();
  }

  /**
   * Puts the logo at position `x` along the bottom edge (see {@link #layout}). Past two thirds the toolbar runs right
   * to left, so it expands away from the edge.
   */
  #setPosition(x: number): void {
    this.#dock.style.setProperty("--ib-x", String(x));
    this.#dock.dataset.align = x > 2 / 3 ? "end" : "start";
    this.#layout();
  }

  /**
   * Places the toolbar so its logo sits at the state's position, collapsed or expanded: the logo never moves when the
   * toolbar expands, and the rest grows away from it, kept inside the margins. The panel opens above, lined up with
   * the toolbar's start (its end when the toolbar runs right to left), and also kept inside the margins.
   */
  #layout(): void {
    if (!this.isConnected) return;
    const viewport = this.#viewport();
    const { anchor } = this.#anchor();
    const x = this.#drag?.moved ? positionForLeft(this.#dragLogoLeft - viewport.left, anchor, viewport.width) : this.#state.x;
    // Expanded, the toolbar grows from its logo toward the side it runs to (right, or left past two thirds). When it
    // does not fit there and fits on the other side, it runs the other way; when it fits on neither, it wraps within
    // the larger room. Either way the logo stays where it is.
    const logoLeft = leftForPosition(x, anchor, viewport.width);
    const rightRoom = viewport.width - BAR_MARGIN_PX - logoLeft;
    const leftRoom = logoLeft + anchor - BAR_MARGIN_PX;
    let end = x > 2 / 3;
    // With Variants open, the toolbar and the popover above it have one width: the toolbar's, at least the popover's
    // smallest useful width.
    const matched = !this.#panel.hidden && this.#panel.dataset.mode === "popover";
    this.#dock.style.minWidth = matched ? `${Math.min(VARIANTS_MIN_WIDTH_PX, viewport.width - 2 * BAR_MARGIN_PX)}px` : "";
    this.#dock.toggleAttribute("data-matched", matched);
    if (this.#dock.hasAttribute("data-awake")) {
      this.#dock.style.maxWidth = "";
      this.#dock.removeAttribute("data-narrow");
      let natural = this.#dock.getBoundingClientRect().width;
      // Too narrow for the whole toolbar on either side: text labels go (each control keeps its name for assistive
      // technology and its tooltip), so every control can fit a row.
      if (natural > Math.max(leftRoom, rightRoom)) {
        this.#dock.toggleAttribute("data-narrow", true);
        natural = this.#dock.getBoundingClientRect().width;
      }
      if (natural > (end ? leftRoom : rightRoom) && natural <= (end ? rightRoom : leftRoom)) end = !end;
      if (natural > Math.max(leftRoom, rightRoom)) end = leftRoom > rightRoom;
      const room = end ? leftRoom : rightRoom;
      if (natural > room) this.#dock.style.maxWidth = `${Math.max(anchor, Math.floor(room))}px`;
    } else {
      this.#dock.style.maxWidth = "";
      this.#dock.removeAttribute("data-narrow");
    }
    this.#dock.dataset.align = end ? "end" : "start";
    const width = this.#dock.getBoundingClientRect().width;
    const left = this.#dock.hasAttribute("data-awake")
      ? toolbarLeft(x, anchor, width, viewport.width, end)
      : leftForPosition(x, anchor, viewport.width);
    this.#dock.style.setProperty("--ib-left", `${Math.round(viewport.left + left)}px`);
    if (matched) {
      this.#panel.style.width = `${Math.round(width)}px`;
      this.#panel.style.left = "0px";
    } else {
      this.#panel.style.removeProperty("width");
      this.#panel.style.removeProperty("left");
    }
    if (!this.#panel.hidden && this.#panel.dataset.mode === "sheet") {
      // The sheet runs the full height on the right, stopping above the toolbar where the toolbar is under it.
      const sheet = this.#panel.getBoundingClientRect();
      const toolbar = this.#logo.parentElement!.getBoundingClientRect();
      const height = document.documentElement.clientHeight || window.innerHeight;
      const under = toolbar.right > sheet.left && toolbar.left < sheet.right;
      this.#panel.style.setProperty("--ib-sheet-bottom", `${under ? Math.round(height - toolbar.top + 8) : BAR_MARGIN_PX}px`);
    }
    if (this.#tooltipFor) this.#showTooltip(this.#tooltipFor);
    // Pins keep off the toolbar and the panel wherever they are now.
    this.#pins?.refresh();
  }

  /**
   * The collapsed toolbar's width (the logo with the toolbar's padding and border around it), which the stored position
   * places, and that inset: the expanded toolbar keeps the logo exactly where the collapsed one shows it.
   */
  #anchor(): { anchor: number; inset: number } {
    const toolbar = getComputedStyle(this.#logo.parentElement!);
    const inset = (Number.parseFloat(toolbar.paddingLeft) || 0) + (Number.parseFloat(toolbar.borderLeftWidth) || 0);
    return { anchor: this.#logo.getBoundingClientRect().width + 2 * inset, inset };
  }

  /** Where a drag has the collapsed toolbar's left edge (the logo's, less the inset), in viewport pixels. */
  #dragLogoLeft = 0;

  /**
   * The layout viewport, which the toolbar's CSS places it in (a fixed, top-layer box), in the coordinates element
   * rectangles use. Dragging, waking and tooltips measure against the same box, so a pinch-zoomed, panned view never
   * makes a drop land somewhere other than where it was shown.
   */
  #viewport(): { left: number; width: number } {
    return { left: 0, width: document.documentElement.clientWidth || window.innerWidth };
  }

  #startDrag(event: PointerEvent): void {
    if (event.button !== 0 || this.#drag) return;
    const logo = this.#logo.getBoundingClientRect();
    const { anchor, inset } = this.#anchor();
    this.#drag = { pointerId: event.pointerId, startX: event.clientX, startLeft: logo.left - inset, logoWidth: anchor, moved: false };
    try {
      this.#logo.setPointerCapture(event.pointerId);
    } catch {
      // Without capture the drag still follows the pointer while it stays over the logo.
    }
  }

  #moveDrag(event: PointerEvent): void {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      if (Math.abs(event.clientX - drag.startX) <= DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      this.#hideTooltip();
      this.#dock.toggleAttribute("data-dragging", true);
    }
    const viewport = this.#viewport();
    const min = viewport.left + BAR_MARGIN_PX;
    const max = Math.max(min, viewport.left + viewport.width - BAR_MARGIN_PX - drag.logoWidth);
    this.#dragLogoLeft = Math.min(max, Math.max(min, drag.startLeft + event.clientX - drag.startX));
    const x = positionForLeft(this.#dragLogoLeft - viewport.left, drag.logoWidth, viewport.width);
    // The toolbar's direction and the panel follow the drag as it goes, so nothing jumps when it is dropped.
    this.#dock.style.setProperty("--ib-x", String(x));
    this.#dock.dataset.align = x > 2 / 3 ? "end" : "start";
    this.#layout();
  }

  /** Ends a press on the logo; a drag (`keep`) saves where it was dropped, as a position, so it fits other widths. */
  #endDrag(event: PointerEvent, keep: boolean): void {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.#drag = null;
    if (!drag.moved) return;
    this.#dock.removeAttribute("data-dragging");
    // The release's click must not also expand or collapse the toolbar.
    this.#swallowLogoClick = true;
    setTimeout(() => {
      this.#swallowLogoClick = false;
    }, 0);
    if (keep) {
      const viewport = this.#viewport();
      const x = positionForLeft(this.#dragLogoLeft - viewport.left, drag.logoWidth, viewport.width);
      this.#saveState({ ...this.#state, x });
      this.#announce(`Toolbar moved to the ${describePosition(x)}.`);
    } else {
      this.#applyState();
    }
  }

  /** Shows the tooltip of the control under the pointer (after a delay) or with keyboard focus (at once). */
  #onTipEnter(event: Event, focus: boolean): void {
    const target = (event.composedPath()[0] as Element | undefined)?.closest?.("[data-tip]") as HTMLElement | null;
    if (!target || !this.#dock.contains(target) || this.#drag) return;
    if (target === this.#tooltipFor) return;
    if (focus && !target.matches(":focus-visible")) return;
    if (this.#tooltipTimer) clearTimeout(this.#tooltipTimer);
    // Moving from one control to the next while a tooltip shows switches it at once, as menus do.
    if (focus || this.#tooltipFor) {
      this.#showTooltip(target);
      return;
    }
    this.#tooltipTimer = setTimeout(() => this.#showTooltip(target), TOOLTIP_DELAY_MS);
  }

  #onTipLeave(event: Event): void {
    const next = (event as PointerEvent | FocusEvent).relatedTarget as Node | null;
    const target = (event.composedPath()[0] as Element | undefined)?.closest?.("[data-tip]");
    if (target && next && target.contains(next)) return;
    if (this.#tooltipTimer) clearTimeout(this.#tooltipTimer);
    this.#tooltipTimer = null;
    // Leaving for another control keeps the tooltip until that one's own enter replaces it.
    const nextTip = next instanceof Element ? next.closest("[data-tip]") : null;
    if (nextTip && this.#dock.contains(nextTip)) {
      this.#showTooltip(nextTip as HTMLElement);
      return;
    }
    this.#hideTooltip();
  }

  #showTooltip(target: HTMLElement): void {
    if (this.#tooltipTimer) clearTimeout(this.#tooltipTimer);
    this.#tooltipTimer = null;
    const label = target.dataset.tip;
    if (!label || !target.isConnected || target.closest("[hidden]")) return;
    const keys = target.dataset.tipKeys;
    const detail = target.dataset.tipDetail;
    this.#tooltip.replaceChildren(h("span", { class: "tooltip-label" }, label, ...(keys ? keys.split(" ").map((key) => h("kbd", {}, key)) : [])));
    if (detail) this.#tooltip.append(h("span", { class: "tooltip-detail" }, detail));
    if (this.#tooltipFor && this.#tooltipFor !== target) this.#tooltipFor.removeAttribute("aria-describedby");
    this.#tooltipFor = target;
    // Its label is the control's own; the explanation (when there is one) describes it.
    if (detail) target.setAttribute("aria-describedby", "iterbar-tooltip");
    this.#tooltip.hidden = false;
    const dock = this.#dock.getBoundingClientRect();
    const control = target.getBoundingClientRect();
    const tipBox = this.#tooltip.getBoundingClientRect();
    const viewport = this.#viewport();
    const centre = control.left + control.width / 2;
    const left = Math.min(viewport.left + viewport.width - BAR_MARGIN_PX - tipBox.width, Math.max(viewport.left + BAR_MARGIN_PX, centre - tipBox.width / 2));
    this.#tooltip.style.left = `${Math.round(left - dock.left)}px`;
    this.#tooltip.style.bottom = `${Math.round(dock.bottom - control.top + 8)}px`;
  }

  #hideTooltip(): void {
    if (this.#tooltipTimer) clearTimeout(this.#tooltipTimer);
    this.#tooltipTimer = null;
    this.#tooltipFor?.removeAttribute("aria-describedby");
    this.#tooltipFor = null;
    this.#tooltip.hidden = true;
  }

  /** The toolbar shows in full when expanded, with a panel or the composer open, or in comment mode. */
  #applyAwake(): void {
    const awake = this.#state.expanded || this.#state.panel !== null || this.#commentMode || this.#composer.open;
    this.#dock.toggleAttribute("data-awake", awake);
    this.#layout();
  }

  /** Arrow keys (Shift for bigger steps), Home and End on the logo move the toolbar along the bottom edge. */
  #moveWithKey(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const x = positionForKey(this.#state.x, event.key, event.shiftKey);
    if (x === null) return;
    event.preventDefault();
    if (x === this.#state.x) return;
    this.#saveState({ ...this.#state, x });
    this.#announce(`Toolbar moved to the ${describePosition(x)}.`);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [BAR_TAG]: IterbarBarElement;
  }
  interface HTMLElementEventMap {
    [COMMENT_MODE_EVENT]: CustomEvent<CommentModeEventDetail>;
  }
}

/** Registers `<iterbar-bar>` once per page; later calls (from any copy of this package) are no-ops. */
export function defineIterbarBar(): CustomElementConstructor {
  const existing = customElements.get(BAR_TAG);
  if (existing) return existing;
  customElements.define(BAR_TAG, IterbarBarElement);
  return IterbarBarElement;
}

export interface MountIterbarBarOptions {
  /** `http://127.0.0.1:<port>` of the daemon. */
  readonly daemonUrl?: string | null;
  /** The daemon's per-start token. */
  readonly token?: string | null;
  /** The project's root folder; see {@link IterbarBarElement.project}. */
  readonly project?: string | null;
  /** Where to add the bar when the page has none; defaults to `document.body`. */
  readonly target?: Element;
  /** The dev server's side (the Iterbar Vite plugin passes it): versions, the CLI, and starting the daemon again. */
  readonly devServer?: DevServerLink | null;
}

/**
 * Defines the element and shows one bar on the page: the existing `<iterbar-bar>` when there is one (given the new
 * daemon URL and token), otherwise a new one appended to `target`.
 */
export function mountIterbarBar(options: MountIterbarBarOptions = {}): IterbarBarElement {
  defineIterbarBar();
  const bar = document.querySelector(BAR_TAG) ?? document.createElement(BAR_TAG);
  if (options.project !== undefined) bar.project = options.project;
  bar.daemonUrl = options.daemonUrl ?? null;
  bar.token = options.token ?? null;
  if (options.devServer !== undefined) bar.devServer = options.devServer;
  if (!bar.isConnected) (options.target ?? document.body ?? document.documentElement).append(bar);
  return bar;
}
