import { DurableObject } from "cloudflare:workers";
import type { ChannelWorkerInterface } from "../channel-interface";
import { PersistedObject, snapshot } from "../shared/persisted-object";
import type {
  Frame,
  EventFrame,
  ErrorShape,
  ResponseFrame,
} from "../protocol/frames";
import { isWebSocketRequest, validateFrame } from "../shared/utils";
import { DEFAULT_CONFIG } from "../config/defaults";
import { GsvConfig, GsvConfigInput, mergeConfig, PendingPair } from "../config";
import { getDefaultAgentId } from "../config/parsing";
import {
  HeartbeatState,
  nextHeartbeatDueAtMs as nextHeartbeatDueAtMsHandler,
  runDueHeartbeats as runDueHeartbeatsHandler,
  scheduleHeartbeat as scheduleHeartbeatHandler,
  triggerHeartbeat as triggerHeartbeatHandler,
} from "./heartbeat";
import {
  canonicalizeSessionKey as canonicalizeKey,
  normalizeAgentId,
  normalizeMainKey,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
} from "../session/routing";
import type { TransferRequestParams } from "../protocol/transfer";
import {
  executeCronTool as executeCronToolHandler,
  executeMessageTool as executeMessageToolHandler,
  executeSessionSendTool as executeSessionSendToolHandler,
  executeSessionsListTool as executeSessionsListToolHandler,
} from "./tool-executors";
import { executeCronJob as executeCronJobHandler } from "./cron-execution";
import { GatewayAsyncExecStateService } from "./async-exec";
import {
  handleChannelInboundRpc as handleChannelInboundRpcHandler,
  type ChannelInboundRpcResult,
} from "./channel-inbound";
import { routePayloadToChannel } from "./channel-routing";
import {
  getChannelBinding as getChannelBindingHandler,
  handleChannelStatusChanged as handleChannelStatusChangedHandler,
  sendChannelResponse as sendChannelResponseHandler,
  sendTypingToChannel as sendTypingToChannelHandler,
} from "./channel-transport";
import {
  failTransfersForNode,
  handleTransferBinaryFrame,
  transferRequest as transferRequestHandler,
  GatewayTransferStateService,
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
  LogsGetParams,
  LogsGetResult,
} from "../protocol/logs";
import type { SessionRegistryEntry } from "../protocol/session";
import type {
  RuntimeNodeInventory,
  NodeExecEventParams,
  ToolDefinition,
  ToolRequestParams,
} from "../protocol/tools";
import { GatewayRpcDispatcher } from "./rpc-dispatcher";
import { GatewayNodeService } from "./node-service";

const DEFAULT_INTERNAL_LOG_TIMEOUT_MS = 20_000;
const DEFAULT_PENDING_TOOL_TIMEOUT_MS = 60_000;

type GatewayAlarmParticipant = {
  name: string;
  nextDueMs: number | undefined;
  run: (params: { now: number }) => Promise<void> | void;
};

export class Gateway extends DurableObject<Env> {
  clients: Map<string, WebSocket> = new Map();
  nodes: Map<string, WebSocket> = new Map();
  channels: Map<string, WebSocket> = new Map();
  readonly transferStateService = new GatewayTransferStateService(
    this.ctx.storage.kv,
  );
  readonly asyncExecStateService = new GatewayAsyncExecStateService(
    this.ctx.storage.kv,
    this,
  );
  readonly nodeService = new GatewayNodeService(
    this.ctx.storage.kv,
  );

  readonly configStore = PersistedObject<Record<string, unknown>>(
    this.ctx.storage.kv,
    {
      prefix: "config:",
    },
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
    {
      prefix: "heartbeatState:",
    },
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
  readonly pendingPairs = PersistedObject<Record<string, PendingPair>>(
    this.ctx.storage.kv,
    {
      prefix: "pendingPairs:",
    },
  );

  // Heartbeat scheduler state (persisted to survive DO eviction)
  readonly heartbeatScheduler: { initialized: boolean } = PersistedObject<{
    initialized: boolean;
  }>(this.ctx.storage.kv, {
    prefix: "heartbeatScheduler:",
    defaults: { initialized: false },
  });

  private readonly cronStore = new CronStore(this.ctx.storage.sql);
  private readonly rpcDispatcher = new GatewayRpcDispatcher();

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
      (nodeId) => !this.nodeService.hasRegisteredTools(nodeId),
    );
    for (const nodeId of orphanedNodeIds) {
      const ws = this.nodes.get(nodeId)!;
      this.nodes.delete(nodeId);
      ws.close(4000, "Missing tool registry after rehydration");
      this.nodeService.markNodeDisconnected(nodeId);
      console.log(
        `[Gateway] Evicted orphaned node ${nodeId} (no tools in registry)`,
      );
    }

