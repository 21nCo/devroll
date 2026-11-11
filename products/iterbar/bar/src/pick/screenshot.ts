import { MAX_ATTACHMENT_BYTES } from "iterbar";
import { createContext, destroyContext, domToBlob } from "modern-screenshot";

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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The width and height in a PNG's IHDR chunk, or `null` when `bytes` do not start like a PNG. */
export function pngDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  if (bytes.byteLength < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (error instanceof Event) return `${error.type} event`;
  return String(error);
}

/**
 * Renders `element` to a PNG at the device scale lowered to the pixel cap. modern-screenshot measures the element
 * again once its images and fonts have loaded and sizes the image from that measurement, so the scale is chosen
 * from it rather than from the size at the pick: an element that grew meanwhile still stays within the cap.
 */
async function render(element: Element, exclude: Node, deviceScale: number): Promise<{ png: Blob; scale: number }> {
  const context = await createContext(element, {
    type: "image/png",
    timeout: SCREENSHOT_TIMEOUT_MS,
    filter: (node) => node !== exclude,
    autoDestruct: true,
  });
  const scale = screenshotScale(context.width, context.height, deviceScale);
  if (scale === null) {
    destroyContext(context);
    throw new Error("the element has no visible area");
  }
  context.scale = scale;
  context.dpi = scale === 1 ? null : 96 * scale;
  return { png: await domToBlob(context), scale };
}

/**
 * Captures `element` as a PNG in the page with modern-screenshot, leaving out `exclude` (the bar), within
 * {@link MAX_SCREENSHOT_PIXELS} and the daemon's attachment size limit. Never rejects: a failure resolves with the
 * reason, so the comment can still be sent without a screenshot.
 */
export async function captureScreenshot(element: Element, exclude: Node): Promise<ScreenshotResult> {
  const rect = element.getBoundingClientRect();
  if (screenshotScale(rect.width, rect.height, 1) === null) return { ok: false, reason: unavailableReason("the element has no visible area") };
  const deviceScale = element.ownerDocument.defaultView?.devicePixelRatio ?? 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`it took longer than ${SCREENSHOT_TIMEOUT_MS / 1000} seconds`)), SCREENSHOT_TIMEOUT_MS);
  });
  try {
    const { png, scale } = await Promise.race([render(element, exclude, deviceScale), timeout]);
    if (png.type !== "image/png") return { ok: false, reason: unavailableReason(`the browser produced ${png.type || "no image type"}`) };
    if (png.size === 0) return { ok: false, reason: unavailableReason("the image is empty") };
    if (png.size > MAX_ATTACHMENT_BYTES) {
      return { ok: false, reason: unavailableReason(`the image is ${png.size} bytes; the daemon accepts at most ${MAX_ATTACHMENT_BYTES}`) };
    }
    // The cap holds for the image actually produced, whatever the renderer did.
    const size = pngDimensions(new Uint8Array(await png.slice(0, 24).arrayBuffer()));
    if (size === null) return { ok: false, reason: unavailableReason("the browser produced an unreadable PNG") };
    if (size.width * size.height > MAX_SCREENSHOT_PIXELS) {
      return {
        ok: false,
        reason: unavailableReason(`the image is ${size.width} x ${size.height} pixels, over the ${MAX_SCREENSHOT_PIXELS / 1_000_000} MP cap`),
      };
    }
    return { ok: true, png, scale };
  } catch (error) {
    return { ok: false, reason: unavailableReason(errorMessage(error)) };
  } finally {
    clearTimeout(timer);
  }
}
