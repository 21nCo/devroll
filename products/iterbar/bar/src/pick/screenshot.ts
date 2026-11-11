import { MAX_ATTACHMENT_BYTES } from "iterbar";
import { domToBlob } from "modern-screenshot";

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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (error instanceof Event) return `${error.type} event`;
  return String(error);
}

/**
 * Captures `element` as a PNG in the page with modern-screenshot, leaving out `exclude` (the bar), within
 * {@link MAX_SCREENSHOT_PIXELS} and the daemon's attachment size limit. Never rejects: a failure resolves with the
 * reason, so the comment can still be sent without a screenshot.
 */
export async function captureScreenshot(element: Element, exclude: Node): Promise<ScreenshotResult> {
  const rect = element.getBoundingClientRect();
  const scale = screenshotScale(rect.width, rect.height, element.ownerDocument.defaultView?.devicePixelRatio ?? 1);
  if (scale === null) return { ok: false, reason: unavailableReason("the element has no visible area") };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`it took longer than ${SCREENSHOT_TIMEOUT_MS / 1000} seconds`)), SCREENSHOT_TIMEOUT_MS);
  });
  try {
    const png = await Promise.race([
      domToBlob(element, {
        scale,
        type: "image/png",
        timeout: SCREENSHOT_TIMEOUT_MS,
        filter: (node) => node !== exclude,
      }),
      timeout,
    ]);
    if (png.type !== "image/png") return { ok: false, reason: unavailableReason(`the browser produced ${png.type || "no image type"}`) };
    if (png.size === 0) return { ok: false, reason: unavailableReason("the image is empty") };
    if (png.size > MAX_ATTACHMENT_BYTES) {
      return { ok: false, reason: unavailableReason(`the image is ${png.size} bytes; the daemon accepts at most ${MAX_ATTACHMENT_BYTES}`) };
    }
    return { ok: true, png, scale };
  } catch (error) {
    return { ok: false, reason: unavailableReason(errorMessage(error)) };
  } finally {
    clearTimeout(timer);
  }
}
