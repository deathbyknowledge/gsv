import { DEFER_RESPONSE, type Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";

export const handleLogsGet: Handler<"logs.get"> = ({ gw, ws, frame, params }) => {
  const attachment = ws.deserializeAttachment();
  const clientId = attachment.clientId as string | undefined;
  if (!clientId) {
    throw new RpcError(101, "Not connected");
  }

  try {
    const result = gw.nodeService.requestLogsFromClient(
      {
        clientId,
        requestId: frame.id,
        nodeId: params?.nodeId,
        lines: params?.lines,
      },
      {
        connectedNodes: gw.nodes,
        pendingLogTtlMs: gw.getPendingLogTimeoutMs(),
      },
    );
    if (!result.ok) {
      throw new Error(result.error ?? "Failed to request node logs");
    }
    void gw.scheduleGatewayAlarm();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "lines must be a positive number") {
      throw new RpcError(400, message);
    }
    if (
      message.startsWith("Node not connected:") ||
      message === "No nodes connected"
    ) {
      throw new RpcError(503, message);
    }
    if (message === "nodeId required when multiple nodes are connected") {
      throw new RpcError(400, message);
    }
    throw new RpcError(500, message);
  }

  return DEFER_RESPONSE;
};

export const handleLogsResult: Handler<"logs.result"> = ({ gw, ws, params }) => {
  if (!params?.callId) {
    throw new RpcError(400, "callId required");
  }

  const attachment = ws.deserializeAttachment();
  const nodeId = attachment.nodeId as string | undefined;
  if (!nodeId) {
    throw new RpcError(403, "Node not authorized for this call");
  }

  const route = gw.nodeService.peekPendingLogCall(params.callId);
  if (!route) {
    if (gw.nodeService.resolveInternalNodeLogResult(nodeId, params)) {
      return { ok: true };
    }
    throw new RpcError(404, "Unknown callId");
  }

  if (nodeId !== route.nodeId) {
    throw new RpcError(403, "Node not authorized for this call");
  }

  gw.nodeService.consumePendingLogCall(params.callId);

  const clientWs = gw.clients.get(route.clientId);
  if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
    return { ok: true, dropped: true };
  }

  if (params.error) {
    gw.sendError(clientWs, route.frameId, 500, params.error);
  } else {
    const lines = params.lines ?? [];
    gw.sendOk(clientWs, route.frameId, {
      nodeId: route.nodeId,
      lines,
      count: lines.length,
      truncated: Boolean(params.truncated),
    });
  }

  return { ok: true };
};
