import { readVariantParam, withVariantParam } from "@iterbar/variants";
import {
  formatVariantParam,
  parseVariantParam,
  readPageApi,
  registrySnapshotSchema,
  safeParseMessage,
  SCHEMA_VERSION,
  VARIANT_URL_PARAM,
  type IterbarPageApi,
  type RegistrySnapshot,
  type SlotReport,
  type SlotState,
} from "iterbar";
import { h } from "./dom.js";
import { icon } from "./icons.js";

/** How often the bar looks for `window.__ITERBAR__` until a registry installs it. */
const PAGE_API_POLL_MS = 500;

/** Most registry warnings listed; the rest are counted. */
const MAX_SHOWN_WARNINGS = 5;

/**
 * `search` with the `iterbar` parameter naming `variant` for `slot`: an existing entry for the slot is replaced in
 * place, otherwise one is appended. Other entries and every other parameter are kept; malformed entries are dropped,
 * as the registry drops them. Returns `null` when the selections cannot be written (too many slots).
 */
export function searchWithSelection(search: string, slot: string, variant: string): string | null {
  const selections = parseVariantParam(readVariantParam(search)).selections;
  const updated = selections.some((entry) => entry.slot === slot)
    ? selections.map((entry) => (entry.slot === slot ? { slot, variant } : entry))
    : [...selections, { slot, variant }];
  try {
    return withVariantParam(search, formatVariantParam(updated));
  } catch {
    return null;
  }
}

function isVariantPair(pair: string): boolean {
  const separator = pair.indexOf("=");
  try {
    return decodeURIComponent((separator === -1 ? pair : pair.slice(0, separator)).replaceAll("+", " ")) === VARIANT_URL_PARAM;
  } catch {
    return false;
  }
}

/**
 * The URL a page's slot report is filed under: without the fragment or the `iterbar` parameter, which switching
 * changes. The rest of the query keeps its exact text, empty segments included, since the daemon files reports by
 * the exact URL.
 */
export function reportPageUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  url.hash = "";
  // The serialized URL has only one "?" before its query, since the path cannot contain one unescaped.
  const serialized = url.href;
  const start = serialized.indexOf("?");
  if (start === -1) return serialized;
  // A query left empty (a bare "?", or only the iterbar parameter) is dropped, so switching never changes the URL.
  const query = serialized.slice(start + 1).split("&").filter((pair) => !isVariantPair(pair)).join("&");
  return query ? `${serialized.slice(0, start)}?${query}` : serialized.slice(0, start);
}

function writeSelectionToUrl(slot: string, variant: string): void {
  try {
    const search = searchWithSelection(location.search, slot, variant);
    if (search === null || search === location.search) return;
    history.replaceState(history.state, "", `${location.pathname}${search}${location.hash}`);
  } catch {
    // A router or sandbox may refuse history changes; the switch itself already applied.
  }
}

export interface SlotsPanelOptions {
  /** Called with every snapshot the registry delivers, so the bar can report the page's slots. */
  readonly onSlots: (slots: readonly SlotState[]) => void;
  /**
   * The pages the daemon knows have slots, for a page that has none; rejects with a message for the user, or resolves
   * to `null` when the bar has no daemon.
   */
  readonly listPages?: () => Promise<readonly SlotReport[] | null>;
}

/** A page URL as the list shows it: its path and query, with the host too when it is another origin. */
function pageLabel(pageUrl: string): string {
  try {
    const url = new URL(pageUrl);
    const path = `${url.pathname}${url.search}`;
    return url.origin === location.origin ? path : `${url.host}${path}`;
  } catch {
    return pageUrl;
  }
}

function plural(count: number, one: string): string {
  return `${count} ${count === 1 ? one : `${one}s`}`;
}

/**
 * The page's slots and their variants, read from and switched through the `window.__ITERBAR__` page API. With more
 * than one slot a dropdown chooses which slot's variants are shown. (The page API and the protocol name a slot's
 * variants its "versions" in protocol version 1.)
 */
export class SlotsPanel {
  readonly element: HTMLElement;
  readonly #options: SlotsPanelOptions;
  readonly #message = h("p", { class: "muted", "data-role": "slots-message" });
  readonly #single = h("p", { class: "slot-name", "data-role": "slot-name", hidden: true });
  readonly #select = h("select", { id: "iterbar-slot-select", "data-role": "slot-select", "aria-label": "Slot" });
  readonly #picker = h("div", { class: "field slot-picker", hidden: true }, this.#select, icon("caret"));
  readonly #variants = h("div", { class: "variants", role: "group", "data-role": "variants", hidden: true });
  readonly #warnings = h("ul", { class: "warnings", "data-role": "warnings", hidden: true });
  /** For a page without slots: the pages that have some, to jump to. */
  readonly #pagesList = h("ul", { class: "variant-pages", "data-role": "variant-pages" });
  readonly #pagesNote = h("p", { class: "muted pages-note", "data-role": "variant-pages-note" });
  readonly #pages = h("div", { class: "pages", "data-role": "pages", hidden: true },
    h("h3", { class: "pages-title" }, "Pages with variants"), this.#pagesList, this.#pagesNote);
  /** Whether this page has no slots, so the pages list belongs in the panel. */
  #empty = false;
  #pagesRequest = 0;
  /** The pages last listed, so a refresh that changes nothing leaves the links (and focus) alone. */
  #pagesKey = "";
  #api: IterbarPageApi | null = null;
  #unsubscribe: (() => void) | null = null;
  #poll: ReturnType<typeof setInterval> | null = null;
  #snapshot: RegistrySnapshot | null = null;
  #selectedSlot: string | null = null;
  #slotKey = "";
  #versionsKey = "";

