const BYTE_STRING_CHUNK_SIZE = 0x8000;

function toByteView(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function byteViewToBinaryString(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += BYTE_STRING_CHUNK_SIZE) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + BYTE_STRING_CHUNK_SIZE)));
  }
  return chunks.join("");
}

export function encodeBase64Bytes(value: ArrayBuffer | ArrayBufferView): string {
  return btoa(byteViewToBinaryString(toByteView(value)));
}

export function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function normalizeBase64Data(value: string): string {
  return value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
}

export function base64DecodedLength(value: string): number {
  const clean = value.replace(/\s/g, "");
  if (!clean) {
    return 0;
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

export function base64DataFromBytes(
  value: ArrayBuffer | ArrayBufferView,
  mimeType: string,
): { data: string; mimeType: string; size: number } | null {
  if (value.byteLength === 0) {
    return null;
  }
  return {
    data: `data:${mimeType};base64,${encodeBase64Bytes(value)}`,
    mimeType,
    size: value.byteLength,
  };
}

export function base64DataFromString(
  value: string,
  mimeType: string,
): { data: string; mimeType: string; size: number } | null {
  const dataUrl = /^data:([^;,]+);base64,(.*)$/i.exec(value);
  const base64 = dataUrl ? dataUrl[2] : normalizeBase64Data(value);
  const resolvedMimeType = dataUrl?.[1] || mimeType;
  const size = base64DecodedLength(base64);
  return size > 0
    ? { data: `data:${resolvedMimeType};base64,${base64}`, mimeType: resolvedMimeType, size }
    : null;
}
