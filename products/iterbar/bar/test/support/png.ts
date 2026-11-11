/** The width and height in a PNG's IHDR chunk, after checking the signature. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength < 24 || signature.some((byte, index) => bytes[index] !== byte)) throw new Error("not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") throw new Error("PNG without IHDR first");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
