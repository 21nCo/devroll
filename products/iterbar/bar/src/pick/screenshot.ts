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

/** Inherited properties a drawing's copy carries on an element that specifies them (see `copyDrawing`). */
const SVG_INHERITED = [
  "color", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray",
  "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "paint-order", "clip-rule",
  "marker-start", "marker-mid", "marker-end", "visibility", "font-family", "font-size", "font-style", "font-weight",
  "font-variant", "font-stretch", "letter-spacing", "word-spacing", "text-anchor", "dominant-baseline", "writing-mode",
  "direction", "shape-rendering", "text-rendering", "image-rendering", "color-interpolation",
] as const;

/** Properties that are not inherited, which the copy carries where they are not their initial value. */
const SVG_OWN: Readonly<Record<string, string>> = {
  opacity: "1", transform: "none", "clip-path": "none", mask: "none", filter: "none", "mix-blend-mode": "normal",
  "stop-color": "rgb(0, 0, 0)", "stop-opacity": "1", "flood-color": "rgb(0, 0, 0)", "flood-opacity": "1",
  "lighting-color": "rgb(255, 255, 255)", "vector-effect": "none", overflow: "visible", "text-decoration-line": "none",
};

/** Colours that `currentColor` can give; the copy keeps the keyword, so a `<use>` showing the element still sets it. */
const PAINT = new Set(["fill", "stroke", "stop-color", "flood-color", "lighting-color"]);

/** A page style rule that declares a property the copy may carry. */
interface CarriedRule {
  readonly selector: string;
  readonly style: CSSStyleDeclaration;
}

/**
 * The style rules of `root` (its style sheets, adopted ones included) that apply now and declare a property the copy
 * carries. Rules in a style sheet the page may not read (another origin's) are left out.
 */
function carriedRules(root: Node): Map<string, CarriedRule[]> {
  const rules = new Map<string, CarriedRule[]>();
  const names = [...SVG_INHERITED, ...PAINT];
  const visit = (list: CSSRuleList): void => {
    for (const rule of list) {
      if (rule instanceof CSSStyleRule) {
        for (const name of names) {
          if (rule.style.getPropertyValue(name) !== "") rules.set(name, [...rules.get(name) ?? [], { selector: rule.selectorText, style: rule.style }]);
        }
      } else if (rule instanceof CSSMediaRule) {
        if (matchMedia(rule.conditionText).matches) visit(rule.cssRules);
      } else if (rule instanceof CSSSupportsRule) {
        if (CSS.supports(rule.conditionText)) visit(rule.cssRules);
      } else if (rule instanceof CSSImportRule) {
        if (rule.styleSheet && (!rule.media.mediaText || matchMedia(rule.media.mediaText).matches)) visit(rule.styleSheet.cssRules);
      } else if ("cssRules" in rule) {
        visit(rule.cssRules as CSSRuleList);
      }
    }
  };
  const owner = root instanceof Document || root instanceof ShadowRoot ? root : null;
  for (const sheet of owner ? [...owner.styleSheets, ...owner.adoptedStyleSheets] : []) {
    if (sheet.disabled || (sheet.media.mediaText && !matchMedia(sheet.media.mediaText).matches)) continue;
    try {
      visit(sheet.cssRules);
    } catch {
      // Another origin's style sheet, which the page may not read.
    }
  }
  return rules;
}

/**
 * Whether `element` itself specifies `name` (by its attribute, a page rule or its inline style), and if so whether as
 * `currentColor`: from the declarations that win (an important inline one, then important rules, then the inline one,
 * then rules, then the attribute), `"either"` when rules that tie disagree, or a custom property decides, and the
 * value it ends up with cannot tell.
 */
