import { env } from "cloudflare:workers";
import type { EventFrame } from "../protocol/frames";
import type {
  TransferEndpoint,
  TransferRequestParams,
  TransferToolResult,
  TransferSendPayload,
  TransferReceivePayload,
  TransferEndPayload,
} from "../protocol/transfer";
import {
  buildTransferBinaryFrame,
  parseTransferBinaryFrame,
} from "../protocol/transfer";
import type { Gateway } from "./do";

export type TransferState = {
  transferId: number;
  callId: string;
  sessionKey: string;
  source: TransferEndpoint;
  destination: TransferEndpoint;
  state: "init" | "meta-wait" | "accept-wait" | "streaming" | "completing";
  size?: number;
  mime?: string;
  bytesTransferred: number;
};

export type TransferR2 = {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  uploadPromise: Promise<R2Object>;
};

function nextTransferId(gw: Gateway): number {
  const keys = Object.keys(gw.transfers);
  if (keys.length === 0) return 1;
  return Math.max(...keys.map(Number)) + 1;
}

export function getTransferWs(
  gw: Gateway,
  nodeId: string,
): WebSocket | undefined {
  if (nodeId === "gsv") return undefined;
  const ws = gw.nodes.get(nodeId);
  return ws && ws.readyState === WebSocket.OPEN ? ws : undefined;
}

export async function transferRequest(
  gw: Gateway,
  params: TransferRequestParams,
): Promise<{ ok: boolean; error?: string }> {
  const transferId = nextTransferId(gw);
  const sourceIsGsv = params.source.node === "gsv";
  const destIsGsv = params.destination.node === "gsv";

  if (!sourceIsGsv && !getTransferWs(gw, params.source.node)) {
    return { ok: false, error: `Source node not connected: ${params.source.node}` };
  }

  if (!destIsGsv && !getTransferWs(gw, params.destination.node)) {
    return {
      ok: false,
      error: `Destination node not connected: ${params.destination.node}`,
    };
  }

  const transfer: TransferState = {
    transferId,
    callId: params.callId,
    sessionKey: params.sessionKey,
    source: params.source,
    destination: params.destination,
    state: "init",
    bytesTransferred: 0,
  };

  gw.transfers[String(transferId)] = transfer;

  if (sourceIsGsv) {
    const r2Object = await (env as Env).STORAGE.head(params.source.path);
    if (!r2Object) {
      delete gw.transfers[String(transferId)];
      return { ok: false, error: `R2 object not found: ${params.source.path}` };
    }
    transfer.size = r2Object.size;
    transfer.mime = r2Object.httpMetadata?.contentType;

    if (destIsGsv) {
      delete gw.transfers[String(transferId)];
      return { ok: false, error: "Cannot transfer from gsv to gsv" };
    }

    const receiveEvt: EventFrame<TransferReceivePayload> = {
      type: "evt",
      event: "transfer.receive",
      payload: {
        transferId,
        path: params.destination.path,
        size: transfer.size,
        mime: transfer.mime,
      },
    };
    getTransferWs(gw, params.destination.node)!.send(JSON.stringify(receiveEvt));
    transfer.state = "accept-wait";
    gw.transfers[String(transferId)] = transfer;
  } else {
    const sendEvt: EventFrame<TransferSendPayload> = {
      type: "evt",
      event: "transfer.send",
      payload: {
        transferId,
        path: params.source.path,
      },
    };
    getTransferWs(gw, params.source.node)!.send(JSON.stringify(sendEvt));
    transfer.state = "meta-wait";
    gw.transfers[String(transferId)] = transfer;
  }

  return { ok: true };
}

