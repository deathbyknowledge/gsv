const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

export function sniffImageMimeType(bytes: Uint8Array): string | undefined {
  if (matches(bytes, JPEG)) return "image/jpeg";
  if (matches(bytes, PNG)) return "image/png";
  if (matches(bytes, GIF87) || matches(bytes, GIF89)) return "image/gif";
  if (matches(bytes, RIFF) && matches(bytes, WEBP, 8)) return "image/webp";
  return undefined;
}

export function isVectorImageMimeType(mimeType: string): boolean {
  return mimeType.split(";", 1)[0].trim().toLowerCase() === "image/svg+xml";
}

function matches(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return bytes.length >= offset + signature.length
    && signature.every((byte, index) => bytes[offset + index] === byte);
}
