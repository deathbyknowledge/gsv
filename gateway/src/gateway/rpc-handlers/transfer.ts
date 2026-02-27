import { env } from "cloudflare:workers";
import type { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";
import {
  completeTransfer,
  failTransfer,
  finalizeR2Upload,
  getTransferWs,
  streamR2ToDest,
} from "../transfers";

export const handleTransferMeta: Handler<"transfer.meta"> = ({
  gw,
  params,
}) => {
  if (!params || typeof params.transferId !== "number") {
    throw new RpcError(400, "transferId required");
  }

  const transfer = gw.transferStateService.getTransfer(params.transferId);
  if (!transfer) return { ok: true };

  if (params.error) {
    failTransfer(gw, transfer, params.error);
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
    gw.transferStateService.setTransferR2(params.transferId, {
      writer,
      uploadPromise,
    });

    const sourceWs = getTransferWs(gw, transfer.source.node);
    if (!sourceWs) {
      failTransfer(
        gw,
        transfer,
        `Source node disconnected: ${transfer.source.node}`,
      );
      return { ok: true };
    }
    sourceWs.send(
      JSON.stringify({
        type: "evt",
        event: "transfer.start",
        payload: { transferId: params.transferId },
      }),
    );
    transfer.state = "streaming";
    gw.transferStateService.setTransfer(transfer);
  } else {
    const destWs = getTransferWs(gw, transfer.destination.node);
    if (!destWs) {
      failTransfer(
        gw,
        transfer,
        `Destination node disconnected: ${transfer.destination.node}`,
      );
      return { ok: true };
    }
    destWs.send(
      JSON.stringify({
        type: "evt",
        event: "transfer.receive",
        payload: {
          transferId: params.transferId,
          path: transfer.destination.path,
          size: params.size,
          mime: params.mime,
        },
      }),
    );
    transfer.state = "accept-wait";
    gw.transferStateService.setTransfer(transfer);
  }

  return { ok: true };
};

export const handleTransferAccept: Handler<"transfer.accept"> = ({
  gw,
  params,
}) => {
  if (!params || typeof params.transferId !== "number") {
    throw new RpcError(400, "transferId required");
  }

  const transfer = gw.transferStateService.getTransfer(params.transferId);
  if (!transfer) return { ok: true };

  if (params.error) {
    failTransfer(gw, transfer, params.error);
    return { ok: true };
  }

  const sourceIsGsv = transfer.source.node === "gsv";

  if (sourceIsGsv) {
    transfer.state = "streaming";
    gw.transferStateService.setTransfer(transfer);
    streamR2ToDest(gw, transfer);
  } else {
    const sourceWs = getTransferWs(gw, transfer.source.node);
    if (!sourceWs) {
      failTransfer(
        gw,
        transfer,
        `Source node disconnected: ${transfer.source.node}`,
      );
      return { ok: true };
    }
    sourceWs.send(
      JSON.stringify({
        type: "evt",
        event: "transfer.start",
        payload: { transferId: params.transferId },
      }),
    );
    transfer.state = "streaming";
    gw.transferStateService.setTransfer(transfer);
  }

  return { ok: true };
};

export const handleTransferComplete: Handler<"transfer.complete"> = ({
  gw,
  params,
}) => {
  if (!params || typeof params.transferId !== "number") {
    throw new RpcError(400, "transferId required");
  }

  const transfer = gw.transferStateService.getTransfer(params.transferId);
  if (!transfer) return { ok: true };

  const destIsGsv = transfer.destination.node === "gsv";

  if (destIsGsv) {
    finalizeR2Upload(gw, transfer);
  } else {
    const destWs = getTransferWs(gw, transfer.destination.node);
    if (!destWs) {
      failTransfer(
        gw,
        transfer,
        `Destination node disconnected: ${transfer.destination.node}`,
      );
      return { ok: true };
    }
    destWs.send(
      JSON.stringify({
        type: "evt",
        event: "transfer.end",
        payload: { transferId: params.transferId },
      }),
    );
    transfer.state = "completing";
    gw.transferStateService.setTransfer(transfer);
  }

  return { ok: true };
};

export const handleTransferDone: Handler<"transfer.done"> = ({
  gw,
  params,
}) => {
  if (!params || typeof params.transferId !== "number") {
    throw new RpcError(400, "transferId required");
  }

  const transfer = gw.transferStateService.getTransfer(params.transferId);
  if (!transfer) return { ok: true };

  if (params.error) {
    failTransfer(gw, transfer, params.error);
    return { ok: true };
  }

  completeTransfer(gw, transfer, params.bytesWritten);
  return { ok: true };
};
