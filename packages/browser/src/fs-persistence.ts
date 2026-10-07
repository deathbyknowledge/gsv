const textEncoder = new TextEncoder();

export type StoredFsEntry =
  | { path: string; kind: "directory"; updatedAt: number }
  | { path: string; kind: "file"; content: ArrayBuffer; contentType?: string; updatedAt: number };

export type FilePersistence = {
  list(): Promise<StoredFsEntry[]>;
  get(path: string): Promise<StoredFsEntry | null>;
  put(entry: StoredFsEntry): Promise<void>;
  delete(paths: string[]): Promise<void>;
};

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function bytesFromStoredContent(content: ArrayBuffer | ArrayBufferView | string | null | undefined): Uint8Array {
  if (content instanceof Uint8Array) {
    return copyBytes(content);
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content.slice(0));
  }
  if (ArrayBuffer.isView(content)) {
    const view = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    return copyBytes(view);
  }
  return textEncoder.encode(String(content ?? ""));
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}
