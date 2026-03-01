import { env } from "cloudflare:workers";
import {
  DEFER_RESPONSE,
  type Handler,
} from "../../protocol/methods";
import { RpcError } from "../../shared/utils";

function extractRunningSessionId(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status.trim() : "";
  if (status !== "running") {
    return undefined;
  }
  const sessionId =
    typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  return sessionId || undefined;
}

function toToolDispatchRpcError(message: string): RpcError {
  if (message.startsWith("No node provides tool:")) {
    return new RpcError(404, message);
  }
  if (message === "Node not connected") {
    return new RpcError(503, message);
  }
  return new RpcError(500, message);
}

export const handleToolsList: Handler<"tools.list"> = ({ gw }) => ({
  tools: gw.nodeService.listTools(gw.nodes.keys()),
});

export const handleToolRequest: Handler<"tool.request"> = ({ gw, params }) => {
  if (!params?.callId || !params?.tool || !params?.sessionKey) {
    throw new RpcError(400, "callId, tool, and sessionKey required");
  }

  const result = gw.nodeService.requestToolForSession(params, gw.nodes);
  if (!result.ok) {
    throw toToolDispatchRpcError(result.error ?? "Failed to dispatch tool");
  }

  return { status: "sent" };
};

export const handleToolInvoke: Handler<"tool.invoke"> = (ctx) => {
  const { ws, frame, gw, params } = ctx;
  if (!params?.tool) {
    throw new RpcError(400, "tool required");
  }

  const attachment = ws.deserializeAttachment();
  const clientId = attachment.clientId as string | undefined;
  if (!clientId) {
    throw new RpcError(101, "Not connected");
  }

  const result = gw.nodeService.requestToolFromClient(
    {
      clientId,
      requestId: frame.id,
      tool: params.tool,
      args: params.args ?? {},
    },
    {
      connectedNodes: gw.nodes,
      pendingToolTtlMs: gw.getPendingToolTimeoutMs(),
    },
  );
  if (!result.ok) {
    throw toToolDispatchRpcError(result.error ?? "Failed to dispatch tool");
  }
  void gw.scheduleGatewayAlarm();

  return DEFER_RESPONSE;
};

export const handleToolResult: Handler<"tool.result"> = async ({
  ws,
  gw,
  params,
}) => {
  if (!params?.callId) {
    throw new RpcError(400, "callId required");
  }

  const route = gw.nodeService.consumePendingToolCall(params.callId);
  if (!route) {
    throw new RpcError(404, "Unknown callId");
  }
  if (
    typeof route !== "object" ||
    route === null ||
    (route.kind !== "client" && route.kind !== "session")
  ) {
    return { ok: true, dropped: true };
  }

  if (route.kind === "client") {
    const clientWs = gw.clients.get(route.clientId);
    if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
      console.log(
        `[Gateway] Dropping tool.result for disconnected client ${route.clientId} (callId=${params.callId})`,
      );
      return { ok: true, dropped: true };
    }

    if (params.error) {
      gw.sendError(clientWs, route.frameId, 500, params.error);
    } else {
      gw.sendOk(clientWs, route.frameId, {
        result: params.result,
      });
    }
    return { ok: true };
  }

  const sessionStub = env.SESSION.getByName(route.sessionKey);
  const result = await sessionStub.toolResult({
    callId: params.callId,
    result: params.result,
    error: params.error,
  });
  if (!result.ok) {
    throw new RpcError(404, `Unknown session tool call: ${params.callId}`);
  }

  const nodeAttachment = ws.deserializeAttachment();
  const nodeId = nodeAttachment.nodeId as string | undefined;
  const runningSessionId = extractRunningSessionId(params.result);
  if (nodeId && runningSessionId) {
    gw.registerPendingAsyncExecSession({
      nodeId,
      sessionId: runningSessionId,
      sessionKey: route.sessionKey,
      callId: params.callId,
    });
  }


  return { ok: true };
};

export const handleNodeExecEvent: Handler<"node.exec.event"> = async ({
  ws,
  gw,
  params,
}) => {
  const attachment = ws.deserializeAttachment();
  const nodeId = attachment.nodeId as string | undefined;
  if (!nodeId) {
    throw new RpcError(403, "Only node clients can submit exec events");
  }
  return await gw.handleNodeExecEvent(nodeId, params);
};
