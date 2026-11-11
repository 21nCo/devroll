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
 * The picked element is rendered on its own at the image origin, so what places it on the page (its transform, its
 * margins and offsets, inline ones included) is dropped from the copy; transforms inside it are kept. The live
 * element is never changed.
 */
const ROOT_STYLE = {
  transform: "none", translate: "none", rotate: "none", scale: "none", margin: "0", inset: "auto",
} as Partial<CSSStyleDeclaration>;

function isTransformed(element: Element): boolean {
  const style = getComputedStyle(element);
  return [style.transform, style.translate, style.rotate, style.scale].some((value) => value && value !== "none");
}

/**
 * The untransformed size the copy is drawn at, when the element or an ancestor is transformed (its on-screen box then
 * differs from its own layout box); else `null`, keeping the measured box.
 */
function untransformedSize(element: Element): { width: number; height: number } | null {
  let transformed = false;
  for (let node: Element | null = element; node && !transformed; node = node.parentElement) transformed = isTransformed(node);
  if (!transformed) return null;
  if (element instanceof HTMLElement) return { width: element.offsetWidth, height: element.offsetHeight };
  if (element instanceof SVGSVGElement) {
    const style = getComputedStyle(element);
    return { width: Number.parseFloat(style.width) || 0, height: Number.parseFloat(style.height) || 0 };
  }
  return null;
}

/** Ends a render that was withdrawn (Cancel, Escape) or timed out, at the next step it reaches. */
function checkWithdrawn(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("the capture was withdrawn");
}

/**
 * Renders `element` to a PNG at the device scale lowered to the pixel cap. modern-screenshot measures the element
 * again once its images and fonts have loaded and sizes the image from that measurement, so the scale is chosen
 * from it rather than from the size at the pick: an element that grew meanwhile still stays within the cap. Scroll
 * offsets inside the element are kept, so the image shows what the page shows. Once `signal` aborts, the render
 * stops at its next step and its context is destroyed.
 */
async function render(element: Element, exclude: Node, deviceScale: number, signal: AbortSignal): Promise<{ png: Blob; scale: number }> {
  checkWithdrawn(signal);
  const check = (): void => checkWithdrawn(signal);
  const context = await createContext(element, {
    type: "image/png",
    timeout: SCREENSHOT_TIMEOUT_MS,
    filter: (node) => node !== exclude,
    style: ROOT_STYLE,
    features: { restoreScrollPosition: true },
    onCloneNode: check,
    onEmbedNode: check,
    onCreateForeignObjectSvg: check,
    autoDestruct: true,
  });
  try {
    check();
    const size = untransformedSize(element);
    if (size) {
      context.width = size.width;
      context.height = size.height;
    }
    const scale = screenshotScale(context.width, context.height, deviceScale);
    if (scale === null) throw new Error("the element has no visible area");
    context.scale = scale;
    context.dpi = scale === 1 ? null : 96 * scale;
    return { png: await domToBlob(context), scale };
  } catch (error) {
    destroyContext(context);
    throw error;
  }
}

/**
 * Captures `element` as a PNG in the page with modern-screenshot, leaving out `exclude` (the bar), within
 * {@link MAX_SCREENSHOT_PIXELS} and the daemon's attachment size limit. Never rejects: a failure resolves with the
 * reason, so the comment can still be sent without a screenshot. Aborting `signal` (or the time limit) withdraws the
 * capture: its render stops at its next step and its context is destroyed, without holding up any other capture.
 */
export async function captureScreenshot(element: Element, exclude: Node, signal?: AbortSignal): Promise<ScreenshotResult> {
  if (!element.isConnected) return { ok: false, reason: unavailableReason("the element is no longer on the page") };
  const rect = element.getBoundingClientRect();
  if (screenshotScale(rect.width, rect.height, 1) === null) return { ok: false, reason: unavailableReason("the element has no visible area") };
  const deviceScale = element.ownerDocument.defaultView?.devicePixelRatio ?? 1;
  const withdraw = new AbortController();
  const onAbort = (): void => withdraw.abort();
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      withdraw.abort();
      reject(new Error(`it took longer than ${SCREENSHOT_TIMEOUT_MS / 1000} seconds`));
    }, SCREENSHOT_TIMEOUT_MS);
  });
  try {
    const { png, scale } = await Promise.race([render(element, exclude, deviceScale, withdraw.signal), timeout]);
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
    signal?.removeEventListener("abort", onAbort);
  }
}
