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

const SVG_NS = "http://www.w3.org/2000/svg";

const XLINK = "http://www.w3.org/1999/xlink";

/**
 * Records in `ids` the `#id` that `url` names, or says why the drawing cannot be drawn: it loads something from
 * outside the page.
 */
function reference(url: string, ids: Set<string>): string | null {
  const value = linkText(url);
  if (!value.startsWith("#")) return /^data:/iu.test(value) ? null : `the drawing loads ${value.slice(0, 100)}, which a screenshot cannot embed yet`;
  const id = markupDrops(value) ? null : fragmentId(value);
  if (id === null) return `the drawing refers to ${value.slice(0, 100)}, an escaped #id a screenshot cannot resolve yet`;
  ids.add(id);
  return null;
}

/** Whether the image's markup loses a character of `text`: modern-screenshot deletes those XML forbids. */
function markupDrops(text: string): boolean {
  return /[\uD800-\uDFFF\uFFFE\uFFFF]/u.test(text) || [...text].some((char) => char < " " && !"\t\n\r".includes(char));
}

/** `url` without the C0 controls and spaces at its ends, which the URL parser strips (and nothing else). */
function linkText(url: string): string {
  let [start, end] = [0, url.length];
  while (start < end && url.charCodeAt(start) <= 0x20) start++;
  while (end > start && url.charCodeAt(end - 1) <= 0x20) end--;
  return url.slice(start, end);
}

/**
 * The id a `#fragment` link (from {@link linkText}) names as the browser looks it up: its URL-parsed fragment,
 * decoded. null when that is not the link's own text (an escape decoded, a tab or newline dropped, a lone surrogate
 * replaced), which is refused rather than resolved.
 */
function fragmentId(link: string): string | null {
  try {
    const id = decodeURIComponent(new URL(link, "about:blank").hash.slice(1));
    return id === link.slice(1) ? id : null;
  } catch {
    return null;
  }
}

/** CSS text with its escapes decoded, so that `u\72l(` reads as the `url(` it is. */
function decodedCss(text: string): string {
  return text.replace(/\\(?:([0-9a-f]{1,6})[ \t\n]?|([^\n]))/giu, (_match, hex: string | undefined, char: string | undefined) => {
    if (hex === undefined) return char ?? "";
    const code = Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "\uFFFD";
  });
}

/**
 * The one check of what CSS text (an attribute, a computed value or a `<style>` element's text) refers to: {@link
 * reference} for each `url(…)` or `src(…)` in it, in any case, quoted or not, escaped or not. An `@import` or an
 * `image-set()` cannot be drawn either.
 */
function references(text: string, ids: Set<string>): string | null {
  const css = decodedCss(text);
  if (/@import/iu.test(css)) return "the drawing imports a style sheet, which a screenshot cannot embed yet";
  if (/image-set\(/iu.test(css)) return "the drawing uses image-set(), which a screenshot cannot embed yet";
  for (const [, double, single, bare = ""] of css.matchAll(/(?<![\w-])(?:url|src)\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))/giu)) {
    const refused = reference(double ?? single ?? bare, ids);
    if (refused !== null) return refused;
  }
  return null;
}

/** What an element's `href` points to, which it loads unless it is a link. */
function hrefOf(element: Element): string | null {
  if (element.localName === "a") return null;
  return element.getAttribute("href") ?? element.getAttributeNS(XLINK, "href");
}

/** Attributes, other than links, that can load something (by a `url()`); others (`data-*`, `aria-*`) are only text. */
const RESOURCE_ATTRIBUTES = new Set(["style", "fill", "stroke", "filter", "clip-path", "mask", "marker-start", "marker-mid", "marker-end", "src"]);

/** SVG animation elements: what they animate (a polygon's points, a link) is not in the computed values compared. */
const ANIMATIONS = new Set(["set", "animate", "animateTransform", "animateMotion", "animateColor", "discard"]);

