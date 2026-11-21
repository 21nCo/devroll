import { SCHEMA_VERSION, type ActiveVariant, type FeedbackDraft, type FeedbackTarget, type SlotState } from "iterbar";
import { Composer } from "./composer.js";
import { DaemonConnection, DaemonRequestError, parseDaemonConfig, type ConnectionStatus } from "./connection.js";
import { h } from "./dom.js";
import { DraftTray, type DraftView } from "./drafts.js";
import { icon } from "./icons.js";
import {
  anchorPopover,
  BAR_MARGIN_PX,
  BAR_STATE_STORAGE_KEY,
  dockForKey,
  formatBarState,
  nextDock,
  parseBarState,
  type BarState,
  type Dock,
  type PanelName,
} from "./position.js";
import { reportPageUrl, SlotsPanel } from "./slots.js";
import { applyBarStyles } from "./theme.js";
import { ElementPicker } from "./pick/picker.js";
import { captureScreenshot, RenderSlot, type ScreenshotResult } from "./pick/screenshot.js";
import { describeTarget, labelElement, readActiveVariants, type TargetLabel } from "./pick/target.js";
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

const PANEL_TITLES: Readonly<Record<PanelName, string>> = { inbox: "Inbox", drafts: "Drafts", versions: "Versions" };

const DOCK_LABELS: Readonly<Record<Dock, string>> = { left: "left", center: "centre", right: "right" };

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

function readStoredState(): BarState {
  try {
    return parseBarState(localStorage.getItem(BAR_STATE_STORAGE_KEY));
  } catch {
    return parseBarState(null);
  }
}

/** A lowercase id that is unique enough for a page's batches and drafts. */
function localId(prefix: string): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replaceAll("-", "").slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
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
 * It sleeps as a compact pill (comment and inbox buttons, the open-feedback count) and wakes on hover or focus, or
 * stays expanded with Ctrl/Cmd+. ; C enters comment mode. The inbox, draft tray and versions open as a panel above it.
 */
export class IterbarBarElement extends ElementBase {
  static get observedAttributes(): string[] {
    return ["daemon-url", "token"];
  }