function specified(element: Element, name: string, rules: readonly CarriedRule[], matches: (element: Element, rule: CarriedRule) => boolean): boolean | "either" | null {
  // Whether a declared value is currentColor ("var" when a custom property decides); "inherit" when it only inherits;
  // null when there is none.
  type Keyword = boolean | "inherit" | "var";
  const keyword = (value: string): Keyword | null => {
    const normal = value.trim().toLowerCase();
    if (normal === "") return null;
    if (normal.includes("var(")) return "var";
    return normal === "inherit" || normal === "unset" ? "inherit" : normal === "currentcolor";
  };
  const inline = element instanceof SVGElement || element instanceof HTMLElement ? element.style : null;
  const matched: { keyword: Keyword; important: boolean }[] = [];
  for (const rule of rules) {
    const value = keyword(rule.style.getPropertyValue(name));
    if (value !== null && matches(element, rule)) matched.push({ keyword: value, important: rule.style.getPropertyPriority(name) === "important" });
  }
  const inlineValue = inline ? keyword(inline.getPropertyValue(name)) : null;
  const important = matched.filter((rule) => rule.important);
  let tie: Keyword[];
  if (inlineValue !== null && inline?.getPropertyPriority(name) === "important") tie = [inlineValue];
  else if (important.length > 0) tie = important.map((rule) => rule.keyword);
  else if (inlineValue !== null) tie = [inlineValue];
  else if (matched.length > 0) tie = matched.map((rule) => rule.keyword);
  else {
    const attribute = keyword(element.getAttribute(name) ?? "");
    if (attribute === null) return null;
    tie = [attribute];
  }
  if (tie.every((value) => value === "inherit")) return null;
  if (tie.every((value) => value === true)) return true;
  if (!tie.includes(true) && !tie.includes("var")) return false;
  const style = getComputedStyle(element);
  return style.getPropertyValue(name) === style.color ? "either" : false;
}

/** {@link specified} for an element, with the page's rules for the property or none. */
type Cascade = (element: Element, name: string, withRules: boolean) => boolean | "either" | null;

/** The {@link Cascade} of `root`'s style rules, each matched against an element at most once. */
function cascadeOf(root: Node): Cascade {
  const rules = carriedRules(root);
  const matched = new WeakMap<Element, Map<CarriedRule, boolean>>();
  const matches = (element: Element, rule: CarriedRule): boolean => {
    let known = matched.get(element);
    if (!known) matched.set(element, known = new Map());
    let result = known.get(rule);
    if (result === undefined) {
      try {
        result = element.matches(rule.selector);
      } catch {
        result = false; // A selector matches() does not take (a pseudo-element's).
      }
      known.set(rule, result);
    }
    return result;
  };
  return (element, name, withRules) => specified(element, name, withRules ? rules.get(name) ?? [] : [], matches);
}

/** Whether `element` gives `name` as currentColor, itself or, where it only inherits it, by its nearest ancestor that does. */
function inheritedKeyword(element: Element, name: string, cascade: Cascade): boolean | "either" {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const found = cascade(node, name, true);
    if (found !== null) return found;
  }
  return false;
}

/** Geometry properties that page CSS can set, by the elements they apply to. */
const GEOMETRY: Readonly<Record<string, readonly string[]>> = {
  circle: ["cx", "cy", "r"], ellipse: ["cx", "cy", "rx", "ry"], rect: ["x", "y", "width", "height", "rx", "ry"],
  image: ["x", "y", "width", "height"], use: ["x", "y", "width", "height"], svg: ["x", "y", "width", "height"], path: ["d"],
};

/** Attributes whose value can refer to something with `url(…)`. */
const URL_ATTRIBUTES = new Set(["style", "fill", "stroke", "clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end"]);

const XLINK = "http://www.w3.org/1999/xlink";

/**
 * Records in `ids` the `#id` that `url` names (and whether a `<use>` shows it), or says why the drawing cannot be
 * drawn: it loads something from outside the page.
 */
function reference(url: string, ids: Map<string, boolean>, shownByUse = false): string | null {
  const value = url.trim();
  if (value.startsWith("#")) ids.set(value.slice(1), shownByUse || ids.get(value.slice(1)) === true);
  else if (!/^data:/iu.test(value)) return `the drawing loads ${value.slice(0, 100)}, which a screenshot cannot embed yet`;
  return null;
}