/**
 * Says why `element`'s attributes cannot be drawn, if they cannot: a link (`href`, `xlink:href`) or a `url()` in an
 * attribute that can load something ({@link RESOURCE_ATTRIBUTES}) that is neither a `#fragment` (recorded in `ids`) nor
 * `data:`.
 */
function attributeReferences(element: Element, ids: Set<string>): string | null {
  let refused: string | null = null;
  if (element.localName !== "a") {
    for (const link of [element.getAttribute("href"), element.getAttributeNS(XLINK, "href")]) if (link !== null) refused ??= reference(link, ids);
  }
  for (const { name, value } of element.attributes) if (RESOURCE_ATTRIBUTES.has(name)) refused ??= references(value, ids);
  return refused;
}

/** Replaces an element's `xlink:href` with an `href`, which the copy is drawn with alike. */
function plainHref(element: Element): void {
  const href = element.getAttributeNS(XLINK, "href");
  if (href === null) return;
  element.removeAttributeNS(XLINK, "href");
  if (!element.hasAttribute("href")) element.setAttribute("href", href);
}

/**
 * Properties that never change how an SVG image is drawn (pointing, selecting, a list item's marker): a drawing's
 * copy neither carries nor compares them (nor keeps their attributes, so a `cursor="url(…)"` loads nothing). Nor does
 * it carry transitions and animations: the copy is drawn as it computes now, still.
 */
const NOT_DRAWN = new Set(["cursor", "pointer-events", "user-select", "-webkit-user-select", "list-style-image"]);

/**
 * Whether the copy leaves a computed value out: one of {@link NOT_DRAWN}, a transition or animation, or a custom
 * property that refers to something outside the page (a property using it computes to that reference, which is
 * checked where it is used).
 */
function leftOut(name: string, value: string): boolean {
  return NOT_DRAWN.has(name) || /^(?:transition|animation)/u.test(name) || (name.startsWith("--") && references(value, new Set()) !== null);
}

/** An element's computed values, read once, so a running transition or animation compares against one moment. */
type Snapshot = (element: Element) => ReadonlyMap<string, string>;

function snapshots(): Snapshot {
  const taken = new Map<Element, Map<string, string>>();
  return (element) => {
    let values = taken.get(element);
    if (!values) {
      const style = getComputedStyle(element);
      values = new Map();
      for (let index = 0; index < style.length; index++) {
        const name = style.item(index);
        const value = style.getPropertyValue(name);
        if (!leftOut(name, value)) values.set(name, value);
      }
      taken.set(element, values);
    }
    return values;
  };
}

/** How many times an element is given the values it differs in: a value given can change another (a border style, its width). */
const MATCH_ROUNDS = 3;

/**
 * Gives `target` (in the isolated document) the values `live` computes (`want`) that it differs in, inline (but not
 * over what it has as important, the frame), after checking what each refers to, comparing again up to
 * {@link MATCH_ROUNDS} times; its transitions and animations, if any, are stopped first, so what it computes is what
 * is drawn. `strict` requires them to match then (a document's root does
 * not need to: it is always a block). A string says why a value cannot be given or does not match.
 */
function carry(
  target: SVGElement, live: Element, want: ReadonlyMap<string, string>, view: Window, ids: Set<string>, strict: boolean, given?: Set<Element>,
): string | null {
  const have = view.getComputedStyle(target);
  if (have.animationName.split(",").some((name) => name.trim() !== "none")) target.style.setProperty("animation", "none", "important");
  if (have.transitionDuration.split(",").some((duration) => Number.parseFloat(duration) > 0)) target.style.setProperty("transition", "none", "important");
  for (let round = 0; ; round++) {
    const values: [string, string][] = [];
    for (const [name, value] of want) {
      // What the frame sets (important) stays.
      if (!computes(have, name, value) && target.style.getPropertyPriority(name) !== "important") values.push([name, value]);
    }
    if (values.length === 0 || (round === MATCH_ROUNDS && !strict)) return null;
    if (round === MATCH_ROUNDS) return cannotReproduce(live, values[0]![0]);
    given?.add(live);
    for (const [name, value] of values) {
      const refused = references(value, ids);
      if (refused !== null) return refused;
      // A custom property set to "" would be removed; one blank is kept, empty.
      target.style.setProperty(name, value === "" && name.startsWith("--") ? " " : value);
    }
  }
}

