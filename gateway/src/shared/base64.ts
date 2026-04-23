const BYTE_STRING_CHUNK_SIZE = 0x8000;

function toByteView(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function byteViewToBinaryString(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BYTE_STRING_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + BYTE_STRING_CHUNK_SIZE);
    for (const byte of chunk) {
      binary += String.fromCharCode(byte);
    }
  }
  return binary;
}

export function encodeBase64Bytes(value: ArrayBuffer | ArrayBufferView): string {
  return btoa(byteViewToBinaryString(toByteView(value)));
}
