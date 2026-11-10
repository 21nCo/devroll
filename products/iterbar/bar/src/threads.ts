import type { Feedback, FeedbackStatus } from "iterbar";
import { h } from "./dom.js";
import { ThreadsState } from "./threads-state.js";

/** Most threads kept and listed at once; older ones are counted but not shown. */
export const MAX_SHOWN_THREADS = 100;

const STATUS_LABELS: Readonly<Record<FeedbackStatus, string>> = {
  open: "Open",
  working: "Working",
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

function pagePath(pageUrl: string): string {
  try {
    const url = new URL(pageUrl);
    return url.pathname;
  } catch {
    return pageUrl;
  }
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

  constructor(feedback: Feedback) {
    this.element = h("li", { class: "thread", "data-feedback-id": feedback.id },
      h("details", {},
        h("summary", {}, this.#badge, this.#summary, this.#count),
        this.#body));
    this.update(feedback);
  }

  update(feedback: Feedback): void {
    const rendered = JSON.stringify(feedback);
    if (rendered === this.#rendered) return;
    this.#rendered = rendered;
    this.#badge.textContent = STATUS_LABELS[feedback.status];
    this.#badge.dataset.status = feedback.status;
    this.#summary.textContent = summaryText(feedback);
    this.#count.textContent = replyCount(feedback);
    this.#body.replaceChildren(
      h("p", { class: "thread-full" }, summaryText(feedback)),
      h("p", { class: "muted" }, pagePath(feedback.pageUrl)),
      feedback.replies.length
        ? h("ol", { class: "replies" }, ...feedback.replies.map((reply) => h("li", { class: "reply", "data-author": reply.author.kind },
          h("span", { class: "reply-author" }, reply.author.kind === "agent" ? `Agent${reply.author.name ? ` (${reply.author.name})` : ""}` : "You"),
          h("span", { class: "reply-text" }, reply.text))))
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
  readonly #list = h("ol", { class: "threads", "aria-labelledby": "iterbar-threads-title" });
  readonly #empty = h("p", { class: "muted", "data-role": "threads-empty" }, "No feedback yet.");
  readonly #more = h("p", { class: "muted", hidden: true });

  constructor() {
    this.element = h("section", { class: "section", "data-section": "threads" }, this.#heading, this.#empty, this.#list, this.#more);
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
    this.#heading.textContent = `Feedback (${total})`;
    this.#empty.hidden = total > 0;
    const hiddenCount = total - shown.length;
    this.#more.hidden = hiddenCount === 0;
    this.#more.textContent = this.#state.complete ? `${hiddenCount} older not shown.` : `${hiddenCount} not shown; updating.`;
  }
}