export function handleTransferBinaryFrame(gw: Gateway, data: ArrayBuffer): void {
  const { transferId, chunk } = parseTransferBinaryFrame(data);
  const transfer = gw.transfers[String(transferId)];
  if (!transfer) return;

  transfer.bytesTransferred += chunk.byteLength;
  gw.transfers[String(transferId)] = transfer;

  const destIsGsv = transfer.destination.node === "gsv";

  if (destIsGsv) {
    const r2 = gw.transferR2.get(transferId);
    if (r2) {
      r2.writer.write(new Uint8Array(chunk)).catch((error) => {
        failTransfer(gw, transfer, `R2 write error: ${error}`);
      });
    }
  } else {
    const destWs = getTransferWs(gw, transfer.destination.node);
    if (destWs) {
      destWs.send(buildTransferBinaryFrame(transferId, chunk));
    }
  }
}

export async function streamR2ToDest(
  gw: Gateway,
  transfer: TransferState,
): Promise<void> {
  try {
    const r2Object = await (env as Env).STORAGE.get(transfer.source.path);
    if (!r2Object) {
      failTransfer(gw, transfer, `R2 object not found: ${transfer.source.path}`);
      return;
    }

    const destWs = getTransferWs(gw, transfer.destination.node);
    if (!destWs) {
      failTransfer(
        gw,
        transfer,
        `Destination node disconnected: ${transfer.destination.node}`,
      );
      return;
    }

    const reader = r2Object.body.getReader();
    let done = false;

    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (result.value) {
        transfer.bytesTransferred += result.value.byteLength;
        destWs.send(buildTransferBinaryFrame(transfer.transferId, result.value));
      }
    }

    gw.transfers[String(transfer.transferId)] = transfer;

    const endEvt: EventFrame<TransferEndPayload> = {
      type: "evt",
      event: "transfer.end",
      payload: { transferId: transfer.transferId },
    };
    destWs.send(JSON.stringify(endEvt));
    transfer.state = "completing";
    gw.transfers[String(transfer.transferId)] = transfer;
  } catch (error) {
    failTransfer(
      gw,
      transfer,
      `R2 stream error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function finalizeR2Upload(
  gw: Gateway,
  transfer: TransferState,
): Promise<void> {
  try {
    const r2 = gw.transferR2.get(transfer.transferId);
    if (!r2) {
      completeTransfer(gw, transfer, transfer.bytesTransferred);
      return;
    }

    await r2.writer.close();
    await r2.uploadPromise;
    completeTransfer(gw, transfer, transfer.bytesTransferred);
  } catch (error) {
    failTransfer(
      gw,
      transfer,
      `R2 upload finalize error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function completeTransfer(
  gw: Gateway,
  transfer: TransferState,
  bytesTransferred: number,
): void {
  const toolResult: TransferToolResult = {
    source: `${transfer.source.node}:${transfer.source.path}`,
    destination: `${transfer.destination.node}:${transfer.destination.path}`,
    bytesTransferred,
    mime: transfer.mime,
  };

  const sessionStub = (env as Env).SESSION.getByName(transfer.sessionKey);
  sessionStub.toolResult({
    callId: transfer.callId,
    result: toolResult,
  });

  gw.transferR2.delete(transfer.transferId);
  delete gw.transfers[String(transfer.transferId)];
}

export function failTransfer(
  gw: Gateway,
  transfer: TransferState,
  error: string,
): void {
  const sessionStub = (env as Env).SESSION.getByName(transfer.sessionKey);
  sessionStub.toolResult({
    callId: transfer.callId,
    error,
  });

  const r2 = gw.transferR2.get(transfer.transferId);
  if (r2) {
    try {
      r2.writer.close().catch(() => {});
    } catch {}
  }

  gw.transferR2.delete(transfer.transferId);
  delete gw.transfers[String(transfer.transferId)];
}

export function failTransfersForNode(gw: Gateway, nodeId: string): void {
  for (const key of Object.keys(gw.transfers)) {
    const transfer = gw.transfers[key];
    if (transfer.source.node === nodeId || transfer.destination.node === nodeId) {
      failTransfer(gw, transfer, `Node disconnected: ${nodeId}`);
    }
  }
}
