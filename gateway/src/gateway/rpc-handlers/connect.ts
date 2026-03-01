import { RpcError, timingSafeEqualStr } from "../../shared/utils";
import type { ConnectResult, Handler } from "../../protocol/methods";
import { normalizeAgentId } from "../../session/routing";
import { validateNodeRuntimeInfo } from "../capabilities";
import type { Gateway } from "../do";

function getSkillProbeAgentIds(gw: Gateway): string[] {
  const configured = gw
    .getFullConfig()
    .agents.list.map((agent) => normalizeAgentId(agent.id || "main"));
  const unique = new Set(["main", ...configured]);
  return Array.from(unique).sort();
}

function onNodeConnected(gw: Gateway, nodeId: string): void {
  void (async () => {
    try {
      await gw.dispatchPendingNodeProbesForNode(nodeId);
      for (const agentId of getSkillProbeAgentIds(gw)) {
        await gw.refreshSkillRuntimeFacts(agentId, { force: false });
      }
    } catch (error) {
      console.error(
        `[Gateway] Failed to refresh skill runtime facts on node connect (${nodeId}):`,
        error,
      );
    }
  })();
}

export const handleConnect: Handler<"connect"> = async (ctx) => {
  const { ws, gw, params } = ctx;
  if (params?.minProtocol !== 1) {
    throw new RpcError(102, "Unsupported protocol version");
  }

  // Check auth token if configured
  const authToken = gw.getConfigPath("auth.token") as string | undefined;

  if (authToken) {
    const providedToken = params?.auth?.token;
    if (!providedToken || !timingSafeEqualStr(providedToken, authToken)) {
      ws.close(4001, "Unauthorized");
      throw new RpcError(401, "Unauthorized: invalid or missing token");
    }
  }

  const mode = params?.client?.mode;
  if (!mode || !["client", "node", "channel"].includes(mode)) {
    throw new RpcError(103, "Invalid client mode");
  }

  let attachments = ws.deserializeAttachment();
  attachments = { ...attachments, connected: true, mode };

  if (mode === "client") {
    const existingWs = gw.clients.get(params.client.id);
    if (existingWs && existingWs !== ws) {
      existingWs.close(1000, "Replaced by newer client connection");
    }

    attachments.clientId = params.client.id;
    gw.clients.set(params.client.id, ws);
    console.log(`[Gateway] Client connected: ${params.client.id}`);
  } else if (mode === "node") {
    const nodeId = params.client.id;
    const nodeTools = params.tools ?? [];
    if (nodeTools.length === 0) {
      throw new RpcError(103, "Node mode requires tools");
    }

    let runtime;
    try {
      runtime = validateNodeRuntimeInfo({
        nodeId,
        tools: nodeTools,
        runtime: params.nodeRuntime,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RpcError(103, `Invalid nodeRuntime: ${message}`);
    }

    const existingWs = gw.nodes.get(nodeId);
    if (existingWs && existingWs !== ws) {
      // Any in-flight logs.get requests targeted at the old socket cannot
      // complete after replacement; fail them before swapping the node entry.
      gw.failPendingLogCallsForNode(
        nodeId,
        `Node replaced during log request: ${nodeId}`,
      );
      gw.nodeService.cancelInternalNodeLogRequestsForNode(
        nodeId,
        `Node replaced during log request: ${nodeId}`,
      );
      gw.markPendingNodeProbesAsQueued(
        nodeId,
        `Node replaced during node probe: ${nodeId}`,
      );
      existingWs.close(1000, "Replaced by newer node connection");
    }

    attachments.nodeId = nodeId;
    gw.nodes.set(nodeId, ws);
    gw.nodeService.registerNode(nodeId, {
      tools: nodeTools,
      runtime,
      metadata: {
        platform: params.client.platform,
        version: params.client.version,
      },
    });
    onNodeConnected(gw, nodeId);
    console.log(
      `[Gateway] Node connected: ${nodeId}, role=${runtime.hostRole}, tools: [${nodeTools.map((t) => `${nodeId}__${t.name}`).join(", ")}]`,
    );
  } else if (mode === "channel") {
    const channel = params.client.channel;
    const accountId = params.client.accountId ?? params.client.id;
    if (!channel) {
      throw new RpcError(103, "Channel mode requires channel field");
    }
    const channelKey = `${channel}:${accountId}`;
    const existingWs = gw.channels.get(channelKey);
    if (existingWs && existingWs !== ws) {
      existingWs.close(1000, "Replaced by newer channel connection");
    }

    attachments.channelKey = channelKey;
    attachments.channel = channel;
    attachments.accountId = accountId;
    gw.channels.set(channelKey, ws);
    // Update channel registry
    gw.channelRegistry[channelKey] = {
      channel,
      accountId,
      connectedAt: Date.now(),
    };
    console.log(`[Gateway] Channel connected: ${channelKey}`);
  }

  ws.serializeAttachment(attachments);
  const payload: ConnectResult = {
    type: "hello-ok",
    protocol: 1,
    server: { version: "0.0.1", connectionId: attachments.id },
    features: {
      methods: [
        "tools.list",
        "logs.get",
        "chat.send",
        "config.get",
        "config.set",
        "skills.status",
        "skills.update",
        "session.get",
        "session.patch",
        "session.stats",
        "session.reset",
        "session.history",
        "session.preview",
        "session.compact",
        "sessions.list",
        "heartbeat.status",
        "heartbeat.start",
        "heartbeat.trigger",
        "cron.status",
        "cron.list",
        "cron.add",
        "cron.update",
        "cron.remove",
        "cron.run",
        "cron.runs",
        "tool.request",
        "tool.result",
        "node.probe.result",
        "node.exec.event",
        "logs.result",
        "channel.inbound",
        "channel.start",
        "channel.stop",
        "channel.status",
        "channel.login",
        "channel.logout",
        "channels.list",
      ],
      events: [
        "chat",
        "tool.invoke",
        "tool.result",
        "node.probe",
        "logs.get",
        "channel.outbound",
      ],
    },
  };

  // Auto-start heartbeat scheduler on first connection (if not already initialized)
  if (!gw.heartbeatScheduler.initialized) {
    gw.scheduleHeartbeat()
      .then(() => {
        gw.heartbeatScheduler.initialized = true;
        console.log(
          `[Gateway] Heartbeat scheduler auto-initialized on first connection`,
        );
      })
      .catch((e) => {
        console.error(
          `[Gateway] Failed to auto-initialize heartbeat scheduler:`,
          e,
        );
      });
  }

  return payload;
};
