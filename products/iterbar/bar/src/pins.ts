import type { Feedback } from "@iterbar/core";
import { h } from "./dom.js";
import { icon } from "./icons.js";

/** Statuses whose threads still show a pin on the page: everything the agent or the user has not closed. */
const PINNED_STATUSES: ReadonlySet<Feedback["status"]> = new Set(["open", "working", "needs-info"]);

/** Size of a pin, in CSS pixels; it sits on its element's top-right corner, inset by half of it. */
const PIN_SIZE_PX = 22;

/** Waits this long after page changes (DOM mutations) before finding the pinned elements again. */
const RESOLVE_DELAY_MS = 150;

export interface PinLayerOptions {
  /** The pins are appended here, inside the bar's shadow root. */
  readonly container: ParentNode;
  /** The bar's host element: mutations inside the bar never make the layer look for elements again. */
  readonly host: Element;
  /** A pin was clicked: the newest of its threads (and every thread on that element). */
  readonly onOpen: (ids: readonly string[]) => void;
  /** The page URL threads are filed under, as slot reports file it; `null` for a page the contract cannot name. */
  readonly pageUrl: () => string | null;
  /** Areas the bar draws (the toolbar, an open panel): a pin that would overlap one hides. */
  readonly avoid?: () => readonly DOMRect[];
}

interface Pin {
  readonly key: string;
  readonly ids: string[];
  readonly selector: string;
  element: Element | null;
  readonly button: HTMLButtonElement;
  readonly count: HTMLSpanElement;
}

/**
 * Comment pins: a small comment icon on the page element each unfinished thread on this page is about (open, in
 * progress or needing info), like the pins of a design tool. Clicking one opens its thread in the inbox. A pin goes
 * once its thread is done or archived, hides while its element is gone, hidden or scrolled out of view, and follows
 * it as the page scrolls, resizes or changes. Threads are found by the selector the bar recorded when the comment was
 * picked; an element the selector no longer finds (the page changed shape) gets no pin.
 *
 * The layer is a manual popover in the top layer, like the bar, so page stacking cannot hide it; only the pins take
 * pointer events.
 */
export class PinLayer {
  readonly #options: PinLayerOptions;
  readonly #layer = h("div", { class: "pin-layer", popover: "manual", "data-role": "pin-layer" });
  readonly #pins = new Map<string, Pin>();
  #threads: readonly Feedback[] = [];
  #enabled = true;
  #attached = false;
  #frame: number | null = null;
  #resolveTimer: ReturnType<typeof setTimeout> | null = null;
  #mutations: MutationObserver | null = null;
  #resizes: ResizeObserver | null = null;

