import { SCHEMA_VERSION, type ActiveVariant, type FeedbackDraft, type FeedbackTarget, type SlotState } from "iterbar";
import { Composer } from "./composer.js";
import { DaemonConnection, parseDaemonConfig, type ConnectionStatus } from "./connection.js";
import { h } from "./dom.js";
import {
  BAR_STATE_STORAGE_KEY,
  edgeForKey,
  formatBarState,
  parseBarState,
  placementForDrop,
  type BarState,
} from "./position.js";
import { reportPageUrl, SlotsPanel } from "./slots.js";
import { applyBarStyles } from "./theme.js";
import { ElementPicker } from "./pick/picker.js";
import { captureScreenshot, type ScreenshotResult } from "./pick/screenshot.js";
import { describeElement, describeTarget, readActiveVariants } from "./pick/target.js";
import { ThreadsPanel } from "./threads.js";

/** The bar's tag name. */
export const BAR_TAG = "iterbar-bar";

/** Dispatched on the bar (bubbling, composed) when comment mode turns on or off; `detail.active` is the new state. */
export const COMMENT_MODE_EVENT = "iterbar-comment-mode";

export interface CommentModeEventDetail {
  readonly active: boolean;
}

/** Pointer travel, in CSS pixels, before pressing the handle becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

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

function isToggleShortcut(event: KeyboardEvent): boolean {
  // `code`, not `key`: with Alt held, macOS turns the I key into another character.
  return event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "KeyI";
}

function readStoredState(): BarState {
  try {
    return parseBarState(localStorage.getItem(BAR_STATE_STORAGE_KEY));
  } catch {
    return parseBarState(null);
  }
}

// Lets the module load where there is no DOM (a server render importing it by accident); defining the element
// still needs a browser.
const ElementBase: typeof HTMLElement = (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement
  ?? (class {} as unknown as typeof HTMLElement);

/** A picked element, described when it was picked so the comment matches what the user saw. */
interface Pick {
  readonly target: FeedbackTarget | null;
  /** The page URL as slot reports file it, or `null` for a page the contract cannot name (such as `file:`). */
  readonly pageUrl: string | null;
  readonly activeVariants: readonly ActiveVariant[];
  /** Captured when Send is first pressed, so picks that are never sent take no screenshot. */
  readonly element: Element;
  /** The capture for this pick, kept for a send retried after a refusal; it never rejects. */
  screenshot: Promise<ScreenshotResult> | null;
  /** Aborted when the pick is replaced, cancelled or left: a screenshot still being taken for it stops. */
  readonly withdraw: AbortController;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly left: number;
  readonly top: number;
  moved: boolean;
}

/**
 * `<iterbar-bar>`: the Iterbar dev bar. Give it the daemon's URL and token through the `daemonUrl` and `token`
 * properties (or the `daemon-url` and `token` attributes); without them it still switches slots, but shows no
 * feedback. Everything it renders lives in its shadow root.
 */
export class IterbarBarElement extends ElementBase {
  static get observedAttributes(): string[] {
    return ["daemon-url", "token"];
  }

