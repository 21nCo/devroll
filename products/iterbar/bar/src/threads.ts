import type { Feedback, FeedbackStatus } from "iterbar";
import { h } from "./dom.js";
import { formatLabel, labelTarget, labelTooltip } from "./pick/target.js";
import type { InboxFilter } from "./position.js";
import { ThreadsState } from "./threads-state.js";

/** Most threads kept and listed at once; older ones are counted but not shown. */
export const MAX_SHOWN_THREADS = 100;

const STATUS_LABELS: Readonly<Record<FeedbackStatus, string>> = {
  open: "Open",
  working: "In progress",
  "needs-info": "Needs info",
  done: "Done",
  resolved: "Resolved",
};

function summaryText(feedback: Feedback): string {
  if (feedback.kind === "choose_variant") {
    const choice = `Chose ${feedback.choice.slot}: ${feedback.choice.version}`;
    return feedback.text.trim() ? `${choice}. ${feedback.text}` : choice;
  }
  return feedback.text;
}

/** The inbox filter a status falls under. */
export function filterOf(status: FeedbackStatus): Exclude<InboxFilter, "all"> {
  if (status === "working") return "progress";
  if (status === "done" || status === "resolved") return "done";
  return "open";
}

const FILTER_LABELS: Readonly<Record<InboxFilter, string>> = { all: "All", open: "Open", progress: "In progress", done: "Done" };

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

/** One `<details>` per thread, updated in place so its open state and focus survive updates. */
class ThreadItem {
  readonly element: HTMLLIElement;
  readonly #badge = h("span", { class: "badge" });
  readonly #summary = h("span", { class: "thread-text" });
  readonly #count = h("span", { class: "thread-count" });
  readonly #body = h("div", { class: "thread-body" });
  #rendered = "";
  status: FeedbackStatus = "open";

