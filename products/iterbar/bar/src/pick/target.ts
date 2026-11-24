import {
  activeVariantsSchema,
  MAX_TEXT_EXCERPT_LENGTH,
  parseSourceLocation,
  readPageApi,
  SOURCE_ATTRIBUTE,
  type ActiveVariant,
  type BoundingBox,
  type FeedbackTarget,
  type SourceLocation,
} from "@iterbar/core";
import { stableSelector } from "./selector.js";

/**
 * `text` with runs of whitespace collapsed and both ends trimmed, cut to `max` UTF-16 code units. A cut text ends
 * with "…" and never splits a surrogate pair.
 */
export function textExcerpt(text: string, max: number = MAX_TEXT_EXCERPT_LENGTH): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= max) return collapsed;
  let cut = collapsed.slice(0, Math.max(0, max - 1));
  if (/[\uD800-\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** The element's rendered text: `innerText` for HTML elements, which skips hidden text and scripts. */
function renderedText(element: Element): string {
  return (element as Partial<HTMLElement>).innerText ?? element.textContent ?? "";
}

/** The element's border box in CSS pixels relative to the top-left corner of the document. */
export function documentBox(element: Element): BoundingBox {
  const rect = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  return {
    x: rect.left + (view?.scrollX ?? 0),
    y: rect.top + (view?.scrollY ?? 0),
    width: Math.max(0, rect.width),
    height: Math.max(0, rect.height),
  };
}

/** The location stamped on the element or its nearest ancestor with a well-formed `data-iterbar-src`. */
export function nearestSourceLocation(element: Element): SourceLocation | null {
  const stamped = `[${SOURCE_ATTRIBUTE}]`;
  let current = element.closest(stamped);
  while (current) {
    const location = parseSourceLocation(current.getAttribute(SOURCE_ATTRIBUTE));
    if (location) return location;
    current = current.parentElement?.closest(stamped) ?? null;
  }
  return null;
}

/** What a comment about `element` says it is about, or `null` when no selector can name it. */
export function describeTarget(element: Element): FeedbackTarget | null {
  const selector = stableSelector(element);
  if (selector === null) return null;
  return {
    selector,
    textExcerpt: textExcerpt(renderedText(element)),
    boundingBox: documentBox(element),
    sourceLocation: nearestSourceLocation(element),
  };
}

/** The variant each slot on the page shows, from the page API; empty without a registry or with an unreadable one. */
export function readActiveVariants(): ActiveVariant[] {
  try {
    const api = readPageApi();
    if (!api) return [];
    const variants = api.getSnapshot().slots.map((slot) => ({ slot: slot.slot, variant: slot.activeVariant }));
    const parsed = activeVariantsSchema.safeParse(variants);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** A short, human-readable name for the picked element, such as `button#save` or `p.lead`. */
export function describeElement(element: Element): string {
  let name = element.localName;
  if (element.id) name += `#${element.id}`;
  else {
    const first = [...element.classList][0];
    if (first) name += `.${first}`;
  }
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
}

/** Longest name a target label shows before cutting it with "…". */
export const MAX_LABEL_NAME_LENGTH = 48;

/** What the composer, the draft tray and the inbox call a target: a readable name and, when known, where it is written. */
export interface TargetLabel {
  /** The accessible name or a short excerpt of the text in quotes, else a short element description such as `img` or `div.card`. */
  readonly name: string;
  /** `File.tsx:12`, from the nearest source stamp, or `null`. */
  readonly source: string | null;
  /** The full source location (`src/File.tsx:12:5`), for a tooltip, or `null`. */
  readonly sourcePath: string | null;
  /** The selector the comment carries, for a tooltip, or `null` when no selector can name the element. */
  readonly selector: string | null;
}

function quoted(text: string): string {
  const excerpt = textExcerpt(text, MAX_LABEL_NAME_LENGTH);
  return excerpt ? `“${excerpt}”` : "";
}

function textOfIds(element: Element, ids: string): string {
  const root = element.getRootNode() as Document | ShadowRoot;
  return ids.split(/\s+/u).map((id) => (id ? root.getElementById?.(id) : null))
    .map((labelled) => (labelled ? renderedText(labelled) : "")).join(" ");
}

/** The text of a native form control's `<label>`s; nothing for any other element, whatever its `labels` property. */
function labelTexts(element: Element): string[] {
  const native = [HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLButtonElement, HTMLOutputElement, HTMLMeterElement, HTMLProgressElement];
  if (!native.some((type) => typeof type === "function" && element instanceof type)) return [];
  const labels = (element as HTMLInputElement).labels;
  return labels ? [...labels].map((label) => renderedText(label)) : [];
}

/**
 * A short accessible name for `element`, in the order screen readers mostly take one: `aria-labelledby`, `aria-label`,
 * an image's `alt`, a form control's label or placeholder, the rendered text, then `title`. Empty when it has none.
 */
export function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  const candidates = [
    labelledBy ? textOfIds(element, labelledBy) : "",
    element.getAttribute("aria-label") ?? "",
    element.localName === "img" ? element.getAttribute("alt") ?? "" : "",
    ...labelTexts(element),
    element.getAttribute("placeholder") ?? "",
    renderedText(element),
    element.getAttribute("title") ?? "",
  ];
  for (const candidate of candidates) {
    const text = textExcerpt(candidate, MAX_LABEL_NAME_LENGTH);
    if (text) return text;
  }
  return "";
}

function shortSource(location: SourceLocation): string {
  return `${location.path.split("/").at(-1)}:${location.line}`;
}

function fullSource(location: SourceLocation): string {
  return `${location.path}:${location.line}:${location.column}`;
}

/** A readable label for a picked element; see {@link TargetLabel}. */
export function labelElement(element: Element, target: FeedbackTarget | null = describeTarget(element)): TargetLabel {
  const name = accessibleName(element);
  const location = target?.sourceLocation ?? nearestSourceLocation(element);
  return {
    name: name ? `“${name}”` : describeElement(element),
    source: location ? shortSource(location) : null,
    sourcePath: location ? fullSource(location) : null,
    selector: target?.selector ?? null,
  };
}

/** The last compound selector of `selector`: what follows its last child combinator outside quotes and brackets. */
export function lastSelectorStep(selector: string): string {
  let start = 0;
  let quote: string | null = null;
  let depth = 0;
  for (let index = 0; index < selector.length; index++) {
    const char = selector[index]!;
    if (char === "\\") index += 1;
    else if (quote) quote = char === quote ? null : quote;
    else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    else if (char === ">" && depth === 0) start = index + 1;
  }
  return selector.slice(start).trim();
}

/** A readable label for a stored target (a thread's), from its text excerpt and source location. */
export function labelTarget(target: FeedbackTarget | null): TargetLabel | null {
  if (!target) return null;
  const location = target.sourceLocation;
  return {
    name: quoted(target.textExcerpt) || lastSelectorStep(target.selector).slice(0, MAX_LABEL_NAME_LENGTH),
    source: location ? shortSource(location) : null,
    sourcePath: location ? fullSource(location) : null,
    selector: target.selector,
  };
}

/** `name · source` (or just the name) on one line. */
export function formatLabel(label: TargetLabel): string {
  return label.source ? `${label.name} · ${label.source}` : label.name;
}

/** The tooltip for a label: the source location and the selector, each on its own line. */
export function labelTooltip(label: TargetLabel): string {
  return [label.sourcePath ? `Source: ${label.sourcePath}` : "", label.selector ? `Selector: ${label.selector}` : ""]
    .filter(Boolean).join("\n");
}
