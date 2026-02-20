export type TransferEndpoint = {
  node: string;
  path: string;
};

export type TransferSendPayload = {
  transferId: number;
  path: string;
};

export type TransferMetaParams = {
  transferId: number;
  size: number;
  mime?: string;
  error?: string;
};

export type TransferReceivePayload = {
  transferId: number;
  path: string;
  size: number;
  mime?: string;
};

export type TransferAcceptParams = {
  transferId: number;
  error?: string;
};

export type TransferStartPayload = {
  transferId: number;
};

export type TransferCompleteParams = {
  transferId: number;
};

export type TransferEndPayload = {
  transferId: number;
};

export type TransferDoneParams = {
  transferId: number;
  bytesWritten: number;
  error?: string;
};

export type TransferRequestParams = {
  callId: string;
  sessionKey: string;
  source: TransferEndpoint;
  destination: TransferEndpoint;
};

export type TransferToolResult = {
  source: string;
  destination: string;
  bytesTransferred: number;
  mime?: string;
};

export const TRANSFER_BINARY_TAG_BYTES = 4;

export function parseTransferBinaryFrame(data: ArrayBuffer): {
  transferId: number;
  chunk: Uint8Array;
} {
  const view = new DataView(data);
  const transferId = view.getUint32(0, true);
  const chunk = new Uint8Array(data, TRANSFER_BINARY_TAG_BYTES);
  return { transferId, chunk };
}

export function buildTransferBinaryFrame(
  transferId: number,
  chunk: Uint8Array,
): ArrayBuffer {
  const frame = new ArrayBuffer(TRANSFER_BINARY_TAG_BYTES + chunk.byteLength);
  new DataView(frame).setUint32(0, transferId, true);
  new Uint8Array(frame, TRANSFER_BINARY_TAG_BYTES).set(chunk);
  return frame;
}