/** {@link reference} for each `url(…)` in a value. */
function urlReferences(value: string, ids: Map<string, boolean>): string | null {
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

/** Whether a computed geometry value differs from what the element's own attribute gives. */
function geometryOverridden(name: string, value: string, attribute: string | null): boolean {
  if (name === "d") return attribute === null && value !== "none";
  if (attribute === null) return value !== "auto" && value !== "0px";
  return Number.parseFloat(attribute) !== px(value);
}

/**
 * Copies an `<svg>` drawing, which is drawn from its markup, with the styles the page gives it inlined. Each element
 * carries the inherited properties it specifies (its value differs from its parent's, or it has its own attribute or
 * inline declaration for it, which a page rule may override), so what it only inherits still comes from where it is
 * shown, a `<use>` included; paint equal to its colour is written as `currentColor`. The drawing's root carries all of
 * them, from the page around it. Non-inherited properties and geometry set by the page are carried too. Its
 * `xlink:href`s become `href`s. What it refers to by `#id` outside itself is copied into it the same way: a definition
 * that a `<use>` shows (a sprite's symbol) inherits from the `<use>`; any other (a gradient, marker or pattern) carries
 * everything it inherits where it stands. A string says why it cannot be drawn: it loads a resource from outside the
 * page, or holds HTML. `eachNode` runs before each element is copied and may end the copy.
 */
async function copyDrawing(svg: SVGSVGElement, eachNode: () => Promise<void>): Promise<SVGSVGElement | string> {
  const own = new Set<string>();
  const wanted = new Map<string, boolean>();
  const box = getComputedStyle(svg);
  if (sumPx(box, ["padding-top", "padding-right", "padding-bottom", "padding-left", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width"]) > 0) {
    return "the drawing has padding or a border, which its copy cannot frame yet";
  }
  const cascade = cascadeOf(svg.getRootNode());
  // What a <use> in it shows, which inherits from the <use>: a rule giving it the value its parent has still counts.
  const shownHere = new Set([...svg.querySelectorAll("use")].map((use) => hrefOf(use)?.trim() ?? "").filter((href) => href.startsWith("#")).map((href) => href.slice(1)));
  const copyOf = async (source: Element, parent: CSSStyleDeclaration | null, carryAll: boolean, shownByUse: boolean): Promise<Element | string> => {
    const shown = shownByUse || shownHere.has(source.id);
    await eachNode();
    if (source.localName === "foreignObject") return "the drawing holds HTML (<foreignObject>), which a screenshot cannot copy with its styles yet";
    if (!(source instanceof SVGElement)) return `the drawing holds a <${source.localName}> element, which a screenshot cannot copy`;
    if (source.id) own.add(source.id);
    const href = hrefOf(source);
    const refused = (href === null ? null : reference(href, wanted, source.localName === "use"))
      ?? [...source.attributes].reduce<string | null>((found, { name, value }) => found ?? (URL_ATTRIBUTES.has(name) ? urlReferences(value, wanted) : null), null);
    if (refused !== null) return refused;
    const copy = source.cloneNode(false) as SVGElement;
    plainHref(copy);
    const style = getComputedStyle(source);
    // Each property it specifies, or (at a root) inherits from the page, keeping currentColor as the keyword; what it
    // only inherits otherwise comes from where it is shown. One differing from its parent's is specified, by a rule
    // the page may not read if by nothing found here.
    const carried = new Map<string, boolean | "either">();
    for (const name of SVG_INHERITED) {
      const mine = cascade(source, name, shown || PAINT.has(name));
      if (carryAll) carried.set(name, PAINT.has(name) ? inheritedKeyword(source, name, cascade) : false);
      else if (mine !== null) carried.set(name, PAINT.has(name) && mine);
      else if (style.getPropertyValue(name) !== parent?.getPropertyValue(name)) carried.set(name, false);
    }
    for (const name of Object.keys(SVG_OWN)) {
      if (style.getPropertyValue(name) !== SVG_OWN[name]) carried.set(name, PAINT.has(name) && (cascade(source, name, true) ?? false));
    }
    for (const name of source === svg ? [] : GEOMETRY[source.localName] ?? []) {
      if (geometryOverridden(name, style.getPropertyValue(name), source.getAttribute(name))) carried.set(name, false);
    }
    if (style.transform !== "none") carried.set("transform-origin", false).set("transform-box", false);
    if (style.display === "none") carried.set("display", false);
    for (const [name, keyword] of carried) {
      if (keyword === "either") return `the drawing's ${name} may be currentColor or a colour equal to it, which cannot be told apart`;
      const value = style.getPropertyValue(name);
      if (!value) continue;
      copy.style.setProperty(name, keyword ? "currentcolor" : value);
      const external = urlReferences(value, wanted);
      if (external !== null) return external;
    }
    for (let child = source.firstChild; child; child = child.nextSibling) {
      if (child instanceof Text) copy.appendChild(child.cloneNode(false));
      else if (child instanceof Element && child.localName !== "script") {
        const childCopy = await copyOf(child, style, false, shown);
        if (typeof childCopy === "string") return childCopy;
        copy.appendChild(childCopy);
      }
    }
    return copy;
  };
  const copy = await copyOf(svg, null, true, false);
  if (typeof copy === "string") return copy;
  const defs = svg.ownerDocument.createElementNS(svg.namespaceURI, "defs");
  for (const [id, shownByUse] of wanted) {
    const definition = own.has(id) ? null : svg.ownerDocument.getElementById(id);
    if (!(definition instanceof SVGElement)) continue;
    const context = definition.parentElement ? getComputedStyle(definition.parentElement) : null;
    const definitionCopy = await copyOf(definition, context, !shownByUse, shownByUse);
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
