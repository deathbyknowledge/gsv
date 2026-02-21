import { DurableObject } from "cloudflare:workers";
import type { ChannelWorkerInterface } from "../channel-interface";
import { PersistedObject, snapshot } from "../shared/persisted-object";
import type {
  Frame,
  EventFrame,
  ErrorShape,
  RequestFrame,
  ResponseFrame,
} from "../protocol/frames";
import {
  isWebSocketRequest,
  validateFrame,
  isWsConnected,
  toErrorShape,
} from "../shared/utils";
import { DEFAULT_CONFIG } from "../config/defaults";
import {
  GsvConfig,
  GsvConfigInput,
  mergeConfig,
  HeartbeatConfig,
  PendingPair,
} from "../config";
import { getDefaultAgentId } from "../config/parsing";
import {
  HeartbeatState,
  getHeartbeatConfig,
  getNextHeartbeatTime,
  isWithinActiveHours,
  HeartbeatResult,
} from "./heartbeat";
import { loadHeartbeatFile, isHeartbeatFileEmpty } from "../agents/loader";
import {
  evaluateSkillEligibility,
  resolveEffectiveSkillPolicy,
} from "../agents/prompt";
import {
  canonicalizeSessionKey as canonicalizeKey,
  normalizeAgentId,
  normalizeMainKey,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
} from "../session/routing";
import { formatTimeFull, resolveTimezone } from "../shared/time";
import { listWorkspaceSkills } from "../skills";
import { getNativeToolDefinitions } from "../agents/tools";
import type {
  TransferRequestParams,
} from "../protocol/transfer";
import { listHostsByRole, pickExecutionHostId } from "./capabilities";
import {
  executeCronTool as executeCronToolHandler,
  executeMessageTool as executeMessageToolHandler,
  executeSessionSendTool as executeSessionSendToolHandler,
  executeSessionsListTool as executeSessionsListToolHandler,
} from "./tool-executors";
import {
  deliverPendingAsyncExecDeliveries as deliverPendingAsyncExecDeliveriesHandler,
  gcDeliveredAsyncExecEvents as gcDeliveredAsyncExecEventsHandler,
  gcPendingAsyncExecDeliveries as gcPendingAsyncExecDeliveriesHandler,
  gcPendingAsyncExecSessions as gcPendingAsyncExecSessionsHandler,
  handleNodeExecEvent as handleNodeExecEventHandler,
  nextDeliveredAsyncExecEventGcAtMs as nextDeliveredAsyncExecEventGcAtMsHandler,
  nextPendingAsyncExecDeliveryAtMs as nextPendingAsyncExecDeliveryAtMsHandler,
  nextPendingAsyncExecSessionExpiryAtMs as nextPendingAsyncExecSessionExpiryAtMsHandler,
  registerPendingAsyncExecSession as registerPendingAsyncExecSessionHandler,
} from "./async-exec-state";
import {
  canNodeProbeBins as canNodeProbeBinsHandler,
  clampSkillProbeTimeoutMs as clampSkillProbeTimeoutMsHandler,
  dispatchPendingNodeProbesForNode as dispatchPendingNodeProbesForNodeHandler,
  gcPendingNodeProbes as gcPendingNodeProbesHandler,
  handleNodeProbeResult as handleNodeProbeResultHandler,
  handlePendingNodeProbeTimeouts as handlePendingNodeProbeTimeoutsHandler,
  markPendingNodeProbesAsQueued as markPendingNodeProbesAsQueuedHandler,
  nextPendingNodeProbeExpiryAtMs as nextPendingNodeProbeExpiryAtMsHandler,
  nextPendingNodeProbeGcAtMs as nextPendingNodeProbeGcAtMsHandler,
  queueNodeBinProbe as queueNodeBinProbeHandler,
  sanitizeSkillBinName as sanitizeSkillBinNameHandler,
} from "./skill-probes";
import {
  handleChannelInboundRpc as handleChannelInboundRpcHandler,
  type ChannelInboundRpcResult,
} from "./channel-inbound";
import {
  routePayloadToChannel,
  type PendingChannelResponseContext,
} from "./channel-routing";
import {
  getChannelBinding as getChannelBindingHandler,
  handleChannelStatusChanged as handleChannelStatusChangedHandler,
  sendChannelResponse as sendChannelResponseHandler,
  sendTypingToChannel as sendTypingToChannelHandler,
} from "./channel-transport";
import {
  completeTransfer as completeTransferHandler,
  failTransfer as failTransferHandler,
  failTransfersForNode as failTransfersForNodeHandler,
  finalizeR2Upload as finalizeR2UploadHandler,
  getTransferWs as getTransferWsHandler,
  handleTransferBinaryFrame as handleTransferBinaryFrameHandler,
  streamR2ToDest as streamR2ToDestHandler,
  transferRequest as transferRequestHandler,
  type TransferR2,
  type TransferState,
} from "./transfers";
import {
  CronService,
  CronStore,
  type CronJob,
  type CronJobCreate,
  type CronJobPatch,
  type CronRun,
  type CronRunResult,
} from "../cron";
import type { ChatEventPayload } from "../protocol/chat";
import type {
  ChannelRegistryEntry,
  ChannelId,
  PeerInfo,
  ChannelInboundParams,
} from "../protocol/channel";
import type {
  LogsGetEventPayload,
  LogsGetParams,
  LogsGetResult,
  LogsResultParams,
} from "../protocol/logs";
import type { SessionRegistryEntry } from "../protocol/session";
import type {
  RuntimeNodeInventory,
  NodeExecEventParams,
  NodeExecEventType,
  NodeRuntimeInfo,
  NodeProbeResultParams,
  ToolDefinition,
  ToolInvokePayload,
  ToolRequestParams,
} from "../protocol/tools";
import {
  DEFER_RESPONSE,
  type DeferredResponse,
  type Handler,
  type RpcMethod,
} from "../protocol/methods";
import { buildRpcHandlers } from "./rpc-handlers/";

export type PendingToolRoute =
  | { kind: "session"; sessionKey: string }
  | { kind: "client"; clientId: string; frameId: string; createdAt: number };

export type PendingLogRoute = {
  clientId: string;
  frameId: string;
  nodeId: string;
  createdAt: number;
};