  constructor(feedback: Feedback) {
    this.element = h("li", { class: "thread", "data-feedback-id": feedback.id },
      h("details", {},
        h("summary", {}, h("span", { class: "thread-head" }, this.#badge, this.#count), this.#summary),
        this.#body));
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
    this.#summary.textContent = summaryText(feedback);
    this.#count.textContent = replyCount(feedback);
    const label = labelTarget(feedback.target);
    const page = pagePath(feedback.pageUrl);
    const meta = [label ? formatLabel(label) : "", page !== "/" ? `Page ${page}` : ""].filter(Boolean).join(" · ");
    this.#body.replaceChildren(
      ...(meta ? [h("p", { class: "thread-meta muted", title: label ? labelTooltip(label) : "" }, meta)] : []),
      feedback.replies.length
        ? h("ol", { class: "replies", "aria-label": "Replies" }, ...feedback.replies.map((reply) => h("li", { class: "reply", "data-author": reply.author.kind },
          h("span", { class: "reply-author" }, replyAuthor(reply)),
          h("p", { class: "reply-text" }, reply.text))))
        : h("p", { class: "muted" }, "No replies yet."),
    );
  }
}

/** The feedback threads, newest first, kept current from daemon listings and events. */
export class ThreadsPanel {
  readonly element: HTMLElement;
  readonly #state = new ThreadsState(MAX_SHOWN_THREADS);
  readonly #rows = new Map<string, ThreadItem>();
  readonly #heading = h("h2", { class: "section-title", id: "iterbar-threads-title" }, "Feedback");
  readonly #filters = h("div", { class: "filters", role: "group", "aria-label": "Show threads", "data-role": "inbox-filters" });
  readonly #filterButtons = new Map<InboxFilter, HTMLButtonElement>();
  readonly #list = h("ol", { class: "threads", "aria-labelledby": "iterbar-threads-title" });
  readonly #empty = h("p", { class: "muted", "data-role": "threads-empty" }, "No feedback yet.");
  readonly #filteredEmpty = h("p", { class: "muted", "data-role": "threads-filtered-empty", hidden: true });
  readonly #more = h("p", { class: "muted", hidden: true });
  readonly #onChange: () => void;
  readonly #onFilter: (filter: InboxFilter) => void;
  #filter: InboxFilter = "all";

  /** `onChange` runs after every render (the toolbar shows the open count); `onFilter` when the user picks a filter. */
  constructor(onChange: () => void = () => undefined, onFilter: (filter: InboxFilter) => void = () => undefined) {
    this.#onChange = onChange;
    this.#onFilter = onFilter;
    for (const filter of ["all", "open", "progress", "done"] as const) {
      const button = h("button", { type: "button", class: "chip", "data-filter": filter, "aria-pressed": "false" });
      button.addEventListener("click", () => {
        this.filter = filter;
        this.#onFilter(filter);
      });
      this.#filterButtons.set(filter, button);
      this.#filters.append(button);
    }
    this.element = h("section", { class: "section", "data-section": "threads" },
      this.#heading, this.#filters, this.#empty, this.#filteredEmpty, this.#list, this.#more);
    this.#render();
  }

  /** Which threads are listed. */
  get filter(): InboxFilter {
    return this.#filter;
  }

  set filter(filter: InboxFilter) {
    if (filter === this.#filter) return;
    this.#filter = filter;
    this.#render();
  }

  /** Threads shown (the newest {@link MAX_SHOWN_THREADS}) that still need the agent: open, in progress or needing info. */
  get openCount(): number {
    return this.#state.shown().filter((item) => filterOf(item.status) !== "done").length;
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

  /** Whether every thread in view has its latest content; see {@link ThreadsState.complete}. */
  get complete(): boolean {
    return this.#state.complete;
  }

  /** Forgets every thread, as when the bar switches to another daemon. */
  clear(): void {
    if (this.#state.clear()) this.#render();
  }

  #render(): void {
    const shown = this.#state.shown();
    const total = this.#state.total;
    const shownIds = new Set(shown.map((item) => item.id));
    for (const [id, row] of this.#rows) {
      if (shownIds.has(id)) continue;
      row.element.remove();
      this.#rows.delete(id);
    }
    // Creation order never changes, so existing rows keep their places (and focus); only new rows are inserted.
    let previous: Element | null = null;
    for (const item of shown) {
      let row = this.#rows.get(item.id);
      if (row) row.update(item);
      else {
        row = new ThreadItem(item);
        this.#rows.set(item.id, row);
      }
      if (row.element.previousElementSibling !== previous || row.element.parentElement !== this.#list) {
        if (previous) previous.after(row.element);
        else this.#list.prepend(row.element);
      }
      previous = row.element;
    }
    const counts: Record<InboxFilter, number> = { all: shown.length, open: 0, progress: 0, done: 0 };
    for (const item of shown) counts[filterOf(item.status)] += 1;
    for (const [filter, button] of this.#filterButtons) {
      button.textContent = `${FILTER_LABELS[filter]} ${counts[filter]}`;
      button.setAttribute("aria-pressed", String(filter === this.#filter));
    }
    for (const row of this.#rows.values()) row.element.hidden = this.#filter !== "all" && filterOf(row.status) !== this.#filter;
    this.#heading.textContent = `Feedback (${total})`;
    this.#empty.hidden = total > 0;
    this.#filteredEmpty.hidden = total === 0 || this.#filter === "all" || counts[this.#filter] > 0;
    // Only the newest threads are held, so an empty filter says so when older ones are not shown.
    this.#filteredEmpty.textContent = total > shown.length
      ? `Nothing ${FILTER_LABELS[this.#filter].toLowerCase()} among the newest ${shown.length}.`
      : `Nothing ${FILTER_LABELS[this.#filter].toLowerCase()}.`;
    const hiddenCount = total - shown.length;
    this.#more.hidden = hiddenCount === 0;
    this.#more.textContent = this.#state.complete ? `${hiddenCount} older not shown.` : `${hiddenCount} not shown; updating.`;
    this.#onChange();
  }
}
