// Twenty One Native, the 21n typeface (@21n/fonts), bundled into the bar as data URLs by the build (tsup's dataurl
// loader for .woff2), so the bar never loads a font at run time.
import medium from "@21n/fonts/fonts/TwentyOneNativeMedium.woff2";
import regular from "@21n/fonts/fonts/TwentyOneNative.woff2";

/**
 * The family name the bar registers the fonts under. It is the bar's own, so registering it never changes how the page
 * renders, and a page that loads Twenty One Native itself keeps its own faces.
 */
export const BAR_FONT_FAMILY = "Iterbar Twenty One Native";

let registered = false;

/** Adds the bar's Twenty One Native faces to the document once; where the FontFace API is missing the fallbacks apply. */
export function registerBarFonts(): void {
  if (registered || typeof FontFace !== "function" || typeof document === "undefined" || !document.fonts) return;
  registered = true;
  for (const [source, weight] of [[regular, "400"], [medium, "500 700"]] as const) {
    try {
      const face = new FontFace(BAR_FONT_FAMILY, `url(${JSON.stringify(source)}) format("woff2")`, { weight, style: "normal", display: "swap" });
      document.fonts.add(face);
      void face.load().catch(() => undefined);
    } catch {
      // The fallback fonts in the stylesheet apply.
    }
  }
}
