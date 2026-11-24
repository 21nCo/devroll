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

/**
 * The Iterbar mark: a lowercase "i" standing on a bar, in the accent fill's text colour, on the accent disc the
 * stylesheet draws behind it. Hidden from assistive technology; the logo button carries the name.
 */
export function logoMark(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "logo-mark");
  const dot = document.createElementNS(SVG, "circle");
  dot.setAttribute("cx", "12");
  dot.setAttribute("cy", "5.75");
  dot.setAttribute("r", "1.9");
  dot.setAttribute("fill", "currentColor");
  svg.append(dot);
  for (const [x, y, width, height] of [[10.6, 9.25, 2.8, 8.5], [5.5, 16.25, 13, 2.8]] as const) {
    const bar = document.createElementNS(SVG, "rect");
    bar.setAttribute("x", String(x));
    bar.setAttribute("y", String(y));
    bar.setAttribute("width", String(width));
    bar.setAttribute("height", String(height));
    bar.setAttribute("rx", "1.4");
    bar.setAttribute("fill", "currentColor");
    svg.append(bar);
  }
  return svg;
}