  readonly #root: ShadowRoot;
  readonly #bar: HTMLDivElement;
  readonly #body: HTMLDivElement;
  readonly #status = h("span", { class: "status", role: "status", "data-role": "status" });
  readonly #detail = h("p", { class: "detail", "data-role": "status-detail", hidden: true });
  readonly #handle = h("button", {
    type: "button", class: "icon handle", "data-role": "handle", "aria-label": "Move Iterbar",
    title: "Drag to a screen edge, or press an arrow key to move to that edge",
  }, "⠿");
  readonly #toggle = h("button", { type: "button", class: "icon", "data-role": "toggle", "aria-controls": "iterbar-body" });
  readonly #comment = h("button", {
    type: "button", "data-role": "comment", "aria-pressed": "false", title: "Comment mode: click an element to comment on it (Esc leaves)",
  }, "Comment");
  /** Inherits the page's effective `zoom`, which the bar cancels; see {@link #fitZoom}. */
  readonly #zoomProbe = h("span", { class: "zoom-probe", "aria-hidden": "true" });
  #zoomObserver: ResizeObserver | null = null;
  readonly #slots: SlotsPanel;
  readonly #threads = new ThreadsPanel();
  readonly #composer = new Composer({
    onSend: (text) => void this.#send(text),
    onCancel: () => this.#cancelPick(),
  });
  readonly #picker: ElementPicker;
  #pick: Pick | null = null;
  /** The pick whose comment is being sent; another element cannot be picked meanwhile. */
  #sendingPick: Pick | null = null;
  /**
   * The pick whose comment has been posted to the daemon and not yet answered. It can no longer be withdrawn, so
   * Cancel is disabled and leaving comment mode keeps the composer open, saying "Sending…", until the answer.
   */
  #postingPick: Pick | null = null;
  #daemonUrl: string | null = null;
  #token: string | null = null;
  #connection: DaemonConnection | null = null;
  /** The daemon URL and token `#connection` was opened with. */
  #connectionKey: string | null = null;
  #reconnectQueued = false;
  #state: BarState = parseBarState(null);
  /** A `collapsed` assigned while disconnected, applied over the stored state on the next connection. */
  #pendingCollapsed: boolean | undefined;
  #commentMode = false;
  #slotsForReport: readonly SlotState[] | null = null;
  #reportTimer: ReturnType<typeof setTimeout> | null = null;
  /** The page URL of the last slot report, so a single-page navigation that keeps the slots is reported too. */
  #reportedUrl: string | null = null;
  #urlPoll: ReturnType<typeof setInterval> | null = null;
  #drag: DragState | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });
    applyBarStyles(this.#root);
    this.#slots = new SlotsPanel({ onSlots: (slots) => this.#queueReport(slots) });
    this.#body = h("div", { class: "body", id: "iterbar-body" },
      this.#detail, this.#composer.element, this.#slots.element, this.#threads.element);
    this.#bar = h("div", { class: "bar", role: "region", "aria-label": "Iterbar", popover: "manual" },
      h("div", { class: "header" },
        this.#handle, h("span", { class: "title" }, "Iterbar"), this.#status, this.#comment, this.#toggle),
      this.#body);
    this.#root.append(this.#zoomProbe, this.#bar);
    this.#picker = new ElementPicker({
      host: this,
      container: this.#root,
      onPick: (element) => this.#onPick(element),
      onEscape: () => {
        this.commentMode = false;
      },
    });

    this.#toggle.addEventListener("click", () => this.#setCollapsed(!this.#state.collapsed));
    this.#comment.addEventListener("click", () => {
      this.commentMode = !this.#commentMode;
    });
    this.#handle.addEventListener("keydown", (event) => this.#moveWithKey(event));
    this.#handle.addEventListener("pointerdown", (event) => this.#dragStart(event));
    this.#handle.addEventListener("pointermove", (event) => this.#dragMove(event));
    this.#handle.addEventListener("pointerup", (event) => this.#dragEnd(event, true));
    this.#handle.addEventListener("pointercancel", (event) => this.#dragEnd(event, false));
    this.#applyState();
    this.#renderStatus({ kind: "unconfigured" });
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
   * Whether comment mode is on: hovering outlines page elements and clicking one opens the composer instead of
   * reaching the page. Escape turns it off, as does sending a comment. Changing it dispatches {@link COMMENT_MODE_EVENT}.
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
    this.dispatchEvent(new CustomEvent<CommentModeEventDetail>(COMMENT_MODE_EVENT, {
      bubbles: true, composed: true, detail: { active },
    }));
  }

  /** Whether only the header is shown. Alt+Shift+I toggles it from anywhere on the page. */
  get collapsed(): boolean {
    return this.#state.collapsed;
  }

  set collapsed(value: boolean) {
    const collapsed = Boolean(value);
    if (this.isConnected) {
      this.#setCollapsed(collapsed);
      return;
    }
    // The stored state is read on connection and would replace this, so remember it, even when it equals the default.
    this.#pendingCollapsed = collapsed;
    this.#state = { ...this.#state, collapsed };
    this.#applyState();
  }

  attributeChangedCallback(name: string, _previous: string | null, value: string | null): void {
    if (name === "daemon-url") this.#daemonUrl = value;
    else if (name === "token") this.#token = value;
    this.#queueReconnect();
  }

  connectedCallback(): void {
    this.#state = readStoredState();
    this.#applyState();
    const pending = this.#pendingCollapsed;
    this.#pendingCollapsed = undefined;
    if (pending !== undefined) this.#saveState({ ...this.#state, collapsed: pending });
    // Properties set on the element before it was upgraded are own properties that hide the accessors. They are
    // applied after the stored state, so an assigned `collapsed` wins over the saved one.
    for (const property of ["daemonUrl", "token", "commentMode", "collapsed"] as const) {
      if (!Object.hasOwn(this, property)) continue;
      const value = (this as Record<string, unknown>)[property];
      delete (this as Record<string, unknown>)[property];
      (this as Record<string, unknown>)[property] = value;
    }
    this.#raise();
    if (this.#commentMode) this.#picker.start();
    this.#watchZoom();
    window.addEventListener("keydown", this.#onKeydown, true);
    this.#watchUrl(true);
    this.#slots.attach();
    this.#reconnect();
  }

  disconnectedCallback(): void {
    this.commentMode = false;
    window.removeEventListener("keydown", this.#onKeydown, true);
    this.#watchUrl(false);
    this.#zoomObserver?.disconnect();
    this.#zoomObserver = null;
    this.#slots.detach();
    this.#connection?.stop();
    this.#connection = null;
    if (this.#reportTimer) clearTimeout(this.#reportTimer);
    this.#reportTimer = null;
    this.#cancelDrag();
  }

  readonly #onKeydown = (event: KeyboardEvent): void => {
    if (!isToggleShortcut(event) || event.repeat) return;
    event.preventDefault();
    const focusInside = this.#root.activeElement !== null;
    this.#setCollapsed(!this.#state.collapsed);
    // Expanding moves focus into the bar so keyboard users can carry on; collapsing keeps focus off hidden controls.
    if (!this.#state.collapsed || focusInside) this.#toggle.focus();
  };

  /** Takes a click in comment mode; refused while the current pick's comment is being sent. */
  #onPick(element: Element): boolean {
    if (this.#sendingPick !== null && this.#sendingPick === this.#pick) return false;
    this.#pick?.withdraw.abort();
    this.#pick = {
      target: describeTarget(element),
      pageUrl: /^https?:$/.test(location.protocol) ? reportPageUrl(location.href) : null,
      activeVariants: readActiveVariants(),
      element,
      screenshot: null,
      withdraw: new AbortController(),
    };
    this.#setCollapsed(false);
    this.#composer.show(describeElement(element));
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
    if (focused && this.#composer.element.contains(focused)) this.#comment.focus();
  }

  /**
   * Sends a comment on the current pick, with its screenshot or the reason there is none. On success the thread is
   * shown and comment mode ends; on failure the composer keeps the text and shows why. The screenshot is taken at the
   * first Send; Cancel or Escape while it is being taken stops it and withdraws the comment before anything is posted.
   */
  async #send(text: string): Promise<void> {
    const pick = this.#pick;
    if (!pick || this.#sendingPick === pick) return;
    const connection = this.#connection;
    if (!connection) {
      this.#composer.showError("Comments need the Iterbar daemon, and the bar has none. Start the dev server with the Iterbar plugin.");
      return;
    }
    if (pick.pageUrl === null) {
      this.#composer.showError("This page's URL is not http or https, so the daemon cannot file a comment for it.");
      return;
    }
    this.#sendingPick = pick;
    this.#composer.setBusy(true);
    try {
      pick.screenshot ??= captureScreenshot(pick.element, this, pick.withdraw.signal);
      const screenshot = await pick.screenshot;
      // Cancelled, Escaped or replaced while the screenshot was being taken: the comment was withdrawn.
      if (this.#pick !== pick) return;
      const draft: FeedbackDraft = {
        schemaVersion: SCHEMA_VERSION,
        kind: "comment",
        text,
        pageUrl: pick.pageUrl,
        target: pick.target,
        activeVariants: [...pick.activeVariants],
        screenshotUnavailableReason: screenshot.ok ? null : screenshot.reason,
        evidenceWindow: null,
      };
      this.#postingPick = pick;
      this.#composer.setBusy(true, false);
      const feedback = await connection.sendFeedback(draft, screenshot.ok ? screenshot.png : null);
      this.#postingPick = null;
      if (this.#connection === connection) this.#threads.merge(feedback);
      this.#finishPick(pick);
    } catch (error) {
      if (this.#pick === pick) this.#composer.showError((error as Error).message);
    } finally {
      if (this.#postingPick === pick) this.#postingPick = null;
      if (this.#sendingPick === pick) this.#sendingPick = null;
      if (this.#pick === pick) this.#composer.setBusy(false);
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
   * Shows the bar in the top layer, outside every page stacking context and containing block, so a `transform`,
   * `filter`, `opacity`, `contain` or `will-change` on an ancestor cannot move, clip or hide it. Removing the element
   * from the page takes it out of the top layer, so this runs on every connect. Without popover support the bar stays
   * an ordinary fixed-position element.
   */
  #raise(): void {
    const bar = this.#bar;
    if (typeof bar.showPopover !== "function" || bar.matches(":popover-open")) return;
    try {
      bar.showPopover();
    } catch {
      // Left as a fixed-position element.
    }
  }

  /** The top layer still inherits `zoom`, so the bar and the pick layer apply the inverse of what the page gives them. */
  #fitZoom(): void {
    const zoom = (this.#zoomProbe as { currentCSSZoom?: number }).currentCSSZoom;
    if (typeof zoom !== "number" || !Number.isFinite(zoom) || zoom <= 0) return;
    const inverse = zoom === 1 ? "" : String(1 / zoom);
    this.#bar.style.zoom = inverse;
    // The pick layer outlines viewport rectangles, so it cancels the inherited zoom too.
    this.#picker.setZoom(inverse);
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
    const key = JSON.stringify([this.#daemonUrl, this.#token]);
    if (this.#connection && key === this.#connectionKey) return;
    this.#connection?.stop();
    this.#connection = null;
    // Threads belong to the daemon that listed them; another daemon (or none) must not show them.
    if (key !== this.#connectionKey) this.#threads.clear();
    this.#connectionKey = key;
    const parsed = parseDaemonConfig(this.#daemonUrl, this.#token);
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
    this.#status.textContent = STATUS_TEXT[status.kind];
    const detail = "message" in status ? status.message
      : status.kind === "unconfigured" ? "No daemon URL and token were given, so feedback is unavailable." : "";
    this.#detail.textContent = detail;
    this.#detail.hidden = !detail;
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

  #setCollapsed(collapsed: boolean): void {
    if (collapsed === this.#state.collapsed) return;
    this.#saveState({ ...this.#state, collapsed });
  }

  #saveState(state: BarState): void {
    this.#state = state;
    this.#applyState();
    try {
      localStorage.setItem(BAR_STATE_STORAGE_KEY, formatBarState(state));
    } catch {
      // Without storage the position simply is not remembered.
    }
  }

  #applyState(): void {
    const { edge, offset, collapsed } = this.#state;
    this.#bar.dataset.edge = edge;
    this.#bar.style.setProperty("--ib-offset", String(offset));
    this.#bar.toggleAttribute("data-collapsed", collapsed);
    this.#body.hidden = collapsed;
    this.#toggle.setAttribute("aria-expanded", String(!collapsed));
    this.#toggle.setAttribute("aria-label", collapsed ? "Expand Iterbar" : "Collapse Iterbar");
    this.#toggle.title = `${collapsed ? "Expand" : "Collapse"} (Alt+Shift+I)`;
    this.#toggle.textContent = collapsed ? "▴" : "▾";
  }

  #moveWithKey(event: KeyboardEvent): void {
    const edge = edgeForKey(event.key);
    if (!edge || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    if (edge !== this.#state.edge) this.#saveState({ ...this.#state, edge });
  }

  #dragStart(event: PointerEvent): void {
    if (event.button !== 0 || this.#drag) return;
    const box = this.#bar.getBoundingClientRect();
    this.#drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: box.left, top: box.top, moved: false };
    this.#handle.setPointerCapture(event.pointerId);
  }

  #dragMove(event: PointerEvent): void {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    this.#bar.toggleAttribute("data-dragging", true);
    this.#bar.style.setProperty("--ib-drag-left", `${drag.left + dx}px`);
    this.#bar.style.setProperty("--ib-drag-top", `${drag.top + dy}px`);
  }

  #dragEnd(event: PointerEvent, drop: boolean): void {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const box = this.#bar.getBoundingClientRect();
    this.#cancelDrag();
    if (!drop || !drag.moved) return;
    const placement = placementForDrop(box, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
    this.#saveState({ ...this.#state, ...placement });
  }

  #cancelDrag(): void {
    const drag = this.#drag;
    this.#drag = null;
    this.#bar.removeAttribute("data-dragging");
    this.#bar.style.removeProperty("--ib-drag-left");
    this.#bar.style.removeProperty("--ib-drag-top");
    if (drag && this.#handle.hasPointerCapture(drag.pointerId)) this.#handle.releasePointerCapture(drag.pointerId);
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
