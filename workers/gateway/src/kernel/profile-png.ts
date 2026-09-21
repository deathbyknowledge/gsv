export const MAX_PROFILE_IMAGE_BYTES = 256 * 1024;
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "sRGB", "gAMA", "cHRM", "pHYs"]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** A bounded static PNG envelope, following https://www.w3.org/TR/png-3/#5Chunk-layout. */
export function profilePngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length > MAX_PROFILE_IMAGE_BYTES || bytes.length < 57 || SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new Error("Choose a static PNG image no larger than 256 KiB");
  }
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let pixels = false;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = data.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("Image contains an incomplete PNG chunk");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!CHUNKS.has(type)) throw new Error("Export a static PNG without embedded metadata before uploading");
    let crc = 0xffffffff;
    for (let index = offset + 4; index < end - 4; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== data.getUint32(end - 4)) throw new Error("Image failed its PNG integrity check");
    if (offset === 8 && type !== "IHDR") throw new Error("Image has no PNG header");
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) throw new Error("Image has an invalid PNG header");
      width = data.getUint32(offset + 8); height = data.getUint32(offset + 12);
      if (!width || !height || width > 512 || height > 512) throw new Error("Profile images must be at most 512 by 512 pixels");
      if (bytes[offset + 16] !== 8 || ![2, 6].includes(bytes[offset + 17]) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) {
        throw new Error("Export a non-interlaced, 8-bit RGB or RGBA PNG");
      }
    }
    if (type === "IDAT" && length > 0) pixels = true;
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length || !pixels) throw new Error("Image has an invalid PNG ending");
      ended = true;
    }
    offset = end;
  }
  if (!ended || offset !== bytes.length) throw new Error("Image is incomplete");
  return { width, height };
}
