import { DurableObject, env } from "cloudflare:workers";
import { PersistedObject, snapshot } from "../shared/persisted-object";
import type {
  Frame,
  EventFrame,
  ErrorShape,
  RequestFrame,
  ResponseFrame,
} from "../protocol/frames";
import type {
  ChannelWorkerInterface,
  ChannelOutboundMessage,
  ChannelPeer,
} from "../channel-interface";
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
import {
  resolveAgentIdFromBinding,
  getDefaultAgentId,
  isAllowedSender,
  normalizeE164,
  resolveLinkedIdentity,
} from "../config/parsing";
import {
  HeartbeatState,
  getHeartbeatConfig,
  getNextHeartbeatTime,
  isWithinActiveHours,
  shouldDeliverResponse,
  HeartbeatResult,
} from "./heartbeat";
import { loadHeartbeatFile, isHeartbeatFileEmpty } from "../agents/loader";
import {
  buildAgentSessionKey,
  canonicalizeMainSessionAlias,
  normalizeAgentId,
  normalizeMainKey,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
} from "../session/routing";
import {
  parseCommand,
  HELP_TEXT,
  normalizeThinkLevel,
  MODEL_SELECTOR_HELP,
  parseModelSelection,
} from "./commands";
import {
  parseDirectives,
  isDirectiveOnly,
  formatDirectiveAck,
} from "./directives";
import { processMediaWithTranscription } from "../transcription";
import { processInboundMedia } from "../storage/media";
import { getNativeToolDefinitions } from "../agents/tools";
import { listHostsByRole, pickExecutionHostId } from "./capabilities";
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
  ChannelOutboundPayload,
  ChannelTypingPayload,
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
  NodeRuntimeInfo,
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

const DEFAULT_LOG_LINES = 100;
const MAX_LOG_LINES = 5000;
const DEFAULT_INTERNAL_LOG_TIMEOUT_MS = 20_000;
const MAX_INTERNAL_LOG_TIMEOUT_MS = 120_000;

type GatewayMethodHandlerContext = {
  gw: Gateway;
  ws: WebSocket;
  frame: RequestFrame;
  params: unknown;
};

type GatewayMethodHandler = (
  ctx: GatewayMethodHandlerContext,
) => Promise<unknown | DeferredResponse> | unknown | DeferredResponse;

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function asMode(value: unknown): "due" | "force" | undefined {
  if (value === "due" || value === "force") {
    return value;
  }
  return undefined;
}

export class Gateway extends DurableObject<Env> {
  clients: Map<string, WebSocket> = new Map();
  nodes: Map<string, WebSocket> = new Map();
  channels: Map<string, WebSocket> = new Map();

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
    if (typeof message !== "string") return;
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

