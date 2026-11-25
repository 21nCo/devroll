import { MAX_COMMENT_LENGTH } from "./composer.js";
import { h } from "./dom.js";
import { formatLabel, labelTooltip, type TargetLabel } from "./pick/target.js";

/** A comment waiting in the tray, as the tray shows it. */
export interface DraftView {
  readonly id: string;
  readonly label: TargetLabel;
  readonly text: string;
  /** `sent` drafts have left the tray; `failed` ones stay with the reason. */
  readonly state: "draft" | "sending" | "failed";
  readonly error: string | null;
}

export interface DraftTrayOptions {
  /** Send all was pressed. */
  readonly onSendAll: () => void;
  readonly onRemove: (id: string) => void;
  /** A draft's text was edited and saved (never blank). */
  readonly onEdit: (id: string, text: string) => void;
  /** The pointer or focus is on a draft (outline its element), or left the list (`null`). */
  readonly onHighlight: (id: string | null) => void;
  /** "Use with your agent" was pressed. */
  readonly onAgentHelp: () => void;
}

/**
 * The draft tray: comments picked and written but kept in the page until Send all posts them together as one batch.
 * Each draft can be edited or removed first.
 */
export class DraftTray {
  readonly element: HTMLElement;
  readonly #options: DraftTrayOptions;
  readonly #list = h("ol", { class: "drafts", "aria-label": "Drafts", "data-role": "drafts" });
  readonly #empty = h("p", { class: "muted empty", "data-role": "drafts-empty" },
    "No drafts. Press Comment (or C), pick an element and choose Add draft. Drafts stay in this tab until you send them.");
  readonly #error = h("p", { class: "composer-error", role: "alert", "data-role": "drafts-error", hidden: true });
  readonly #sendAll = h("button", { type: "button", class: "primary", "data-role": "drafts-send" }, "Send all");
  readonly #footer = h("div", { class: "drafts-footer", hidden: true }, h("div", { class: "composer-actions" }, h("span", { class: "spacer" }), this.#sendAll));
  /** How to get the comments into a coding agent; shown under the drafts, and most of all when the tray is empty. */
  readonly #agentHelp = h("button", { type: "button", class: "link agent-link", "data-role": "agent-help" }, "Use with your agent");
  readonly #agentHint = h("p", { class: "agent-hint muted" },
    "Sent comments go to your coding agent through the iterbar MCP server. ", this.#agentHelp);
  #drafts: readonly DraftView[] = [];
  #busy = false;
  #editing: { id: string; value: string; focus: boolean } | null = null;

  constructor(options: DraftTrayOptions) {
    this.#options = options;
    this.element = h("section", { class: "section", "data-section": "drafts", "aria-labelledby": "iterbar-drafts-title" },
      h("h2", { class: "sr-only", id: "iterbar-drafts-title" }, "Drafts"), this.#empty, this.#list, this.#error, this.#footer, this.#agentHint);
    this.#sendAll.addEventListener("click", () => this.#options.onSendAll());
    this.#agentHelp.addEventListener("click", () => this.#options.onAgentHelp());
    this.#list.addEventListener("pointerleave", () => this.#options.onHighlight(null));
    this.#list.addEventListener("focusout", (event) => {
      if (!this.#list.contains(event.relatedTarget as Node | null)) this.#options.onHighlight(null);
    });
  }

  /** Shows `drafts`; while `busy` (sending) nothing can be edited or removed. */
  render(drafts: readonly DraftView[], busy: boolean, error: string | null): void {
    this.#drafts = drafts;
    this.#busy = busy;
    if (this.#editing && !drafts.some((draft) => draft.id === this.#editing!.id)) this.#editing = null;
    const focusedId = (this.element.getRootNode() as ShadowRoot).activeElement?.closest?.("[data-draft-id]")?.getAttribute("data-draft-id");
    const focusedRole = (this.element.getRootNode() as ShadowRoot).activeElement?.getAttribute?.("data-role");
    this.#list.replaceChildren(...drafts.map((draft, index) => this.#row(draft, index)));
    this.#empty.hidden = drafts.length > 0;
    this.#footer.hidden = drafts.length === 0;
    this.#sendAll.disabled = busy || drafts.length === 0 || this.#editing !== null;
    const label = drafts.length === 1 ? "Send 1 comment" : `Send all ${drafts.length}`;
    this.#sendAll.textContent = busy ? "Sending…" : label;
    this.#error.textContent = error ?? "";
    this.#error.hidden = !error;
    // Re-rendering replaces the rows; focus goes back to the same control of the same draft.
    if (focusedId && focusedRole) {
      this.#list.querySelector<HTMLElement>(`[data-draft-id="${CSS.escape(focusedId)}"] [data-role="${CSS.escape(focusedRole)}"]`)?.focus();
    }
  }

  /** Scrolls to a draft (its pin was clicked), marks it for a moment and focuses its Edit button. */
  reveal(id: string): boolean {
    const row = this.#list.querySelector<HTMLElement>(`[data-draft-id="${CSS.escape(id)}"]`);
    if (!row) return false;
    row.scrollIntoView({ block: "nearest" });
    row.toggleAttribute("data-revealed", true);
    setTimeout(() => row.removeAttribute("data-revealed"), 1600);
    row.querySelector<HTMLElement>("[data-role=draft-edit]")?.focus({ preventScroll: true });
    this.#options.onHighlight(id);
    return true;
  }

  /** Leaves the edit without saving; focus goes back to the draft's Edit button. */
  #stopEditing(id: string): void {
    this.#editing = null;
    this.render(this.#drafts, this.#busy, this.#error.hidden ? null : this.#error.textContent);
    this.#list.querySelector<HTMLElement>(`[data-draft-id="${CSS.escape(id)}"] [data-role=draft-edit]`)?.focus();
  }

  #row(draft: DraftView, index: number): HTMLLIElement {
    const label = h("p", { class: "draft-target", title: labelTooltip(draft.label) }, formatLabel(draft.label));
    const editing = this.#editing?.id === draft.id ? this.#editing : null;
    const row = h("li", { class: "draft", "data-draft-id": draft.id, "data-state": draft.state },
      h("span", { class: "draft-index", "aria-hidden": "true" }, String(index + 1)));
    const body = h("div", { class: "draft-body" }, label);
    if (editing) {
      const area = h("textarea", {
        class: "composer-text", "data-role": "draft-text", rows: "3", maxlength: String(MAX_COMMENT_LENGTH),
        "aria-label": `Edit draft ${index + 1}`,
      });
      area.value = editing.value;
      const save = h("button", { type: "button", class: "primary", "data-role": "draft-save" }, "Save");
      const cancel = h("button", { type: "button", "data-role": "draft-cancel" }, "Cancel");
      const renderSave = () => {
        save.disabled = area.value.trim().length === 0;
      };
      renderSave();
      area.addEventListener("input", () => {
        editing.value = area.value;
        renderSave();
      });
      const commit = () => {
        if (area.value.trim().length === 0) return;
        this.#editing = null;
        this.#options.onEdit(draft.id, area.value);
      };
      area.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape" && !event.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          this.#stopEditing(draft.id);
        }
      });
      save.addEventListener("click", commit);
      cancel.addEventListener("click", () => this.#stopEditing(draft.id));
      body.append(area, h("div", { class: "composer-actions" }, h("span", { class: "spacer" }), cancel, save));
      // Focus moves into the editor when editing starts, never on a later re-render (a new draft, a send).
      if (editing.focus) {
        editing.focus = false;
        queueMicrotask(() => {
          if (area.isConnected) area.focus();
        });
      }
    } else {
      body.append(h("p", { class: "draft-text" }, draft.text));
      if (draft.error) body.append(h("p", { class: "composer-error" }, draft.error));
      // One draft is edited at a time, so unsaved text in another is never dropped.
      const edit = h("button", {
        type: "button", "data-role": "draft-edit", "aria-label": `Edit draft ${index + 1}`, disabled: this.#busy || this.#editing !== null,
      }, "Edit");
      const remove = h("button", { type: "button", "data-role": "draft-remove", "aria-label": `Remove draft ${index + 1}`, disabled: this.#busy }, "Remove");
      edit.addEventListener("click", () => {
        this.#editing = { id: draft.id, value: draft.text, focus: true };
        this.render(this.#drafts, this.#busy, this.#error.hidden ? null : this.#error.textContent);
      });
      remove.addEventListener("click", () => this.#options.onRemove(draft.id));
      body.append(h("div", { class: "draft-actions" }, edit, remove));
    }
    row.append(body);
    row.addEventListener("pointerenter", () => this.#options.onHighlight(draft.id));
    row.addEventListener("focusin", () => this.#options.onHighlight(draft.id));
    return row;
  }
}
