export const BINARY_FRAME_HEADER_BYTES = 5;

export const BINARY_FRAME_DATA = 1 << 0;
export const BINARY_FRAME_END = 1 << 1;
export const BINARY_FRAME_ERROR = 1 << 2;

export type BinaryFrame = {
  streamId: number;
  flags: number;
  payload: Uint8Array;
};

export type BinaryFrameDescriptor = {
  streamId: number;
  length?: number;
};

export function buildBinaryFrame(
  streamId: number,
  flags: number,
  payload: Uint8Array = new Uint8Array(),
): ArrayBuffer {
  assertStreamId(streamId);
  const frame = new Uint8Array(BINARY_FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, streamId, true);
  view.setUint8(4, flags & 0xff);
  frame.set(payload, BINARY_FRAME_HEADER_BYTES);
  return frame.buffer;
}

export function parseBinaryFrame(data: ArrayBuffer | ArrayBufferView): BinaryFrame | null {
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength < BINARY_FRAME_HEADER_BYTES) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const streamId = view.getUint32(0, true);
  if (!Number.isSafeInteger(streamId) || streamId <= 0) {
    return null;
  }

  return {
    streamId,
    flags: view.getUint8(4),
    payload: bytes.slice(BINARY_FRAME_HEADER_BYTES),
  };
}

export function assertStreamId(streamId: number): void {
  if (!Number.isSafeInteger(streamId) || streamId <= 0 || streamId > 0xffffffff) {
    throw new Error(`Invalid binary stream id: ${streamId}`);
  }
}