/**
 * Whether `style` computes `name` as `value`. A custom property that is empty (`--x: ;`, which a `var()` substitutes
 * as nothing) differs from an absent one (whose `var()` takes its fallback), though both read as "".
 */
function computes(style: CSSStyleDeclaration, name: string, value: string): boolean {
  if (value !== style.getPropertyValue(name)) return false;
  if (value !== "" || !name.startsWith("--")) return true;
  // A computed style lists its custom properties last; reading only those keeps this cheap.
  for (let index = style.length - 1; index >= 0; index--) {
    const listed = style.item(index);
    if (listed === name) return true;
    if (!listed.startsWith("--")) break;
  }
  return false;
}

function cannotReproduce(element: Element, name: string): string {
  return `the page styles the drawing's <${element.localName}> (its ${name}) in a way its copy cannot reproduce yet`;
}

/** Where a `var()` names a custom property (in CSS text without comments or escapes); "" where it names none. */
const VARIABLE = /var\(\s*(--[^\s,)]+)?/giu;

/**
 * Whether the page registers custom property `name` (by `@property` or `CSS.registerProperty`), which the copy's
 * document does not: unregistered, it inherits any value and has none initially. Tested on two throwaway elements in
 * `scratch`, which is in the page's document but out of reach of its style rules.
 */
function registered(name: string, scratch: Node): boolean {
  const document = scratch.ownerDocument ?? (scratch as Document);
  const parent = document.createElement("x-iterbar-probe");
  const child = parent.appendChild(document.createElement("x-iterbar-probe"));
  const initial = document.createElement("x-iterbar-probe");
  parent.style.setProperty(name, "iterbar-probe");
  initial.style.setProperty(name, "initial");
  scratch.appendChild(parent);
  scratch.appendChild(initial);
  try {
    return getComputedStyle(child).getPropertyValue(name) !== "iterbar-probe" || getComputedStyle(initial).getPropertyValue(name) !== "";
  } finally {
    parent.remove();
    initial.remove();
  }
}

/**
 * Says why what the drawing's `<use>`s show (`shown`) may not be drawn as on the page, if it may not. A `<use>`'s
 * instance gets every page rule matching the element, resolved where shown; its copy only the element's attributes,
 * the drawing's own rules and what the `<use>` passes down. So nothing else may reach a shown element: refused are an
 * unreadable page sheet; a page rule (any nesting or condition, matched widened) matching one; an own rule nested,
 * conditional or matching its copy differently; one given values to match (`given`); a page-registered custom property
 * used. `eachNode` runs before each rule and each element it is matched against.
 */
