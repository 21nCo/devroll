const SVG = "http://www.w3.org/2000/svg";

/** 16 x 16 stroke paths, drawn in `currentColor`. */
const PATHS = {
  comment: "M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z",
  inbox: "M2 9.5l1.6-5.2a1 1 0 0 1 1-.8h6.8a1 1 0 0 1 1 .8L14 9.5V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zM2 9.5h3.5l1 1.5h3l1-1.5H14",
  tray: "M3 3h10M3 6h10M3 9h6M3 12h4M11.5 9.5v4M9.5 11.5h4",
  layers: "M8 2.5l6 3-6 3-6-3zM2 8.5l6 3 6-3M2 11l6 3 6-3",
  dock: "M2.5 3.5h11v9h-11zM2.5 10h11",
  expand: "M4 10l4-4 4 4",
  collapse: "M4 6l4 4 4-4",
  close: "M4 4l8 8M12 4l-8 8",
} as const;

export type IconName = keyof typeof PATHS;

/** An inline SVG icon; the toolbar never loads a remote resource. Hidden from assistive technology. */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "glyph");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", PATHS[name]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}
