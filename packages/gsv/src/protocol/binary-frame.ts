export const BINARY_FRAME_HEADER_BYTES = 5;

export const BINARY_FRAME_DATA = 1 << 0;
export const BINARY_FRAME_END = 1 << 1;
export const BINARY_FRAME_ERROR = 1 << 2;
/** The receiver no longer wants the peer's outgoing stream. */
export const BINARY_FRAME_CANCEL = 1 << 3;
/**
 * Flow-control credit from a receiver to a sender. The payload is a little-endian
 * u32 counting the additional body bytes the sender may put on the wire.
 */
export const BINARY_FRAME_WINDOW = 1 << 4;

/**
 * Credit every sender starts with before its receiver has granted anything.
 * Shared by every implementation so the first chunks can race the descriptor.
 */
export const BINARY_INITIAL_WINDOW_BYTES = 4 * 1024 * 1024;
export const BINARY_WINDOW_PAYLOAD_BYTES = 4;

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
    payload: bytes.subarray(BINARY_FRAME_HEADER_BYTES),
  };
}

export function buildWindowFrame(streamId: number, creditBytes: number): ArrayBuffer {
  if (!Number.isSafeInteger(creditBytes) || creditBytes <= 0 || creditBytes > 0xffffffff) {
    throw new Error(`Invalid binary window credit: ${creditBytes}`);
  }
  const payload = new Uint8Array(BINARY_WINDOW_PAYLOAD_BYTES);
  new DataView(payload.buffer).setUint32(0, creditBytes, true);
  return buildBinaryFrame(streamId, BINARY_FRAME_WINDOW, payload);
}

/** Returns the credit carried by a WINDOW payload, or null when it is malformed. */
export function parseWindowCredit(payload: Uint8Array): number | null {
  if (payload.byteLength !== BINARY_WINDOW_PAYLOAD_BYTES) {
    return null;
  }
  const credit = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
  return credit > 0 ? credit : null;
}

export function assertStreamId(streamId: number): void {
  if (!Number.isSafeInteger(streamId) || streamId <= 0 || streamId > 0xffffffff) {
    throw new Error(`Invalid binary stream id: ${streamId}`);
  }
}
