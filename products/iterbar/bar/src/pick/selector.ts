import { SLOT_ATTRIBUTE, SOURCE_ATTRIBUTE } from "iterbar";

/** Longest selector the feedback contract accepts. */
export const MAX_SELECTOR_LENGTH = 2048;

/** Most classes written into one path segment; they describe the element, while `:nth-of-type` keeps it unique. */
const MAX_SEGMENT_CLASSES = 2;

/** Class names that read as names rather than generated state such as Tailwind's `hover:bg-x` or `w-1/2`. */
const READABLE_CLASS = /^-?[A-Za-z_][\w-]*$/;

/** Attributes that anchor a path: the nearest uniquely stamped element or slot root, in that order. */
const ANCHOR_ATTRIBUTES = [SOURCE_ATTRIBUTE, SLOT_ATTRIBUTE] as const;

/**
 * `value` as a double-quoted CSS string. Only `"`, `\` and characters a string cannot hold are escaped, so a stamp
 * such as `src/App.tsx:12:5` stays readable.
 */
export function cssString(value: string): string {
  // eslint-disable-next-line no-control-regex
  const escaped = value.replace(/["\\]/gu, "\\$&").replace(/[\u0000-\u001f\u007f]/gu, (character) => {
    const code = character.codePointAt(0)!;
    return code === 0 ? "\uFFFD" : `\\${code.toString(16)} `;
  });
  return `"${escaped}"`;
}

function attributeSelector(name: string, value: string): string {
  return `[${name}=${cssString(value)}]`;
}

/** Whether `selector` names exactly `element` in its document. */
export function resolvesTo(selector: string, element: Element): boolean {
  try {
    const found = element.ownerDocument.querySelectorAll(selector);
    return found.length === 1 && found[0] === element;
  } catch {
    return false;
  }
}

function usable(selector: string, element: Element): boolean {
  return selector.length <= MAX_SELECTOR_LENGTH && resolvesTo(selector, element);
}

/** `[data-testid="…"]`, then `#id`, when either names only this element. */
function ownSelector(element: Element): string | null {
  const testId = element.getAttribute("data-testid");
  if (testId) {
    const selector = attributeSelector("data-testid", testId);
    if (usable(selector, element)) return selector;
  }
  if (element.id) {
    const selector = `#${CSS.escape(element.id)}`;
    if (usable(selector, element)) return selector;
  }
  return null;
}

/** The stamp or slot selector of `element`, when it names only that element. */
function anchorSelector(element: Element): string | null {
  for (const name of ANCHOR_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value === null) continue;
    const selector = attributeSelector(name, value);
    if (resolvesTo(selector, element)) return selector;
  }
  return null;
}

/** `tag.class:nth-of-type(n)`; the position is written only when a sibling has the same tag. */
function segment(element: Element, withClasses: boolean): string {
  let text = CSS.escape(element.localName);
  if (withClasses) {
    const classes = [...element.classList].filter((name) => READABLE_CLASS.test(name)).slice(0, MAX_SEGMENT_CLASSES);
    for (const name of classes) text += `.${CSS.escape(name)}`;
  }
  const parent = element.parentElement;
  if (parent) {
    const sameType = [...parent.children].filter((child) => child.localName === element.localName);
    if (sameType.length > 1) text += `:nth-of-type(${sameType.indexOf(element) + 1})`;
  }
  return text;
}

/**
 * A child-combinator path from the nearest element, the picked one included, whose stamp or slot attribute names it
 * alone; without one the path starts at `:root`.
 */
function pathSelector(element: Element, withClasses: boolean): string | null {
  const root = element.ownerDocument.documentElement;
  const segments: string[] = [];
  let anchor = ":root";
  for (let current: Element = element; current !== root;) {
    const own = anchorSelector(current);
    if (own) {
      anchor = own;
      break;
    }
    segments.unshift(segment(current, withClasses));
    const parent = current.parentElement;
    if (!parent) return null;
    current = parent;
  }
  const selector = [anchor, ...segments].join(" > ");
  return usable(selector, element) ? selector : null;
}

/**
 * A CSS selector that names `element` alone, from a closed set tried in order: its `data-testid`, its `id`, then a
 * tag/class/`:nth-of-type` path from the nearest uniquely stamped (`data-iterbar-src`) or slot (`data-iterbar-slot`)
 * element, or from `:root`. Classes are dropped when they would push the path over {@link MAX_SELECTOR_LENGTH}.
 * Returns `null` for an element outside its document's tree (inside a shadow root, or detached) or when no form fits.
 */
export function stableSelector(element: Element): string | null {
  const root = element.ownerDocument.documentElement;
  if (element !== root && !root.contains(element)) return null;
  return ownSelector(element) ?? pathSelector(element, true) ?? pathSelector(element, false);
}