  constructor(options: SlotsPanelOptions) {
    this.#options = options;
    this.element = h("section", { class: "section", "data-section": "slots", "aria-label": "Variants" },
      this.#message, this.#single, this.#picker, this.#variants, this.#warnings, this.#pages);
    this.#select.addEventListener("change", () => {
      this.#selectedSlot = this.#select.value;
      this.#render();
    });
  }

  /** Starts following the page API, waiting for it when no registry is installed yet. */
  attach(): void {
    if (this.#api || this.#poll) return;
    if (!this.#connect()) {
      this.#poll = setInterval(() => {
        if (this.#connect() && this.#poll) {
          clearInterval(this.#poll);
          this.#poll = null;
        }
      }, PAGE_API_POLL_MS);
    }
  }

  detach(): void {
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#api = null;
  }

  /** Returns true once there is nothing more to wait for: the API was found, or it is unusable. */
  #connect(): boolean {
    let api: IterbarPageApi | null;
    try {
      api = readPageApi(globalThis);
    } catch (error) {
      this.#showMessage(`The page's Iterbar registry is not compatible with this bar: ${(error as Error).message}`);
      return true;
    }
    if (!api) {
      this.#showMessage("No variants on this page.", true);
      return false;
    }
    this.#api = api;
    try {
      this.#unsubscribe = api.subscribe((snapshot) => this.#update(snapshot));
      this.#update(api.getSnapshot());
    } catch (error) {
      this.#showMessage(`The page's Iterbar registry failed: ${(error as Error).message}`);
    }
    return true;
  }

  /**
   * Applies a snapshot from the page. One that does not match the contract is shown as an error, and the page is
   * then reported to have no slots, since nothing it showed before can be trusted.
   */
  #update(input: unknown): void {
    const parsed = safeParseMessage(registrySnapshotSchema, input, "registry snapshot");
    if (!parsed.success) {
      this.#snapshot = null;
      this.#warnings.hidden = true;
      this.#warnings.replaceChildren();
      this.#options.onSlots([]);
      this.#showMessage(`The page's Iterbar registry sent an invalid snapshot: ${parsed.error.message}`);
      return;
    }
    this.#snapshot = parsed.data;
    this.#options.onSlots(parsed.data.slots);
    this.#render();
  }

  /** Shows `text` in place of the slots; `empty` (the page has no slots) also lists the pages that have some. */
  #showMessage(text: string, empty = false): void {
    this.#message.textContent = text;
    this.#message.hidden = false;
    this.#single.hidden = true;
    this.#picker.hidden = true;
    this.#variants.hidden = true;
    const wasEmpty = this.#empty;
    this.#empty = empty;
    this.#pages.hidden = !empty;
    if (empty && !wasEmpty) void this.refreshPages();
  }

  /** Forgets the page list (the bar switched daemons) and asks the new daemon for it. */
  resetPages(): void {
    this.#pagesRequest += 1;
    this.#pagesKey = "";
    this.#pagesList.replaceChildren();
    this.#pagesNote.textContent = "";
    void this.refreshPages();
  }

  /**
   * Lists the pages the daemon has slot reports for, with each page's variant count, when this page has none. The
   * bar calls it when the panel opens and when a page reports its slots.
   */
  async refreshPages(): Promise<void> {
    if (!this.#empty || !this.#options.listPages) return;
    const request = ++this.#pagesRequest;
    let pages: readonly SlotReport[] | null;
    try {
      pages = await this.#options.listPages();
    } catch (error) {
      if (request !== this.#pagesRequest) return;
      this.#pagesList.replaceChildren();
      // The emptied list matches no key, so the next answer rebuilds it even when its pages are the same.
      this.#pagesKey = "";
      this.#pagesNote.textContent = `The page list is unavailable: ${(error as Error).message}`;
      return;
    }
    if (request !== this.#pagesRequest) return;
    const here = reportPageUrl(location.href);
    const withSlots = (pages ?? []).filter((page) => page.slots.length > 0 && page.pageUrl !== here);
    // Unchanged pages keep their links (and a keyboard user's focus on one); only a changed list is rebuilt.
    const key = JSON.stringify(withSlots.map((page) => [page.pageUrl, page.slots.map((slot) => [slot.slot, slot.variants.length])]));
    if (key === this.#pagesKey && pages !== null) {
      this.#pagesNote.textContent = withSlots.length === 0
        ? "No other page has reported variants yet. Pages report theirs when they are opened with the bar."
        : "Pages report their variants when they are opened with the bar.";
      return;
    }
    this.#pagesKey = key;
    this.#pagesList.replaceChildren(...withSlots.map((page) => {
      const variants = page.slots.reduce((sum, slot) => sum + slot.variants.length, 0);
      const link = h("a", { class: "variant-page", href: page.pageUrl, "data-role": "variant-page", "data-page-url": page.pageUrl },
        h("span", { class: "variant-page-path" }, pageLabel(page.pageUrl)),
        h("span", { class: "variant-page-count" }, `${plural(variants, "variant")} · ${plural(page.slots.length, "slot")}`));
      return h("li", {}, link);
    }));
    this.#pagesNote.textContent = pages === null
      ? "Connect the bar to its daemon to see which pages have variants."
      : withSlots.length === 0
        ? "No other page has reported variants yet. Pages report theirs when they are opened with the bar."
        : "Pages report their variants when they are opened with the bar.";
  }

  #render(): void {
    const snapshot = this.#snapshot;
    if (!snapshot) return;
    this.#renderWarnings(snapshot);
    const { slots } = snapshot;
    if (slots.length === 0) {
      this.#showMessage("No variants on this page.", true);
      return;
    }
    this.#message.hidden = true;
    this.#empty = false;
    this.#pages.hidden = true;
    const slot = slots.find((entry) => entry.slot === this.#selectedSlot) ?? slots[0]!;
    this.#selectedSlot = slot.slot;

    this.#single.hidden = slots.length !== 1;
    this.#picker.hidden = slots.length === 1;
    this.#single.replaceChildren(h("span", { class: "muted" }, "Slot "), h("strong", {}, slot.slot));
    const slotKey = JSON.stringify(slots.map((entry) => entry.slot));
    if (slotKey !== this.#slotKey) {
      this.#slotKey = slotKey;
      this.#select.replaceChildren(...slots.map((entry) => h("option", { value: entry.slot }, entry.slot)));
    }
    this.#select.value = slot.slot;
    this.#renderVersions(slot);
  }

  #renderVersions(slot: SlotState): void {
    this.#variants.hidden = false;
    this.#variants.setAttribute("aria-label", `Variants of ${slot.slot}`);
    const key = JSON.stringify([slot.slot, slot.variants, slot.defaultVariant, slot.descriptions ?? null]);
    if (key !== this.#versionsKey) {
      this.#versionsKey = key;
      this.#variants.replaceChildren(...slot.variants.map((variant) => {
        // Own entries only: a variant named like an Object.prototype member ("constructor") has none of its own.
        const description = slot.descriptions && Object.hasOwn(slot.descriptions, variant) ? slot.descriptions[variant] : undefined;
        const button = h("button", { type: "button", class: "variant", "data-variant": variant },
          h("span", { class: "variant-text" },
            h("span", { class: "variant-head" },
              h("span", { class: "variant-name" }, variant),
              variant === slot.defaultVariant ? h("span", { class: "variant-tag" }, "default") : null),
            description ? h("span", { class: "variant-description", "data-role": "variant-description" }, description) : null),
          h("span", { class: "variant-check", "aria-hidden": "true" }, icon("check")));
        button.addEventListener("click", () => this.#choose(slot.slot, variant));
        return button;
      }));
    }
    for (const button of this.#variants.querySelectorAll<HTMLButtonElement>("button[data-variant]")) {
      button.setAttribute("aria-pressed", String(button.dataset.variant === slot.activeVariant));
    }
  }

  #renderWarnings(snapshot: RegistrySnapshot): void {
    const shown = snapshot.warnings.slice(0, MAX_SHOWN_WARNINGS);
    const rest = snapshot.warnings.length - shown.length;
    this.#warnings.hidden = shown.length === 0;
    this.#warnings.replaceChildren(
      ...shown.map((warning) => h("li", {}, warning.message)),
      ...(rest > 0 ? [h("li", {}, `${rest} more warnings.`)] : []),
    );
  }

  /** Switches through the page API and, once the registry shows the variant, records it in the `iterbar` URL parameter. */
  #choose(slot: string, variant: string): void {
    const api = this.#api;
    if (!api) return;
    try {
      // readPageApi puts a registry from protocol version 1 behind a version 2 adapter, which translates this.
      api.select({ schemaVersion: SCHEMA_VERSION, slot, variant });
      const snapshot = safeParseMessage(registrySnapshotSchema, api.getSnapshot(), "registry snapshot");
      const applied = snapshot.success && snapshot.data.slots.find((entry) => entry.slot === slot)?.activeVariant === variant;
      if (applied) writeSelectionToUrl(slot, variant);
    } catch (error) {
      this.#showMessage(`The page's Iterbar registry failed: ${(error as Error).message}`);
    }
  }
}
