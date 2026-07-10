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