type PendingInternalLogRequest = {
  nodeId: string;
  resolve: (result: LogsGetResult) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

type PendingNodeProbe = {
  nodeId: string;
  agentId: string;
  kind: "bins";
  bins: string[];
  timeoutMs: number;
  attempts: number;
  createdAt: number;
  sentAt?: number;
  expiresAt?: number;
};

type PendingAsyncExecSession = {
  nodeId: string;
  sessionId: string;
  sessionKey: string;
  callId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

type AsyncExecTerminalEventType = Extract<
  NodeExecEventType,
  "finished" | "failed" | "timed_out"
>;

type PendingAsyncExecDelivery = {
  eventId: string;
  nodeId: string;
  sessionId: string;
  sessionKey: string;
  callId: string;
  event: AsyncExecTerminalEventType;
  exitCode?: number | null;
  signal?: string;
  outputTail?: string;
  startedAt?: number;
  endedAt?: number;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  expiresAt: number;
  lastError?: string;
};

const DEFAULT_LOG_LINES = 100;
const MAX_LOG_LINES = 5000;
const DEFAULT_INTERNAL_LOG_TIMEOUT_MS = 20_000;
const MAX_INTERNAL_LOG_TIMEOUT_MS = 120_000;
const SKILL_BIN_STATUS_TTL_MS = 5 * 60_000;

type GatewayMethodHandlerContext = {
  gw: Gateway;
  ws: WebSocket;
  frame: RequestFrame;
  params: unknown;
};

type GatewayMethodHandler = (
  ctx: GatewayMethodHandlerContext,
) => Promise<unknown | DeferredResponse> | unknown | DeferredResponse;

export class Gateway extends DurableObject<Env> {
  clients: Map<string, WebSocket> = new Map();
  nodes: Map<string, WebSocket> = new Map();
  channels: Map<string, WebSocket> = new Map();

  readonly transfers = PersistedObject<Record<string, TransferState>>(
    this.ctx.storage.kv,
    { prefix: "transfers:" },
  );
  transferR2 = new Map<number, TransferR2>();

  readonly toolRegistry = PersistedObject<Record<string, ToolDefinition[]>>(
    this.ctx.storage.kv,
    { prefix: "toolRegistry:" },
  );
  readonly nodeRuntimeRegistry = PersistedObject<
    Record<string, NodeRuntimeInfo>
  >(this.ctx.storage.kv, { prefix: "nodeRuntimeRegistry:" });

  readonly pendingToolCalls = PersistedObject<Record<string, PendingToolRoute>>(
    this.ctx.storage.kv,
    { prefix: "pendingToolCalls:" },
  );

  readonly pendingLogCalls = PersistedObject<Record<string, PendingLogRoute>>(
    this.ctx.storage.kv,
    { prefix: "pendingLogCalls:" },
  );
  readonly pendingNodeProbes = PersistedObject<Record<string, PendingNodeProbe>>(
    this.ctx.storage.kv,
    { prefix: "pendingNodeProbes:" },
  );
  readonly pendingAsyncExecSessions = PersistedObject<
    Record<string, PendingAsyncExecSession>
  >(this.ctx.storage.kv, { prefix: "pendingAsyncExecSessions:" });
  readonly pendingAsyncExecDeliveries = PersistedObject<
    Record<string, PendingAsyncExecDelivery>
  >(this.ctx.storage.kv, { prefix: "pendingAsyncExecDeliveries:" });
  readonly deliveredAsyncExecEvents = PersistedObject<Record<string, number>>(
    this.ctx.storage.kv,
    { prefix: "deliveredAsyncExecEvents:" },
  );
  private readonly pendingInternalLogCalls = new Map<
    string,
    PendingInternalLogRequest
  >();

  readonly configStore = PersistedObject<Record<string, unknown>>(
    this.ctx.storage.kv,
    { prefix: "config:" },
  );

  readonly sessionRegistry = PersistedObject<
    Record<string, SessionRegistryEntry>
  >(this.ctx.storage.kv, { prefix: "sessionRegistry:" });

  readonly channelRegistry = PersistedObject<
    Record<string, ChannelRegistryEntry>
  >(this.ctx.storage.kv, { prefix: "channelRegistry:" });

  // Heartbeat state per agent
  readonly heartbeatState = PersistedObject<Record<string, HeartbeatState>>(
    this.ctx.storage.kv,
    { prefix: "heartbeatState:" },
  );

  // Last active channel context per agent (for heartbeat delivery)
  readonly lastActiveContext = PersistedObject<
    Record<
      string,
      {
        agentId: string;
        channel: ChannelId;
        accountId: string;
        peer: PeerInfo;
        sessionKey: string;
        timestamp: number;
      }
    >
  >(this.ctx.storage.kv, { prefix: "lastActiveContext:" });

  // Pending pairing requests (key: "channel:senderId")
  pendingPairs = PersistedObject<Record<string, PendingPair>>(
    this.ctx.storage.kv,
    { prefix: "pendingPairs:" },
  );

  // Heartbeat scheduler state (persisted to survive DO eviction)
  heartbeatScheduler = PersistedObject<{ initialized: boolean }>(
    this.ctx.storage.kv,
    { prefix: "heartbeatScheduler:", defaults: { initialized: false } },
  );

  private readonly cronStore = new CronStore(this.ctx.storage.sql);

  private readonly handlers = buildRpcHandlers();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);

    const websockets = this.ctx.getWebSockets();
    console.log(
      `[Gateway] Constructor: rehydrating ${websockets.length} WebSockets`,
    );

    for (const ws of websockets) {
      const { connected, mode, clientId, nodeId, channelKey } =
        ws.deserializeAttachment();
      if (!connected) continue;

      switch (mode) {
        case "client":
          this.clients.set(clientId, ws);
          console.log(`[Gateway]   Rehydrated client: ${clientId}`);
          break;
        case "node":
          this.nodes.set(nodeId, ws);
          console.log(`[Gateway]   Rehydrated node: ${nodeId}`);
          break;
        case "channel":
          if (channelKey) {
            this.channels.set(channelKey, ws);
            console.log(`[Gateway]   Rehydrated channel: ${channelKey}`);
          }
          break;
      }
    }

    console.log(
      `[Gateway] After rehydration: ${this.clients.size} clients, ${this.nodes.size} nodes, ${this.channels.size} channels`,
    );

    // Evict rehydrated nodes that lost their registry data (KV was
    // deleted but the WebSocket survived hibernation).
    const orphanedNodeIds = Array.from(this.nodes.keys()).filter(
      (nodeId) => !this.toolRegistry[nodeId]?.length,
    );
    for (const nodeId of orphanedNodeIds) {
      const ws = this.nodes.get(nodeId)!;
      this.nodes.delete(nodeId);
      ws.close(4000, "Missing tool registry after rehydration");
      console.log(
        `[Gateway] Evicted orphaned node ${nodeId} (no tools in registry)`,
      );
    }

    const detachedNodeIds = Object.keys(this.toolRegistry).filter(
      (nodeId) => !this.nodes.has(nodeId),
    );
    if (detachedNodeIds.length > 0) {
      console.log(
        `[Gateway] Preserving ${detachedNodeIds.length} detached registry entries until explicit disconnect`,
      );
    }
    const detachedRuntimeNodeIds = Object.keys(this.nodeRuntimeRegistry).filter(
      (nodeId) => !this.nodes.has(nodeId),
    );
    if (detachedRuntimeNodeIds.length > 0) {
      console.log(
        `[Gateway] Preserving ${detachedRuntimeNodeIds.length} detached runtime entries until explicit disconnect`,
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (isWebSocketRequest(request)) {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ id: crypto.randomUUID(), connected: false });
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not Found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message !== "string") {
      this.handleTransferBinaryFrame(ws, message as ArrayBuffer);
      return;
    }
    try {
      const frame: Frame = JSON.parse(message);
      console.log(
        `[Gateway] Received frame: ${frame.type}/${(frame as any).method || (frame as any).event || "?"}`,
      );
      validateFrame(frame);
      await this.handleFrame(ws, frame);
    } catch (e) {
      console.error(e);
    }
  }

  async handleFrame(ws: WebSocket, frame: Frame) {
    if (frame.type !== "req") return;

    if (!isWsConnected(ws) && frame.method !== "connect") {
      this.sendError(ws, frame.id, 101, "Not connected");
      return;
    }

    const methodHandler = this.getMethodHandler(frame.method);
    if (!methodHandler) {
      this.sendError(ws, frame.id, 404, `Unknown method: ${frame.method}`);
      return;
    }

    try {
      const payload = await methodHandler({
        gw: this,
        ws,
        frame,
        params: frame.params,
      });
      if (payload !== DEFER_RESPONSE) {
        this.sendOk(ws, frame.id, payload);
      }
    } catch (error) {
      this.sendErrorShape(ws, frame.id, toErrorShape(error));
    }
  }

  private getMethodHandler(method: string): GatewayMethodHandler | undefined {
    const handler = this.handlers[method as RpcMethod] as
      | Handler<RpcMethod>
      | undefined;
    if (!handler) {
      return undefined;
    }

    return handler as unknown as GatewayMethodHandler;
  }

  webSocketClose(ws: WebSocket) {
    const { mode, clientId, nodeId, channelKey } = ws.deserializeAttachment();
    console.log(
      `[Gateway] WebSocket closed: mode=${mode}, clientId=${clientId}, nodeId=${nodeId}, channelKey=${channelKey}`,
    );
    if (mode === "client" && clientId) {
      // Ignore close events from stale sockets that were replaced by reconnect.
      if (this.clients.get(clientId) !== ws) {
        console.log(`[Gateway] Ignoring stale client close: ${clientId}`);
        return;
      }
      this.clients.delete(clientId);
      // Cleanup persisted client-routed tool calls for this disconnected client.
      for (const [callId, route] of Object.entries(this.pendingToolCalls)) {
        if (
          typeof route === "object" &&
          route.kind === "client" &&
          route.clientId === clientId
        ) {
          delete this.pendingToolCalls[callId];
        }
      }
      for (const [callId, route] of Object.entries(this.pendingLogCalls)) {
        if (typeof route === "object" && route.clientId === clientId) {
          delete this.pendingLogCalls[callId];
        }
      }
    } else if (mode === "node" && nodeId) {
      // Ignore close events from stale sockets that were replaced by reconnect.
      if (this.nodes.get(nodeId) !== ws) {
        console.log(`[Gateway] Ignoring stale node close: ${nodeId}`);
        return;
      }
      this.nodes.delete(nodeId);
      delete this.toolRegistry[nodeId];
      for (const [callId, route] of Object.entries(this.pendingLogCalls)) {
        if (typeof route === "object" && route.nodeId === nodeId) {
          const clientWs = this.clients.get(route.clientId);
          if (clientWs && clientWs.readyState === WebSocket.OPEN) {
            this.sendError(
              clientWs,
              route.frameId,
              503,
              `Node disconnected: ${nodeId}`,
            );
          }
          delete this.pendingLogCalls[callId];
        }
      }
      this.cancelInternalNodeLogRequestsForNode(
        nodeId,
        `Node disconnected during log request: ${nodeId}`,
      );
      this.markPendingNodeProbesAsQueued(
        nodeId,
        `Node disconnected during node probe: ${nodeId}`,
      );
      this.failTransfersForNode(nodeId);
      delete this.nodeRuntimeRegistry[nodeId];
      console.log(`[Gateway] Node ${nodeId} removed from registry`);
    } else if (mode === "channel" && channelKey) {
      // Ignore close events from stale sockets that were replaced by reconnect.
      if (this.channels.get(channelKey) !== ws) {
        console.log(`[Gateway] Ignoring stale channel close: ${channelKey}`);
        return;
      }
      this.channels.delete(channelKey);
      console.log(`[Gateway] Channel ${channelKey} disconnected`);
    }
  }

  async toolRequest(
    params: ToolRequestParams,
  ): Promise<{ ok: boolean; error?: string }> {
    const resolved = this.findNodeForTool(params.tool);
    if (!resolved) {
      return { ok: false, error: `No node provides tool: ${params.tool}` };
    }

    const nodeWs = this.nodes.get(resolved.nodeId);
    if (!nodeWs) {
      return { ok: false, error: "Node not connected" };
    }

    // Track pending call for routing result back
    this.pendingToolCalls[params.callId] = {
      kind: "session",
      sessionKey: params.sessionKey,
    };

    // Send tool.invoke event to node (with un-namespaced tool name)
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

    return { ok: true };
  }

  sendOk(ws: WebSocket, id: string, payload?: unknown) {
    const res: ResponseFrame = { type: "res", id, ok: true, payload };
    ws.send(JSON.stringify(res));
  }

  sendError(ws: WebSocket, id: string, code: number, message: string) {
    this.sendErrorShape(ws, id, { code, message });
  }

  sendErrorShape(ws: WebSocket, id: string, error: ErrorShape) {
    const res: ResponseFrame = {
      type: "res",
      id,
      ok: false,
      error,
    };

    ws.send(JSON.stringify(res));
  }

  private resolveLogLineLimit(input: number | undefined): number {
    if (input === undefined) {
      return DEFAULT_LOG_LINES;
    }
    if (!Number.isFinite(input) || input < 1) {
      throw new Error("lines must be a positive number");
    }
    return Math.min(Math.floor(input), MAX_LOG_LINES);
  }

  private resolveTargetNodeForLogs(nodeId: string | undefined): string {
    if (nodeId) {
      if (!this.nodes.has(nodeId)) {
        throw new Error(`Node not connected: ${nodeId}`);
      }
      return nodeId;
    }

    if (this.nodes.size === 1) {
      return Array.from(this.nodes.keys())[0];
    }

    if (this.nodes.size === 0) {
      throw new Error("No nodes connected");
    }

    throw new Error("nodeId required when multiple nodes are connected");
  }

  async getNodeLogs(
    params?: LogsGetParams & { timeoutMs?: number },
  ): Promise<LogsGetResult> {
    const lines = this.resolveLogLineLimit(params?.lines);
    const nodeId = this.resolveTargetNodeForLogs(params?.nodeId);
    const nodeWs = this.nodes.get(nodeId);
    if (!nodeWs || nodeWs.readyState !== WebSocket.OPEN) {
      throw new Error(`Node not connected: ${nodeId}`);
    }

    const timeoutInput =
      typeof params?.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
        ? Math.floor(params.timeoutMs)
        : DEFAULT_INTERNAL_LOG_TIMEOUT_MS;
    const timeoutMs = Math.max(1000, Math.min(timeoutInput, MAX_INTERNAL_LOG_TIMEOUT_MS));
    const callId = crypto.randomUUID();

    const responsePromise = new Promise<LogsGetResult>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const pending = this.pendingInternalLogCalls.get(callId);
        if (!pending) {
          return;
        }
        this.pendingInternalLogCalls.delete(callId);
        pending.reject(
          new Error(`logs.get timed out for node ${pending.nodeId} after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      this.pendingInternalLogCalls.set(callId, {
        nodeId,
        resolve,
        reject,
        timeoutHandle,
      });
    });

    try {
      const evt: EventFrame<LogsGetEventPayload> = {
        type: "evt",
        event: "logs.get",
        payload: {
          callId,
          lines,
        },
      };
      nodeWs.send(JSON.stringify(evt));
    } catch (error) {
      const pending = this.pendingInternalLogCalls.get(callId);
      if (pending) {
        clearTimeout(pending.timeoutHandle);
        this.pendingInternalLogCalls.delete(callId);
      }
      throw error;
    }

    return await responsePromise;
  }

  resolveInternalNodeLogResult(
    nodeId: string,
    params: LogsResultParams,
  ): boolean {
    const pending = this.pendingInternalLogCalls.get(params.callId);
    if (!pending) {
      return false;
    }

    this.pendingInternalLogCalls.delete(params.callId);
    clearTimeout(pending.timeoutHandle);

    if (pending.nodeId !== nodeId) {
      pending.reject(new Error("Node not authorized for this internal logs call"));
      return true;
    }

    if (params.error) {
      pending.reject(new Error(params.error));
      return true;
    }

    const lines = params.lines ?? [];
    pending.resolve({
      nodeId,
      lines,
      count: lines.length,
      truncated: Boolean(params.truncated),
    });
    return true;
  }

  cancelInternalNodeLogRequestsForNode(nodeId: string, reason: string): void {
    for (const [callId, pending] of this.pendingInternalLogCalls.entries()) {
      if (pending.nodeId !== nodeId) {
        continue;
      }

      clearTimeout(pending.timeoutHandle);
      this.pendingInternalLogCalls.delete(callId);
      pending.reject(new Error(reason));
    }
  }

  private canNodeProbeBins(nodeId: string): boolean {
    return canNodeProbeBinsHandler(this, nodeId);
  }

  private sanitizeSkillBinName(bin: string): string | null {
    return sanitizeSkillBinNameHandler(bin);
  }

  private clampSkillProbeTimeoutMs(timeoutMs?: number): number {
    return clampSkillProbeTimeoutMsHandler(timeoutMs);
  }

  private gcPendingAsyncExecSessions(now = Date.now(), reason?: string): number {
    return gcPendingAsyncExecSessionsHandler(this, now, reason);
  }

  private nextPendingAsyncExecSessionExpiryAtMs(): number | undefined {
    return nextPendingAsyncExecSessionExpiryAtMsHandler(this);
  }

  registerPendingAsyncExecSession(params: {
    nodeId: string;
    sessionId: string;
    sessionKey: string;
    callId: string;
  }): void {
    registerPendingAsyncExecSessionHandler(this, params);
    this.ctx.waitUntil(this.scheduleGatewayAlarm());
  }

  private gcPendingAsyncExecDeliveries(now = Date.now(), reason?: string): number {
    return gcPendingAsyncExecDeliveriesHandler(this, now, reason);
  }

  private nextPendingAsyncExecDeliveryAtMs(now = Date.now()): number | undefined {
    return nextPendingAsyncExecDeliveryAtMsHandler(this, now);
  }

  private gcDeliveredAsyncExecEvents(now = Date.now(), reason?: string): number {
    return gcDeliveredAsyncExecEventsHandler(this, now, reason);
  }

  private nextDeliveredAsyncExecEventGcAtMs(now = Date.now()): number | undefined {
    return nextDeliveredAsyncExecEventGcAtMsHandler(this, now);
  }

  private async deliverPendingAsyncExecDeliveries(now = Date.now()): Promise<number> {
    return deliverPendingAsyncExecDeliveriesHandler(
      this,
      {
        getSessionByName: (sessionKey) => this.env.SESSION.getByName(sessionKey),
      },
      now,
    );
  }

  private queueNodeBinProbe(params: {
    nodeId: string;
    agentId: string;
    bins: string[];
    timeoutMs: number;
  }): { probeId?: string; bins: string[]; dispatched: boolean } {
    return queueNodeBinProbeHandler(this, params);
  }

  markPendingNodeProbesAsQueued(nodeId: string, reason: string): void {
    markPendingNodeProbesAsQueuedHandler(this, nodeId, reason);
  }

  async dispatchPendingNodeProbesForNode(nodeId: string): Promise<number> {
    return dispatchPendingNodeProbesForNodeHandler(this, nodeId, {
      scheduleAlarm: () => this.scheduleGatewayAlarm(),
    });
  }

  private nextPendingNodeProbeExpiryAtMs(): number | undefined {
    return nextPendingNodeProbeExpiryAtMsHandler(this);
  }

  private nextPendingNodeProbeGcAtMs(now = Date.now()): number | undefined {
    return nextPendingNodeProbeGcAtMsHandler(this, now);
  }

  private gcPendingNodeProbes(now = Date.now(), reason?: string): number {
    return gcPendingNodeProbesHandler(this, now, reason);
  }

  private async handlePendingNodeProbeTimeouts(): Promise<void> {
    return handlePendingNodeProbeTimeoutsHandler(this);
  }

  async handleNodeProbeResult(
    nodeId: string,
    params: NodeProbeResultParams,
  ): Promise<{ ok: true; dropped?: true }> {
    return handleNodeProbeResultHandler(this, nodeId, params, {
      scheduleAlarm: () => this.scheduleGatewayAlarm(),
    });
  }

  async handleNodeExecEvent(
    nodeId: string,
    params: NodeExecEventParams,
  ): Promise<{ ok: true; dropped?: true }> {
    return handleNodeExecEventHandler(this, nodeId, params, {
      getSessionByName: (sessionKey) => this.env.SESSION.getByName(sessionKey),
      scheduleAlarm: () => this.scheduleGatewayAlarm(),
    });
  }

  getTransferWs(nodeId: string): WebSocket | undefined {
    return getTransferWsHandler(this, nodeId);
  }

  async transferRequest(
    params: TransferRequestParams,
  ): Promise<{ ok: boolean; error?: string }> {
    return transferRequestHandler(this, params);
  }

  private handleTransferBinaryFrame(_ws: WebSocket, data: ArrayBuffer): void {
    handleTransferBinaryFrameHandler(this, data);
  }

  async streamR2ToDest(transfer: TransferState): Promise<void> {
    return streamR2ToDestHandler(this, transfer);
  }

  async finalizeR2Upload(transfer: TransferState): Promise<void> {
    return finalizeR2UploadHandler(this, transfer);
  }

  completeTransfer(
    transfer: TransferState,
    bytesTransferred: number,
  ): void {
    completeTransferHandler(this, transfer, bytesTransferred);
  }

  failTransfer(transfer: TransferState, error: string): void {
    failTransferHandler(this, transfer, error);
  }

  private failTransfersForNode(nodeId: string): void {
    failTransfersForNodeHandler(this, nodeId);
  }

  /**
   * Find the node for a namespaced tool name.
   * Tool names are formatted as "{nodeId}__{toolName}"
   */
  findNodeForTool(
    namespacedTool: string,
  ): { nodeId: string; toolName: string } | null {
    const separatorIndex = namespacedTool.indexOf("__");
    if (separatorIndex <= 0 || separatorIndex === namespacedTool.length - 2) {
      // Node tools must be explicitly namespaced: "<nodeId>__<toolName>"
      return null;
    }

    const nodeId = namespacedTool.slice(0, separatorIndex);
    const toolName = namespacedTool.slice(separatorIndex + 2); // +2 for '__'

    // Verify node exists and has this tool
    if (!this.nodes.has(nodeId)) {
      return null;
    }

    const hasTooled = this.toolRegistry[nodeId]?.some(
      (t: ToolDefinition) => t.name === toolName,
    );
    if (!hasTooled) {
      return null;
    }

    return { nodeId, toolName };
  }

  getExecutionHostId(): string | null {
    return pickExecutionHostId({
      nodeIds: Array.from(this.nodes.keys()),
      runtimes: this.nodeRuntimeRegistry,
    });
  }

  getSpecializedHostIds(): string[] {
    return listHostsByRole({
      nodeIds: Array.from(this.nodes.keys()),
      runtimes: this.nodeRuntimeRegistry,
      role: "specialized",
    });
  }

  getRuntimeNodeInventory(): RuntimeNodeInventory {
    const nodeIds = Array.from(this.nodes.keys()).sort();
    const hosts = nodeIds.map((nodeId) => {
      const runtime = this.nodeRuntimeRegistry[nodeId];
      const tools = (this.toolRegistry[nodeId] ?? [])
        .map((tool) => tool.name)
        .sort();

      if (!runtime) {
        return {
          nodeId,
          hostRole: "specialized" as const,
          hostCapabilities: [],
          toolCapabilities: {},
          tools,
          hostEnv: [],
          hostBins: [],
        };
      }

      const hostBinStatus = runtime.hostBinStatus
        ? Object.fromEntries(
            Object.entries(runtime.hostBinStatus).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : undefined;
      const hostBins = hostBinStatus
        ? Object.entries(hostBinStatus)
            .filter(([, available]) => available)
            .map(([bin]) => bin)
            .sort()
        : [];

      return {
        nodeId,
        hostRole: runtime.hostRole,
        hostCapabilities: [...runtime.hostCapabilities].sort(),
        toolCapabilities: Object.fromEntries(
          Object.entries(runtime.toolCapabilities)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([toolName, capabilities]) => [
              toolName,
              [...capabilities].sort(),
            ]),
        ),
        tools,
        hostOs: runtime.hostOs,
        hostEnv: runtime.hostEnv ? [...runtime.hostEnv].sort() : [],
        hostBins,
        hostBinStatus,
        hostBinStatusUpdatedAt: runtime.hostBinStatusUpdatedAt,
      };
    });

    return {
      executionHostId: this.getExecutionHostId(),
      specializedHostIds: this.getSpecializedHostIds(),
      hosts,
    };
  }

  async refreshSkillRuntimeFacts(
    agentId: string,
    options?: { force?: boolean; timeoutMs?: number },
  ): Promise<{
    agentId: string;
    refreshedAt: number;
    requiredBins: string[];
    updatedNodeCount: number;
    skippedNodeIds: string[];
    errors: string[];
  }> {
    const normalizedAgentId = normalizeAgentId(agentId || "main");
    const config = this.getFullConfig();
    const workspaceSkills = await listWorkspaceSkills(
      this.env.STORAGE,
      normalizedAgentId,
    );

    const requiredBinsSet = new Set<string>();
    for (const skill of workspaceSkills) {
      const policy = resolveEffectiveSkillPolicy(skill, config.skills.entries);
      if (!policy || policy.always || !policy.requires) {
        continue;
      }
      for (const bin of [...policy.requires.bins, ...policy.requires.anyBins]) {
        const sanitized = this.sanitizeSkillBinName(bin);
        if (sanitized) {
          requiredBinsSet.add(sanitized);
        }
      }
    }

    const requiredBins = Array.from(requiredBinsSet).sort();
    if (requiredBins.length === 0) {
      return {
        agentId: normalizedAgentId,
        refreshedAt: Date.now(),
        requiredBins,
        updatedNodeCount: 0,
        skippedNodeIds: [],
        errors: [],
      };
    }

    const timeoutMs = this.clampSkillProbeTimeoutMs(options?.timeoutMs);
    const now = Date.now();
    let updatedNodeCount = 0;
    const skippedNodeIds: string[] = [];
    const errors: string[] = [];

    for (const nodeId of Array.from(this.nodes.keys()).sort()) {
      const runtime = this.nodeRuntimeRegistry[nodeId];
      if (!runtime) {
        skippedNodeIds.push(nodeId);
        continue;
      }

      if (!this.canNodeProbeBins(nodeId)) {
        skippedNodeIds.push(nodeId);
        continue;
      }

      const existingStatus = runtime.hostBinStatus ?? {};
      const isStale =
        !runtime.hostBinStatusUpdatedAt ||
        now - runtime.hostBinStatusUpdatedAt > SKILL_BIN_STATUS_TTL_MS;
      const binsToProbe =
        options?.force || isStale
          ? requiredBins
          : requiredBins.filter((bin) => !(bin in existingStatus));

      if (binsToProbe.length === 0) {
        continue;
      }

      const probe = this.queueNodeBinProbe({
        nodeId,
        agentId: normalizedAgentId,
        bins: binsToProbe,
        timeoutMs,
      });
      if (probe.bins.length > 0) {
        updatedNodeCount += 1;
      }
    }

    await this.scheduleGatewayAlarm();

    return {
      agentId: normalizedAgentId,
      refreshedAt: Date.now(),
      requiredBins,
      updatedNodeCount,
      skippedNodeIds,
      errors,
    };
  }

  getAllTools(): ToolDefinition[] {
    console.log(`[Gateway] getAllTools called`);
    console.log(
      `[Gateway]   nodes in memory: [${[...this.nodes.keys()].join(", ")}]`,
    );
    console.log(
      `[Gateway]   toolRegistry keys: [${Object.keys(this.toolRegistry).join(", ")}]`,
    );

    // Start with native tools (always available)
    const nativeTools = getNativeToolDefinitions();

    // Add node tools namespaced as {nodeId}__{toolName}
    const nodeTools = Array.from(this.nodes.keys()).flatMap((nodeId) =>
      (this.toolRegistry[nodeId] ?? []).map((tool) => ({
        ...tool,
        name: `${nodeId}__${tool.name}`,
      })),
    );

    const tools = [...nativeTools, ...nodeTools];
    console.log(
      `[Gateway]   returning ${tools.length} tools (${nativeTools.length} native + ${nodeTools.length} node): [${tools.map((t) => t.name).join(", ")}]`,
    );
    return tools;
  }

  private getCronService(): CronService {
    const config = this.getFullConfig();
    const cronConfig = config.cron;
    const maxJobs = Math.max(1, Math.floor(cronConfig.maxJobs));
    const maxRunsPerJobHistory = Math.max(
      1,
      Math.floor(cronConfig.maxRunsPerJobHistory),
    );
    const maxConcurrentRuns = Math.max(
      1,
      Math.floor(cronConfig.maxConcurrentRuns),
    );

    return new CronService({
      store: this.cronStore,
      cronEnabled: cronConfig.enabled,
      maxJobs,
      maxRunsPerJobHistory,
      maxConcurrentRuns,
      mainKey: config.session.mainKey,
      executeSystemEvent: async ({ job, text, sessionKey }) => {
        return await this.executeCronJob({ job, text, sessionKey });
      },
      executeTask: async (params) => {
        return await this.executeCronJob({
          job: params.job,
          text: params.message,
          sessionKey: params.sessionKey,
          deliver: params.deliver,
          channel: params.channel,
          to: params.to,
          bestEffortDeliver: params.bestEffortDeliver,
        });
      },
      logger: console,
    });
  }

  /**
   * Execute a cron job by sending a message to a session with delivery wiring.
   *
   * For both systemEvent (main session) and task (isolated session) modes,
   * this resolves a delivery target from the job's explicit channel/to or
   * from lastActiveContext, and registers pendingChannelResponses so the
   * session's response routes back to the originating channel.
   */
  private async executeCronJob(params: {
    job: CronJob;
    text: string;
    sessionKey: string;
    deliver?: boolean;
    channel?: string;
    to?: string;
    bestEffortDeliver?: boolean;
  }): Promise<{
    status: "ok" | "error" | "skipped";
    error?: string;
    summary?: string;
  }> {
    const runId = crypto.randomUUID();
    const agentId = params.job.agentId;
    const session = this.env.SESSION.getByName(params.sessionKey);

    // Resolve delivery target.
    // If deliver is explicitly false, skip delivery setup.
    // Otherwise, try explicit channel/to from the job spec, then fall back to lastActiveContext.
    let deliveryContext: {
      channel: ChannelId;
      accountId: string;
      peer: PeerInfo;
    } | null = null;

    const shouldDeliver = params.deliver !== false;
    if (shouldDeliver) {
      const lastActive = this.lastActiveContext[agentId];

      if (params.channel && params.to && lastActive) {
        // Explicit channel/to specified — use them with the lastActive accountId
        deliveryContext = JSON.parse(JSON.stringify({
          channel: params.channel,
          accountId: lastActive.accountId,
          peer: { kind: "dm" as const, id: params.to },
        }));
      } else if (params.to && lastActive) {
        // Explicit "to" but no channel — use lastActive channel
        deliveryContext = JSON.parse(JSON.stringify({
          channel: lastActive.channel,
          accountId: lastActive.accountId,
          peer: { kind: "dm" as const, id: params.to },
        }));
      } else if (lastActive) {
        // Fall back to last active context (same as heartbeat does)
        deliveryContext = JSON.parse(JSON.stringify({
          channel: lastActive.channel,
          accountId: lastActive.accountId,
          peer: lastActive.peer,
        }));
      }
    }

    // Register delivery context so broadcastToSession can route the response
    if (deliveryContext) {
      this.pendingChannelResponses[runId] = {
        ...deliveryContext,
        inboundMessageId: `cron:${params.job.id}:${Date.now()}`,
        agentId,
      };
    }

    // Ensure lastActiveContext is set so gsv__Message can resolve defaults
    // (for isolated cron sessions, no channel inbound has ever set this).
    if (deliveryContext) {
      this.lastActiveContext[agentId] = {
        agentId,
        channel: deliveryContext.channel,
        accountId: deliveryContext.accountId,
        peer: deliveryContext.peer,
        sessionKey: params.sessionKey,
        timestamp: Date.now(),
      };
    }

    // Prepend current time context so the agent knows when the cron fired.
    // When delivery is wired, append an instruction so the agent doesn't
    // also use gsv__Message (which would cause duplicate delivery).
    const config = this.getFullConfig();
    const tz = resolveTimezone(config.userTimezone);
    const timePrefix = `[cron · ${formatTimeFull(new Date(), tz)}]`;
    const deliveryNote = deliveryContext
      ? `\n[Your response will be delivered automatically to ${deliveryContext.channel}:${deliveryContext.peer.id} — reply normally, do NOT use gsv__Message for this.]`
      : "";
    const cronMessage = `${timePrefix} ${params.text}${deliveryNote}`;

    try {
      await session.chatSend(
        cronMessage,
        runId,
        JSON.parse(JSON.stringify(this.getAllTools())),
        JSON.parse(JSON.stringify(this.getRuntimeNodeInventory())),
        params.sessionKey,
        undefined, // messageOverrides
        undefined, // media
        deliveryContext
          ? {
              channel: deliveryContext.channel,
              accountId: deliveryContext.accountId,
              peer: {
                kind: deliveryContext.peer.kind,
                id: deliveryContext.peer.id,
                name: deliveryContext.peer.name,
              },
            }
          : undefined,
      );
      return {
        status: "ok",
        summary: `queued to ${params.sessionKey}${deliveryContext ? ` (delivering to ${deliveryContext.channel}:${deliveryContext.peer.id})` : ""}`,
      };
    } catch (error) {
      // Clean up pending context on failure
      if (deliveryContext) {
        delete this.pendingChannelResponses[runId];
      }
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getCronStatus(): Promise<{
    enabled: boolean;
    count: number;
    dueCount: number;
    runningCount: number;
    nextRunAtMs?: number;
    maxJobs: number;
    maxConcurrentRuns: number;
  }> {
    const service = this.getCronService();
    return service.status();
  }

  async listCronJobs(opts?: {
    agentId?: string;
    includeDisabled?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ jobs: CronJob[]; count: number }> {
    return this.getCronService().list(opts);
  }

  async addCronJob(input: CronJobCreate): Promise<CronJob> {
    const job = this.getCronService().add(input);
    await this.scheduleGatewayAlarm();
    return job;
  }

  async updateCronJob(id: string, patch: CronJobPatch): Promise<CronJob> {
    const job = this.getCronService().update(id, patch);
    await this.scheduleGatewayAlarm();
    return job;
  }

  async removeCronJob(id: string): Promise<{ removed: boolean }> {
    const result = this.getCronService().remove(id);
    await this.scheduleGatewayAlarm();
    return result;
  }

  async runCronJobs(opts?: {
    id?: string;
    mode?: "due" | "force";
  }): Promise<{ ran: number; results: CronRunResult[] }> {
    const result = await this.getCronService().run(opts);
    await this.scheduleGatewayAlarm();
    return result;
  }

  async listCronRuns(opts?: {
    jobId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ runs: CronRun[]; count: number }> {
    return this.getCronService().runs(opts);
  }

  async executeCronTool(args: Record<string, unknown>): Promise<unknown> {
    return executeCronToolHandler(this, args);
  }

  async executeMessageTool(
    agentId: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return executeMessageToolHandler(this, agentId, args);
  }

  // ---------------------------------------------------------------------------
  // gsv__SessionsList tool — list active sessions with metadata
  // ---------------------------------------------------------------------------

  async executeSessionsListTool(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return executeSessionsListToolHandler(this, args);
  }

  // ---------------------------------------------------------------------------
  // gsv__SessionSend tool — send a message into another session
  // ---------------------------------------------------------------------------

  async executeSessionSendTool(
    callerAgentId: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return executeSessionSendToolHandler(this, callerAgentId, args);
  }

  /**
   * Get channel service binding by channel ID.
   * Returns undefined if channel is not configured.
   */
  getChannelBinding(
    channel: ChannelId,
  ): (Fetcher & ChannelWorkerInterface) | undefined {
    return getChannelBindingHandler(channel);
  }

  /**
   * Send a response back to a channel via Service Binding RPC.
   * Falls back to WebSocket if channel binding not configured.
   * Fire-and-forget - errors are logged but not propagated.
   */
  sendChannelResponse(
    channel: ChannelId,
    accountId: string,
    peer: PeerInfo,
    replyToId: string,
    text: string,
  ): void {
    sendChannelResponseHandler(
      this,
      channel,
      accountId,
      peer,
      replyToId,
      text,
    );
  }

  /**
   * Send a typing indicator to a channel via Service Binding RPC.
   * Falls back to WebSocket if channel binding not configured.
   * Fire-and-forget - errors are logged but not propagated.
   */
  private sendTypingToChannel(
    channel: ChannelId,
    accountId: string,
    peer: PeerInfo,
    sessionKey: string,
    typing: boolean,
  ): void {
    sendTypingToChannelHandler(
      this,
      channel,
      accountId,
      peer,
      sessionKey,
      typing,
    );
  }

  pendingChannelResponses = PersistedObject<
    Record<
      string,
      {
        channel: ChannelId;
        accountId: string;
        peer: PeerInfo;
        inboundMessageId: string;
        agentId?: string; // For heartbeat deduplication
      }
    >
  >(this.ctx.storage.kv, { prefix: "pendingChannelResponses:" });

  canonicalizeSessionKey(sessionKey: string, agentIdHint?: string): string {
    const config = this.getFullConfig();
    const defaultAgentId = agentIdHint?.trim()
      ? normalizeAgentId(agentIdHint)
      : normalizeAgentId(getDefaultAgentId(config));

    return canonicalizeKey(sessionKey, {
      mainKey: config.session.mainKey,
      dmScope: config.session.dmScope,
      defaultAgentId,
    });
  }

  getConfigPath(path: string): unknown {
    const parts = path.split(".");
    let current: unknown = this.getFullConfig();

    for (const part of parts) {
      if (current && typeof current === "object" && part in current) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  setConfigPath(path: string, value: unknown): void {
    const parts = path.split(".");

    if (parts.length === 1) {
      this.configStore[path] = value;
      return;
    }

    // Handle nested paths like "channels.whatsapp.allowFrom"
    // Get a plain object copy of the config store (PersistedObject proxy can't be cloned)
    const plainConfig = JSON.parse(JSON.stringify(this.configStore)) as Record<
      string,
      unknown
    >;

    // Build up the nested structure
    let current = plainConfig;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const existing = current[part];

      if (typeof existing !== "object" || existing === null) {
        current[part] = {};
      }

      current = current[part] as Record<string, unknown>;
    }

    // Set the final value
    const lastPart = parts[parts.length - 1];
    current[lastPart] = value;

    // Write back the top-level key
    const topLevelKey = parts[0];
    this.configStore[topLevelKey] = plainConfig[topLevelKey];

    // Clean up any flat key that might exist
    delete this.configStore[path];
  }

  getFullConfig(): GsvConfig {
    return mergeConfig(DEFAULT_CONFIG,
      snapshot(this.configStore) as GsvConfigInput,
    );
  }

  getSafeConfig(): GsvConfig {
    const full = this.getFullConfig();
    const apiKeys = Object.fromEntries(
      Object.entries(full.apiKeys).map(([key, value]) => [
        key,
        value ? "***" : undefined,
      ]),
    );
    const auth = {
      ...full.auth,
      token: full.auth.token ? "***" : undefined,
    };
    return {
      ...full,
      apiKeys,
      auth,
    };
  }

  getConfig(): GsvConfig {
    return this.getFullConfig();
  }

  broadcastToSession(sessionKey: string, payload: ChatEventPayload): void {
    const evt: EventFrame<ChatEventPayload> = {
      type: "evt",
      event: "chat",
      payload,
    };
    const message = JSON.stringify(evt);

    for (const ws of this.clients.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }

    // Look up channel context by runId (each message has unique runId)
    const runId = payload.runId;
    if (!runId) {
      // No runId means this is a WebSocket-only client, not a channel
      return;
    }

    const channelContext = this.pendingChannelResponses[runId];
    if (!channelContext) {
      // No channel context - either WebSocket client or context already cleaned up
      return;
    }

    // Handle partial state: route text to channel but keep context for final response
    if (payload.state === "partial" && payload.message) {
      // Route partial text to channel (e.g., "Let me check..." before tool execution)
      this.routeToChannel(sessionKey, channelContext, payload);
      // Don't delete context - we'll need it for the final response
      return;
    }

    // Handle final/error state: route to channel, stop typing, and clean up
    if (payload.state === "final" || payload.state === "error") {
      // Stop typing indicator
      this.sendTypingToChannel(
        channelContext.channel,
        channelContext.accountId,
        channelContext.peer,
        sessionKey,
        false, // typing = false
      );

      // Route the response to the channel
      if (payload.state === "final" && payload.message) {
        this.routeToChannel(sessionKey, channelContext, payload);
      }

      // Clean up context for this runId
      delete this.pendingChannelResponses[runId];
    }
  }

  private routeToChannel(
    sessionKey: string,
    context: PendingChannelResponseContext,
    payload: ChatEventPayload,
  ): void {
    routePayloadToChannel(this, sessionKey, context, payload);
  }

  // ---- Heartbeat System ----

  private resolveHeartbeatAgentIds(config: GsvConfig): string[] {
    const configured = config.agents.list
      .map((agent) => agent.id)
      .filter(Boolean);
    if (configured.length > 0) {
      return configured;
    }
    return [getDefaultAgentId(config)];
  }

  private nextHeartbeatDueAtMs(): number | undefined {
    let next: number | undefined;
    for (const state of Object.values(this.heartbeatState)) {
      const candidate = state?.nextHeartbeatAt ?? undefined;
      if (!candidate) {
        continue;
      }
      if (next === undefined || candidate < next) {
        next = candidate;
      }
    }
    return next;
  }

  private async scheduleGatewayAlarm(): Promise<void> {
    const heartbeatNext = this.nextHeartbeatDueAtMs();
    const cronNext = this.getCronService().nextRunAtMs();
    const probeTimeoutNext = this.nextPendingNodeProbeExpiryAtMs();
    const probeGcNext = this.nextPendingNodeProbeGcAtMs();
    const asyncExecGcNext = this.nextPendingAsyncExecSessionExpiryAtMs();
    const asyncExecDeliveryNext = this.nextPendingAsyncExecDeliveryAtMs();
    const asyncExecDeliveredGcNext = this.nextDeliveredAsyncExecEventGcAtMs();
    let nextAlarm: number | undefined;
    const candidates = [
      heartbeatNext,
      cronNext,
      probeTimeoutNext,
      probeGcNext,
      asyncExecGcNext,
      asyncExecDeliveryNext,
      asyncExecDeliveredGcNext,
    ].filter(
      (value): value is number => typeof value === "number",
    );
    if (candidates.length > 0) {
      nextAlarm = Math.min(...candidates);
    }

    if (nextAlarm === undefined) {
      await this.ctx.storage.deleteAlarm();
      console.log(`[Gateway] Alarm cleared (no heartbeat/cron/probe work scheduled)`);
      return;
    }

    await this.ctx.storage.setAlarm(nextAlarm);
    console.log(
      `[Gateway] Alarm scheduled for ${new Date(nextAlarm).toISOString()} (heartbeat=${heartbeatNext ?? "none"}, cron=${cronNext ?? "none"}, probeTimeouts=${probeTimeoutNext ?? "none"}, probeGc=${probeGcNext ?? "none"}, asyncExecGc=${asyncExecGcNext ?? "none"}, asyncExecDelivery=${asyncExecDeliveryNext ?? "none"}, asyncExecDeliveredGc=${asyncExecDeliveredGcNext ?? "none"})`,
    );
  }

  /**
   * Schedule the next heartbeat alarm
   */
  async scheduleHeartbeat(): Promise<void> {
    const config = this.getFullConfig();
    const activeAgentIds = new Set(this.resolveHeartbeatAgentIds(config));

    for (const existingAgentId of Object.keys(this.heartbeatState)) {
      if (!activeAgentIds.has(existingAgentId)) {
        delete this.heartbeatState[existingAgentId];
      }
    }

    for (const agentId of activeAgentIds) {
      const heartbeatConfig = getHeartbeatConfig(config, agentId);
      const nextTime = getNextHeartbeatTime(heartbeatConfig);

      const state = this.heartbeatState[agentId] ?? {
        agentId,
        nextHeartbeatAt: null,
        lastHeartbeatAt: null,
        lastHeartbeatText: null,
        lastHeartbeatSentAt: null,
      };
      state.nextHeartbeatAt = nextTime;
      this.heartbeatState[agentId] = state;
    }

    await this.scheduleGatewayAlarm();
  }

  /**
   * Handle alarm (heartbeat + cron trigger)
   */
  async alarm(): Promise<void> {
    console.log(`[Gateway] Alarm fired`);

    const config = this.getFullConfig();
    const now = Date.now();

    // Run due heartbeats.
    for (const agentId of Object.keys(this.heartbeatState)) {
      const state = this.heartbeatState[agentId];
      if (!state.nextHeartbeatAt || state.nextHeartbeatAt > now) continue;

      const heartbeatConfig = getHeartbeatConfig(config, agentId);

      // Check active hours
      if (!isWithinActiveHours(heartbeatConfig.activeHours)) {
        console.log(
          `[Gateway] Heartbeat for ${agentId} skipped (outside active hours)`,
        );
        state.nextHeartbeatAt = getNextHeartbeatTime(heartbeatConfig);
        this.heartbeatState[agentId] = state;
        continue;
      }

      // Run heartbeat
      await this.runHeartbeat(agentId, heartbeatConfig, "interval");

      // Schedule next
      state.lastHeartbeatAt = now;
      state.nextHeartbeatAt = getNextHeartbeatTime(heartbeatConfig);
      this.heartbeatState[agentId] = state;
    }

    // Run due cron jobs.
    try {
      const cronResult = await this.runCronJobs({ mode: "due" });
      if (cronResult.ran > 0) {
        console.log(`[Gateway] Alarm executed ${cronResult.ran} due cron jobs`);
      }
    } catch (error) {
      console.error(`[Gateway] Cron due run failed:`, error);
    }

    this.gcPendingNodeProbes(now, "alarm");
    await this.handlePendingNodeProbeTimeouts();
    this.gcPendingAsyncExecSessions(now, "alarm");
    this.gcPendingAsyncExecDeliveries(now, "alarm");
    this.gcDeliveredAsyncExecEvents(now, "alarm");
    await this.deliverPendingAsyncExecDeliveries(now);

    await this.scheduleGatewayAlarm();
  }

  /**
   * Run a heartbeat for an agent
   */
  private async runHeartbeat(
    agentId: string,
    config: HeartbeatConfig,
    reason: "interval" | "manual" | "cron",
  ): Promise<HeartbeatResult> {
    console.log(
      `[Gateway] Running heartbeat for agent ${agentId} (reason: ${reason})`,
    );

    const result: HeartbeatResult = {
      agentId,
      sessionKey: "",
      reason,
      timestamp: Date.now(),
    };

    // Skip check 1: Outside active hours (unless manual trigger)
    if (reason !== "manual" && config.activeHours) {
      const now = new Date();
      if (!isWithinActiveHours(config.activeHours, now)) {
        console.log(
          `[Gateway] Skipping heartbeat for ${agentId}: outside active hours`,
        );
        result.skipped = true;
        result.skipReason = "outside_active_hours";
        return result;
      }
    }

    // Skip check 2: Empty HEARTBEAT.md file (unless manual trigger)
    if (reason !== "manual") {
      const heartbeatFile = await loadHeartbeatFile(this.env.STORAGE, agentId);
      if (
        !heartbeatFile.exists ||
        isHeartbeatFileEmpty(heartbeatFile.content)
      ) {
        console.log(
          `[Gateway] Skipping heartbeat for ${agentId}: HEARTBEAT.md is empty or missing`,
        );
        result.skipped = true;
        result.skipReason = heartbeatFile.exists
          ? "empty_heartbeat_file"
          : "no_heartbeat_file";
        return result;
      }
    }

    // Skip check 3: Session is busy (has messages in queue)
    // Get the target session and check if it's processing
    const lastActive = this.lastActiveContext[agentId];
    if (reason !== "manual" && lastActive) {
      const sessionStub = this.env.SESSION.get(
        this.env.SESSION.idFromName(lastActive.sessionKey),
      );
      const stats = await sessionStub.stats();
      if (stats.isProcessing || stats.queueSize > 0) {
        console.log(
          `[Gateway] Skipping heartbeat for ${agentId}: session is busy (queue: ${stats.queueSize})`,
        );
        result.skipped = true;
        result.skipReason = "session_busy";
        return result;
      }
    }

    // Resolve delivery target from config
    const target = config.target ?? "last";

    // Heartbeats always run in their own internal session.
    // Delivery routing is independent and controlled by target/lastActive context.
    const sessionKey = `agent:${agentId}:heartbeat:system:internal`;
    let deliveryContext: {
      channel: ChannelId;
      accountId: string;
      peer: PeerInfo;
    } | null = null;

    if (target === "none") {
      console.log(`[Gateway] Heartbeat target=none, running silently`);
    } else if (target === "last" && lastActive) {
      // Clone to strip Proxy wrappers from PersistedObject before storing in another PersistedObject
      deliveryContext = JSON.parse(
        JSON.stringify({
          channel: lastActive.channel,
          accountId: lastActive.accountId,
          peer: lastActive.peer,
        }),
      );
      console.log(
        `[Gateway] Heartbeat target=last, delivering to ${lastActive.channel}:${lastActive.peer.id}`,
      );
    } else if (target === "last") {
      console.log(
        `[Gateway] Heartbeat target=last, no last active context, running silently`,
      );
    } else if (target !== "last" && target !== "none") {
      // Specific channel target (e.g., "whatsapp")
      // For now, use last active if channel matches
      if (lastActive && lastActive.channel === target) {
        // Clone to strip Proxy wrappers from PersistedObject before storing in another PersistedObject
        deliveryContext = JSON.parse(
          JSON.stringify({
            channel: lastActive.channel,
            accountId: lastActive.accountId,
            peer: lastActive.peer,
          }),
        );
        console.log(
          `[Gateway] Heartbeat target=${target}, matched last active`,
        );
      } else {
        console.log(
          `[Gateway] Heartbeat target=${target}, no matching context, running silently`,
        );
      }
    }

    // Set sessionKey in result
    result.sessionKey = sessionKey;

    // Get the session DO
    const session = this.env.SESSION.getByName(sessionKey);

    // Send heartbeat prompt
    const runId = crypto.randomUUID();

    // Set up delivery context if we have one (keyed by runId for correct routing)
    if (deliveryContext) {
      this.pendingChannelResponses[runId] = {
        ...deliveryContext,
        inboundMessageId: `heartbeat:${reason}:${Date.now()}`,
        agentId, // For deduplication lookup
      };
    }
    const prompt = config.prompt;
    const tools = JSON.parse(JSON.stringify(this.getAllTools()));
    const runtimeNodes = JSON.parse(
      JSON.stringify(this.getRuntimeNodeInventory()),
    );

    try {
      await session.chatSend(
        prompt,
        runId,
        tools,
        runtimeNodes,
        sessionKey,
        undefined, // messageOverrides
        undefined, // media
        deliveryContext
          ? {
              channel: deliveryContext.channel,
              accountId: deliveryContext.accountId,
              peer: deliveryContext.peer,
            }
          : undefined,
      );
      console.log(`[Gateway] Heartbeat sent to session ${sessionKey}`);
    } catch (e) {
      console.error(`[Gateway] Heartbeat failed for ${agentId}:`, e);
      result.error = e instanceof Error ? e.message : String(e);
      // Clean up pending context on failure (keyed by runId)
      if (deliveryContext) {
        delete this.pendingChannelResponses[runId];
      }
    }

    return result;
  }

  /**
   * Manually trigger a heartbeat for an agent
   */
  async triggerHeartbeat(agentId: string): Promise<{
    ok: boolean;
    message: string;
    skipped?: boolean;
    skipReason?: string;
  }> {
    const config = await this.getConfig();
    const heartbeatConfig = getHeartbeatConfig(config, agentId);

    const result = await this.runHeartbeat(agentId, heartbeatConfig, "manual");

    if (result.skipped) {
      return {
        ok: true,
        message: `Heartbeat skipped for agent ${agentId}: ${result.skipReason}`,
        skipped: true,
        skipReason: result.skipReason,
      };
    }

    if (result.error) {
      return {
        ok: false,
        message: `Heartbeat failed for agent ${agentId}: ${result.error}`,
      };
    }

    return {
      ok: true,
      message: `Heartbeat triggered for agent ${agentId} (session: ${result.sessionKey})`,
    };
  }

  // ─────────────────────────────────────────────────────────
  // RPC Methods (called by GatewayEntrypoint via Service Binding)
  // ─────────────────────────────────────────────────────────

  /**
   * Handle inbound message from channel via RPC (Service Binding).
   * This is the same logic as handleChannelInbound but without WebSocket response.
   */
  async handleChannelInboundRpc(
    params: ChannelInboundParams,
  ): Promise<ChannelInboundRpcResult> {
    return handleChannelInboundRpcHandler(this, params, {
      getSessionStub: (sessionKey) =>
        this.env.SESSION.get(this.env.SESSION.idFromName(sessionKey)),
      workersAi: this.env.AI,
      storage: this.env.STORAGE,
    });
  }

  /**
   * Handle channel status change notification via RPC.
   */
  async handleChannelStatusChanged(
    channelId: string,
    accountId: string,
    status: { connected: boolean; authenticated: boolean; error?: string },
  ): Promise<void> {
    return handleChannelStatusChangedHandler(this, channelId, accountId, status);
  }
}
