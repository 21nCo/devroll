import { h } from "./dom.js";
import { formatLabel, labelTooltip, type TargetLabel } from "./pick/target.js";

/** Longest comment the feedback contract accepts. */
export const MAX_COMMENT_LENGTH = 20_000;

export interface ComposerOptions {
  /** Send was pressed (or Ctrl/Cmd+Shift+Enter) with non-blank text: the comment goes to the daemon now, on its own. */
  readonly onSend: (text: string) => void;
  /** Add draft was pressed (or Ctrl/Cmd+Enter) with non-blank text: the comment joins the draft tray. */
  readonly onDraft: (text: string) => void;
  /** Cancel was pressed: the pick is dropped (and a send not yet posted is withdrawn), comment mode stays on. */
  readonly onCancel: () => void;
}

/** Whether `event` is Ctrl+Enter or Cmd+Enter (with or without Shift), outside an input method composition. */
function isSubmitKey(event: KeyboardEvent): boolean {
  return event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing;
}

/**
 * The comment composer: a small popover anchored to the picked element, with what was picked, a text area, Cancel,
 * Send and Add draft, and the last error. Picking another element keeps the text and only changes the target.
 */
export class Composer {
  readonly element: HTMLElement;
  readonly #options: ComposerOptions;
  readonly #target = h("p", { class: "composer-target", "data-role": "composer-target" });
  readonly #text = h("textarea", {
    id: "iterbar-composer-text", class: "composer-text", "data-role": "composer-text", rows: "3",
    maxlength: String(MAX_COMMENT_LENGTH), placeholder: "What should change here?",
    "aria-describedby": "iterbar-composer-hint",
  });
  readonly #send = h("button", {
    type: "button", "data-role": "composer-send", disabled: true, title: "Send this comment now, on its own (Ctrl/⌘+Shift+Enter)",
  }, "Send");
  readonly #draft = h("button", {
    type: "button", class: "primary", "data-role": "composer-draft", disabled: true,
    title: "Add to the draft tray and pick the next element (Ctrl/⌘+Enter)",
  }, "Add draft");
  readonly #cancel = h("button", { type: "button", "data-role": "composer-cancel" }, "Cancel");
  readonly #error = h("p", { class: "composer-error", role: "alert", "data-role": "composer-error", hidden: true });
  #busy = false;

  constructor(options: ComposerOptions) {
    this.#options = options;
    this.element = h("section", {
      class: "composer", "data-section": "composer", role: "dialog", "aria-label": "Comment on the picked element",
      popover: "manual", hidden: true,
    },
    h("label", { class: "section-title", for: "iterbar-composer-text" }, "Comment"),
    this.#target, this.#text, this.#error,
    h("p", { class: "composer-hint muted", id: "iterbar-composer-hint" }, "⌘/Ctrl+Enter adds a draft · ⌘/Ctrl+Shift+Enter sends now"),
    h("div", { class: "composer-actions" }, this.#cancel, h("span", { class: "spacer" }), this.#send, this.#draft));
    this.#text.addEventListener("input", () => this.#renderButtons());
    this.#text.addEventListener("keydown", (event) => {
      if (!isSubmitKey(event)) return;
      event.preventDefault();
      this.#submit(event.shiftKey ? "send" : "draft");
    });
    this.#send.addEventListener("click", () => this.#submit("send"));
    this.#draft.addEventListener("click", () => this.#submit("draft"));
    this.#cancel.addEventListener("click", () => this.#options.onCancel());
  }

  get open(): boolean {
    return !this.element.hidden;
  }

  /** Shows the composer for the element `label` names, keeping any text already typed, and focuses it. */
  show(label: TargetLabel): void {
    this.#target.textContent = `On ${formatLabel(label)}`;
    this.#target.title = labelTooltip(label);
    this.element.hidden = false;
    if (typeof this.element.showPopover === "function" && !this.element.matches(":popover-open")) {
      try {
        this.element.showPopover();
      } catch {
        // Left as a fixed-position element.
      }
    }
    this.#error.hidden = true;
    this.#renderButtons();
    this.#text.focus();
  }

  /** Puts the composer's top-left corner at viewport coordinates. */
  moveTo(left: number, top: number): void {
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }

  /** Hides the composer and forgets its text and error. */
  close(): void {
    if (typeof this.element.hidePopover === "function" && this.element.matches(":popover-open")) this.element.hidePopover();
    this.element.hidden = true;
    this.#text.value = "";
    this.#error.textContent = "";
    this.#error.hidden = true;
    this.setBusy(false);
  }

  /**
   * While busy (sending) the text and both submit buttons are disabled and Send says so. Cancel stays enabled unless
   * `cancellable` is `false`: once the comment is on its way to the daemon it can no longer be withdrawn.
   */
  setBusy(busy: boolean, cancellable = true): void {
    this.#busy = busy;
    this.#text.readOnly = busy;
    this.#send.textContent = busy ? "Sending…" : "Send";
    this.#cancel.disabled = busy && !cancellable;
    this.#renderButtons();
  }

  showError(message: string): void {
    this.#error.textContent = message;
    this.#error.hidden = false;
  }

  #renderButtons(): void {
    const blank = this.#text.value.trim().length === 0;
    this.#send.disabled = this.#busy || blank;
    this.#draft.disabled = this.#busy || blank;
  }

  #submit(how: "send" | "draft"): void {
    const text = this.#text.value;
    if (this.#busy || text.trim().length === 0) return;
    this.#error.hidden = true;
    if (how === "send") this.#options.onSend(text);
    else this.#options.onDraft(text);
  }
}
