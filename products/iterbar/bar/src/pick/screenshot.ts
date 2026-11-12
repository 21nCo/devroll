import { MAX_ATTACHMENT_BYTES } from "iterbar";
import { createContext, destroyContext, domToBlob } from "modern-screenshot";

/** Most pixels in one screenshot (4 MP); larger elements are captured at a lower scale. */
export const MAX_SCREENSHOT_PIXELS = 4_000_000;

/** Longest a capture may take, image and font loading included, before the comment is sent without it. */
export const SCREENSHOT_TIMEOUT_MS = 10_000;

/** Longest `screenshotUnavailableReason` the contract accepts. */
const MAX_REASON_LENGTH = 500;

export type ScreenshotResult =
  | { readonly ok: true; readonly png: Blob; readonly scale: number }
  | { readonly ok: false; readonly reason: string };

/**
 * The scale to capture a `width` x `height` CSS-pixel element at: the device pixel ratio, lowered so that the image
 * stays within {@link MAX_SCREENSHOT_PIXELS}. `null` for an element with no area.
 */
export function screenshotScale(width: number, height: number, deviceScale: number): number | null {
  if (!(width > 0 && height > 0) || !Number.isFinite(width * height)) return null;
  const preferred = Number.isFinite(deviceScale) && deviceScale > 0 ? deviceScale : 1;
  return Math.min(preferred, Math.sqrt(MAX_SCREENSHOT_PIXELS / (width * height)));
}

/** A reason the contract accepts: non-blank and at most 500 characters. */
export function unavailableReason(message: string): string {
  const text = `The screenshot failed: ${message.replace(/\s+/gu, " ").trim() || "unknown error"}`;
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 1)}…` : text;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The width and height in a PNG's IHDR chunk, or `null` when `bytes` do not start like a PNG. */
export function pngDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  if (bytes.byteLength < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (error instanceof Event) return `${error.type} event`;
  return String(error);
}

/** What places an element on the page, apart from its transform; the copy leaves it out. */
const PLACEMENT = { translate: "none", rotate: "none", scale: "none", margin: "0", inset: "auto" } as const;

/** How long a render works before it yields to the page, which can then withdraw it. */
const YIELD_EVERY_MS = 10;

/**
 * modern-screenshot 4.7.0 draws an `<svg>` whose markup does not match this as the markup stands, and copies any other
 * one as an HTML element would be; the drawing's copy is built not to match it.
 */
const SVG_EXTERNAL_RESOURCE = /\bx?link:?href\s*=\s*["'](?!data:)[^"']+["']/i;

/** Inherited properties a drawing's copy carries on each element where they differ from its parent's. */
const SVG_INHERITED = [
  "color", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray",
  "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "paint-order", "clip-rule",
  "marker-start", "marker-mid", "marker-end", "visibility", "font-family", "font-size", "font-style", "font-weight",
  "letter-spacing", "text-anchor", "dominant-baseline",
] as const;

/** Properties that are not inherited, which the copy carries where they are not their initial value. */
const SVG_OWN: Readonly<Record<string, string>> = {
  opacity: "1", transform: "none", "clip-path": "none", mask: "none", filter: "none", "mix-blend-mode": "normal",
  "stop-color": "rgb(0, 0, 0)", "stop-opacity": "1", "vector-effect": "none",
};

const XLINK = "http://www.w3.org/1999/xlink";

/** Records in `ids` the `#id` that `url` names, or says why it cannot be drawn: it loads something from outside the page. */
function reference(url: string, ids: Set<string>): string | null {
  const value = url.trim();
  if (value.startsWith("#")) ids.add(value.slice(1));
  else if (!/^data:/iu.test(value)) return `the drawing loads ${value.slice(0, 100)}, which a screenshot cannot embed yet`;
  return null;
}

