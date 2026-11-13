import { h } from "./dom.js";

/** Longest comment the feedback contract accepts. */
export const MAX_COMMENT_LENGTH = 20_000;

export interface ComposerOptions {
  /** Send was pressed (or Ctrl/Cmd+Enter) with non-blank text. */
  readonly onSend: (text: string) => void;
  /** Cancel was pressed: the pick is dropped (and a send not yet posted is withdrawn), comment mode stays on. */
  readonly onCancel: () => void;
}

/**
 * The comment composer shown in the bar once an element is picked: what was picked, a text area, Send and Cancel,
 * and the last error. Picking another element keeps the text and only changes the target.
 */
export class Composer {
  readonly element: HTMLElement;
  readonly #options: ComposerOptions;
  readonly #target = h("p", { class: "composer-target", "data-role": "composer-target" });
  readonly #text = h("textarea", {
    id: "iterbar-composer-text", class: "composer-text", "data-role": "composer-text", rows: "3",
    maxlength: String(MAX_COMMENT_LENGTH), placeholder: "What should change here?",
  });
  readonly #send = h("button", { type: "button", class: "primary", "data-role": "composer-send", disabled: true }, "Send");
  readonly #cancel = h("button", { type: "button", "data-role": "composer-cancel" }, "Cancel");
  readonly #error = h("p", { class: "composer-error", role: "alert", "data-role": "composer-error", hidden: true });
  #busy = false;

  constructor(options: ComposerOptions) {
    this.#options = options;
    this.element = h("section", { class: "section composer", "data-section": "composer", "aria-label": "New comment", hidden: true },
      h("label", { class: "section-title", for: "iterbar-composer-text" }, "Comment"),
      this.#target, this.#text, this.#error,
      h("div", { class: "composer-actions" }, this.#cancel, this.#send));
    this.#text.addEventListener("input", () => this.#renderSend());
    this.#text.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
      event.preventDefault();
      this.#submit();
    });
    this.#send.addEventListener("click", () => this.#submit());
    this.#cancel.addEventListener("click", () => this.#options.onCancel());
  }

  get open(): boolean {
    return !this.element.hidden;
  }

  /** Shows the composer for the element `description` names, keeping any text already typed, and focuses it. */
  show(description: string): void {
    this.#target.textContent = `On ${description}`;
    this.element.hidden = false;
    this.#error.hidden = true;
    this.#renderSend();
    this.#text.focus();
  }

  /** Hides the composer and forgets its text and error. */
  close(): void {
    this.element.hidden = true;
    this.#text.value = "";
    this.#error.textContent = "";
    this.#error.hidden = true;
    this.setBusy(false);
  }

  /**
   * While busy (sending) the text and Send are disabled and Send says so. Cancel stays enabled unless
   * `cancellable` is `false`: once the comment is on its way to the daemon it can no longer be withdrawn.
   */
  setBusy(busy: boolean, cancellable = true): void {
    this.#busy = busy;
    this.#text.readOnly = busy;
    this.#send.textContent = busy ? "Sending…" : "Send";
    this.#cancel.disabled = busy && !cancellable;
    this.#renderSend();
  }

  showError(message: string): void {
    this.#error.textContent = message;
    this.#error.hidden = false;
  }

  #renderSend(): void {
    this.#send.disabled = this.#busy || this.#text.value.trim().length === 0;
  }

  #submit(): void {
    const text = this.#text.value;
    if (this.#busy || text.trim().length === 0) return;
    this.#error.hidden = true;
    this.#options.onSend(text);
  }
}