  readonly #root: ShadowRoot;
  readonly #dock: HTMLDivElement;
  readonly #panel: HTMLDivElement;
  readonly #panelTitle = h("h2", { class: "panel-title", id: "iterbar-panel-title" });
  readonly #panelClose = h("button", { type: "button", class: "icon", "data-role": "panel-close", "aria-label": "Close panel", title: "Close (Esc)" }, icon("close"));
  readonly #status = h("span", { class: "status", role: "status", "data-role": "status" });
  /** The connection's colour, a fixed-size dot among the sleeping pill's controls; the status text comes after them. */
  readonly #statusDot = h("span", { class: "status-dot", "aria-hidden": "true", "data-role": "status-dot" });
  readonly #detail = h("p", { class: "detail", "data-role": "status-detail", hidden: true });
  readonly #announcer = h("div", { class: "sr-only", "aria-live": "polite", "data-role": "announce" });
  readonly #comment = h("button", {
    type: "button", class: "tool", "data-role": "comment", "aria-pressed": "false",
    title: "Comment: pick an element and write a comment on it (C; Esc leaves)", "aria-label": "Comment", "aria-keyshortcuts": "C",
  }, icon("comment"));
  readonly #draftsButton = h("button", {
    type: "button", class: "tool", "data-role": "drafts-toggle", "aria-expanded": "false", "aria-controls": "iterbar-panel",
    title: "Draft tray: comments waiting to be sent together",
  }, icon("tray"));
  readonly #draftCount = h("span", { class: "count", "data-role": "draft-count", hidden: true });
  readonly #inboxButton = h("button", {
    type: "button", class: "tool", "data-role": "inbox-toggle", "aria-expanded": "false", "aria-controls": "iterbar-panel",
    title: "Inbox: feedback threads, their status and agent replies",
  }, icon("inbox"));
  readonly #openCount = h("span", { class: "count", "data-role": "open-count", hidden: true });
  readonly #versionsButton = h("button", {
    type: "button", class: "tool extra", "data-role": "versions-toggle", "aria-expanded": "false", "aria-controls": "iterbar-panel",
    title: "Versions: switch the variants of slots on this page",
  }, icon("layers"), h("span", { class: "tool-label" }, "Versions"));
  readonly #slotCount = h("span", { class: "count", "data-role": "slot-count", hidden: true });
  readonly #dockButton = h("button", {
    type: "button", class: "icon extra", "data-role": "dock", title: "Dock the toolbar left, centre or right (or press ← →)",
  }, icon("dock"));
  readonly #toggle = h("button", { type: "button", class: "icon extra", "data-role": "toggle", "aria-controls": "iterbar-toolbar" });
  /** Inherits the page's effective `zoom`, which the bar cancels; see {@link #fitZoom}. */
  readonly #zoomProbe = h("span", { class: "zoom-probe", "aria-hidden": "true" });
  #zoomObserver: ResizeObserver | null = null;
  readonly #slots: SlotsPanel;
  readonly #threads: ThreadsPanel;
  readonly #tray: DraftTray;
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
    this.#slots = new SlotsPanel({ onSlots: (slots) => this.#onSlots(slots) });
    this.#threads = new ThreadsPanel(() => this.#renderCounts(), (filter) => this.#saveState({ ...this.#state, filter }));
    this.#tray = new DraftTray({
      onSendAll: () => void this.#sendAll(),
      onRemove: (id) => this.#removeDraft(id),
      onEdit: (id, text) => this.#editDraft(id, text),
      onHighlight: (id) => this.#picker.mark(this.#drafts.find((draft) => draft.id === id)?.pick.element ?? null),
    });
    this.#draftsButton.append(this.#draftCount);
    this.#inboxButton.append(this.#openCount);
    this.#versionsButton.append(this.#slotCount);
    this.#panel = h("div", {
      class: "panel", id: "iterbar-panel", role: "region", "aria-labelledby": "iterbar-panel-title", "data-role": "panel", hidden: true,
    },
    h("div", { class: "panel-header" }, this.#panelTitle, this.#panelClose),
    h("div", { class: "panel-body" }, this.#detail, this.#tray.element, this.#threads.element, this.#slots.element));
    const toolbar = h("div", { class: "toolbar", id: "iterbar-toolbar", role: "group", "aria-label": "Iterbar toolbar" },
      // What the sleeping pill shows comes first and never changes size, so waking only adds controls beyond it (after
      // it, or before it on a right-docked toolbar) and nothing under the pointer moves. Drafts, shown asleep only
      // while there are drafts, comes after the status for the same reason.
      this.#comment, this.#inboxButton, this.#statusDot, this.#draftsButton, this.#status,
      h("span", { class: "divider extra", "aria-hidden": "true" }),
      this.#versionsButton, this.#dockButton, this.#toggle);
    this.#dock = h("div", { class: "dock bar", role: "region", "aria-label": "Iterbar", popover: "manual" }, toolbar, this.#panel);
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

    this.#toggle.addEventListener("click", () => this.#setExpanded(!this.#state.expanded));
    this.#comment.addEventListener("click", () => {
      this.commentMode = !this.#commentMode;
    });
    this.#draftsButton.addEventListener("click", () => this.#togglePanel("drafts"));
    this.#inboxButton.addEventListener("click", () => this.#togglePanel("inbox"));
    this.#versionsButton.addEventListener("click", () => this.#togglePanel("versions"));
    this.#panelClose.addEventListener("click", () => this.#closePanel(true));
    this.#dockButton.addEventListener("click", () => this.#saveState({ ...this.#state, dock: nextDock(this.#state.dock) }));
    this.#dockButton.addEventListener("keydown", (event) => this.#moveWithKey(event));
    toolbar.addEventListener("pointerenter", () => this.#holdPlace(true));
    this.addEventListener("pointerdown", (event) => {
      this.#pressesInside.add(event);
    });
    // A touch leaves as the finger lifts; a tap keeps the toolbar awake until the next tap elsewhere instead.
    this.#dock.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "touch") this.#holdPlace(false);
    });
    this.#dock.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.isComposing || this.#state.panel === null || this.#commentMode) return;
      event.preventDefault();
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

  /** Whether the full toolbar stays shown; when `false` it sleeps as a pill until hovered or focused. Ctrl/Cmd+. toggles it. */
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
    if (name === "daemon-url") this.#daemonUrl = value;
    else if (name === "token") this.#token = value;
    this.#queueReconnect();
  }

  connectedCallback(): void {
    this.#state = readStoredState();
    this.#threads.filter = this.#state.filter;
    this.#applyState();
    const pending = this.#pendingExpanded;
    this.#pendingExpanded = undefined;
    if (pending !== undefined) this.#saveState({ ...this.#state, expanded: pending });
    // Properties set on the element before it was upgraded are own properties that hide the accessors. They are
    // applied after the stored state, so an assigned `expanded` or `collapsed` wins over the saved one.
    for (const property of ["daemonUrl", "token", "commentMode", "expanded", "collapsed"] as const) {
      if (!Object.hasOwn(this, property)) continue;
      const value = (this as Record<string, unknown>)[property];
      delete (this as Record<string, unknown>)[property];
      (this as Record<string, unknown>)[property] = value;
    }
    this.#raise();
    if (this.#commentMode) {
      this.#picker.start();
      this.#setCrosshair(true);
    }
    this.#watchZoom();
    window.addEventListener("keydown", this.#onKeydown, true);
    window.addEventListener("pointerdown", this.#onPagePointerDown, true);
    window.addEventListener("resize", this.#releaseHold);
    window.visualViewport?.addEventListener("resize", this.#releaseHold);
    this.#watchUrl(true);
    this.#slots.attach();
    this.#reconnect();
  }

  disconnectedCallback(): void {
    // Leaving comment mode withdraws a screenshot still being taken (see #leavePicking).
    this.commentMode = false;
    this.#setCrosshair(false);
    this.#picker.mark(null);
    window.removeEventListener("keydown", this.#onKeydown, true);
    window.removeEventListener("pointerdown", this.#onPagePointerDown, true);
    window.removeEventListener("resize", this.#releaseHold);
    window.visualViewport?.removeEventListener("resize", this.#releaseHold);
    this.#watchUrl(false);
    this.#zoomObserver?.disconnect();
    this.#zoomObserver = null;
    this.#slots.detach();
    this.#connection?.stop();
    this.#connection = null;
    if (this.#reportTimer) clearTimeout(this.#reportTimer);
    this.#reportTimer = null;
    this.#followComposer(false);
  }

  /**
   * A press outside the toolbar ends a wake that a tap began (see the dock's pointerleave listener). Every press is
   * seen here first, in the capture phase, where a page cannot stop it; whether it was inside is decided once it has
   * been dispatched, by a listener on the bar itself, since a closed shadow root around the bar would hide the bar
   * from the event's composed path here.
   */
  readonly #pressesInside = new WeakSet<Event>();
  /** Counts presses, so only the latest one's decision counts: an earlier press never undoes what a later one did. */
  #pressCount = 0;

  readonly #onPagePointerDown = (event: PointerEvent): void => {
    const press = ++this.#pressCount;
    setTimeout(() => {
      if (press === this.#pressCount && !this.#pressesInside.has(event)) this.#holdPlace(false);
    }, 0);
  };

  /** Lets go of the place held for the pointer; the toolbar stays awake. */
  readonly #releaseHold = (): void => {
    this.#dock.removeAttribute("data-held");
    this.#dock.style.removeProperty("--ib-held-left");
    this.#dock.style.removeProperty("--ib-held-room");
  };

  readonly #onKeydown = (event: KeyboardEvent): void => {
    if (event.repeat || event.defaultPrevented) return;
    // Text fields keep both shortcuts: Ctrl/Cmd+. is an editor command in some (Quick Fix), C is a letter.
    if (isTextEntry(event.composedPath()[0])) return;
    if (isToggleShortcut(event)) {
      event.preventDefault();
      const focusInside = this.#root.activeElement !== null;
      this.#setExpanded(!this.#state.expanded);
      // Expanding moves focus into the toolbar so keyboard users can carry on; sleeping keeps focus where it was inside.
      if (this.#state.expanded || focusInside) this.#comment.focus();
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
      screenshot: captureScreenshot(element, this, this.#renderSlot, withdraw.signal),
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
    const reserved = Math.max(0, offset.top + viewport.height - this.#dock.getBoundingClientRect().top);
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

  #renderDrafts(): void {
    this.#tray.render(this.#drafts.map((draft) => ({
      id: draft.id, label: draft.pick.label, text: draft.text, state: draft.state, error: draft.error,
    })), this.#sendingBatch, this.#batchError);
    const count = this.#drafts.length;
    this.#draftCount.textContent = String(count);
    this.#draftCount.hidden = count === 0;
    this.#draftsButton.toggleAttribute("data-has", count > 0);
    this.#draftsButton.setAttribute("aria-label", count ? `Drafts, ${count} waiting` : "Drafts");
  }

  /** Updates the toolbar's open-feedback count from the inbox. */
  #renderCounts(): void {
    // The inbox renders once while it is being constructed, before it is assigned.
    if (!this.#threads) return;
    const open = this.#threads.openCount;
    this.#openCount.textContent = String(open);
    this.#openCount.hidden = open === 0;
    this.#inboxButton.setAttribute("aria-label", open ? `Inbox, ${open} open` : "Inbox");
  }

  #onSlots(slots: readonly SlotState[]): void {
    this.#slotCount.textContent = String(slots.length);
    this.#slotCount.hidden = slots.length === 0;
    this.#versionsButton.toggleAttribute("data-has", slots.length > 0);
    this.#queueReport(slots);
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
    if (refocus) this.#panelButton(panel).focus();
  }

  #panelButton(panel: PanelName): HTMLButtonElement {
    return panel === "drafts" ? this.#draftsButton : panel === "inbox" ? this.#inboxButton : this.#versionsButton;
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
    if (key !== this.#connectionKey) this.#threads.clear();
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
    const connection = new DaemonConnection(parsed.config, {
      onStatus: (status) => {
        if (this.#connection === connection) this.#renderStatus(status);
      },
      onFeedback: (item): boolean => this.#connection === connection && this.#threads.merge(item),
      onListing: (items, touched): boolean => this.#connection !== connection || this.#threads.replace(items, touched),
      isComplete: (): boolean => this.#connection !== connection || this.#threads.complete,
    });
    this.#connection = connection;
    connection.start();
    if (this.#slotsForReport) this.#queueReport(this.#slotsForReport);
  }

  #renderStatus(status: ConnectionStatus): void {
    this.#status.dataset.status = status.kind;
    this.#statusDot.dataset.status = status.kind;
    this.#statusDot.title = STATUS_TEXT[status.kind];
    this.#status.textContent = STATUS_TEXT[status.kind];
    this.#dock.dataset.status = status.kind;
    const detail = "message" in status ? status.message
      : status.kind === "unconfigured" ? "No daemon URL and token were given, so feedback is unavailable." : "";
    this.#detail.textContent = detail;
    this.#detail.hidden = !detail;
    this.#status.title = detail;
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
    // Moving the toolbar to another dock lets go of the place held for the pointer.
    if (state.dock !== this.#state.dock) {
      this.#dock.removeAttribute("data-held");
      this.#dock.style.removeProperty("--ib-held-left");
      this.#dock.style.removeProperty("--ib-held-room");
    }
    this.#state = state;
    this.#applyState();
    try {
      localStorage.setItem(BAR_STATE_STORAGE_KEY, formatBarState(state));
    } catch {
      // Without storage the state simply is not remembered.
    }
  }

  #applyState(): void {
    const { dock, expanded, panel } = this.#state;
    this.#dock.dataset.dock = dock;
    this.#dock.toggleAttribute("data-expanded", expanded);
    this.#toggle.setAttribute("aria-expanded", String(expanded));
    this.#toggle.setAttribute("aria-label", expanded ? "Let the toolbar sleep" : "Keep the toolbar expanded");
    this.#toggle.title = `${expanded ? "Sleep" : "Keep expanded"} (Ctrl/⌘+.)`;
    this.#toggle.replaceChildren(icon(expanded ? "collapse" : "expand"));
    this.#dockButton.setAttribute("aria-label", `Toolbar docked ${DOCK_LABELS[dock]}; move it`);
    this.#panel.hidden = panel === null;
    this.#panelTitle.textContent = panel ? PANEL_TITLES[panel] : "";
    this.#tray.element.hidden = panel !== "drafts";
    this.#threads.element.hidden = panel !== "inbox";
    this.#slots.element.hidden = panel !== "versions";
    for (const name of ["drafts", "inbox", "versions"] as const) {
      this.#panelButton(name).setAttribute("aria-expanded", String(panel === name));
    }
    this.#applyAwake();
  }

  /**
   * The pointer (or a tap) wakes the sleeping toolbar. Docked left or right it grows away from its edge; centred, its
   * left edge holds still while it wakes, shifting left only as far as staying in view needs, so the sleeping buttons
   * stay under the pointer.
   */
  #holdPlace(on: boolean): void {
    const dock = this.#dock;
    if (!on) {
      dock.removeAttribute("data-hovered");
      dock.removeAttribute("data-held");
      dock.style.removeProperty("--ib-held-left");
      dock.style.removeProperty("--ib-held-room");
      return;
    }
    if (dock.hasAttribute("data-hovered")) return;
    // Measured before it wakes; the dock cancels any page zoom, so its CSS pixels are viewport pixels.
    if (this.#state.dock === "center" && !dock.hasAttribute("data-awake")) {
      const left = dock.getBoundingClientRect().left;
      dock.style.setProperty("--ib-held-left", `${left}px`);
      dock.toggleAttribute("data-held", true);
      dock.toggleAttribute("data-hovered", true);
      const visual = window.visualViewport;
      // Short of room to the right, the added controls wrap onto a row above rather than moving the sleeping ones.
      const right = (visual?.offsetLeft ?? 0) + (visual?.width ?? window.innerWidth) - BAR_MARGIN_PX;
      dock.style.setProperty("--ib-held-room", `${Math.max(0, right - left)}px`);
      return;
    }
    dock.toggleAttribute("data-hovered", true);
  }

  /** The toolbar is awake (full) when expanded, with a panel or the composer open, or in comment mode. */
  #applyAwake(): void {
    const awake = this.#state.expanded || this.#state.panel !== null || this.#commentMode || this.#composer.open;
    // A panel, the composer or comment mode needs the toolbar placed as usual: the place held for the pointer goes.
    if (this.#state.panel !== null || this.#commentMode || this.#composer.open) this.#releaseHold();
    this.#dock.toggleAttribute("data-awake", awake);
  }

  #moveWithKey(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const dock = dockForKey(this.#state.dock, event.key);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") event.preventDefault();
    if (dock) this.#saveState({ ...this.#state, dock });
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
  /** Where to add the bar when the page has none; defaults to `document.body`. */
  readonly target?: Element;
}

/**
 * Defines the element and shows one bar on the page: the existing `<iterbar-bar>` when there is one (given the new
 * daemon URL and token), otherwise a new one appended to `target`.
 */
export function mountIterbarBar(options: MountIterbarBarOptions = {}): IterbarBarElement {
  defineIterbarBar();
  const bar = document.querySelector(BAR_TAG) ?? document.createElement(BAR_TAG);
  bar.daemonUrl = options.daemonUrl ?? null;
  bar.token = options.token ?? null;
  if (!bar.isConnected) (options.target ?? document.body ?? document.documentElement).append(bar);
  return bar;
}
