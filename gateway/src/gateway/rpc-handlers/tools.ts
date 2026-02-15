import { env } from "cloudflare:workers";
import type { EventFrame } from "../../protocol/frames";
import {
  DEFER_RESPONSE,
  type Handler,
} from "../../protocol/methods";
import { RpcError } from "../../shared/utils";
import type { ToolInvokePayload } from "../../protocol/tools";

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

export const handleToolsList: Handler<"tools.list"> = ({ gw }) => ({
  tools: gw.getAllTools(),
});

export const handleToolRequest: Handler<"tool.request"> = ({ gw, params }) => {
  if (!params?.callId || !params?.tool || !params?.sessionKey) {
    throw new RpcError(400, "callId, tool, and sessionKey required");
  }

  const resolved = gw.findNodeForTool(params.tool);
  if (!resolved) {
    throw new RpcError(404, `No node provides tool: ${params.tool}`);
  }

  const nodeWs = gw.nodes.get(resolved.nodeId);
  if (!nodeWs) {
    throw new RpcError(503, "Node not connected");
  }

  gw.pendingToolCalls[params.callId] = {
    kind: "session",
    sessionKey: params.sessionKey,
  };

  // Send the original (un-namespaced) tool name to the node
  const evt: EventFrame<ToolInvokePayload> = {
    type: "evt",
    event: "tool.invoke",
    payload: {
      callId: params.callId,
      tool: resolved.toolName,
      args: params.args ?? {},
    },
  };
  nodeWs.send(JSON.stringify(evt));

  return { status: "sent" };
};

export const handleToolInvoke: Handler<"tool.invoke"> = (ctx) => {
  const { ws, frame, gw, params } = ctx;
  if (!params?.tool) {
    throw new RpcError(400, "tool required");
  }

  const resolved = gw.findNodeForTool(params.tool);
  if (!resolved) {
    throw new RpcError(404, `No node provides tool: ${params.tool}`);
  }

  const nodeWs = gw.nodes.get(resolved.nodeId);
  if (!nodeWs) {
    throw new RpcError(503, "Node not connected");
  }

  const attachment = ws.deserializeAttachment();
  const clientId = attachment.clientId as string | undefined;
  if (!clientId) {
    throw new RpcError(101, "Not connected");
  }

  const callId = crypto.randomUUID();
  gw.pendingToolCalls[callId] = {
    kind: "client",
    clientId,
    frameId: frame.id,
    createdAt: Date.now(),
  };

  const evt: EventFrame<ToolInvokePayload> = {
    type: "evt",
    event: "tool.invoke",
    payload: { callId, tool: resolved.toolName, args: params.args ?? {} },
  };
  nodeWs.send(JSON.stringify(evt));

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

  const route = gw.pendingToolCalls[params.callId];
  if (!route) {
    throw new RpcError(404, "Unknown callId");
  }
  if (
    typeof route !== "object" ||
    route === null ||
    (route.kind !== "client" && route.kind !== "session")
  ) {
    delete gw.pendingToolCalls[params.callId];
    return { ok: true, dropped: true };
  }

  if (route.kind === "client") {
    const clientWs = gw.clients.get(route.clientId);
    if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
      console.log(
        `[Gateway] Dropping tool.result for disconnected client ${route.clientId} (callId=${params.callId})`,
      );
      delete gw.pendingToolCalls[params.callId];
      return { ok: true, dropped: true };
    }

    if (params.error) {
      gw.sendError(clientWs, route.frameId, 500, params.error);
    } else {
      gw.sendOk(clientWs, route.frameId, {
        result: params.result,
      });
    }
    delete gw.pendingToolCalls[params.callId];
    return { ok: true };
  }

  const sessionStub = env.SESSION.getByName(route.sessionKey);
  const result = await sessionStub.toolResult({
    callId: params.callId,
    result: params.result,
    error: params.error,
  });
  if (!result.ok) {
    delete gw.pendingToolCalls[params.callId];
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

  delete gw.pendingToolCalls[params.callId];

  return { ok: true };
};

export const handleNodeProbeResult: Handler<"node.probe.result"> = async ({
  ws,
  gw,
  params,
}) => {
  const attachment = ws.deserializeAttachment();
  const nodeId = attachment.nodeId as string | undefined;
  if (!nodeId) {
    throw new RpcError(403, "Only node clients can submit probe results");
  }
  return await gw.handleNodeProbeResult(nodeId, params);
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
