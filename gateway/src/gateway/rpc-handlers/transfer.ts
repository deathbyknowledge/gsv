import { env } from "cloudflare:workers";
import type { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";

export const handleTransferMeta: Handler<"transfer.meta"> = ({ gw, params }) => {
  if (!params || typeof params.transferId !== "number") {
    throw new RpcError(400, "transferId required");
  }

  const transfer = gw.transfers[String(params.transferId)];
  if (!transfer) return { ok: true };

  if (params.error) {
    gw.failTransfer(transfer, params.error);
    return { ok: true };
  }

  transfer.size = params.size;
  transfer.mime = params.mime;

  const destIsGsv = transfer.destination.node === "gsv";

  if (destIsGsv) {
    const { readable, writable } = new FixedLengthStream(params.size);
    const writer = writable.getWriter();
    const uploadPromise = (env as Env).STORAGE.put(
      transfer.destination.path,
      readable,
      {
        httpMetadata: transfer.mime
          ? { contentType: transfer.mime }
          : undefined,
      },
    );
    gw.transferR2.set(params.transferId, { writer, uploadPromise });

    const sourceWs = gw.getTransferWs(transfer.source.node);
    if (!sourceWs) {
      gw.failTransfer(transfer, `Source node disconnected: ${transfer.source.node}`);
      return { ok: true };
    }
    sourceWs.send(JSON.stringify({
      type: "evt",
      event: "transfer.start",
      payload: { transferId: params.transferId },
    }));
    transfer.state = "streaming";
    gw.transfers[String(params.transferId)] = transfer;
  } else {
    const destWs = gw.getTransferWs(transfer.destination.node);
    if (!destWs) {
      gw.failTransfer(transfer, `Destination node disconnected: ${transfer.destination.node}`);
      return { ok: true };
    }
    destWs.send(JSON.stringify({
      type: "evt",
      event: "transfer.receive",
      payload: {
        transferId: params.transferId,
        path: transfer.destination.path,
        size: params.size,
        mime: params.mime,
      },
    }));
    transfer.state = "accept-wait";
    gw.transfers[String(params.transferId)] = transfer;
  }

  return { ok: true };
};

export const handleTransferAccept: Handler<"transfer.accept"> = ({ gw, params }) => {
  if (!params || typeof params.transferId !== "number") {
    throw new RpcError(400, "transferId required");
  }

  const transfer = gw.transfers[String(params.transferId)];
  if (!transfer) return { ok: true };

  if (params.error) {
    gw.failTransfer(transfer, params.error);
    return { ok: true };
  }

  const sourceIsGsv = transfer.source.node === "gsv";

  if (sourceIsGsv) {
    transfer.state = "streaming";
    gw.transfers[String(params.transferId)] = transfer;
    gw.streamR2ToDest(transfer);
  } else {
    const sourceWs = gw.getTransferWs(transfer.source.node);
    if (!sourceWs) {
      gw.failTransfer(transfer, `Source node disconnected: ${transfer.source.node}`);
      return { ok: true };
    }
    sourceWs.send(JSON.stringify({
      type: "evt",
      event: "transfer.start",
      payload: { transferId: params.transferId },
    }));
    transfer.state = "streaming";
    gw.transfers[String(params.transferId)] = transfer;
  }

  return { ok: true };
};

export const handleTransferComplete: Handler<"transfer.complete"> = ({ gw, params }) => {
  if (!params || typeof params.transferId !== "number") {
    throw new RpcError(400, "transferId required");
  }

  const transfer = gw.transfers[String(params.transferId)];
  if (!transfer) return { ok: true };

  const destIsGsv = transfer.destination.node === "gsv";

  if (destIsGsv) {
    gw.finalizeR2Upload(transfer);
  } else {
    const destWs = gw.getTransferWs(transfer.destination.node);
    if (!destWs) {
      gw.failTransfer(transfer, `Destination node disconnected: ${transfer.destination.node}`);
      return { ok: true };
    }
    destWs.send(JSON.stringify({
      type: "evt",
      event: "transfer.end",
      payload: { transferId: params.transferId },
    }));
    transfer.state = "completing";
    gw.transfers[String(params.transferId)] = transfer;
  }

  return { ok: true };
};

export const handleTransferDone: Handler<"transfer.done"> = ({ gw, params }) => {
  if (!params || typeof params.transferId !== "number") {
    throw new RpcError(400, "transferId required");
  }

  const transfer = gw.transfers[String(params.transferId)];
  if (!transfer) return { ok: true };

  if (params.error) {
    gw.failTransfer(transfer, params.error);
    return { ok: true };
  }

  gw.completeTransfer(transfer, params.bytesWritten);
  return { ok: true };
};
