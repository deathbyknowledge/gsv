import type { EventFrame } from "../../protocol/frames";
import { DEFER_RESPONSE, type Handler } from "../../protocol/methods";
import type { LogsGetEventPayload } from "../../protocol/logs";
import { RpcError } from "../../shared/utils";

const DEFAULT_LOG_LINES = 100;
const MAX_LOG_LINES = 5000;

function resolveLogLineLimit(input: number | undefined): number {
  if (input === undefined) {
    return DEFAULT_LOG_LINES;
  }
  if (!Number.isFinite(input) || input < 1) {
    throw new RpcError(400, "lines must be a positive number");
  }
  return Math.min(Math.floor(input), MAX_LOG_LINES);
}

export const handleLogsGet: Handler<"logs.get"> = ({ gw, ws, frame, params }) => {
  const attachment = ws.deserializeAttachment();
  const clientId = attachment.clientId as string | undefined;
  if (!clientId) {
    throw new RpcError(101, "Not connected");
  }

  const lines = resolveLogLineLimit(params?.lines);

  const nodeId = params?.nodeId;
  let targetNodeId: string;
  if (nodeId) {
    if (!gw.nodes.has(nodeId)) {
      throw new RpcError(503, `Node not connected: ${nodeId}`);
    }
    targetNodeId = nodeId;
  } else if (gw.nodes.size === 1) {
    targetNodeId = Array.from(gw.nodes.keys())[0];
  } else if (gw.nodes.size === 0) {
    throw new RpcError(503, "No nodes connected");
  } else {
    throw new RpcError(
      400,
      "nodeId required when multiple nodes are connected",
    );
  }

  const nodeWs = gw.nodes.get(targetNodeId);
  if (!nodeWs) {
    throw new RpcError(503, `Node not connected: ${targetNodeId}`);
  }

  const callId = crypto.randomUUID();
  gw.registerPendingLogCall(callId, {
    clientId,
    frameId: frame.id,
    nodeId: targetNodeId,
    createdAt: Date.now(),
  });

  const evt: EventFrame<LogsGetEventPayload> = {
    type: "evt",
    event: "logs.get",
    payload: {
      callId,
      lines,
    },
  };
  nodeWs.send(JSON.stringify(evt));

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

  const route = gw.consumePendingLogCall(params.callId);
  if (!route) {
    if (gw.resolveInternalNodeLogResult(nodeId, params)) {
      return { ok: true };
    }
    throw new RpcError(404, "Unknown callId");
  }

  if (nodeId !== route.nodeId) {
    throw new RpcError(403, "Node not authorized for this call");
  }

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
