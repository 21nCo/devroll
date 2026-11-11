import { h } from "../dom.js";

/**
 * Page events the picker swallows while it is active, so picking never presses a page button, follows a link, moves
 * focus, starts a selection or opens a menu. Hover (`pointermove`) is observed but left to the page.
 */
const SWALLOWED_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu"] as const;

export interface PickerOptions {
  /** The bar's host element: events inside it reach the bar as usual, and it is never picked. */
  readonly host: Element;
  /** The highlight layer is appended here, inside the bar's shadow root. */
  readonly container: ParentNode;
  /** A page element was clicked, or Enter or Space pressed on it. Returns whether it is now the picked element (`false` keeps the previous one). */
  readonly onPick: (element: Element) => boolean;
  /** Escape was pressed: the caller leaves comment mode. */
  readonly onEscape: () => void;
}

/**
 * Comment mode's element picker. While active it outlines the element under the pointer, picks the clicked element,
 * or the focused one on Enter or Space (outlining it until the pick is cleared), and swallows that input; Escape asks to leave.
 * While inactive it has no listeners and its layer is hidden, so the page gets every event.
 *
 * The layer is a manual popover in the top layer, like the bar, so page stacking and transforms cannot hide or shift
 * it, and it never takes pointer events.
 */
export class ElementPicker {
  readonly #options: PickerOptions;
  readonly #layer = h("div", { class: "pick-layer", popover: "manual", "aria-hidden": "true", "data-role": "pick-layer" });
  readonly #hoverBox = h("div", { class: "pick-box", "data-role": "pick-hover", hidden: true });
  readonly #pickedBox = h("div", { class: "pick-box picked", "data-role": "pick-picked", hidden: true });
  #active = false;
  #hovered: Element | null = null;
  #picked: Element | null = null;
  #frame: number | null = null;
  /** The `code` of the activation key that made the last pick, until it is released; see {@link #ownsKey}. */
  #heldKey: string | null = null;

  constructor(options: PickerOptions) {
    this.#options = options;
    this.#layer.append(this.#hoverBox, this.#pickedBox);
    options.container.append(this.#layer);
  }

  get active(): boolean {
    return this.#active;
  }

  /** The element last picked, until {@link clearPick} or {@link stop}. */
  get picked(): Element | null {
    return this.#picked;
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    for (const type of SWALLOWED_EVENTS) window.addEventListener(type, this.#swallow, true);
    window.addEventListener("pointermove", this.#onPointerMove, { capture: true, passive: true });
    window.addEventListener("pointerout", this.#onPointerOut, { capture: true, passive: true });
    window.addEventListener("keydown", this.#onKeydown, true);
    window.addEventListener("keyup", this.#onKeyup, true);
    window.addEventListener("scroll", this.#queueLayout, { capture: true, passive: true });
    window.addEventListener("resize", this.#queueLayout, { passive: true });
    this.#layer.toggleAttribute("data-active", true);
    if (typeof this.#layer.showPopover === "function" && !this.#layer.matches(":popover-open")) {
      try {
        this.#layer.showPopover();
      } catch {
        // Left as a fixed-position element.
      }
    }
  }

  /** Removes every listener and hides the layer; the page gets its events back at once. */
  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    for (const type of SWALLOWED_EVENTS) window.removeEventListener(type, this.#swallow, true);
    window.removeEventListener("pointermove", this.#onPointerMove, true);
    window.removeEventListener("pointerout", this.#onPointerOut, true);
    window.removeEventListener("keydown", this.#onKeydown, true);
    window.removeEventListener("keyup", this.#onKeyup, true);
    window.removeEventListener("scroll", this.#queueLayout, true);
    window.removeEventListener("resize", this.#queueLayout);
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    this.#heldKey = null;
    this.#hovered = null;
    this.#picked = null;
    this.#layer.removeAttribute("data-active");
    if (typeof this.#layer.hidePopover === "function" && this.#layer.matches(":popover-open")) this.#layer.hidePopover();
    this.#layout();
  }

  /** Sets the layer's CSS `zoom`, which cancels the zoom it inherits from the page (`""` for none). */
  setZoom(zoom: string): void {
    this.#layer.style.zoom = zoom;
  }

  /** Forgets the picked element; hovering and picking carry on. */
  clearPick(): void {
    this.#picked = null;
    this.#layout();
  }

  /** The page element an event is for, or `null` for the bar, the document itself or a non-element. */
  #pageElement(event: Event): Element | null {
    if (event.composedPath().includes(this.#options.host)) return null;
    const target = event.target;
    if (!(target instanceof Element) || target === document.documentElement) return null;
    return target.isConnected ? target : null;
  }

  /** Whether `event` comes from the user and is not for the bar. */
  #isPageInput(event: Event): boolean {
    // A page script's own `element.click()` is left alone; only the user's input picks.
    return event.isTrusted && !event.composedPath().includes(this.#options.host);
  }

  #pick(element: Element): void {
    if (!this.#options.onPick(element)) return;
    this.#picked = element;
    this.#layout();
  }

  /** Swallows pointer input on the page, the document root included, and picks on a primary click. */
  readonly #swallow = (event: Event): void => {
    if (!this.#isPageInput(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== "click" || (event as MouseEvent).button !== 0) return;
    const element = this.#pageElement(event);
    if (element) this.#pick(element);
  };

  /**
   * The focused page element an activation key (Enter or Space) is for: not the bar, nor the body when nothing is
   * focused, where Space scrolls the page.
   */
  #activationTarget(event: KeyboardEvent): Element | null {
    if ((event.key !== "Enter" && event.key !== " ") || event.isComposing || !this.#isPageInput(event)) return null;
    const element = this.#pageElement(event);
    return element === document.body ? null : element;
  }

  readonly #onPointerMove = (event: PointerEvent): void => {
    const element = this.#pageElement(event);
    if (element === this.#hovered) return;
    this.#hovered = element;
    this.#layout();
  };

  /** The pointer left the window. */
  readonly #onPointerOut = (event: PointerEvent): void => {
    if (event.relatedTarget !== null || this.#hovered === null) return;
    this.#hovered = null;
    this.#layout();
  };

  /**
   * Swallows the repeats and release of the key that made a pick. The pick moves focus into the composer, so they would
   * otherwise type into it and reach the page's handlers.
   */
  #ownsKey(event: KeyboardEvent): boolean {
    if (this.#heldKey === null || event.code !== this.#heldKey) return false;
    if (event.type === "keyup") this.#heldKey = null;
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }

  readonly #onKeydown = (event: KeyboardEvent): void => {
    if (event.repeat && this.#ownsKey(event)) return;
    const element = this.#activationTarget(event);
    if (element) {
      // Picks at once, before the page's handlers could submit, act on or cancel the key.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      this.#heldKey = event.code;
      this.#pick(element);
      return;
    }
    if (event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.#options.onEscape();
  };

  readonly #onKeyup = (event: KeyboardEvent): void => {
    if (this.#ownsKey(event) || !this.#activationTarget(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  readonly #queueLayout = (): void => {
    if (this.#frame !== null) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#layout();
    });
  };

  #layout(): void {
    place(this.#hoverBox, this.#active && this.#hovered !== this.#picked ? this.#hovered : null);
    place(this.#pickedBox, this.#active ? this.#picked : null);
  }
}

/** Outlines `element`'s border box in viewport coordinates, or hides the box. */
function place(box: HTMLElement, element: Element | null): void {
  if (!element?.isConnected) {
    box.hidden = true;
    return;
  }
  const rect = element.getBoundingClientRect();
  box.hidden = false;
  box.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
}
