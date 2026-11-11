import type { IterbarPageApi } from "iterbar";

declare global {
  interface Window {
    __ITERBAR__?: IterbarPageApi;
    /** Page events a test records, as `type:tag`. */
    pageEvents: string[];
    /** PNGs the page's canvases have produced, when a test counts them. */
    canvasBlobs: number;
  }
}
