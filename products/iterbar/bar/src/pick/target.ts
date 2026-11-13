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
} from "iterbar";
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

/** The version each slot on the page shows, from the page API; empty without a registry or with an unreadable one. */
export function readActiveVariants(): ActiveVariant[] {
  try {
    const api = readPageApi();
    if (!api) return [];
    const variants = api.getSnapshot().slots.map((slot) => ({ slot: slot.slot, version: slot.activeVersion }));
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
