import { PHOSPHOR } from "./phosphor.js";

const SVG = "http://www.w3.org/2000/svg";

export type IconName = keyof typeof PHOSPHOR;

/**
 * An inline Phosphor icon (Light weight, as in the 21n apps; see scripts/phosphor-icons.mjs), drawn in
 * `currentColor`. The toolbar never loads a remote resource. Hidden from assistive technology.
 */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 256 256");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "glyph");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", PHOSPHOR[name]);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}
