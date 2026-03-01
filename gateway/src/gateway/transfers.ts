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
import { PersistedObject } from "../shared/persisted-object";

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
  const transferId = gw.transferStateService.nextTransferId();
  const sourceIsGsv = params.source.node === "gsv";
  const destIsGsv = params.destination.node === "gsv";

  if (!sourceIsGsv && !getTransferWs(gw, params.source.node)) {
    return {
      ok: false,
      error: `Source node not connected: ${params.source.node}`,
    };
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

  gw.transferStateService.setTransfer(transfer);

  if (sourceIsGsv) {
    const r2Object = await (env as Env).STORAGE.head(params.source.path);
    if (!r2Object) {
      gw.transferStateService.deleteTransfer(transferId);
      return { ok: false, error: `R2 object not found: ${params.source.path}` };
    }
    transfer.size = r2Object.size;
    transfer.mime = r2Object.httpMetadata?.contentType;

    if (destIsGsv) {
      gw.transferStateService.deleteTransfer(transferId);
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
    getTransferWs(gw, params.destination.node)!.send(
      JSON.stringify(receiveEvt),
    );
    transfer.state = "accept-wait";
    gw.transferStateService.setTransfer(transfer);
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
    gw.transferStateService.setTransfer(transfer);
  }

  return { ok: true };
}

export function handleTransferBinaryFrame(
  gw: Gateway,
  data: ArrayBuffer,
): void {
  const { transferId, chunk } = parseTransferBinaryFrame(data);
  const transfer = gw.transferStateService.getTransfer(transferId);
  if (!transfer) return;

  transfer.bytesTransferred += chunk.byteLength;
  gw.transferStateService.setTransfer(transfer);

  const destIsGsv = transfer.destination.node === "gsv";

  if (destIsGsv) {
    const r2 = gw.transferStateService.getTransferR2(transferId);
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
      failTransfer(
        gw,
        transfer,
        `R2 object not found: ${transfer.source.path}`,
      );
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
        destWs.send(
          buildTransferBinaryFrame(transfer.transferId, result.value),
        );
      }
    }

    gw.transferStateService.setTransfer(transfer);

    const endEvt: EventFrame<TransferEndPayload> = {
      type: "evt",
      event: "transfer.end",
      payload: { transferId: transfer.transferId },
    };
    destWs.send(JSON.stringify(endEvt));
    transfer.state = "completing";
    gw.transferStateService.setTransfer(transfer);
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
    const r2 = gw.transferStateService.getTransferR2(transfer.transferId);
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

  gw.transferStateService.deleteTransferR2(transfer.transferId);
  gw.transferStateService.deleteTransfer(transfer.transferId);
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

  const r2 = gw.transferStateService.getTransferR2(transfer.transferId);
  if (r2) {
    try {
      r2.writer.close().catch(() => {});
    } catch {}
  }

  gw.transferStateService.deleteTransferR2(transfer.transferId);
  gw.transferStateService.deleteTransfer(transfer.transferId);
}

export function failTransfersForNode(gw: Gateway, nodeId: string): void {
  gw.transferStateService.forEachTransferInvolvingNode(nodeId, (transfer) => {
    failTransfer(gw, transfer, `Node disconnected: ${nodeId}`);
  });
}

type TransferId = number;

type TransferStoreData = ReturnType<
  typeof PersistedObject<Record<string, TransferState>>
>;

export class GatewayTransferStateService {
  private readonly transfers: TransferStoreData;
  private readonly transferR2: Map<TransferId, TransferR2> = new Map();

  constructor(kv: SyncKvStorage) {
    this.transfers = PersistedObject<Record<string, TransferState>>(kv, {
      prefix: "transfers:",
    });
  }

  private toKey(transferId: TransferId): string {
    return String(transferId);
  }

  nextTransferId(): TransferId {
    const keys = Object.keys(this.transfers);
    if (keys.length === 0) {
      return 1;
    }
    const ids = keys
      .map((key) => Number(key))
      .filter((id) => Number.isFinite(id));
    return (ids.length === 0 ? 0 : Math.max(...ids)) + 1;
  }

  getTransfer(transferId: TransferId): TransferState | undefined {
    return this.transfers[this.toKey(transferId)];
  }

  setTransfer(transfer: TransferState): void {
    this.transfers[this.toKey(transfer.transferId)] = transfer;
  }

  deleteTransfer(transferId: TransferId): void {
    delete this.transfers[this.toKey(transferId)];
  }

  getTransferR2(transferId: TransferId): TransferR2 | undefined {
    return this.transferR2.get(transferId);
  }

  setTransferR2(transferId: TransferId, r2: TransferR2): void {
    this.transferR2.set(transferId, r2);
  }

  deleteTransferR2(transferId: TransferId): void {
    this.transferR2.delete(transferId);
  }

  forEachTransferInvolvingNode(
    nodeId: string,
    callback: (transfer: TransferState) => void,
  ): void {
    for (const transfer of Object.values(this.transfers)) {
      if (
        transfer.source.node === nodeId ||
        transfer.destination.node === nodeId
      ) {
        callback(transfer);
      }
    }
  }
}