  /**
   * Handle a slash command for chat.send (no channel context)
   */
  async handleSlashCommandForChat(
    command: { name: string; args: string },
    sessionKey: string,
  ): Promise<{ handled: boolean; response?: string; error?: string }> {
    const sessionStub = env.SESSION.getByName(sessionKey);

    try {
      switch (command.name) {
        case "reset": {
          const result = await sessionStub.reset();
          return {
            handled: true,
            response: `Session reset. Archived ${result.archivedMessages} messages.`,
          };
        }

        case "compact": {
          const keepCount = command.args ? parseInt(command.args, 10) : 20;
          if (isNaN(keepCount) || keepCount < 1) {
            return {
              handled: true,
              error: "Invalid count. Usage: /compact [N]",
            };
          }
          const result = await sessionStub.compact(keepCount);
          return {
            handled: true,
            response: `Compacted session. Kept ${result.keptMessages} messages, archived ${result.trimmedMessages}.`,
          };
        }

        case "stop": {
          const result = await sessionStub.abort();
          if (result.wasRunning) {
            return {
              handled: true,
              response: `Stopped run ${result.runId}${result.pendingToolsCancelled > 0 ? `, cancelled ${result.pendingToolsCancelled} pending tool(s)` : ""}.`,
            };
          } else {
            return {
              handled: true,
              response: "No run in progress.",
            };
          }
        }

        case "status": {
          const info = await sessionStub.get();
          const stats = await sessionStub.stats();
          const config = this.getFullConfig();

          const lines = [
            `Session: ${sessionKey}`,
            `Messages: ${info.messageCount}`,
            `Tokens: ${stats.tokens.input} in / ${stats.tokens.output} out`,
            `Model: ${config.model.provider}/${config.model.id}`,
            info.settings.thinkingLevel
              ? `Thinking: ${info.settings.thinkingLevel}`
              : null,
            info.resetPolicy ? `Reset: ${info.resetPolicy.mode}` : null,
          ].filter(Boolean);

          return { handled: true, response: lines.join("\n") };
        }

        case "model": {
          const info = await sessionStub.get();
          const config = this.getFullConfig();
          const effectiveModel = info.settings.model || config.model;

          if (!command.args) {
            return {
              handled: true,
              response: `Current model: ${effectiveModel.provider}/${effectiveModel.id}\n${MODEL_SELECTOR_HELP}`,
            };
          }

          const resolved = parseModelSelection(
            command.args,
            effectiveModel.provider,
          );
          if (!resolved) {
            return {
              handled: true,
              error: `Invalid model selector: ${command.args}\n${MODEL_SELECTOR_HELP}`,
            };
          }

          await sessionStub.patch({ settings: { model: resolved } });
          return {
            handled: true,
            response: `Model set to ${resolved.provider}/${resolved.id}`,
          };
        }

        case "think": {
          if (!command.args) {
            const info = await sessionStub.get();
            return {
              handled: true,
              response: `Thinking level: ${info.settings.thinkingLevel || "off"}\nLevels: off, minimal, low, medium, high, xhigh`,
            };
          }

          const level = normalizeThinkLevel(command.args);
          if (!level) {
            return {
              handled: true,
              error: `Invalid level: ${command.args}\nLevels: off, minimal, low, medium, high, xhigh`,
            };
          }

          await sessionStub.patch({ settings: { thinkingLevel: level } });
          return {
            handled: true,
            response: `Thinking level set to ${level}`,
          };
        }

        case "help": {
          return { handled: true, response: HELP_TEXT };
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return { handled: true, error: `Command failed: ${e}` };
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
        };
      }

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
      };
    });

    return {
      executionHostId: this.getExecutionHostId(),
      specializedHostIds: this.getSpecializedHostIds(),
      hosts,
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
      executeMainJob: async ({ job, text, sessionKey }) => {
        return await this.executeCronMainJob({ job, text, sessionKey });
      },
      logger: console,
    });
  }

  private async executeCronMainJob(params: {
    job: CronJob;
    text: string;
    sessionKey: string;
  }): Promise<{
    status: "ok" | "error" | "skipped";
    error?: string;
    summary?: string;
  }> {
    const runId = crypto.randomUUID();
    const session = this.env.SESSION.getByName(params.sessionKey);

    try {
      await session.chatSend(
        params.text,
        runId,
        JSON.parse(JSON.stringify(this.getAllTools())),
        JSON.parse(JSON.stringify(this.getRuntimeNodeInventory())),
        params.sessionKey,
      );
      return {
        status: "ok",
        summary: `queued to ${params.sessionKey}`,
      };
    } catch (error) {
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
    const actionRaw = typeof args.action === "string" ? args.action : "status";
    const action = actionRaw.trim().toLowerCase();

    switch (action) {
      case "status":
        return await this.getCronStatus();
      case "list":
        return await this.listCronJobs({
          agentId: asString(args.agentId),
          includeDisabled:
            typeof args.includeDisabled === "boolean"
              ? args.includeDisabled
              : undefined,
          limit: asNumber(args.limit),
          offset: asNumber(args.offset),
        });
      case "add": {
        const jobInput = asObject(args.job) ?? args;
        if (!jobInput || typeof jobInput !== "object") {
          throw new Error("cron add requires a job object");
        }
        const ji = jobInput as Record<string, unknown>;
        if (!ji.name || !ji.schedule || !ji.payload) {
          throw new Error("cron add requires name, schedule, and payload");
        }
        const job = await this.addCronJob(jobInput as unknown as CronJobCreate);
        return { ok: true, job };
      }
      case "update": {
        const id = asString(args.id);
        if (!id) {
          throw new Error("cron update requires id");
        }
        const patch = asObject(args.patch);
        if (!patch) {
          throw new Error("cron update requires patch object");
        }
        const job = await this.updateCronJob(
          id,
          patch as unknown as CronJobPatch,
        );
        return { ok: true, job };
      }
      case "remove": {
        const id = asString(args.id);
        if (!id) {
          throw new Error("cron remove requires id");
        }
        const result = await this.removeCronJob(id);
        return { ok: true, removed: result.removed };
      }
      case "run":
        return {
          ok: true,
          ...(await this.runCronJobs({
            id: asString(args.id),
            mode: asMode(args.mode),
          })),
        };
      case "runs":
        return await this.listCronRuns({
          jobId: asString(args.jobId),
          limit: asNumber(args.limit),
          offset: asNumber(args.offset),
        });
      default:
        throw new Error(`Unknown cron action: ${action}`);
    }
  }

  /**
   * Handle a slash command and return the result
   */
  private async handleSlashCommand(
    command: { name: string; args: string },
    sessionKey: string,
    channel: ChannelId,
    accountId: string,
    peer: PeerInfo,
    messageId: string,
  ): Promise<{ handled: boolean; response?: string; error?: string }> {
    const sessionStub = env.SESSION.getByName(sessionKey);

    try {
      switch (command.name) {
        case "reset": {
          const result = await sessionStub.reset();
          return {
            handled: true,
            response: `Session reset. Archived ${result.archivedMessages} messages.`,
          };
        }

        case "compact": {
          const keepCount = command.args ? parseInt(command.args, 10) : 20;
          if (isNaN(keepCount) || keepCount < 1) {
            return {
              handled: true,
              error: "Invalid count. Usage: /compact [N]",
            };
          }
          const result = await sessionStub.compact(keepCount);
          return {
            handled: true,
            response: `Compacted session. Kept ${result.keptMessages} messages, archived ${result.trimmedMessages}.`,
          };
        }

        case "stop": {
          const result = await sessionStub.abort();
          if (result.wasRunning) {
            return {
              handled: true,
              response: `Stopped run \`${result.runId}\`${result.pendingToolsCancelled > 0 ? `, cancelled ${result.pendingToolsCancelled} pending tool(s)` : ""}.`,
            };
          } else {
            return {
              handled: true,
              response: "No run in progress.",
            };
          }
        }

        case "status": {
          const info = await sessionStub.get();
          const stats = await sessionStub.stats();
          const config = this.getFullConfig();

          const lines = [
            `**Session Status**`,
            `• Session: \`${sessionKey}\``,
            `• Messages: ${info.messageCount}`,
            `• Tokens: ${stats.tokens.input} in / ${stats.tokens.output} out`,
            `• Model: ${config.model.provider}/${config.model.id}`,
            info.settings.thinkingLevel
              ? `• Thinking: ${info.settings.thinkingLevel}`
              : null,
            info.resetPolicy ? `• Reset: ${info.resetPolicy.mode}` : null,
          ].filter(Boolean);

          return { handled: true, response: lines.join("\n") };
        }

        case "model": {
          const info = await sessionStub.get();
          const config = this.getFullConfig();
          const effectiveModel = info.settings.model || config.model;

          if (!command.args) {
            return {
              handled: true,
              response: `Current model: ${effectiveModel.provider}/${effectiveModel.id}\n\n${MODEL_SELECTOR_HELP}`,
            };
          }

          const resolved = parseModelSelection(
            command.args,
            effectiveModel.provider,
          );
          if (!resolved) {
            return {
              handled: true,
              error: `Invalid model selector: ${command.args}\n\n${MODEL_SELECTOR_HELP}`,
            };
          }

          await sessionStub.patch({ settings: { model: resolved } });
          return {
            handled: true,
            response: `Model set to ${resolved.provider}/${resolved.id}`,
          };
        }

        case "think": {
          if (!command.args) {
            const info = await sessionStub.get();
            return {
              handled: true,
              response: `Thinking level: ${info.settings.thinkingLevel || "off"}\n\nLevels: off, minimal, low, medium, high, xhigh`,
            };
          }

          const level = normalizeThinkLevel(command.args);
          if (!level) {
            return {
              handled: true,
              error: `Invalid level: ${command.args}\n\nLevels: off, minimal, low, medium, high, xhigh`,
            };
          }

          await sessionStub.patch({ settings: { thinkingLevel: level } });
          return {
            handled: true,
            response: `Thinking level set to ${level}`,
          };
        }

        case "help": {
          return { handled: true, response: HELP_TEXT };
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return { handled: true, error: `Command failed: ${e}` };
    }
  }

  /**
   * Get channel service binding by channel ID.
   * Returns undefined if channel is not configured.
   */
  getChannelBinding(
    channel: ChannelId,
  ): (Fetcher & ChannelWorkerInterface) | undefined {
    // Map channel IDs to service bindings
    // Add new channels here as they're configured
    switch (channel) {
      case "whatsapp":
        return (env as any).CHANNEL_WHATSAPP as Fetcher &
          ChannelWorkerInterface;
      case "discord":
        return (env as any).CHANNEL_DISCORD as Fetcher & ChannelWorkerInterface;
      case "test":
        return (env as any).CHANNEL_TEST as Fetcher & ChannelWorkerInterface;
      default:
        return undefined;
    }
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
    // Try Service Binding RPC first (fire-and-forget)
    const channelBinding = this.getChannelBinding(channel);
    if (channelBinding) {
      const message: ChannelOutboundMessage = {
        peer: peer as ChannelPeer,
        text,
        replyToId,
      };
      channelBinding
        .send(accountId, message)
        .then((result) => {
          if (!result.ok) {
            console.error(`[Gateway] Channel RPC send failed: ${result.error}`);
          }
        })
        .catch((e) => {
          console.error(`[Gateway] Channel RPC error:`, e);
          // Could implement WebSocket fallback here if needed
        });
      return;
    }

    // WebSocket fallback (for backwards compatibility during migration)
    const channelKey = `${channel}:${accountId}`;
    const channelWs = this.channels.get(channelKey);

    if (!channelWs || channelWs.readyState !== WebSocket.OPEN) {
      console.log(
        `[Gateway] Channel ${channelKey} not connected for command response`,
      );
      return;
    }

    const outbound: ChannelOutboundPayload = {
      channel,
      accountId,
      peer,
      sessionKey: "",
      message: {
        text,
        replyToId,
      },
    };

    const evt: EventFrame<ChannelOutboundPayload> = {
      type: "evt",
      event: "channel.outbound",
      payload: outbound,
    };

    channelWs.send(JSON.stringify(evt));
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
    // Try Service Binding RPC first (fire-and-forget)
    const channelBinding = this.getChannelBinding(channel);
    if (channelBinding?.setTyping) {
      channelBinding
        .setTyping(accountId, peer as ChannelPeer, typing)
        .then(() => {
          console.log(
            `[Gateway] Sent typing=${typing} via RPC to ${channel}:${accountId}`,
          );
        })
        .catch((e) => {
          console.error(`[Gateway] Channel typing RPC error:`, e);
        });
      return;
    }

    // WebSocket fallback
    const channelKey = `${channel}:${accountId}`;
    const channelWs = this.channels.get(channelKey);

    if (!channelWs || channelWs.readyState !== WebSocket.OPEN) {
      return;
    }

    const payload: ChannelTypingPayload = {
      channel,
      accountId,
      peer,
      sessionKey,
      typing,
    };

    const evt: EventFrame<ChannelTypingPayload> = {
      type: "evt",
      event: "channel.typing",
      payload,
    };

    channelWs.send(JSON.stringify(evt));
    console.log(
      `[Gateway] Sent typing=${typing} to ${channelKey} for ${peer.id}`,
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
    const raw = sessionKey.trim();
    if (!raw) {
      return raw;
    }

    const config = this.getFullConfig();
    const defaultAgentId = agentIdHint?.trim()
      ? normalizeAgentId(agentIdHint)
      : normalizeAgentId(getDefaultAgentId(config));

    if (!raw.startsWith("agent:")) {
      if (raw === "main" || raw === normalizeMainKey(config.session.mainKey)) {
        return resolveAgentMainSessionKey({
          agentId: defaultAgentId,
          mainKey: config.session.mainKey,
        });
      }
      return raw;
    }

    const agentId = resolveAgentIdFromSessionKey(raw, defaultAgentId);
    return canonicalizeMainSessionAlias({
      agentId,
      sessionKey: raw,
      mainKey: config.session.mainKey,
    });
  }

  private buildSessionKeyFromChannel(
    agentId: string,
    channel: ChannelId,
    accountId: string,
    peer: PeerInfo,
    senderId?: string,
  ): string {
    const config = this.getFullConfig();

    // Check for identity link - use senderId if provided (for groups), otherwise peer.id
    const idToCheck = senderId || peer.id;
    const linkedIdentity = resolveLinkedIdentity(config, channel, idToCheck);

    if (linkedIdentity) {
      console.log(`[Gateway] Identity link: ${idToCheck} -> ${linkedIdentity}`);
    }

    return buildAgentSessionKey({
      agentId,
      channel,
      accountId,
      peer,
      dmScope: config.session.dmScope,
      mainKey: config.session.mainKey,
      linkedIdentity,
    });
  }

  /**
   * Find a connected channel WebSocket for a given channel type
   */
  findChannelForMessage(channel: string): string | null {
    for (const [channelKey, ws] of this.channels.entries()) {
      if (
        channelKey.startsWith(`${channel}:`) &&
        ws.readyState === WebSocket.OPEN
      ) {
        return channelKey;
      }
    }
    return null;
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
    context: {
      channel: ChannelId;
      accountId: string;
      peer: PeerInfo;
      inboundMessageId: string;
      agentId?: string;
    },
    payload: ChatEventPayload,
  ): void {
    // Extract text from response
    let text = "";
    const msg = payload.message as { content?: unknown } | undefined;
    if (msg?.content) {
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (typeof block === "object" && block && "type" in block) {
            if (
              (block as { type: string }).type === "text" &&
              "text" in block
            ) {
              text += (block as { text: string }).text;
            }
          }
        }
      }
    }

    if (!text) {
      console.log(`[Gateway] No text content in response for ${sessionKey}`);
      return;
    }

    // Check if this is a heartbeat response (inboundMessageId starts with "heartbeat:")
    const isHeartbeat = context.inboundMessageId.startsWith("heartbeat:");

    if (isHeartbeat) {
      const { deliver, cleanedText } = shouldDeliverResponse(text);

      if (!deliver) {
        console.log(
          `[Gateway] Heartbeat response suppressed (HEARTBEAT_OK or short ack)`,
        );
        return;
      }

      // Use cleaned text (HEARTBEAT_OK stripped)
      text = cleanedText || text;

      // Deduplication: Skip if same text was sent within 24 hours
      const agentId = context.agentId;
      if (agentId) {
        const state = this.heartbeatState[agentId];
        const now = Date.now();
        const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

        if (
          state?.lastHeartbeatText &&
          state?.lastHeartbeatSentAt &&
          state.lastHeartbeatText.trim() === text.trim() &&
          now - state.lastHeartbeatSentAt < DEDUP_WINDOW_MS
        ) {
          console.log(
            `[Gateway] Heartbeat response deduplicated for ${agentId} (same text within 24h)`,
          );
          return;
        }

        // Update state with this response (will be delivered)
        this.heartbeatState[agentId] = {
          ...state,
          agentId,
          lastHeartbeatText: text.trim(),
          lastHeartbeatSentAt: now,
          nextHeartbeatAt: state?.nextHeartbeatAt ?? null,
          lastHeartbeatAt: state?.lastHeartbeatAt ?? null,
        };
      }
    }

    const replyToId = isHeartbeat ? undefined : context.inboundMessageId;

    // Try Service Binding RPC first (preferred for queue-based channels like Discord)
    const channelBinding = this.getChannelBinding(context.channel);

    if (channelBinding) {
      // Clone the message to ensure it's a plain object (not a proxy)
      // This is necessary for Service Binding RPC serialization
      const message: ChannelOutboundMessage = JSON.parse(
        JSON.stringify({
          peer: {
            kind: context.peer.kind,
            id: context.peer.id,
            name: context.peer.name,
          },
          text,
          replyToId,
        }),
      );
      channelBinding
        .send(context.accountId, message)
        .then((result) => {
          if (result.ok) {
            console.log(
              `[Gateway] Routed response via RPC to ${context.channel}:${context.accountId}${isHeartbeat ? " (heartbeat)" : ""}`,
            );
          } else {
            console.error(`[Gateway] Channel RPC send failed: ${result.error}`);
          }
        })
        .catch((e) => {
          console.error(`[Gateway] Channel RPC error:`, e);
        });
      return;
    }

    // WebSocket fallback (for channels that connect via WebSocket)
    const channelKey = `${context.channel}:${context.accountId}`;
    const channelWs = this.channels.get(channelKey);

    if (!channelWs || channelWs.readyState !== WebSocket.OPEN) {
      console.log(
        `[Gateway] Channel ${channelKey} not connected for outbound (no RPC binding, no WebSocket)`,
      );
      return;
    }

    const outbound: ChannelOutboundPayload = {
      channel: context.channel,
      accountId: context.accountId,
      peer: context.peer,
      sessionKey,
      message: {
        text,
        replyToId,
      },
    };

    const evt: EventFrame<ChannelOutboundPayload> = {
      type: "evt",
      event: "channel.outbound",
      payload: outbound,
    };

    channelWs.send(JSON.stringify(evt));
    console.log(
      `[Gateway] Routed response to channel ${channelKey}${isHeartbeat ? " (heartbeat)" : ""}`,
    );
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
    let nextAlarm: number | undefined;

    if (heartbeatNext !== undefined && cronNext !== undefined) {
      nextAlarm = Math.min(heartbeatNext, cronNext);
    } else {
      nextAlarm = heartbeatNext ?? cronNext;
    }

    if (nextAlarm === undefined) {
      await this.ctx.storage.deleteAlarm();
      console.log(`[Gateway] Alarm cleared (no heartbeat/cron work scheduled)`);
      return;
    }

    await this.ctx.storage.setAlarm(nextAlarm);
    console.log(
      `[Gateway] Alarm scheduled for ${new Date(nextAlarm).toISOString()} (heartbeat=${heartbeatNext ?? "none"}, cron=${cronNext ?? "none"})`,
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
      await session.chatSend(prompt, runId, tools, runtimeNodes, sessionKey);
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

  /**
   * Get heartbeat status for all agents
   */
  async getHeartbeatStatus(): Promise<
    Record<
      string,
      HeartbeatState & {
        lastActive?: {
          channel: ChannelId;
          accountId: string;
          peer: PeerInfo;
          timestamp: number;
        };
      }
    >
  > {
    const result: Record<
      string,
      HeartbeatState & {
        lastActive?: {
          channel: ChannelId;
          accountId: string;
          peer: PeerInfo;
          timestamp: number;
        };
      }
    > = {};

    // Merge heartbeat state with last active context
    for (const [agentId, state] of Object.entries(this.heartbeatState)) {
      const lastActive = this.lastActiveContext[agentId];
      result[agentId] = {
        ...state,
        lastActive: lastActive
          ? {
              channel: lastActive.channel,
              accountId: lastActive.accountId,
              peer: lastActive.peer,
              timestamp: lastActive.timestamp,
            }
          : undefined,
      };
    }

    // Also include agents with lastActive but no heartbeat state yet
    for (const [agentId, context] of Object.entries(this.lastActiveContext)) {
      if (!result[agentId]) {
        result[agentId] = {
          agentId,
          nextHeartbeatAt: null,
          lastHeartbeatAt: null,
          lastHeartbeatText: null,
          lastHeartbeatSentAt: null,
          lastActive: {
            channel: context.channel,
            accountId: context.accountId,
            peer: context.peer,
            timestamp: context.timestamp,
          },
        };
      }
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────
  // RPC Methods (called by GatewayEntrypoint via Service Binding)
  // ─────────────────────────────────────────────────────────

  /**
   * Handle inbound message from channel via RPC (Service Binding).
   * This is the same logic as handleChannelInbound but without WebSocket response.
   */
  async handleChannelInboundRpc(params: ChannelInboundParams): Promise<{
    ok: boolean;
    sessionKey?: string;
    status?: string;
    error?: string;
    [key: string]: unknown;
  }> {
    if (
      !params?.channel ||
      !params?.accountId ||
      !params?.peer ||
      !params?.message
    ) {
      return {
        ok: false,
        error: "channel, accountId, peer, and message required",
      };
    }

    const config = this.getConfig();

    // Check allowlist
    const senderId = params.sender?.id ?? params.peer.id;
    const senderName = params.sender?.name ?? params.peer.name;
    const allowCheck = isAllowedSender(
      config,
      params.channel,
      senderId,
      params.peer.id,
    );

    if (!allowCheck.allowed) {
      if (allowCheck.needsPairing) {
        const pairKey = `${params.channel}:${normalizeE164(senderId)}`;
        if (!this.pendingPairs[pairKey]) {
          this.pendingPairs[pairKey] = {
            channel: params.channel,
            senderId: normalizeE164(senderId),
            senderName: senderName,
            requestedAt: Date.now(),
            firstMessage: params.message.text?.slice(0, 200),
          };
          console.log(
            `[Gateway] New pairing request from ${senderId} (${senderName})`,
          );

          // Send "pending approval" message back via channel
          this.sendChannelResponse(
            params.channel,
            params.accountId,
            params.peer,
            params.message.id,
            "Your message has been received. Awaiting approval from the owner.",
          );
        }
        return {
          ok: true,
          status: "pending_pairing",
          senderId: normalizeE164(senderId),
        };
      }

      console.log(
        `[Gateway] Blocked message from ${senderId}: ${allowCheck.reason}`,
      );
      return {
        ok: true,
        status: "blocked",
        reason: allowCheck.reason,
      };
    }

    // Build session key
    const agentId = resolveAgentIdFromBinding(
      config,
      params.channel,
      params.accountId,
      params.peer,
    );
    const sessionKey = this.buildSessionKeyFromChannel(
      agentId,
      params.channel,
      params.accountId,
      params.peer,
      senderId,
    );

    // Update channel registry
    const channelKey = `${params.channel}:${params.accountId}`;
    const existing = this.channelRegistry[channelKey];
    if (existing) {
      this.channelRegistry[channelKey] = {
        ...existing,
        lastMessageAt: Date.now(),
      };
    }

    const messageText = params.message.text;

    // Check for slash commands
    const command = parseCommand(messageText);
    if (command) {
      const commandResult = await this.handleSlashCommand(
        command,
        sessionKey,
        params.channel,
        params.accountId,
        params.peer,
        params.message.id,
      );

      if (commandResult.handled) {
        // Send response via channel outbound
        this.sendChannelResponse(
          params.channel,
          params.accountId,
          params.peer,
          params.message.id,
          commandResult.response || commandResult.error || "Command executed",
        );
        return {
          ok: true,
          sessionKey,
          status: "command",
          command: command.name,
          response: commandResult.response,
        };
      }
    }

    const fullConfig = this.getFullConfig();
    const sessionStub = this.env.SESSION.get(
      this.env.SESSION.idFromName(sessionKey),
    );

    // Parse directives. For provider-less model selectors (e.g. /m:o3),
    // resolve against the session's current provider, not the global default.
    let directives = parseDirectives(messageText);
    const needsProviderFallback =
      directives.hasModelDirective &&
      !directives.model &&
      !!directives.rawModelDirective &&
      !directives.rawModelDirective.includes("/");

    if (needsProviderFallback) {
      try {
        const info = await sessionStub.get();
        const fallbackProvider =
          info.settings.model?.provider || fullConfig.model.provider;
        directives = parseDirectives(messageText, fallbackProvider);
      } catch (e) {
        console.warn(
          `[Gateway] Failed to resolve session model provider for ${sessionKey}, using global default:`,
          e,
        );
        directives = parseDirectives(messageText, fullConfig.model.provider);
      }
    }

    if (isDirectiveOnly(messageText)) {
      const ack = formatDirectiveAck(directives);
      if (ack) {
        this.sendChannelResponse(
          params.channel,
          params.accountId,
          params.peer,
          params.message.id,
          ack,
        );
      }
      return {
        ok: true,
        sessionKey,
        status: "directive-only",
        directives: {
          thinkLevel: directives.thinkLevel,
          model: directives.model,
        },
      };
    }

    // Update session registry
    const now = Date.now();
    const existingSession = this.sessionRegistry[sessionKey];
    this.sessionRegistry[sessionKey] = {
      sessionKey,
      createdAt: existingSession?.createdAt ?? now,
      lastActiveAt: now,
      label: existingSession?.label ?? params.peer.name,
    };

    // Generate runId before try block so it's accessible in catch for cleanup
    const runId = crypto.randomUUID();

    try {
      const messageOverrides: {
        thinkLevel?: string;
        model?: { provider: string; id: string };
      } = {};
      if (directives.thinkLevel)
        messageOverrides.thinkLevel = directives.thinkLevel;
      if (directives.model) messageOverrides.model = directives.model;

      // Process media
      let processedMedia = await processMediaWithTranscription(
        params.message.media,
        {
          workersAi: this.env.AI,
          openaiApiKey: fullConfig.apiKeys.openai,
          preferredProvider: fullConfig.transcription.provider,
        },
      );

      if (processedMedia.length > 0) {
        processedMedia = await processInboundMedia(
          processedMedia,
          this.env.STORAGE,
          sessionKey,
        );
      }

      // Store channel context by runId (not sessionKey) for correct routing with queued messages
      this.pendingChannelResponses[runId] = {
        channel: params.channel,
        accountId: params.accountId,
        peer: params.peer,
        inboundMessageId: params.message.id,
      };

      // Update last active context
      this.lastActiveContext[agentId] = {
        agentId,
        channel: params.channel,
        accountId: params.accountId,
        peer: params.peer,
        sessionKey,
        timestamp: Date.now(),
      };

      // Send typing indicator
      this.sendTypingToChannel(
        params.channel,
        params.accountId,
        params.peer,
        sessionKey,
        true,
      );

      const result = await sessionStub.chatSend(
        directives.cleaned,
        runId,
        JSON.parse(JSON.stringify(this.getAllTools())),
        JSON.parse(JSON.stringify(this.getRuntimeNodeInventory())),
        sessionKey,
        messageOverrides,
        processedMedia.length > 0 ? processedMedia : undefined,
      );

      return {
        ok: true,
        sessionKey,
        status: "started",
        runId: result.runId,
        directives:
          directives.hasThinkDirective || directives.hasModelDirective
            ? {
                thinkLevel: directives.thinkLevel,
                model: directives.model,
              }
            : undefined,
      };
    } catch (e) {
      this.sendTypingToChannel(
        params.channel,
        params.accountId,
        params.peer,
        sessionKey,
        false,
      );
      delete this.pendingChannelResponses[runId];
      return {
        ok: false,
        sessionKey,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Handle channel status change notification via RPC.
   */
  async handleChannelStatusChanged(
    channelId: string,
    accountId: string,
    status: { connected: boolean; authenticated: boolean; error?: string },
  ): Promise<void> {
    const channelKey = `${channelId}:${accountId}`;
    console.log(
      `[Gateway] Channel status changed: ${channelKey} connected=${status.connected}`,
    );

    // Update channel registry
    const existing = this.channelRegistry[channelKey];
    if (existing) {
      this.channelRegistry[channelKey] = {
        ...existing,
        connectedAt: status.connected ? Date.now() : existing.connectedAt,
      };
    } else if (status.connected) {
      this.channelRegistry[channelKey] = {
        channel: channelId as ChannelId,
        accountId,
        connectedAt: Date.now(),
      };
    }
  }
}