  constructor(options: PinLayerOptions) {
    this.#options = options;
    options.container.append(this.#layer);
  }

  /** The pins shown now, for tests and the bar's own checks. */
  get size(): number {
    return [...this.#pins.values()].filter((pin) => !pin.button.hidden).length;
  }

  /** Whether pins show at all (the bar hides them while it has no daemon). */
  set enabled(value: boolean) {
    if (value === this.#enabled) return;
    this.#enabled = value;
    this.#rebuild();
  }

  /** Cancels the inverse page zoom the bar applies, so the pins line up with viewport rectangles. */
  setZoom(zoom: string): void {
    this.#layer.style.zoom = zoom;
  }

  attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    try {
      this.#layer.showPopover?.();
    } catch {
      // Left as an ordinary fixed layer.
    }
    window.addEventListener("scroll", this.#queuePlace, { capture: true, passive: true });
    window.addEventListener("resize", this.#queuePlace, { passive: true });
    if (typeof MutationObserver === "function") {
      this.#mutations = new MutationObserver((records) => {
        if (records.every((record) => this.#options.host.contains(record.target))) return;
        this.#queueResolve();
      });
      // Every attribute: a recorded selector may name any of them (an id, a class, data-testid, data-iterbar-src).
      this.#mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    }
    if (typeof ResizeObserver === "function") this.#resizes = new ResizeObserver(this.#queuePlace);
    this.#rebuild();
  }

  detach(): void {
    if (!this.#attached) return;
    this.#attached = false;
    window.removeEventListener("scroll", this.#queuePlace, true);
    window.removeEventListener("resize", this.#queuePlace);
    this.#mutations?.disconnect();
    this.#mutations = null;
    this.#resizes?.disconnect();
    this.#resizes = null;
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    if (this.#resolveTimer) clearTimeout(this.#resolveTimer);
    this.#resolveTimer = null;
    try {
      this.#layer.hidePopover?.();
    } catch {
      // Not shown.
    }
  }

  /** The threads the bar holds; the unfinished ones on this page get pins. */
  update(threads: readonly Feedback[]): void {
    this.#threads = threads;
    this.#rebuild();
  }

  /** Builds the pins from the threads: one per element, newest thread first. */
  #rebuild(): void {
    const page = this.#options.pageUrl();
    const groups = new Map<string, string[]>();
    if (this.#enabled && this.#attached && page !== null) {
      for (const thread of this.#threads) {
        if (!PINNED_STATUSES.has(thread.status) || thread.pageUrl !== page || !thread.target) continue;
        const ids = groups.get(thread.target.selector);
        if (ids) ids.push(thread.id);
        else groups.set(thread.target.selector, [thread.id]);
      }
    }
    for (const [key, pin] of this.#pins) {
      if (groups.has(key)) continue;
      pin.button.remove();
      if (pin.element) this.#resizes?.unobserve(pin.element);
      this.#pins.delete(key);
    }
    for (const [selector, ids] of groups) {
      let pin = this.#pins.get(selector);
      if (!pin) {
        const count = h("span", { class: "pin-count", hidden: true });
        const button = h("button", { type: "button", class: "pin", "data-role": "pin", "data-selector": selector }, icon("comment"), count);
        const created: Pin = { key: selector, ids: [], selector, element: null, button, count };
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          this.#options.onOpen([...created.ids]);
        });
        this.#layer.append(button);
        this.#pins.set(selector, created);
        pin = created;
      }
      pin.ids.splice(0, pin.ids.length, ...ids);
      pin.count.textContent = String(ids.length);
      pin.count.hidden = ids.length < 2;
      const label = ids.length === 1 ? "Open comment" : `Open ${ids.length} comments`;
      pin.button.setAttribute("aria-label", label);
      pin.button.title = ids.length === 1 ? "Open comment" : `${ids.length} comments`;
      pin.button.dataset.feedbackIds = ids.join(" ");
    }
    this.#resolve();
  }

  /** Finds each pin's element again (the page may have replaced or removed it), then places the pins. */
  #resolve(): void {
    for (const pin of this.#pins.values()) {
      let element: Element | null;
      try {
        element = document.querySelector(pin.selector);
      } catch {
        element = null;
      }
      // An element inside the bar is never a pin's target.
      if (element && this.#options.host.contains(element)) element = null;
      if (element !== pin.element) {
        if (pin.element) this.#resizes?.unobserve(pin.element);
        if (element) this.#resizes?.observe(element);
        pin.element = element;
      }
    }
    this.#place();
  }

  readonly #queueResolve = (): void => {
    if (this.#resolveTimer) return;
    this.#resolveTimer = setTimeout(() => {
      this.#resolveTimer = null;
      this.#resolve();
    }, RESOLVE_DELAY_MS);
  };

  readonly #queuePlace = (): void => {
    if (this.#frame !== null) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#place();
    });
  };

  /** Places the pins again, as when the bar's toolbar or panel moved. */
  refresh(): void {
    this.#queuePlace();
  }

  /**
   * Puts each pin on its element's top-right corner; one whose element is gone, hidden or out of view hides, and so
   * does one that would sit on the bar's toolbar or open panel.
   */
  #place(): void {
    const width = document.documentElement.clientWidth || window.innerWidth;
    const height = document.documentElement.clientHeight || window.innerHeight;
    const avoid = this.#options.avoid?.() ?? [];
    for (const pin of this.#pins.values()) {
      const element = pin.element;
      const rect = element?.isConnected ? element.getBoundingClientRect() : null;
      const shown = rect !== null && rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width
        && (element as HTMLElement).checkVisibility?.({ visibilityProperty: true, opacityProperty: false }) !== false;
      if (!shown || !rect) {
        pin.button.hidden = true;
        continue;
      }
      const left = Math.min(width - PIN_SIZE_PX - 2, Math.max(2, rect.right - PIN_SIZE_PX / 2));
      const top = Math.min(height - PIN_SIZE_PX - 2, Math.max(2, rect.top - PIN_SIZE_PX / 2));
      const covered = avoid.some((area) => left < area.right && left + PIN_SIZE_PX > area.left
        && top < area.bottom && top + PIN_SIZE_PX > area.top);
      pin.button.hidden = covered;
      if (covered) continue;
      pin.button.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    }
  }
}