    const rehydratedAt = Date.now();
    for (const nodeId of Array.from(this.nodes.keys())) {
      this.nodeService.markNodeConnected(nodeId, { connectedAt: rehydratedAt });
    }

    const staleOnlineNodeIds = this.nodeService.listStaleOnlineNodeIds(
      this.nodes.keys(),
    );
    for (const nodeId of staleOnlineNodeIds) {
      this.nodeService.markNodeDisconnected(nodeId, rehydratedAt);
    }
    if (staleOnlineNodeIds.length > 0) {
      console.log(
        `[Gateway] Reconciled ${staleOnlineNodeIds.length} stale node presence entries to offline`,
      );
    }

    const detachedNodeIds = this.nodeService.listDetachedToolNodeIds(
      this.nodes.keys(),
    );
    if (detachedNodeIds.length > 0) {
      console.log(
        `[Gateway] Preserving ${detachedNodeIds.length} detached tool registry entries for known hosts`,
      );
    }
    const detachedRuntimeNodeIds = this.nodeService.listDetachedRuntimeNodeIds(
      this.nodes.keys(),
    );
    if (detachedRuntimeNodeIds.length > 0) {
      console.log(
        `[Gateway] Preserving ${detachedRuntimeNodeIds.length} detached runtime entries for known hosts`,
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
      handleTransferBinaryFrame(this, message as ArrayBuffer);
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
    const requestFrame = frame;
    const outcome = await this.rpcDispatcher.dispatch(this, ws, requestFrame);
    if (outcome.kind === "ignore" || outcome.kind === "deferred") {
      return;
    }

    if (outcome.kind === "ok") {
      this.sendOk(ws, requestFrame.id, outcome.payload);
      return;
    }

    this.sendErrorShape(ws, requestFrame.id, outcome.error);
  }

  failPendingLogCallsForNode(nodeId: string, message?: string): void {
    const failureMessage = message ?? `Node disconnected: ${nodeId}`;
    const failedCalls = this.nodeService.failPendingLogCallsForNode(nodeId);
    for (const failedCall of failedCalls) {
      const clientWs = this.clients.get(failedCall.clientId);
      if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
        continue;
      }
      this.sendError(clientWs, failedCall.frameId, 503, failureMessage);
    }
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
      this.nodeService.cleanupClientPendingOperations(clientId);
    } else if (mode === "node" && nodeId) {
      // Ignore close events from stale sockets that were replaced by reconnect.
      if (this.nodes.get(nodeId) !== ws) {
        console.log(`[Gateway] Ignoring stale node close: ${nodeId}`);
        return;
      }
      this.nodes.delete(nodeId);
      this.nodeService.markNodeDisconnected(nodeId);
      this.failPendingLogCallsForNode(nodeId);
      this.nodeService.cancelInternalNodeLogRequestsForNode(
        nodeId,
        `Node disconnected during log request: ${nodeId}`,
      );
      failTransfersForNode(this, nodeId);
      console.log(`[Gateway] Node ${nodeId} marked offline`);
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
    return this.nodeService.requestToolForSession(params, this.nodes);
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

  async getNodeLogs(
    params?: LogsGetParams & { timeoutMs?: number },
  ): Promise<LogsGetResult> {
    return await this.nodeService.getNodeLogs(this.nodes, params);
  }

  registerPendingAsyncExecSession(params: {
    nodeId: string;
    sessionId: string;
    sessionKey: string;
    callId: string;
  }): void {
    this.asyncExecStateService.registerPendingAsyncExecSession(params);
    this.ctx.waitUntil(this.scheduleGatewayAlarm());
  }

  async handleNodeExecEvent(
    nodeId: string,
    params: NodeExecEventParams,
  ): Promise<{ ok: true; dropped?: true }> {
    return this.asyncExecStateService.handleNodeExecEvent(nodeId, params);
  }

  async transferRequest(
    params: TransferRequestParams,
  ): Promise<{ ok: boolean; error?: string }> {
    return transferRequestHandler(this, params);
  }

  getRuntimeNodeInventory(): RuntimeNodeInventory {
    return this.nodeService.getRuntimeNodeInventory(this.nodes.keys());
  }

  getPendingToolTimeoutMs(): number {
    const config = this.getFullConfig();
    const configured = config.timeouts?.toolMs;
    if (typeof configured === "number" && Number.isFinite(configured)) {
      return Math.max(1_000, Math.floor(configured));
    }
    return DEFAULT_PENDING_TOOL_TIMEOUT_MS;
  }

  getPendingLogTimeoutMs(): number {
    const config = this.getFullConfig();
    const configured = config.timeouts?.toolMs;
    if (typeof configured === "number" && Number.isFinite(configured)) {
      return Math.max(1_000, Math.floor(configured));
    }
    return DEFAULT_INTERNAL_LOG_TIMEOUT_MS;
  }

  private failExpiredPendingOperations(now: number): void {
    const expired = this.nodeService.cleanupExpiredPendingOperations(now);
    for (const expiredTool of expired.toolCalls) {
      if (expiredTool.route.kind !== "client") {
        console.warn(
          `[Gateway] Expired pending tool request (${expiredTool.callId}) for session ${expiredTool.route.sessionKey} without session result`,
        );
        continue;
      }

      const clientWs = this.clients.get(expiredTool.route.clientId);
      if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
        continue;
      }

      this.sendError(
        clientWs,
        expiredTool.route.frameId,
        504,
        "Tool request timed out",
      );
    }

    for (const expiredLog of expired.logCalls) {
      const clientWs = this.clients.get(expiredLog.route.clientId);
      if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
        continue;
      }

      this.sendError(
        clientWs,
        expiredLog.route.frameId,
        504,
        `logs.get timed out after ${this.getPendingLogTimeoutMs()}ms`,
      );
    }
  }

  getAllTools(): ToolDefinition[] {
    console.log(`[Gateway] getAllTools called`);
    console.log(
      `[Gateway]   nodes in memory: [${[...this.nodes.keys()].join(", ")}]`,
    );
    console.log(
      `[Gateway]   toolRegistry keys: [${this.nodeService.listToolRegistryNodeIds().join(", ")}]`,
    );

    const tools = this.nodeService.listTools(this.nodes.keys());
    const nodeTools = tools.filter(
      (tool) => tool.name.includes("__") && !tool.name.startsWith("gsv__"),
    );
    const nativeTools = tools.length - nodeTools.length;
    console.log(
      `[Gateway]   returning ${tools.length} tools (${nativeTools} native + ${nodeTools.length} node): [${tools.map((t) => t.name).join(", ")}]`,
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
        return await executeCronJobHandler(this, { job, text, sessionKey });
      },
      executeTask: async (params) => {
        return await executeCronJobHandler(this, {
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
    sendChannelResponseHandler(this, channel, accountId, peer, replyToId, text);
  }

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
    return mergeConfig(
      DEFAULT_CONFIG,
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

    // Route back to channel for run-scoped responses when available.
    if (!payload.runId) {
      // No runId means this is a WebSocket-only client, not a channel
      return;
    }

    const channelContext = payload.channelContext;
    if (!channelContext) {
      // No channel context - this run originated from WebSocket/client input.
      return;
    }

    // Handle partial state: route text to channel but keep context for final response
    if (payload.state === "partial" && payload.message) {
      // Route partial text to channel (e.g., "Let me check..." before tool execution)
      routePayloadToChannel(this, sessionKey, channelContext, payload);
      // Don't delete context - we'll need it for the final response
      return;
    }

    // Handle final/error state: route to channel, stop typing, and clean up
    if (payload.state === "final" || payload.state === "error") {
      // Stop typing indicator
      sendTypingToChannelHandler(
        this,
        channelContext.channel,
        channelContext.accountId,
        channelContext.peer,
        sessionKey,
        false,
      );

      // Route the response to the channel
      if (payload.state === "final" && payload.message) {
        routePayloadToChannel(this, sessionKey, channelContext, payload);
      }
    }
  }

  // ---- Heartbeat System ----

  private getGatewayAlarmParticipants(
    now: number = Date.now(),
  ): GatewayAlarmParticipant[] {
    return [
      {
        name: "heartbeat",
        nextDueMs: nextHeartbeatDueAtMsHandler(this),
        run: () => runDueHeartbeatsHandler(this, now),
      },
      {
        name: "cron",
        nextDueMs: this.getCronService().nextRunAtMs(),
        run: async () => {
          try {
            const cronResult = await this.runCronJobs({ mode: "due" });
            if (cronResult.ran > 0) {
              console.log(
                `[Gateway] Alarm executed ${cronResult.ran} due cron jobs`,
              );
            }
          } catch (error) {
            console.error(`[Gateway] Cron due run failed:`, error);
          }
        },
      },
      {
        name: "asyncExecGc",
        nextDueMs:
          this.asyncExecStateService.nextPendingAsyncExecSessionExpiryAtMs(),
        run: async (params: { now: number }) => {
          this.asyncExecStateService.gcPendingAsyncExecSessions(
            params.now,
            "alarm",
          );
        },
      },
      {
        name: "asyncExecDeliveryGc",
        nextDueMs:
          this.asyncExecStateService.nextPendingAsyncExecDeliveryAtMs(),
        run: async (params: { now: number }) => {
          this.asyncExecStateService.gcPendingAsyncExecDeliveries(
            params.now,
            "alarm",
          );
        },
      },
      {
        name: "asyncExecDeliveredGc",
        nextDueMs:
          this.asyncExecStateService.nextDeliveredAsyncExecEventGcAtMs(),
        run: async (params: { now: number }) => {
          this.asyncExecStateService.gcDeliveredAsyncExecEvents(
            params.now,
            "alarm",
          );
        },
      },
      {
        name: "pendingOps",
        nextDueMs: this.nodeService.getNextPendingOperationExpirationAtMs(),
        run: async () => {},
      },
      {
        name: "asyncExecDelivery",
        nextDueMs:
          this.asyncExecStateService.nextPendingAsyncExecDeliveryAtMs(),
        run: async (params: { now: number }) => {
          await this.asyncExecStateService.deliverPendingAsyncExecDeliveries(
            params.now,
          );
        },
      },
    ];
  }

  async scheduleGatewayAlarm(): Promise<void> {
    const participants = this.getGatewayAlarmParticipants();
    let nextAlarm: number | undefined;
    const candidates = participants
      .map((participant) => participant.nextDueMs)
      .filter((value): value is number => typeof value === "number");

    if (candidates.length > 0) {
      nextAlarm = Math.min(...candidates);
    }

    if (nextAlarm === undefined) {
      await this.ctx.storage.deleteAlarm();
      console.log(
        `[Gateway] Alarm cleared (no scheduled gateway work)`,
      );
      return;
    }

    await this.ctx.storage.setAlarm(nextAlarm);
    const participantLog = participants
      .map(
        (participant) =>
          `${participant.name}=${participant.nextDueMs ?? "none"}`,
      )
      .join(", ");
    console.log(
      `[Gateway] Alarm scheduled for ${new Date(nextAlarm).toISOString()} (${participantLog})`,
    );
  }

  /**
   * Schedule the next heartbeat alarm
   */
  async scheduleHeartbeat(): Promise<void> {
    return scheduleHeartbeatHandler(this);
  }

  /**
   * Handle alarm (heartbeat + cron trigger)
   */
  async alarm(): Promise<void> {
    console.log(`[Gateway] Alarm fired`);

    const now = Date.now();
    this.failExpiredPendingOperations(now);

    for (const participant of this.getGatewayAlarmParticipants(now)) {
      if (participant.nextDueMs === undefined || participant.nextDueMs > now) {
        continue;
      }
      await participant.run({ now });
    }

    await this.scheduleGatewayAlarm();
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
    return triggerHeartbeatHandler(this, agentId);
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
    return handleChannelInboundRpcHandler(this, params);
  }

  /**
   * Handle channel status change notification via RPC.
   */
  async handleChannelStatusChanged(
    channelId: string,
    accountId: string,
    status: { connected: boolean; authenticated: boolean; error?: string },
  ): Promise<void> {
    return handleChannelStatusChangedHandler(
      this,
      channelId,
      accountId,
      status,
    );
  }
}
