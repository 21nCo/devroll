type Child = Node | string | null | undefined | false;

/** Whether `element` is rendered: `checkVisibility()` where the browser has it, its boxes otherwise (Safari < 17.4). */
export function isRendered(element: Element): boolean {
  return typeof element.checkVisibility === "function" ? element.checkVisibility() : element.getClientRects().length > 0;
}

/** Creates an element with attributes (`true` sets an empty attribute, `false`/`null` skips it) and children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string | boolean | null | undefined>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === true) element.setAttribute(name, "");
    else if (typeof value === "string") element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}
