import type { Feedback, FeedbackStatus } from "@iterbar/core";
import { h } from "./dom.js";
import { icon, type IconName } from "./icons.js";
import { formatLabel, labelTarget, labelTooltip } from "./pick/target.js";
import type { InboxFilter } from "./position.js";
import { ThreadsState } from "./threads-state.js";

/** Most threads the bar keeps at once, newest first; older ones are counted but not listed. */
export const MAX_SHOWN_THREADS = 500;

/** Threads listed per page; "Show more" adds another page. */
export const THREADS_PAGE_SIZE = 25;

/** How long a delete can be undone before the bar asks the daemon to delete. */
export const DELETE_UNDO_MS = 6000;

/**
 * What the inbox shows for each status. `done` and `resolved` mean the same to the user (nothing is left for the
 * agent; `resolved` is the older name agents may still send), so both read "Done".
 */
const STATUS_LABELS: Readonly<Record<FeedbackStatus, string>> = {
  open: "Open",
  working: "In progress",
  "needs-info": "Needs info",
  done: "Done",
  resolved: "Done",
  archived: "Archived",
};

function summaryText(feedback: Feedback): string {
  if (feedback.kind === "choose_variant") {
    const choice = `Chose ${feedback.choice.slot}: ${feedback.choice.variant}`;
    return feedback.text.trim() ? `${choice}. ${feedback.text}` : choice;
  }
  return feedback.text;
}

/** The inbox filter a status falls under; "all" lists every filter but "archived". */
export function filterOf(status: FeedbackStatus): Exclude<InboxFilter, "all"> {
  if (status === "working") return "progress";
  if (status === "done" || status === "resolved") return "done";
  if (status === "archived") return "archived";
  return "open";
}

function inFilter(status: FeedbackStatus, filter: InboxFilter): boolean {
  const own = filterOf(status);
  return filter === "all" ? own !== "archived" : own === filter;
}

const FILTER_LABELS: Readonly<Record<InboxFilter, string>> = {
  all: "All", open: "Open", progress: "In progress", done: "Done", archived: "Archived",
};

const FILTERS: readonly InboxFilter[] = ["all", "open", "progress", "done", "archived"];

/** What the inbox can do to threads, one at a time or to a selection. */
export type ThreadAction = "done" | "reopen" | "archive" | "delete";

const ACTIONS: readonly ThreadAction[] = ["done", "reopen", "archive", "delete"];

const ACTION_LABELS: Readonly<Record<ThreadAction, string>> = {
  done: "Mark done", reopen: "Reopen", archive: "Archive", delete: "Delete",
};

const ACTION_ICONS: Readonly<Record<ThreadAction, IconName>> = {
  done: "check", reopen: "reopen", archive: "archive", delete: "trash",
};

/** The status a status action sets. */
export const ACTION_STATUS: Readonly<Record<Exclude<ThreadAction, "delete">, FeedbackStatus>> = {
  done: "done", reopen: "open", archive: "archived",
};

/** Whether `action` changes a thread with `status`; an action that would change nothing is not offered. */
export function actionApplies(action: ThreadAction, status: FeedbackStatus): boolean {
  switch (action) {
    case "done": return status !== "done" && status !== "resolved";
    case "reopen": return status === "done" || status === "resolved" || status === "archived";
    case "archive": return status !== "archived";
    case "delete": return true;
  }
}