async function shownRefusal(
  shown: ReadonlySet<Element>, copies: ReadonlyMap<Node, SVGElement>, given: ReadonlySet<Element>, lookup: Document | ShadowRoot,
  scratch: Node, eachNode: () => Promise<void>,
): Promise<string | null> {
  if (shown.size === 0) return null;
  const variables = new Set<string>();
  const noteVariables = (text: string): void => {
    for (const [, name = ""] of decodedCss(text.replaceAll(/\/\*[\s\S]*?\*\//gu, "")).matchAll(VARIABLE)) variables.add(name);
  };
  // Only attributes parsed as CSS: style and presentation attributes, not text (`data-*`, `aria-*`, a title).
  for (const element of shown) {
    for (const { name, value } of element.attributes) if (!/^(?:data-|aria-)|^(?:id|class|title|role|lang|tabindex)$/u.test(name)) noteVariables(value);
  }
  const unreadable = "the page has a style sheet it cannot read (another origin's), whose rules may style what a <use> in the drawing shows, which a screenshot cannot check yet";
  // Each list of rules; whether it is the drawing's own; whether it is nested or under a condition; and, inside a
  // style rule, the selector its declarations after nested rules have (relative ones match more: `&` stands for any).
  // And whether its sheet declares a default namespace (see widen).
  const stack: { rules: CSSRuleList; own: boolean; nested: boolean; parent: string | null; namespaced: boolean }[] = [];
  const push = (sheet: CSSStyleSheet | null, own: boolean): boolean => {
    if (!sheet) return false;
    if (sheet.disabled) return true;
    try {
      stack.push({ rules: sheet.cssRules, own, nested: Boolean(sheet.media.mediaText), parent: null, namespaced: false });
      return true;
    } catch {
      return false; // Another origin's style sheet, which the page may not read.
    }
  };
  for (const sheet of [...lookup.styleSheets, ...lookup.adoptedStyleSheets]) {
    if (!push(sheet, sheet.ownerNode !== null && copies.has(sheet.ownerNode))) return unreadable;
  }
  for (let next = stack.pop(); next; next = stack.pop()) {
    for (const rule of next.rules) {
      await eachNode();
      // A sheet's @namespace rules come before its style rules.
      if (rule instanceof CSSNamespaceRule) next.namespaced ||= rule.prefix === "";
      if (rule instanceof CSSImportRule) {
        // One never fetched (its condition is false) applies nothing.
        if (rule.styleSheet && !push(rule.styleSheet, next.own)) return unreadable;
        continue;
      }
      let { parent } = next;
      // A style rule, or the declarations a style rule (or @scope, for its root and what is in it) has among its rules.
      if (rule instanceof CSSStyleRule || ("style" in rule && (parent !== null || rule.constructor.name === "CSSNestedDeclarations"))) {
        const exact = !next.nested && rule instanceof CSSStyleRule;
        // In @scope (but not in a style rule in it), `&` is the scope's root, and declarations apply to it.
        const root = scopeRoot(rule, parent, next.namespaced);
        const selector = rule instanceof CSSStyleRule ? rule.selectorText : root ?? parent ?? "*";
        // What it matches at least (see widen), which its nested rules' `&` stands for in turn.
        const matching = rule instanceof CSSStyleRule ? widen(selector, root ?? parent, next.namespaced) : selector;
        if (matching === null) return `the page has a style rule (${selector.slice(0, 100)}) that a screenshot cannot match against what a <use> in the drawing shows yet`;
        parent = matching;
        const style = (rule as CSSStyleRule).style;
        for (const element of style.length > 0 ? shown : []) {
          await eachNode();
          let matches: boolean;
          let copyMatches = false;
          try {
            matches = element.matches(matching);
            if (next.own) copyMatches = copies.get(element)!.matches(matching);
          } catch {
            return `the page has a style rule (${selector.slice(0, 100)}) that a screenshot cannot match against what a <use> in the drawing shows yet`;
          }
          if (!matches && !copyMatches) continue;
          // An own rule is compared on original and copy only as it stands: widened, both may match where it does not.
          if (!next.own || !exact || matching !== selector || matches !== copyMatches) {
            return `the page has a style rule for the <${element.localName}> that a <use> in the drawing shows, which a screenshot cannot draw for each <use> yet`;
          }
          noteVariables(style.cssText);
        }
      }
      if ("cssRules" in rule) stack.push({ rules: rule.cssRules as CSSRuleList, own: next.own, nested: true, parent, namespaced: next.namespaced });
    }
  }
  for (const element of shown) {
    if (given.has(element)) return `the page styles the <${element.localName}> that a <use> in the drawing shows, which its copy cannot reproduce yet`;
    // The copy is drawn still, as its original computes now, which is not how each <use> shows it moving.
    await eachNode();
    if (getComputedStyle(element).animationName.split(",").some((name) => name.trim() !== "none")) {
      return "what a <use> in the drawing shows is animated, which a screenshot cannot check yet";
    }
  }
  for (const name of variables) {
    await eachNode();
    if (name === "") return "what a <use> in the drawing shows uses a var() a screenshot cannot read yet";
    if (registered(name, scratch)) return `what a <use> in the drawing shows uses ${name}, which the page registers, and a screenshot cannot reproduce yet`;
  }
  return null;
}

/**
 * The selector of the root of the @scope that `rule` is in, through any grouping or conditional rules but not through
 * a style rule (where `&` is that rule): its start selector, widened with `parent` (the selector of the style rule the
 * @scope is in) for `&`. Undefined when `rule` is not in an @scope that way.
 */
function scopeRoot(rule: CSSRule, parent: string | null, namespaced: boolean): string | undefined {
  for (let outer = rule.parentRule; outer; outer = outer.parentRule) {
    if (outer instanceof CSSStyleRule) return undefined;
    if ("start" in outer) {
      const start = (outer as { start?: string | null }).start;
      return (start && widen(start, parent, namespaced)) || "*";
    }
  }
  return undefined;
}

/** Where the escape at `at` in `text` (a backslash and a character, or up to 6 hex digits and a space) ends. */
function escapeEnd(text: string, at: number): number {
  let end = at + 1;
  while (end < at + 7 && /[0-9a-f]/iu.test(text[end] ?? "")) end++;
  return end === at + 1 ? end + 1 : end + Number(/[ \t\n]/u.test(text[end] ?? ""));
}

/** Whether `char` continues a name (or a namespace prefix) in a selector. */
const inName = (char: string): boolean => /[\w*-]/u.test(char) || char > "\u007f";

/** Functional pseudo-classes that match more when their argument does; in any other, it can match less. */
const MONOTONE = new Set(["is", "where", "has", "matches", "-webkit-any", "host", "host-context"]);

/**
 * `selector` widened in one pass to match at least what it can on the page: `&` becomes `:is(parent)` (any element
 * without one), `:scope` any element, a namespace prefix (`matches()` knows none) `*|`. Each outermost pseudo-class but
 * {@link MONOTONE} ones (`:not()`, `:nth-child(… of …)`) that holds one of them, or any under a default namespace
 * (`namespaced`, whose unprefixed names `matches()` reads as any), becomes `:is(*)`. Strings and escapes are kept.
 * `null` when its parentheses do not balance.
 */
function widen(selector: string, parent: string | null, namespaced = false): string | null {
  let out = "";
  // Each open parenthesis: where its pseudo-class starts in `out`, whether it is monotone, whether it holds a widening.
  const open: { start: number; monotone: boolean; widened: boolean }[] = [];
  // Where the name `out` ends with starts: a namespace prefix there is replaced.
  let name = 0;
  const emit = (text: string, widened = false): void => {
    out += text;
    name = out.length;
    if (widened) for (const group of open) group.widened = true;
  };
  for (let at = 0; at < selector.length;) {
    const char = selector[at]!;
    const next = selector[at + 1] ?? "";
    if (char === '"' || char === "'") {
      let end = at + 1;
      while (end < selector.length && selector[end] !== char) end += selector[end] === "\\" ? 2 : 1;
      emit(selector.slice(at, end + 1));
      at = end + 1;
    } else if (char === "\\") {
      // Part of a name.
      const end = escapeEnd(selector, at);
      out += selector.slice(at, end);
      at = end;
    } else if (char === ":" && selector.slice(at, at + 6).toLowerCase() === ":scope" && !inName(selector[at + 6] ?? "")) {
      emit("*", true);
      at += 6;
    } else if (char === "&") {
      emit(parent === null ? "*" : `:is(${parent})`, true);
      at++;
    } else if (char === "|" && next !== "=" && next !== "|" && selector[at - 1] !== "|") {
      out = out.slice(0, name);
      emit("*|", true);
      at++;
    } else if (char === "(") {
      // The pseudo-class (or pseudo-element) whose name `out` ends with.
      const colons = out[name - 1] === ":" ? 1 + Number(out[name - 2] === ":") : 0;
      open.push({ start: name - colons, monotone: colons === 1 && MONOTONE.has(out.slice(name).toLowerCase()), widened: namespaced });
      emit(char);
      at++;
    } else if (char === ")") {
      const group = open.pop();
      if (!group) return null;
      emit(char);
      if (group.widened && !group.monotone) {
        out = out.slice(0, group.start);
        emit(":is(*)");
      }
      at++;
    } else {
      out += char;
      if (!inName(char)) name = out.length;
      at++;
    }
  }
  return open.length === 0 ? out : null;
}

/**
 * Copies an `<svg>` drawing (drawn from its markup) and checks that the copy computes its styles as the drawing does,
 * in a hidden, sandboxed `about:blank` frame in `scratch` without the page's style sheets, the copy as its root. The
 * root carries the drawing's computed values it lacks there (what it inherits reaches its shapes); each definition it
 * uses by `#id` from elsewhere is copied under copies (without ids or other children) of its ancestors up to its own
 * `<svg>`, carrying values the same way. Each copied element is compared with its original, property by property
 * (custom properties too, an empty one kept empty), given the values it differs in as computed, and compared again
 * once all are given. What a `<use>` shows must have nothing from the page its copy lacks (see {@link shownRefusal}),
 * the copy no text, and no SVG animation may hold or target what is copied. What the copy refers to (links, `url()`s
 * in attributes that can load something, given values, `<style>` text) is checked before it holds it. A string says
 * why it cannot be drawn. `eachNode` runs before each element or rule is copied or compared, and may end the copy; the
 * frame is removed however it ends.
 */
async function copyDrawing(svg: SVGSVGElement, frame: Frame, scratch: Node, eachNode: () => Promise<void>): Promise<SVGSVGElement | string> {
  const box = getComputedStyle(svg);
  if (sumPx(box, ["padding-top", "padding-right", "padding-bottom", "padding-left", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width"]) > 0) {
    return "the drawing has padding or a border, which its copy cannot frame yet";
  }
  const ids = new Set<string>();
  const own = new Set<string>();
  // Each copied element and its original, compared once the copy is complete.
  const pairs: [Element, SVGElement][] = [];
  /** A copy of `source` without its children, once what it refers to is checked; a string says why it cannot be. */
  const shallow = (source: Element, ownsId = true): SVGElement | string => {
    if (source.localName === "foreignObject") return "the drawing holds HTML (<foreignObject>), which a screenshot cannot copy with its styles yet";
    if (!(source instanceof SVGElement)) return `the drawing holds a <${source.localName}> element, which a screenshot cannot copy`;
    if (ANIMATIONS.has(source.localName)) return `the drawing is animated (<${source.localName}>), which a screenshot cannot check yet`;
    const refused = attributeReferences(source, ids);
    if (refused !== null) return refused;
    if (ownsId && markupDrops(source.id)) return "the drawing has an id with a control character, which a screenshot cannot keep yet";
    if (source.id && ownsId) own.add(source.id);
    const copy = source.cloneNode(false) as SVGElement;
    plainHref(copy);
    for (const name of NOT_DRAWN) copy.removeAttribute(name);
    return copy;
  };
  const copyInto = async (parent: Element, source: Element): Promise<string | null> => {
    await eachNode();
    const copy = shallow(source);
    if (typeof copy === "string") return copy;
    pairs.push([source, copy]);
    parent.appendChild(copy);
    return childrenInto(copy, source);
  };
  const childrenInto = async (copy: Element, source: Element): Promise<string | null> => {
    if (source.localName === "style") {
      // Its rules as the page has them (a script may have changed them since its text), checked, and then given at
      // once, so the copy (which is in a document) parses them once. A disabled one has none.
      const sheet = (source as SVGStyleElement).sheet;
      const rules = !sheet || sheet.disabled ? [] : [...sheet.cssRules];
      const text = !sheet ? source.textContent ?? "" : rules.map((rule) => rule.cssText).join("\n");
      // A namespace's url() names it, and loads nothing.
      const refused = references(!sheet ? text : rules.filter((rule) => !(rule instanceof CSSNamespaceRule)).map((rule) => rule.cssText).join("\n"), ids);
      if (refused !== null) return refused;
      copy.textContent = text;
      return null;
    }
    for (let child = source.firstChild; child; child = child.nextSibling) {
      await eachNode();
      if (child instanceof Text) copy.appendChild(child.cloneNode(false));
      else if (child instanceof Element && child.localName !== "script") {
        const refused = await copyInto(copy, child);
        if (refused !== null) return refused;
      }
    }
    return null;
  };

  await eachNode();
  const root = shallow(svg);
  if (typeof root === "string") return root;
  const snapshot = snapshots();
  const isolated = svg.ownerDocument.createElement("iframe");
  isolated.setAttribute("sandbox", "allow-same-origin");
  isolated.setAttribute("aria-hidden", "true");
  isolated.tabIndex = -1;
  isolated.style.cssText = `position: fixed; top: 0; left: 0; width: ${frame.style.width}; height: ${frame.style.height}; border: 0; visibility: hidden; pointer-events: none`;
  scratch.appendChild(isolated);
  try {
    const isolatedDocument = isolated.contentDocument;
    const view = isolated.contentWindow;
    if (!isolatedDocument?.documentElement || !view) return "the drawing could not be checked";
    isolatedDocument.replaceChild(root, isolatedDocument.documentElement);
    const copy = root as SVGSVGElement;
    const carried = carry(copy, svg, snapshot(svg), view, ids, false);
    if (carried !== null) return carried;
    frameSvgCopy(copy, frame);
    // What the root differs in now, being the frame's root (it is a block), may differ at the end too; nothing else.
    const rootStyle = view.getComputedStyle(copy);
    const rootResidual = new Set([...snapshot(svg)].filter(([name, value]) => !computes(rootStyle, name, value)).map(([name]) => name));
    const children = await childrenInto(copy, svg);
    if (children !== null) return children;
    // What it refers to by #id outside itself (a sprite's symbol, a gradient), with what the definitions refer to.
    const lookup = svg.getRootNode() as Document | ShadowRoot;
    const defs = isolatedDocument.createElementNS(SVG_NS, "defs");
    const ancestors = new Map<Element, Element>();
    const define = async (id: string): Promise<string | null> => {
      const definition = own.has(id) ? null : lookup.getElementById(id);
      if (!(definition instanceof SVGElement) || definition.contains(svg)) return null;
      if (!defs.parentNode) copy.appendChild(defs);
      // An outermost <svg> stands in HTML: a group carries what its parent gives it.
      const chain: Element[] = [];
      const top = definition.ownerSVGElement ?? definition.parentElement;
      for (let node: Element | null = definition.parentElement; top && node; node = node.parentElement) {
        chain.unshift(node);
        if (node === top) break;
      }
      let context: Element = defs;
      for (const ancestor of chain) {
        let ancestorCopy = ancestors.get(ancestor);
        if (!ancestorCopy) {
          await eachNode();
          const made = ancestor instanceof SVGElement ? shallow(ancestor, false) : isolatedDocument.createElementNS(SVG_NS, "g");
          if (typeof made === "string") return made;
          // Without its id, nothing in the copy can refer to this partial copy.
          made.removeAttribute("id");
          ancestors.set(ancestor, ancestorCopy = context.appendChild(made));
          const refused = carry(made, ancestor, snapshot(ancestor), view, ids, false);
          if (refused !== null) return refused;
        }
        context = ancestorCopy;
      }
      return copyInto(context, definition);
    };
    // Definitions first; then each new element is compared and given what it differs in, whose references may need
    // more definitions; until nothing is left.
    const defined = new Set<string>();
    let compared = 0;
    // The elements given values to match their originals.
    const given = new Set<Element>();
    for (;;) {
      for (const id of ids) {
        if (defined.has(id)) continue;
        defined.add(id);
        const refused = await define(id);
        if (refused !== null) return refused;
      }
      if (compared === pairs.length) break;
      for (; compared < pairs.length; compared++) {
        await eachNode();
        const [live, copied] = pairs[compared]!;
        const refused = carry(copied, live, snapshot(live), view, ids, true, given);
        if (refused !== null) return refused;
      }
    }
    // What <use>s show, which must have nothing from the page; then every element again, now that all are given values.
    const copies = new Map<Node, SVGElement>(pairs);
    // One elsewhere on the page that animates the root, a copied element or a definition's ancestor (by its href)
    // changes it too.
    for (const animation of lookup.querySelectorAll([...ANIMATIONS].join(","))) {
      await eachNode();
      const href = linkText(hrefOf(animation) ?? "");
      // Its link names its target by #id, alone or after this page's URL (another page's targets nothing); none, its parent.
      let target: Element | null = animation.parentElement;
      if (href) {
        try {
          const [url, here] = [new URL(href, animation.baseURI), new URL(animation.ownerDocument.URL)];
          const id = decodeURIComponent(url.hash.slice(1));
          [url.hash, here.hash] = ["", ""];
          target = href.startsWith("#") || url.href === here.href ? lookup.getElementById(id) : null;
        } catch {
          target = svg; // A link it cannot read is taken to target the drawing.
        }
      }
      if (target && (target === svg || copies.has(target) || ancestors.has(target))) return `the drawing is animated (<${animation.localName}>), which a screenshot cannot check yet`;
    }
    const shown = new Set<Element>();
    for (const [live] of pairs) {
      const href = live.localName === "use" ? linkText(hrefOf(live) ?? "") : "";
      const id = href.startsWith("#") ? fragmentId(href) : null;
      const target = id === null ? null : lookup.getElementById(id);
      if (!target || !copies.has(target) || shown.has(target)) continue;
      for (const element of [target, ...target.querySelectorAll("*")]) {
        await eachNode();
        if (copies.has(element)) shown.add(element);
      }
    }
    const shownRefused = await shownRefusal(shown, copies, given, lookup, scratch, eachNode);
    if (shownRefused !== null) return shownRefused;
    // Text, whose font and its rasterising an image cannot be shown to match the page's (a <use> shows its copy's).
    if (pairs.some(([live]) => live.localName === "text")) return "the drawing has text, whose font a screenshot cannot check yet";
    // Its own selectors may match the root differently now that it has its children: given its values again, it
    // must match as it did.
    const recarried = carry(copy, svg, snapshot(svg), view, ids, false);
    if (recarried !== null) return recarried;
    for (const [name, value] of snapshot(svg)) if (!rootResidual.has(name) && !computes(rootStyle, name, value)) return cannotReproduce(svg, name);
    for (const [live, copied] of pairs) {
      await eachNode();
      const have = view.getComputedStyle(copied);
      for (const [name, value] of snapshot(live)) if (!computes(have, name, value)) return cannotReproduce(live, name);
    }
    isolatedDocument.removeChild(copy);
    svg.ownerDocument.adoptNode(copy);
    // modern-screenshot would copy a drawing whose markup matches its test for links as an HTML element instead.
    if (SVG_EXTERNAL_RESOURCE.test(copy.innerHTML)) return "the drawing's text looks like a link to the screenshot library";
    return copy;
  } finally {
    isolated.remove();
  }
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
    "min-width": "0", "max-width": "none", "min-height": "0", "max-height": "none",
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
  // Where a drawing's copy is checked: inside the bar's shadow root, out of the page's reach.
  const scratch = (exclude instanceof Element && exclude.shadowRoot) || exclude;
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
      // Drawn from the markup of a framed copy that is checked to look the same; the live element is never changed.
      const copy = await copyDrawing(element, frame, scratch, eachNode);
      if (typeof copy === "string") throw new Error(copy);
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
 * Captures `element` as a PNG in the page with modern-screenshot, leaving out `exclude` (the bar, whose shadow root
 * holds the frame a drawing's copy is checked in while it is), within
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
