/**
 * A saved computer workspace is sealed in 1 MiB AES-GCM chunks, so neither the
 * save nor the restore holds the whole archive. Each chunk's associated data
 * binds its object address, position and whether it is the last chunk, so
 * reordering, truncation or another object's chunks fail authentication.
 */
const FORMAT = new Uint8Array([71, 83, 86, 87]);
const PREFIX_BYTES = 8;
const HEADER_BYTES = FORMAT.length + PREFIX_BYTES;
const TAG_BYTES = 16;
export const WORKSPACE_CHUNK_BYTES = 1 << 20;
const SEALED_BYTES = WORKSPACE_CHUNK_BYTES + TAG_BYTES;

export function sealedWorkspaceBytes(size: number): number {
  return HEADER_BYTES + size + TAG_BYTES * Math.max(1, Math.ceil(size / WORKSPACE_CHUNK_BYTES));
}

export function openedWorkspaceBytes(sealed: number): number {
  const chunks = Math.max(1, Math.ceil((sealed - HEADER_BYTES) / SEALED_BYTES));
  const size = sealed - HEADER_BYTES - TAG_BYTES * chunks;
  if (size < 0) throw new Error("Saved workspace is truncated");
  return size;
}

export function workspaceKey(raw: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function parameters(prefix: Uint8Array, address: string, index: number, final: boolean): SubtleCryptoEncryptAlgorithm {
  const iv = new Uint8Array(12);
  iv.set(prefix);
  new DataView(iv.buffer).setUint32(PREFIX_BYTES, index);
  return { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${address}\0${index}\0${final ? "last" : "more"}`) };
}

export function sealWorkspace(key: CryptoKey, address: string): TransformStream<Uint8Array, Uint8Array> {
  const prefix = crypto.getRandomValues(new Uint8Array(PREFIX_BYTES));
  let buffer = new Uint8Array(WORKSPACE_CHUNK_BYTES), filled = 0, index = 0;
  const seal = async (chunk: Uint8Array, final: boolean) =>
    new Uint8Array(await crypto.subtle.encrypt(parameters(prefix, address, index++, final), key, chunk));
  return new TransformStream({
    start(controller) {
      const header = new Uint8Array(HEADER_BYTES);
      header.set(FORMAT); header.set(prefix, FORMAT.length);
      controller.enqueue(header);
    },
    async transform(chunk, controller) {
      for (let offset = 0; offset < chunk.byteLength;) {
        // A full chunk is sealed only when more bytes follow; the last chunk is always marked last.
        if (filled === WORKSPACE_CHUNK_BYTES) {
          controller.enqueue(await seal(buffer, false));
          buffer = new Uint8Array(WORKSPACE_CHUNK_BYTES); filled = 0;
        }
        const count = Math.min(WORKSPACE_CHUNK_BYTES - filled, chunk.byteLength - offset);
        buffer.set(chunk.subarray(offset, offset + count), filled);
        filled += count; offset += count;
      }
    },
    async flush(controller) { controller.enqueue(await seal(buffer.subarray(0, filled), true)); },
  });
}

export function openWorkspace(key: CryptoKey, address: string): TransformStream<Uint8Array, Uint8Array> {
  const header = new Uint8Array(HEADER_BYTES);
  let headerFilled = 0, buffer = new Uint8Array(SEALED_BYTES), filled = 0, index = 0;
  const open = async (chunk: Uint8Array, final: boolean) => {
    try {
      return new Uint8Array(await crypto.subtle.decrypt(parameters(header.subarray(FORMAT.length), address, index++, final), key, chunk));
    } catch (cause) { throw new Error("Saved workspace failed authentication", { cause }); }
  };
  return new TransformStream({
    async transform(chunk, controller) {
      let offset = 0;
      if (headerFilled < HEADER_BYTES) {
        const count = Math.min(HEADER_BYTES - headerFilled, chunk.byteLength);
        header.set(chunk.subarray(0, count), headerFilled);
        headerFilled += count; offset = count;
        if (headerFilled === HEADER_BYTES && !FORMAT.every((value, position) => header[position] === value)) throw new Error("Unsupported saved workspace format");
      }
      while (offset < chunk.byteLength) {
        if (filled === SEALED_BYTES) {
          controller.enqueue(await open(buffer, false));
          buffer = new Uint8Array(SEALED_BYTES); filled = 0;
        }
        const count = Math.min(SEALED_BYTES - filled, chunk.byteLength - offset);
        buffer.set(chunk.subarray(offset, offset + count), filled);
        filled += count; offset += count;
      }
    },
    async flush(controller) {
      if (headerFilled < HEADER_BYTES || filled < TAG_BYTES) throw new Error("Saved workspace is truncated");
      controller.enqueue(await open(buffer.subarray(0, filled), true));
    },
  });
}
