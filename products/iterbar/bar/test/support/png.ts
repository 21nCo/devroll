import type { Page } from "@playwright/test";

/** The width and height in a PNG's IHDR chunk, after checking the signature. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength < 24 || signature.some((byte, index) => bytes[index] !== byte)) throw new Error("not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") throw new Error("PNG without IHDR first");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The RGBA of `png` at each CSS-pixel `[x, y]` point, and the share of its pixels that are opaque, decoded in the page. */
export function pngPixels(page: Page, png: Buffer, points: readonly (readonly [number, number])[]): Promise<{ at: number[][]; opaque: number }> {
  return page.evaluate(async ({ base64, points }) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let opaque = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index] === 255) opaque += 1;
    const at = points.map(([x, y]) => [...data.subarray((y * bitmap.width + x) * 4, (y * bitmap.width + x) * 4 + 4)]);
    return { at, opaque: opaque / (bitmap.width * bitmap.height) };
  }, { base64: png.toString("base64"), points });
}

/** How many pixels of `png` are opaque and dark (text drawn in black), decoded in the page. */
export function darkPixels(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let dark = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index + 3] === 255 && data[index]! + data[index + 1]! + data[index + 2]! < 300) dark += 1;
    return dark;
  }, png.toString("base64"));
}