/** {@link reference} for each `url(…)` in a style value. */
function urlReferences(value: string, ids: Set<string>): string | null {
  for (const [, url = ""] of value.matchAll(/url\(\s*["']?([^"')]*)/gu)) {
    const refused = reference(url, ids);
    if (refused !== null) return refused;
  }
  return null;
}

/** What an element's `href` points to, which it loads unless it is a link. */
function hrefOf(element: Element): string | null {
  if (element.localName === "a") return null;
  return element.getAttribute("href") ?? element.getAttributeNS(XLINK, "href");
}

/** Replaces an element's `xlink:href` with an `href`, which the copy is drawn with alike. */
function plainHref(element: Element): void {
  const href = element.getAttributeNS(XLINK, "href");
  if (href === null) return;
  element.removeAttributeNS(XLINK, "href");
  if (!element.hasAttribute("href")) element.setAttribute("href", href);
}

/**
 * Copies an `<svg>` drawing with the computed styles it takes from the page (its style sheets, and what it inherits,
 * `currentColor` included) inlined, since it is drawn from its markup. Its `xlink:href`s become `href`s, and what it
 * refers to by `#id` outside itself (a sprite's symbols, gradients) is copied into it as it stands there (a symbol
 * inherits from the `<use>` that shows it). A string says why it cannot be drawn: it loads a resource from outside the
 * page. `eachNode` runs before each element is copied and may end the copy.
 */
async function copyDrawing(svg: SVGSVGElement, eachNode: () => Promise<void>): Promise<SVGSVGElement | string> {
  const own = new Set<string>();
  const wanted = new Set<string>();
  const copyOf = async (source: Element, parent: CSSStyleDeclaration | null, styled: boolean): Promise<Element | string> => {
    await eachNode();
    if (source.id) own.add(source.id);
    const href = hrefOf(source);
    const refused = (href === null ? null : reference(href, wanted))
      ?? [...source.attributes].reduce<string | null>((found, { value }) => found ?? urlReferences(value, wanted), null);
    if (refused !== null) return refused;
    const copy = source.cloneNode(false) as Element;
    plainHref(copy);
    const style = getComputedStyle(source);
    if (styled && (copy instanceof SVGElement || copy instanceof HTMLElement)) {
      const carry = (name: string, value: string): string | null => {
        copy.style.setProperty(name, value);
        return urlReferences(value, wanted);
      };
      for (const name of SVG_INHERITED) {
        const value = style.getPropertyValue(name);
        const external = value && value !== parent?.getPropertyValue(name) ? carry(name, value) : null;
        if (external !== null) return external;
      }
      for (const [name, initial] of Object.entries(SVG_OWN)) {
        const value = style.getPropertyValue(name);
        const external = value && value !== initial ? carry(name, value) : null;
        if (external !== null) return external;
      }
      if (style.transform !== "none") {
        carry("transform-origin", style.transformOrigin);
        carry("transform-box", style.transformBox);
      }
      if (style.display === "none") carry("display", "none");
    }
    for (let child = source.firstChild; child; child = child.nextSibling) {
      if (child instanceof Text) copy.appendChild(child.cloneNode(false));
      else if (child instanceof Element && child.localName !== "script") {
        const childCopy = await copyOf(child, style, styled);
        if (typeof childCopy === "string") return childCopy;
        copy.appendChild(childCopy);
      }
    }
    return copy;
  };
  const copy = await copyOf(svg, null, true);
  if (typeof copy === "string") return copy;
  const defs = svg.ownerDocument.createElementNS(svg.namespaceURI, "defs");
  for (const id of wanted) {
    const definition = own.has(id) ? null : svg.ownerDocument.getElementById(id);
    if (!(definition instanceof SVGElement)) continue;
    const definitionCopy = await copyOf(definition, null, false);
    if (typeof definitionCopy === "string") return definitionCopy;
    defs.appendChild(definitionCopy);
  }
  if (defs.firstChild) copy.prepend(defs);
  // modern-screenshot would copy a drawing whose markup matches its test for links as an HTML element instead.
  if (SVG_EXTERNAL_RESOURCE.test(copy.innerHTML)) return "the drawing's text looks like a link to the screenshot library";
  return copy as SVGSVGElement;
}

/** How the copy is framed: its size in the image in CSS pixels, and the style its root is laid out with. */
interface Frame {
  readonly width: number;
  readonly height: number;
  readonly style: Readonly<Record<string, string>>;
}

function px(value: string): number | null {
  if (!value.endsWith("px")) return null;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

function sumPx(style: CSSStyleDeclaration, names: readonly string[]): number {
  return names.reduce((sum, name) => sum + (px(style.getPropertyValue(name)) ?? 0), 0);
}

/** Elements laid out at their own size even when `display: inline`. */
const REPLACED = new Set(["img", "video", "canvas", "iframe", "embed", "object", "input", "select", "textarea", "button", "audio", "meter", "progress"]);

/**
 * What a scrollbar takes from `element`'s box across (`"x"`) or down, in the element's CSS pixels: its integer layout
 * box less its integer inner box and borders, so less than 2 pixels is rounding, not a scrollbar.
 */
function gutter(element: HTMLElement, style: CSSStyleDeclaration, axis: "x" | "y"): number {
  if (/^(?:visible|clip)$/u.test(axis === "x" ? style.overflowY : style.overflowX)) return 0;
  const gap = axis === "x"
    ? element.offsetWidth - element.clientWidth - sumPx(style, ["border-left-width", "border-right-width"])
    : element.offsetHeight - element.clientHeight - sumPx(style, ["border-top-width", "border-bottom-width"]);
  return gap >= 2 ? Math.round(gap) : 0;
}

/**
 * One framing rule for every element that can be captured: the copy is drawn alone at the image origin, upright, at
 * the element's exact border box (fractional, never rounded, so its text wraps as on the page; its scrollbars
 * included) times its effective zoom. A non-replaced inline element has no box size of its own: its box on screen is
 * its size. What places it on the page (its transform, margins and offsets, and its ancestors' transforms) is left
 * out; transforms inside it are kept. A transformed element keeps an identity transform, so it still contains its fixed
 * descendants. A string says why the element cannot be framed. Measured when called, so call it once the element's
 * images and fonts have loaded.
 */
function frameOf(element: Element): Frame | string {
  const style = getComputedStyle(element);
  const zoom = element.currentCSSZoom || 1;
  let width: number | null;
  let height: number | null;
  if (style.display === "inline" && element instanceof HTMLElement && !REPLACED.has(element.localName)) {
    // Its width and height do not apply; unless a transform around it scales or turns it, which its (rounded) layout
    // size then shows, its box on screen is its size.
    const rect = element.getBoundingClientRect();
    width = rect.width / zoom;
    height = rect.height / zoom;
    if (Math.abs(width - element.offsetWidth) > 1 || Math.abs(height - element.offsetHeight) > 1) {
      return "the element is an inline box inside a scaled or turned one; pick a box around it";
    }
  } else {
    // Computed sizes are in the element's own CSS pixels, before zoom and transforms; a content-box size leaves out
    // the padding, borders and scrollbars.
    width = px(style.width);
    height = px(style.height);
    if (width === null || height === null) return `the element's size cannot be measured (${style.width} x ${style.height})`;
    if (style.boxSizing !== "border-box") {
      width += sumPx(style, ["padding-left", "padding-right", "border-left-width", "border-right-width"]);
      height += sumPx(style, ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"]);
      if (element instanceof HTMLElement) {
        width += gutter(element, style, "x");
        height += gutter(element, style, "y");
      }
    }
  }
  const own = [style.transform, style.translate, style.rotate, style.scale].some((value) => value && value !== "none");
  return {
    width: width * zoom,
    height: height * zoom,
    style: {
      ...PLACEMENT, transform: own ? "translate(0px)" : "none", boxSizing: "border-box", width: `${width}px`, height: `${height}px`, zoom: String(zoom),
    },
  };
}

/**
 * Frames a detached copy of an `<svg>`, which is drawn from its markup: at the frame's size, with its placement and
 * offsets overridden by important inline declarations, which win over its own style sheets too.
 */
function frameSvgCopy(copy: SVGSVGElement, frame: Frame): void {
  copy.removeAttribute("transform");
  const style: Record<string, string> = {
    transform: "none", translate: "none", rotate: "none", scale: "none", margin: "0", zoom: "1", position: "static",
    inset: "auto", "box-sizing": "border-box", width: frame.style.width!, height: frame.style.height!,
  };
  for (const [name, value] of Object.entries(style)) copy.style.setProperty(name, value, "important");
  copy.setAttribute("width", frame.style.width!.slice(0, -2));
  copy.setAttribute("height", frame.style.height!.slice(0, -2));
}

/** Whether the element or a box inside it is scrolled, which the copy cannot show: it is drawn unscrolled. */
function hasScrolledBox(element: Element): boolean {
  return [element, ...element.querySelectorAll("*")].some((node) => node.scrollTop !== 0 || node.scrollLeft !== 0);
}

/** Ends a render that was withdrawn (another pick, Cancel, Escape, the bar's removal) or timed out, at the next step it reaches. */
function checkWithdrawn(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("the capture was withdrawn");
}

/** Lets the page run its pending events (input that may withdraw the render) before the render carries on. */
function yieldToPage(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Lets one capture at a time do the heavy part of a render: copying the element, embedding its resources, drawing and
 * encoding. Waiting for images and fonts to load is outside it. The holder is always withdrawn before another capture
 * starts (a new pick replaces the old one). Withdrawn while copying or embedding, it frees the slot at once: its copy
 * stops at the next node, and what it may still wait for (a resource fetch, a video) holds up no other capture.
 * Withdrawn while drawing (decoding the finished copy, drawing and encoding it, which waits on nothing outside the
 * page), it keeps the slot until it ends. So one render at a time does heavy work, however fast the user re-picks.
 */
export class RenderSlot {
  #tail: Promise<void> = Promise.resolve();

  /** Resolves, once the slot is free, with the function that frees it again. */
  async acquire(): Promise<() => void> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }
}

/**
 * Renders `element` to a PNG at the device scale lowered to the pixel cap. modern-screenshot first waits for the
 * element's images and fonts; the frame is measured after that, so an element that grew meanwhile still stays within
 * the cap. Once `signal` aborts, the render stops at its next copied node or step and its context is destroyed.
 */
async function render(element: Element, exclude: Node, deviceScale: number, slot: RenderSlot, signal: AbortSignal): Promise<{ png: Blob; scale: number }> {
  checkWithdrawn(signal);
  const check = (): void => checkWithdrawn(signal);
  let worked = performance.now();
  // Whether the render has reached drawing, which it finishes holding the slot (see RenderSlot).
  let drawing = false;
  const eachNode = async (): Promise<void> => {
    check();
    if (performance.now() - worked < YIELD_EVERY_MS) return;
    await yieldToPage();
    worked = performance.now();
    check();
  };
  const context = await createContext(element, {
    type: "image/png",
    timeout: SCREENSHOT_TIMEOUT_MS,
    filter: (node) => node !== exclude,
    // modern-screenshot awaits this after each copied node and lets what it throws end the copy.
    onCloneEachNode: eachNode,
    onCloneNode: check,
    onEmbedNode: check,
    onCreateForeignObjectSvg: () => {
      check();
      drawing = true;
    },
    autoDestruct: true,
  });
  let release: (() => void) | null = null;
  const freeUnlessDrawing = (): void => {
    if (!drawing) release?.();
  };
  try {
    check();
    release = await slot.acquire();
    signal.addEventListener("abort", freeUnlessDrawing, { once: true });
    check();
    worked = performance.now();
    // Everything that reads or copies the element happens from here on, holding the slot.
    if (hasScrolledBox(element)) throw new Error("a box in the element is scrolled, which a screenshot cannot show yet");
    const frame = frameOf(element);
    if (typeof frame === "string") throw new Error(frame);
    context.width = frame.width;
    context.height = frame.height;
    context.style = frame.style as Partial<CSSStyleDeclaration>;
    if (element instanceof SVGSVGElement) {
      // Drawn from the markup of a styled copy, which is what gets framed; the live element is never changed.
      const copy = await copyDrawing(element, eachNode);
      if (typeof copy === "string") throw new Error(copy);
      frameSvgCopy(copy, frame);
      context.node = copy;
      drawing = true;
    }
    const scale = screenshotScale(context.width, context.height, deviceScale);
    if (scale === null) throw new Error("the element has no visible area");
    context.scale = scale;
    context.dpi = scale === 1 ? null : 96 * scale;
    return { png: await domToBlob(context), scale };
  } catch (error) {
    destroyContext(context);
    throw error;
  } finally {
    signal.removeEventListener("abort", freeUnlessDrawing);
    release?.();
  }
}

/**
 * Captures `element` as a PNG in the page with modern-screenshot, leaving out `exclude` (the bar), within
 * {@link MAX_SCREENSHOT_PIXELS} and the daemon's attachment size limit, doing its heavy work only while it holds
 * `slot`. Never rejects: a failure resolves with the reason, so the comment can still be sent without a screenshot.
 * Aborting `signal` (or the time limit, counted from this call, when its render starts: it is queued behind nothing
 * but a withdrawn holder finishing its drawing) withdraws the capture: it resolves at once, and its render stops at its
 * next copied node or step and its context is destroyed.
 */
export async function captureScreenshot(element: Element, exclude: Node, slot: RenderSlot, signal?: AbortSignal): Promise<ScreenshotResult> {
  if (!element.isConnected) return { ok: false, reason: unavailableReason("the element is no longer on the page") };
  if (!(element instanceof HTMLElement || element instanceof SVGSVGElement)) {
    return { ok: false, reason: unavailableReason(`only HTML elements and whole SVG drawings can be captured, not <${element.localName}>`) };
  }
  const rect = element.getBoundingClientRect();
  if (screenshotScale(rect.width, rect.height, 1) === null) return { ok: false, reason: unavailableReason("the element has no visible area") };
  const deviceScale = element.ownerDocument.defaultView?.devicePixelRatio ?? 1;
  const withdraw = new AbortController();
  const onAbort = (): void => withdraw.abort();
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`it took longer than ${SCREENSHOT_TIMEOUT_MS / 1000} seconds`));
      withdraw.abort();
    }, SCREENSHOT_TIMEOUT_MS);
    withdraw.signal.addEventListener("abort", () => reject(new Error("the capture was withdrawn")), { once: true });
  });
  try {
    const { png, scale } = await Promise.race([render(element, exclude, deviceScale, slot, withdraw.signal), ended]);
    if (png.type !== "image/png") return { ok: false, reason: unavailableReason(`the browser produced ${png.type || "no image type"}`) };
    if (png.size === 0) return { ok: false, reason: unavailableReason("the image is empty") };
    if (png.size > MAX_ATTACHMENT_BYTES) {
      return { ok: false, reason: unavailableReason(`the image is ${png.size} bytes; the daemon accepts at most ${MAX_ATTACHMENT_BYTES}`) };
    }
    // The cap holds for the image actually produced, whatever the renderer did.
    const size = pngDimensions(new Uint8Array(await png.slice(0, 24).arrayBuffer()));
    if (size === null) return { ok: false, reason: unavailableReason("the browser produced an unreadable PNG") };
    if (size.width * size.height > MAX_SCREENSHOT_PIXELS) {
      return {
        ok: false,
        reason: unavailableReason(`the image is ${size.width} x ${size.height} pixels, over the ${MAX_SCREENSHOT_PIXELS / 1_000_000} MP cap`),
      };
    }
    return { ok: true, png, scale };
  } catch (error) {
    return { ok: false, reason: unavailableReason(errorMessage(error)) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
