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
  readonly element: Element;
  readonly ids: string[];
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
/** Whether an element with `style` is the containing block of fixed elements inside it, as a transform makes it. */
function holdsFixed(style: CSSStyleDeclaration): boolean {
  const individual = (value: string | undefined) => value !== undefined && value !== "" && value !== "none";
  return style.transform !== "none" || individual(style.translate) || individual(style.rotate) || individual(style.scale)
    || style.perspective !== "none" || style.filter !== "none"
    || (style.backdropFilter !== undefined && style.backdropFilter !== "none" && style.backdropFilter !== "")
    || /paint|layout|strict|content/.test(style.contain)
    || /transform|translate|rotate|scale|perspective|filter/.test(style.willChange);
}

/**
 * The part of `element` its scrolling or clipping ancestors leave in view, as a viewport rectangle; `null` when none
 * of it is (scrolled out of an `overflow: auto` list, say).
 */
function visibleRect(element: Element): DOMRect | null {
  const rect = element.getBoundingClientRect();
  let left = rect.left;
  let top = rect.top;
  let right = rect.right;
  let bottom = rect.bottom;
  // A fixed element is laid out against its containing block: the viewport, or the nearest ancestor with a transform,
  // filter, perspective or paint containment. Boxes between it and that block do not clip it; that block and the boxes
  // around it do.
  let skipping = getComputedStyle(element).position === "fixed";
  for (let ancestor = element.parentElement; ancestor && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (skipping) {
      if (!holdsFixed(style)) continue;
      skipping = false;
    }
    const clipsX = style.overflowX !== "visible";
    const clipsY = style.overflowY !== "visible";
    if (clipsX || clipsY) {
      // Each axis is clipped only where the ancestor clips it.
      const box = ancestor.getBoundingClientRect();
      if (clipsX) {
        left = Math.max(left, box.left);
        right = Math.min(right, box.right);
      }
      if (clipsY) {
        top = Math.max(top, box.top);
        bottom = Math.min(bottom, box.bottom);
      }
      if (right <= left || bottom <= top) return null;
    }
    // Inside a fixed ancestor, the same rule holds for the boxes past it.
    if (style.position === "fixed") skipping = true;
  }
  if (right <= left || bottom <= top) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}

export class PinLayer {
  readonly #options: PinLayerOptions;
  readonly #layer = h("div", { class: "pin-layer", popover: "manual", "data-role": "pin-layer" });
  /** One pin per element: threads whose recorded selectors find the same element share it. */
  readonly #pins = new Map<Element, Pin>();
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
    // The pins go with the observers; attaching again builds them afresh, each observed by the new resize observer.
    for (const pin of this.#pins.values()) pin.button.remove();
    this.#pins.clear();
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

  /**
   * Builds the pins from the threads: finds each unfinished thread's element (again, as the page may have replaced or
   * removed it) and gives every element found one pin with its threads, newest first. Then places them.
   */
  #rebuild(): void {
    const page = this.#options.pageUrl();
    const groups = new Map<Element, string[]>();
    if (this.#enabled && this.#attached && page !== null) {
      const found = new Map<string, Element | null>();
      for (const thread of this.#threads) {
        if (!PINNED_STATUSES.has(thread.status) || thread.pageUrl !== page || !thread.target) continue;
        const { selector } = thread.target;
        if (!found.has(selector)) found.set(selector, this.#find(selector));
        const element = found.get(selector);
        if (!element) continue;
        const ids = groups.get(element);
        if (ids) ids.push(thread.id);
        else groups.set(element, [thread.id]);
      }
    }
    for (const [element, pin] of this.#pins) {
      if (groups.has(element)) continue;
      pin.button.remove();
      this.#resizes?.unobserve(element);
      this.#pins.delete(element);
    }
    for (const [element, ids] of groups) {
      let pin = this.#pins.get(element);
      if (!pin) {
        const count = h("span", { class: "pin-count", hidden: true });
        const button = h("button", { type: "button", class: "pin", "data-role": "pin" }, icon("comment"), count);
        const created: Pin = { element, ids: [], button, count };
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          this.#options.onOpen([...created.ids]);
        });
        this.#layer.append(button);
        this.#pins.set(element, created);
        this.#resizes?.observe(element);
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
    this.#place();
  }

  /** The element a recorded selector finds now; never one inside the bar, and none for a selector that throws. */
  #find(selector: string): Element | null {
    let element: Element | null;
    try {
      element = document.querySelector(selector);
    } catch {
      element = null;
    }
    return element && !this.#options.host.contains(element) ? element : null;
  }

  readonly #queueResolve = (): void => {
    if (this.#resolveTimer) return;
    this.#resolveTimer = setTimeout(() => {
      this.#resolveTimer = null;
      this.#rebuild();
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
    let avoid: readonly DOMRect[] = [];
    try {
      avoid = this.#options.avoid?.() ?? [];
    } catch {
      // Pins still show; only the areas to keep clear are unknown.
    }
    for (const pin of this.#pins.values()) {
      const element = pin.element;
      const rect = element.isConnected ? visibleRect(element) : null;
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