function pagePath(pageUrl: string): string {
  try {
    const url = new URL(pageUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return pageUrl;
  }
}

function replyAuthor(reply: Feedback["replies"][number]): string {
  if (reply.author.kind !== "agent") return "You";
  return reply.author.name ? `Agent (${reply.author.name})` : "Agent";
}

function replyCount(feedback: Feedback): string {
  const count = feedback.replies.length;
  return count === 1 ? "1 reply" : `${count} replies`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One thread: a selection checkbox and a `<details>`, updated in place so its open state and focus survive updates. */
class ThreadItem {
  readonly element: HTMLLIElement;
  readonly checkbox: HTMLInputElement;
  readonly #badge = h("span", { class: "badge" });
  readonly #summary = h("span", { class: "thread-text" });
  readonly #count = h("span", { class: "thread-count" });
  readonly #content = h("div", { class: "thread-content" });
  readonly #actions = h("div", { class: "thread-actions", role: "group", "aria-label": "Thread actions" });
  readonly #onAction: (action: ThreadAction, id: string) => void;
  #rendered = "";
  readonly id: string;
  status: FeedbackStatus = "open";

  constructor(feedback: Feedback, onAction: (action: ThreadAction, id: string) => void) {
    this.id = feedback.id;
    this.#onAction = onAction;
    this.checkbox = h("input", { type: "checkbox", class: "thread-check", "data-role": "thread-select" });
    this.element = h("li", { class: "thread", "data-feedback-id": feedback.id },
      h("span", { class: "thread-gutter" }, this.checkbox),
      h("details", {},
        h("summary", {}, h("span", { class: "thread-head" }, this.#badge, this.#count), this.#summary),
        h("div", { class: "thread-body" }, this.#content, this.#actions)));
    this.update(feedback);
  }

  update(feedback: Feedback): void {
    const rendered = JSON.stringify(feedback);
    if (rendered === this.#rendered) return;
    this.#rendered = rendered;
    this.status = feedback.status;
    this.element.dataset.status = feedback.status;
    this.#badge.textContent = STATUS_LABELS[feedback.status];
    this.#badge.dataset.status = feedback.status;
    const summary = summaryText(feedback);
    this.#summary.textContent = summary;
    this.checkbox.setAttribute("aria-label", `Select: ${summary.slice(0, 80)}`);
    this.#count.textContent = replyCount(feedback);
    const label = labelTarget(feedback.target);
    const page = pagePath(feedback.pageUrl);
    const meta = [label ? formatLabel(label) : "", page !== "/" ? `Page ${page}` : ""].filter(Boolean).join(" · ");
    this.#content.replaceChildren(
      ...(meta ? [h("p", { class: "thread-meta muted", title: label ? labelTooltip(label) : "" }, meta)] : []),
      feedback.replies.length
        ? h("ol", { class: "replies", "aria-label": "Replies" }, ...feedback.replies.map((reply) => h("li", { class: "reply", "data-author": reply.author.kind },
          h("span", { class: "reply-author" }, replyAuthor(reply)),
          h("p", { class: "reply-text" }, reply.text))))
        : h("p", { class: "muted" }, "No replies yet."),
    );
    // Focus on an action that this update removes moves to the next one, so the keyboard keeps its place.
    const root = this.element.getRootNode();
    const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
    const focused = active !== null && this.#actions.contains(active);
    this.#actions.replaceChildren(...ACTIONS.filter((action) => actionApplies(action, feedback.status)).map((action) => {
      const button = h("button", {
        type: "button", class: `icon action${action === "delete" ? " danger" : ""}`, "data-action": action,
        "data-tip": ACTION_LABELS[action],
      }, icon(ACTION_ICONS[action]), h("span", {}, ACTION_LABELS[action]));
      button.addEventListener("click", () => this.#onAction(action, this.id));
      return button;
    }));
    if (focused) (this.#actions.querySelector("button") as HTMLButtonElement | null)?.focus();
  }

  set selected(value: boolean) {
    this.checkbox.checked = value;
    this.element.toggleAttribute("data-selected", value);
  }
}

export interface ThreadsPanelOptions {
  /** After every render (the toolbar shows the open count). */
  readonly onChange?: () => void;
  /** The user picked a filter, to be remembered. */
  readonly onFilter?: (filter: InboxFilter) => void;
  /** Sets `status` on every thread in `ids`; rejects with a message for the user when any failed. */
  readonly onStatus?: (ids: readonly string[], status: FeedbackStatus) => Promise<void>;
  /** Deletes the threads in `ids` for good, once their undo has run out; rejects with a message when any failed. */
  readonly onDelete?: (ids: readonly string[]) => Promise<void>;
  /** Says `text` to screen readers. */
  readonly announce?: (text: string) => void;
}

/** A drag that selects the threads it passes over, from the row it started on. */
interface DragSelect {
  readonly pointerId: number;
  readonly anchor: string;
  /** The selection before the drag, which the dragged range is added to. */
  readonly base: ReadonlySet<string>;
  active: boolean;
}

/**
 * The inbox: feedback threads, newest first, kept current from daemon listings and events. Filter pills (with their
 * counts) choose what is listed, a page at a time. Threads can be selected (checkbox, shift-click for a range,
 * Ctrl/Cmd-click, or dragging across rows) and then marked done, reopened, archived or deleted together; each thread
 * offers the same actions when opened. A delete waits {@link DELETE_UNDO_MS} with an Undo before it is sent.
 */
export class ThreadsPanel {
  readonly element: HTMLElement;
  readonly #state = new ThreadsState(MAX_SHOWN_THREADS);
  readonly #rows = new Map<string, ThreadItem>();
  readonly #filters = h("div", { class: "filters", role: "group", "aria-label": "Show threads", "data-role": "inbox-filters" });
  readonly #filterButtons = new Map<InboxFilter, HTMLButtonElement>();
  readonly #selectAll = h("input", { type: "checkbox", class: "thread-check", "data-role": "select-all", "aria-label": "Select every listed thread" });
  readonly #bulkText = h("span", { class: "bulk-text", "data-role": "inbox-count", "aria-live": "polite" });
  readonly #bulkActions = h("div", { class: "bulk-actions", role: "group", "aria-label": "Selected threads", "data-role": "bulk-actions", hidden: true });
  readonly #bulkButtons = new Map<ThreadAction, HTMLButtonElement>();
  readonly #clearSelection = h("button", {
    type: "button", class: "icon", "data-role": "clear-selection", "aria-label": "Clear selection", "data-tip": "Clear selection", "data-tip-keys": "Esc",
  }, icon("close"));
  readonly #error = h("p", { class: "inbox-error", role: "alert", "data-role": "inbox-error", hidden: true });
  readonly #undo = h("div", { class: "undo", role: "status", "data-role": "undo", hidden: true });
  readonly #list = h("ol", { class: "threads", "aria-label": "Feedback threads" });
  readonly #scroller = h("div", { class: "threads-scroller", "data-role": "threads-scroller" });
  readonly #empty = h("p", { class: "muted empty", "data-role": "threads-empty" }, "No feedback yet. Press C and pick an element to comment on it.");
  readonly #filteredEmpty = h("p", { class: "muted empty", "data-role": "threads-filtered-empty", hidden: true });
  readonly #moreButton = h("button", { type: "button", class: "more", "data-role": "threads-more", hidden: true });
  readonly #older = h("p", { class: "muted older", "data-role": "threads-older", hidden: true });
  readonly #options: ThreadsPanelOptions;
  #filter: InboxFilter = "all";
  #pages = 1;
  readonly #selected = new Set<string>();
  /** The thread a shift-click range starts from: the last one selected or unselected on its own. */
  #anchor: string | null = null;
  #drag: DragSelect | null = null;
  /** A drag-select just ended: the click its release makes must not open the row it ended on. */
  #swallowClick = false;
  /** Threads deleted but still undoable: hidden here, sent to the daemon when the undo runs out. */
  #pendingDelete: { ids: Set<string>; timer: ReturnType<typeof setTimeout> } | null = null;
  #busy = false;

  /** `options` connects the panel to the bar: counts, the remembered filter and the daemon requests for actions. */
  constructor(options: ThreadsPanelOptions = {}) {
    this.#options = options;
    for (const filter of FILTERS) {
      const button = h("button", { type: "button", class: "chip", "data-filter": filter, "aria-pressed": "false" });
      button.addEventListener("click", () => {
        this.filter = filter;
        this.#options.onFilter?.(filter);
      });
      this.#filterButtons.set(filter, button);
      this.#filters.append(button);
    }
    for (const action of ACTIONS) {
      // Icons only, so every action fits beside the count; each names itself in its tooltip and to assistive technology.
      const button = h("button", {
        type: "button", class: `icon action${action === "delete" ? " danger" : ""}`, "data-bulk": action,
        "aria-label": `${ACTION_LABELS[action]}: selected threads`, "data-tip": ACTION_LABELS[action],
        "data-tip-detail": action === "delete" ? "You can undo for a few seconds" : null,
      }, icon(ACTION_ICONS[action]));
      button.addEventListener("click", () => this.#act(action, [...this.#selected]));
      this.#bulkButtons.set(action, button);
      this.#bulkActions.append(button);
    }
    this.#bulkActions.append(this.#clearSelection);
    this.#clearSelection.addEventListener("click", () => this.clearSelection());
    this.#selectAll.addEventListener("change", () => this.#toggleAll(this.#selectAll.checked));
    this.#moreButton.addEventListener("click", () => {
      this.#pages += 1;
      this.#render();
    });
    this.#scroller.append(this.#empty, this.#filteredEmpty, this.#list, this.#moreButton, this.#older);
    this.element = h("section", { class: "section inbox", "data-section": "threads", "aria-label": "Feedback threads" },
      this.#filters,
      h("div", { class: "bulk", "data-role": "bulk" }, h("span", { class: "thread-gutter" }, this.#selectAll), this.#bulkText, this.#bulkActions),
      this.#error, this.#undo, this.#scroller);
    this.#listenForSelection();
    this.#render();
  }

  /** Which threads are listed. Changing it goes back to the first page and keeps the selection. */
  get filter(): InboxFilter {
    return this.#filter;
  }

  set filter(filter: InboxFilter) {
    if (filter === this.#filter) return;
    this.#filter = filter;
    this.#pages = 1;
    // A selection never reaches threads the user cannot see.
    this.#selected.clear();
    this.#anchor = null;
    this.#scroller.scrollTop = 0;
    this.#render();
  }

  /** Threads kept (the newest {@link MAX_SHOWN_THREADS}) that still need the agent: open, in progress or needing info. */
  get openCount(): number {
    return this.#state.shown().filter((item) => filterOf(item.status) === "open" || filterOf(item.status) === "progress").length;
  }

  /** How many threads are selected. */
  get selectionSize(): number {
    return this.#selected.size;
  }

  /** Every thread kept, newest first (the comment pins read them). */
  get threads(): readonly Feedback[] {
    return this.#state.shown();
  }

  /**
   * Shows a thread: lists it (switching to a filter that has it, and paging to it), opens it, scrolls it into view and
   * highlights it briefly. Returns whether the thread is held.
   */
  reveal(id: string): boolean {
    const item = this.#state.get(id);
    if (!item || this.#pendingDelete?.ids.has(id)) return false;
    if (!inFilter(item.status, this.#filter)) {
      this.filter = filterOf(item.status) === "archived" ? "archived" : "all";
      this.#options.onFilter?.(this.#filter);
    }
    const index = this.#filtered().findIndex((each) => each.id === id);
    if (index >= THREADS_PAGE_SIZE * this.#pages) this.#pages = Math.floor(index / THREADS_PAGE_SIZE) + 1;
    this.#render();
    const row = this.#rows.get(id);
    if (!row) return false;
    const details = row.element.querySelector("details");
    if (details) details.open = true;
    row.element.scrollIntoView({ block: "nearest" });
    row.element.toggleAttribute("data-revealed", true);
    setTimeout(() => row.element.removeAttribute("data-revealed"), 1600);
    row.element.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    return true;
  }

  clearSelection(): void {
    if (this.#selected.size === 0) return;
    this.#selected.clear();
    this.#anchor = null;
    this.#render();
  }

  /**
   * Merges an item from an event; see {@link ThreadsState.merge}. Returns whether the event's copy is current (applied,
   * or as recent as the one held) rather than stale, so it may take precedence over a listing in flight.
   */
  merge(item: Feedback): boolean {
    const result = this.#state.merge(item);
    if (result === "changed") this.#render();
    return result !== "stale";
  }

  /**
   * Replaces the threads with a complete listing; see {@link ThreadsState.applyListing}. Returns whether the listing
   * was complete, so a fresh one is needed when it was not.
   */
  replace(items: readonly Feedback[], touched: ReadonlySet<string>): boolean {
    const { changed, complete } = this.#state.applyListing(items, touched);
    if (changed) this.#render();
    return complete;
  }

  /** A thread was deleted (here or elsewhere): it goes for good. */
  remove(id: string): void {
    const had = this.#state.remove(id);
    this.#selected.delete(id);
    if (had) this.#render();
  }

  /** Whether every thread in view has its latest content; see {@link ThreadsState.complete}. */
  get complete(): boolean {
    return this.#state.complete;
  }

  /** Forgets every thread, as when the bar switches to another daemon. A delete still undoable is dropped. */
  clear(): void {
    this.#dropPendingDelete();
    this.#selected.clear();
    this.#anchor = null;
    if (this.#state.clear()) this.#render();
  }

  /** Sends a delete still waiting for its undo now, as when the page goes away. */
  flushDeletes(): void {
    const pending = this.#pendingDelete;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pendingDelete = null;
    this.#undo.hidden = true;
    void this.#sendDelete([...pending.ids]);
  }

  /** The threads the current filter lists, newest first, leaving out deletes still undoable. */
  #filtered(): Feedback[] {
    const pending = this.#pendingDelete?.ids;
    return this.#state.shown().filter((item) => !pending?.has(item.id) && inFilter(item.status, this.#filter));
  }

  #act(action: ThreadAction, ids: readonly string[]): void {
    if (this.#busy || ids.length === 0) return;
    const items = ids.map((id) => this.#state.get(id)).filter((item): item is Feedback => item !== undefined);
    const targets = items.filter((item) => actionApplies(action, item.status)).map((item) => item.id);
    if (targets.length === 0) return;
    this.#showError(null);
    if (action === "delete") {
      this.#deleteWithUndo(targets);
      return;
    }
    const status = ACTION_STATUS[action];
    const onStatus = this.#options.onStatus;
    if (!onStatus) return;
    this.#setBusy(true);
    onStatus(targets, status).then(() => {
      const done = { done: "marked done", reopen: "reopened", archive: "archived" }[action];
      this.#options.announce?.(`${plural(targets.length, "thread")} ${done}.`);
      for (const id of targets) this.#selected.delete(id);
    }, (error: unknown) => {
      this.#showError((error as Error).message);
    }).finally(() => {
      this.#setBusy(false);
      this.#render();
    });
  }

  #deleteWithUndo(ids: readonly string[]): void {
    // A second delete sends the first one's at once, so there is only ever one Undo.
    this.flushDeletes();
    const set = new Set(ids);
    for (const id of ids) this.#selected.delete(id);
    const timer = setTimeout(() => this.flushDeletes(), DELETE_UNDO_MS);
    this.#pendingDelete = { ids: set, timer };
    const undo = h("button", { type: "button", class: "link", "data-role": "undo-delete" }, "Undo");
    undo.addEventListener("click", () => {
      this.#dropPendingDelete();
      this.#options.announce?.("Delete undone.");
      this.#render();
    });
    this.#undo.replaceChildren(h("span", {}, `Deleted ${plural(ids.length, "thread")}.`), undo);
    this.#undo.hidden = false;
    this.#options.announce?.(`Deleted ${plural(ids.length, "thread")}. Undo is in the inbox for a few seconds.`);
    this.#render();
  }

  #dropPendingDelete(): void {
    const pending = this.#pendingDelete;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pendingDelete = null;
    this.#undo.hidden = true;
  }

  async #sendDelete(ids: readonly string[]): Promise<void> {
    const onDelete = this.#options.onDelete;
    if (!onDelete) return;
    try {
      await onDelete(ids);
      for (const id of ids) this.#state.remove(id);
    } catch (error) {
      this.#showError((error as Error).message);
    }
    this.#render();
  }

  #setBusy(busy: boolean): void {
    this.#busy = busy;
    this.element.toggleAttribute("data-busy", busy);
  }

  #showError(message: string | null): void {
    this.#error.textContent = message ?? "";
    this.#error.hidden = !message;
  }

  #toggleAll(on: boolean): void {
    const listed = this.#visible().map((item) => item.id);
    for (const id of listed) {
      if (on) this.#selected.add(id);
      else this.#selected.delete(id);
    }
    this.#anchor = null;
    this.#render();
  }

  /** The listed page: the first {@link THREADS_PAGE_SIZE} times the pages shown of the filtered threads. */
  #visible(): Feedback[] {
    return this.#filtered().slice(0, THREADS_PAGE_SIZE * this.#pages);
  }

  /** Selects or unselects `id`, or with `range` every listed thread from the anchor to it, to match `on`. */
  #select(id: string, on: boolean, range: boolean): void {
    const listed = this.#visible().map((item) => item.id);
    const from = range && this.#anchor !== null ? listed.indexOf(this.#anchor) : -1;
    const to = listed.indexOf(id);
    if (from >= 0 && to >= 0) {
      for (const each of listed.slice(Math.min(from, to), Math.max(from, to) + 1)) {
        if (on) this.#selected.add(each);
        else this.#selected.delete(each);
      }
    } else if (on) {
      this.#selected.add(id);
    } else {
      this.#selected.delete(id);
    }
    if (!range) this.#anchor = id;
    this.#render();
  }

  #rowOf(target: EventTarget | null | undefined): ThreadItem | null {
    const li = target instanceof Element ? target.closest("li.thread") : null;
    const id = li instanceof HTMLElement ? li.dataset.feedbackId : undefined;
    return id ? this.#rows.get(id) ?? null : null;
  }

  /**
   * Selection by pointer: the checkbox (shift for a range), Ctrl/Cmd-click or shift-click anywhere on a row's summary,
   * and dragging from one row across others, which selects every row between where it started and where it is.
   */
  #listenForSelection(): void {
    this.#list.addEventListener("click", (event) => {
      if (this.#swallowClick) {
        this.#swallowClick = false;
        event.preventDefault();
        return;
      }
      const target = event.target as Element;
      const row = this.#rowOf(target);
      if (!row) return;
      if (target === row.checkbox) {
        this.#select(row.id, row.checkbox.checked, event.shiftKey);
        return;
      }
      // Modifier clicks on the summary select instead of opening the thread.
      if (!target.closest("summary")) return;
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        this.#select(row.id, !this.#selected.has(row.id), false);
      } else if (event.shiftKey) {
        event.preventDefault();
        this.#select(row.id, true, true);
      }
    });
    this.#list.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.pointerType === "touch") return;
      const target = event.target as Element;
      const row = this.#rowOf(target);
      // Drags start on the summary or the checkbox gutter, never in a thread's opened content (text stays selectable).
      if (!row || !(target.closest("summary") || target.closest(".thread-gutter"))) return;
      this.#swallowClick = false;
      this.#drag = { pointerId: event.pointerId, anchor: row.id, base: new Set(this.#selected), active: false };
    });
    this.#list.addEventListener("pointermove", (event) => {
      const drag = this.#drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if ((event.buttons & 1) === 0) {
        this.#endDrag();
        return;
      }
      // The pointer is captured by nothing, so the row under it is the event's target.
      const row = this.#rowOf(event.target);
      if (!row) return;
      if (!drag.active) {
        if (row.id === drag.anchor) return;
        drag.active = true;
        this.#list.toggleAttribute("data-dragging", true);
        (this.element.getRootNode() as Document | ShadowRoot & { getSelection?: () => Selection | null })
          .getSelection?.()?.removeAllRanges();
      }
      event.preventDefault();
      this.#autoScroll(event.clientY);
      const listed = this.#visible().map((item) => item.id);
      const from = listed.indexOf(drag.anchor);
      const to = listed.indexOf(row.id);
      if (from < 0 || to < 0) return;
      this.#selected.clear();
      for (const id of drag.base) this.#selected.add(id);
      for (const id of listed.slice(Math.min(from, to), Math.max(from, to) + 1)) this.#selected.add(id);
      this.#anchor = drag.anchor;
      this.#render();
    });
    const finish = (event: PointerEvent): void => {
      if (!this.#drag || event.pointerId !== this.#drag.pointerId) return;
      if (this.#drag.active) {
        // The click this release makes (if any: one that ends on another row lands on the list) comes in this task.
        this.#swallowClick = true;
        setTimeout(() => {
          this.#swallowClick = false;
        }, 0);
      }
      this.#endDrag();
    };
    this.#list.addEventListener("pointerup", finish);
    this.#list.addEventListener("pointercancel", (event) => {
      finish(event);
      this.#swallowClick = false;
    });
    // A drag released outside the list still ends.
    this.element.addEventListener("pointerleave", (event) => {
      if (this.#drag && (event.buttons & 1) === 0) this.#endDrag();
    });
  }

  /** Scrolls the list while a drag-select is held near its top or bottom edge. */
  #autoScroll(y: number): void {
    const box = this.#scroller.getBoundingClientRect();
    const edge = 28;
    if (y < box.top + edge) this.#scroller.scrollTop -= 12;
    else if (y > box.bottom - edge) this.#scroller.scrollTop += 12;
  }

  #endDrag(): void {
    this.#drag = null;
    this.#list.removeAttribute("data-dragging");
  }

  #render(): void {
    const shown = this.#state.shown();
    const total = this.#state.total;
    const pending = this.#pendingDelete?.ids;
    const live = pending ? shown.filter((item) => !pending.has(item.id)) : shown;
    const liveIds = new Set(live.map((item) => item.id));
    for (const id of this.#selected) if (!liveIds.has(id)) this.#selected.delete(id);
    const filtered = this.#filtered();
    const visible = filtered.slice(0, THREADS_PAGE_SIZE * this.#pages);
    const visibleIds = new Set(visible.map((item) => item.id));
    for (const [id, row] of this.#rows) {
      if (liveIds.has(id) && visibleIds.has(id)) continue;
      row.element.remove();
      // Rows that went for good are forgotten; rows only filtered out or past the page keep their open state.
      if (!this.#state.get(id)) this.#rows.delete(id);
    }
    // Creation order never changes, so existing rows keep their places (and focus); only new rows are inserted.
    let previous: Element | null = null;
    for (const item of visible) {
      let row = this.#rows.get(item.id);
      if (row) row.update(item);
      else {
        row = new ThreadItem(item, (action, id) => this.#act(action, [id]));
        this.#rows.set(item.id, row);
      }
      row.selected = this.#selected.has(item.id);
      if (row.element.previousElementSibling !== previous || row.element.parentElement !== this.#list) {
        if (previous) previous.after(row.element);
        else this.#list.prepend(row.element);
      }
      previous = row.element;
    }
    const counts: Record<InboxFilter, number> = { all: 0, open: 0, progress: 0, done: 0, archived: 0 };
    for (const item of live) {
      const own = filterOf(item.status);
      counts[own] += 1;
      if (own !== "archived") counts.all += 1;
    }
    for (const [filter, button] of this.#filterButtons) {
      button.replaceChildren(FILTER_LABELS[filter], h("span", { class: "chip-count" }, String(counts[filter])));
      button.setAttribute("aria-pressed", String(filter === this.#filter));
      button.setAttribute("aria-label", `${FILTER_LABELS[filter]}, ${counts[filter]}`);
    }
    // Selection and the page count share one row: the count when nothing is selected, the actions when something is.
    const selected = this.#selected.size;
    const selectedItems = live.filter((item) => this.#selected.has(item.id));
    this.#bulkActions.hidden = selected === 0;
    for (const [action, button] of this.#bulkButtons) {
      const applies = selectedItems.filter((item) => actionApplies(action, item.status)).length;
      button.hidden = applies === 0;
      button.disabled = this.#busy;
    }
    this.#bulkText.textContent = selected > 0
      ? `${selected} selected`
      : filtered.length === 0 ? "" : `${visible.length} of ${filtered.length}`;
    const allVisibleSelected = visible.length > 0 && visible.every((item) => this.#selected.has(item.id));
    this.#selectAll.checked = allVisibleSelected;
    this.#selectAll.indeterminate = selected > 0 && !allVisibleSelected;
    this.#selectAll.disabled = visible.length === 0;
    this.element.toggleAttribute("data-selecting", selected > 0);
    this.#empty.hidden = live.length > 0 || total > shown.length;
    this.#filteredEmpty.hidden = live.length === 0 || filtered.length > 0;
    this.#filteredEmpty.textContent = this.#filter === "all" ? "Nothing here: every thread is archived." : `Nothing in ${FILTER_LABELS[this.#filter]}.`;
    const rest = filtered.length - visible.length;
    this.#moreButton.hidden = rest <= 0;
    this.#moreButton.textContent = `Show ${Math.min(rest, THREADS_PAGE_SIZE)} more`;
    // Only the newest threads are kept; older ones are counted so the totals stay honest.
    const older = total - shown.length;
    this.#older.hidden = older <= 0;
    this.#older.textContent = this.#state.complete
      ? `${plural(older, "older thread")} not loaded. The bar keeps the newest ${MAX_SHOWN_THREADS}.`
      : `${plural(older, "thread")} not shown yet; updating.`;
    this.#options.onChange?.();
  }
}
