import { getNativeToolDefinitions } from "../agents/tools";
import { PersistedObject, snapshot, type Proxied } from "../shared/persisted-object";
import {
  listHostsByRole,
  pickExecutionHostId,
} from "./capabilities";
import type { EventFrame } from "../protocol/frames";
import type {
  LogsGetEventPayload,
  LogsGetParams,
  LogsGetResult,
  LogsResultParams,
} from "../protocol/logs";
import type {
  NodeRuntimeInfo,
  ToolInvokePayload,
  ToolRequestParams,
  RuntimeNodeInventory,
  ToolDefinition,
} from "../protocol/tools";
import {
  GatewayPendingOperationsService,
  type ExpiredPendingOperations,
  type FailedLogOperation,
  type PendingLogRoute,
  type PendingToolRoute,
} from "./pending-ops";

export type NodeCatalogEntry = {
  nodeId: string;
  online: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
  clientPlatform?: string;
  clientVersion?: string;
};

function cloneToolDefinitions(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)),
  }));
}

export function cloneNodeRuntimeInfo(
  runtime: NodeRuntimeInfo,
  overrides?: Partial<NodeRuntimeInfo>,
): NodeRuntimeInfo {
  const plainRuntime = snapshot(runtime as unknown as Proxied<NodeRuntimeInfo>);
  const hostCapabilities =
    overrides?.hostCapabilities ?? plainRuntime.hostCapabilities;
  const toolCapabilities =
    overrides?.toolCapabilities ?? plainRuntime.toolCapabilities;
  const hostEnv = overrides?.hostEnv ?? plainRuntime.hostEnv;
  const hostBinStatus = overrides?.hostBinStatus ?? plainRuntime.hostBinStatus;

  return {
    hostRole: overrides?.hostRole ?? plainRuntime.hostRole,
    hostCapabilities: [...hostCapabilities],
    toolCapabilities: Object.fromEntries(
      Object.entries(toolCapabilities).map(([toolName, capabilities]) => [
        toolName,
        [...capabilities],
      ]),
    ),
    hostOs: overrides?.hostOs ?? plainRuntime.hostOs,
    hostEnv: hostEnv ? [...hostEnv] : undefined,
    hostBinStatus: hostBinStatus
      ? Object.fromEntries(
          Object.entries(hostBinStatus).map(([bin, available]) => [
            bin,
            available === true,
          ]),
        )
      : undefined,
    hostBinStatusUpdatedAt:
      overrides?.hostBinStatusUpdatedAt ?? plainRuntime.hostBinStatusUpdatedAt,
  };
}

type NodeConnectionMetadata = {
  platform?: string;
  version?: string;
  connectedAt?: number;
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

export class GatewayNodeService {
  private readonly toolRegistry: ReturnType<
    typeof PersistedObject<Record<string, ToolDefinition[]>>
  >;
  private readonly nodeRuntimeRegistry: ReturnType<
    typeof PersistedObject<Record<string, NodeRuntimeInfo>>
  >;
  private readonly nodeCatalog: ReturnType<
    typeof PersistedObject<Record<string, NodeCatalogEntry>>
  >;
  private readonly pendingOperations: GatewayPendingOperationsService;
  private readonly pendingInternalLogCalls = new Map<
    string,
    PendingInternalLogRequest
  >();

  constructor(private readonly kv: SyncKvStorage) {
    this.toolRegistry = PersistedObject<Record<string, ToolDefinition[]>>(
      this.kv,
      { prefix: "toolRegistry:" },
    );
    this.nodeRuntimeRegistry = PersistedObject<Record<string, NodeRuntimeInfo>>(
      this.kv,
      { prefix: "nodeRuntimeRegistry:" },
    );
    this.nodeCatalog = PersistedObject<Record<string, NodeCatalogEntry>>(
      this.kv,
      { prefix: "nodeCatalog:" },
    );
    this.pendingOperations = new GatewayPendingOperationsService(this.kv);
  }

  private normalizeString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeTimestamp(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.floor(value);
    }
    return Date.now();
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

  private resolveTargetNodeForLogs(
    nodeId: string | undefined,
    connectedNodes: Map<string, WebSocket>,
  ): string {
    if (nodeId) {
      if (!connectedNodes.has(nodeId)) {
        throw new Error(`Node not connected: ${nodeId}`);
      }
      return nodeId;
    }

    if (connectedNodes.size === 1) {
      return Array.from(connectedNodes.keys())[0];
    }

    if (connectedNodes.size === 0) {
      throw new Error("No nodes connected");
    }

    throw new Error("nodeId required when multiple nodes are connected");
  }

  registerNode(
    nodeId: string,
    info: {
      tools: ToolDefinition[];
      runtime: NodeRuntimeInfo;
      metadata?: NodeConnectionMetadata;
    },
  ): void {
    this.toolRegistry[nodeId] = cloneToolDefinitions(info.tools);
    this.nodeRuntimeRegistry[nodeId] = cloneNodeRuntimeInfo(info.runtime);
    this.markNodeConnected(nodeId, info.metadata);
  }

  markNodeConnected(nodeId: string, metadata?: NodeConnectionMetadata): void {
    const connectedAt = this.normalizeTimestamp(metadata?.connectedAt);
    const existing = this.nodeCatalog[nodeId];
    const platform =
      this.normalizeString(metadata?.platform) ?? existing?.clientPlatform;
    const version =
      this.normalizeString(metadata?.version) ?? existing?.clientVersion;

    this.nodeCatalog[nodeId] = {
      nodeId,
      online: true,
      firstSeenAt: existing?.firstSeenAt ?? connectedAt,
      lastSeenAt: connectedAt,
      lastConnectedAt: connectedAt,
      lastDisconnectedAt: existing?.lastDisconnectedAt,
      clientPlatform: platform,
      clientVersion: version,
    };
  }

  markNodeDisconnected(nodeId: string, disconnectedAt?: number): void {
    const resolvedDisconnectedAt = this.normalizeTimestamp(disconnectedAt);
    const existing = this.nodeCatalog[nodeId];

    this.nodeCatalog[nodeId] = {
      nodeId,
      online: false,
      firstSeenAt: existing?.firstSeenAt ?? resolvedDisconnectedAt,
      lastSeenAt: resolvedDisconnectedAt,
      lastConnectedAt: existing?.lastConnectedAt,
      lastDisconnectedAt: resolvedDisconnectedAt,
      clientPlatform: existing?.clientPlatform,
      clientVersion: existing?.clientVersion,
    };
  }

  hasRegisteredTools(nodeId: string): boolean {
    return (this.toolRegistry[nodeId]?.length ?? 0) > 0;
  }

  listToolRegistryNodeIds(): string[] {
    return Object.keys(this.toolRegistry).sort();
  }

  listRuntimeRegistryNodeIds(): string[] {
    return Object.keys(this.nodeRuntimeRegistry).sort();
  }

  listStaleOnlineNodeIds(connectedNodeIds: Iterable<string>): string[] {
    const connected = new Set(connectedNodeIds);
    return Object.entries(this.nodeCatalog)
      .filter(([nodeId, entry]) => entry.online === true && !connected.has(nodeId))
      .map(([nodeId]) => nodeId)
      .sort();
  }

  listDetachedToolNodeIds(connectedNodeIds: Iterable<string>): string[] {
    const connected = new Set(connectedNodeIds);
    return Object.keys(this.toolRegistry)
      .filter((nodeId) => !connected.has(nodeId))
      .sort();
  }

  listDetachedRuntimeNodeIds(connectedNodeIds: Iterable<string>): string[] {
    const connected = new Set(connectedNodeIds);
    return Object.keys(this.nodeRuntimeRegistry)
      .filter((nodeId) => !connected.has(nodeId))
      .sort();
  }

  getKnownNodeIds(connectedNodeIds: Iterable<string>): string[] {
    return Array.from(
      new Set([
        ...Array.from(connectedNodeIds),
        ...Object.keys(this.nodeCatalog),
        ...Object.keys(this.toolRegistry),
        ...Object.keys(this.nodeRuntimeRegistry),
      ]),
    ).sort();
  }

  getNodeRuntime(nodeId: string): NodeRuntimeInfo | undefined {
    const runtime = this.nodeRuntimeRegistry[nodeId];
    if (!runtime) {
      return undefined;
    }
    return cloneNodeRuntimeInfo(runtime);
  }

  setNodeRuntime(nodeId: string, runtime: NodeRuntimeInfo): void {
    this.nodeRuntimeRegistry[nodeId] = cloneNodeRuntimeInfo(runtime);
  }

  canNodeProbeBins(nodeId: string): boolean {
    const runtime = this.nodeRuntimeRegistry[nodeId];
    if (!runtime) {
      return false;
    }
    return runtime.hostCapabilities.includes("shell.exec");
  }

  mergeNodeBinStatus(
    nodeId: string,
    statusByBin: Record<string, boolean>,
    updatedAt: number = Date.now(),
  ): boolean {
    const runtime = this.nodeRuntimeRegistry[nodeId];
    if (!runtime) {
      return false;
    }

    const existingStatus = runtime.hostBinStatus ?? {};
    this.nodeRuntimeRegistry[nodeId] = cloneNodeRuntimeInfo(runtime, {
      hostBinStatus: Object.fromEntries(
        Object.entries({
          ...existingStatus,
          ...statusByBin,
        }).sort(([left], [right]) => left.localeCompare(right)),
      ),
      hostBinStatusUpdatedAt: Math.floor(updatedAt),
    });
    return true;
  }

  resolveTool(
    namespacedTool: string,
    connectedNodeIds: Iterable<string>,
  ): { nodeId: string; toolName: string } | null {
    const separatorIndex = namespacedTool.indexOf("__");
    if (separatorIndex <= 0 || separatorIndex === namespacedTool.length - 2) {
      return null;
    }

    const nodeId = namespacedTool.slice(0, separatorIndex);
    const toolName = namespacedTool.slice(separatorIndex + 2);
    const connected = new Set(connectedNodeIds);
    if (!connected.has(nodeId)) {
      return null;
    }

    const hasTool = (this.toolRegistry[nodeId] ?? []).some(
      (tool) => tool.name === toolName,
    );
    if (!hasTool) {
      return null;
    }

    return { nodeId, toolName };
  }

  consumePendingToolCall(callId: string): PendingToolRoute | undefined {
    return this.pendingOperations.consumeToolCall(callId);
  }

  consumePendingLogCall(callId: string): PendingLogRoute | undefined {
    return this.pendingOperations.consumeLogCall(callId);
  }

  cleanupClientPendingOperations(clientId: string): void {
    this.pendingOperations.cleanupClientPendingOperations(clientId);
  }

  failPendingLogCallsForNode(nodeId: string): FailedLogOperation[] {
    return this.pendingOperations.failPendingLogCallsForNode(nodeId);
  }

  getNextPendingOperationExpirationAtMs(): number | undefined {
    return this.pendingOperations.getNextExpirationAtMs();
  }

  cleanupExpiredPendingOperations(now = Date.now()): ExpiredPendingOperations {
    return this.pendingOperations.cleanupExpired(now);
  }

  requestToolForSession(
    params: ToolRequestParams,
    connectedNodes: Map<string, WebSocket>,
  ): { ok: boolean; error?: string } {
    const resolved = this.resolveTool(params.tool, connectedNodes.keys());
    if (!resolved) {
      return { ok: false, error: `No node provides tool: ${params.tool}` };
    }

    const nodeWs = connectedNodes.get(resolved.nodeId);
    if (!nodeWs || nodeWs.readyState !== WebSocket.OPEN) {
      return { ok: false, error: "Node not connected" };
    }

    this.pendingOperations.registerToolCall(params.callId, {
      kind: "session",
      sessionKey: params.sessionKey,
    });

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

  requestToolFromClient(input: {
    clientId: string;
    requestId: string;
    tool: string;
    args?: Record<string, unknown>;
  }, params: {
    connectedNodes: Map<string, WebSocket>;
    pendingToolTtlMs?: number;
  }): { ok: boolean; error?: string } {
    const resolved = this.resolveTool(input.tool, params.connectedNodes.keys());
    if (!resolved) {
      return { ok: false, error: `No node provides tool: ${input.tool}` };
    }

    const nodeWs = params.connectedNodes.get(resolved.nodeId);
    if (!nodeWs || nodeWs.readyState !== WebSocket.OPEN) {
      return { ok: false, error: "Node not connected" };
    }

    const callId = crypto.randomUUID();
    this.pendingOperations.registerToolCall(callId, {
      kind: "client",
      clientId: input.clientId,
      frameId: input.requestId,
      createdAt: Date.now(),
    }, {
      ttlMs: params.pendingToolTtlMs,
    });

    const evt: EventFrame<ToolInvokePayload> = {
      type: "evt",
      event: "tool.invoke",
      payload: { callId, tool: resolved.toolName, args: input.args ?? {} },
    };
    nodeWs.send(JSON.stringify(evt));

    return { ok: true };
  }

  requestLogsFromClient(input: {
    clientId: string;
    requestId: string;
    nodeId?: string;
    lines?: number;
  }, params: {
    connectedNodes: Map<string, WebSocket>;
    pendingLogTtlMs?: number;
  }): { ok: boolean; error?: string } {
    const lines = this.resolveLogLineLimit(input.lines);
    const targetNodeId = this.resolveTargetNodeForLogs(
      input.nodeId,
      params.connectedNodes,
    );
    const nodeWs = params.connectedNodes.get(targetNodeId);
    if (!nodeWs || nodeWs.readyState !== WebSocket.OPEN) {
      return { ok: false, error: `Node not connected: ${targetNodeId}` };
    }

    const callId = crypto.randomUUID();
    this.pendingOperations.registerLogCall(callId, {
      clientId: input.clientId,
      frameId: input.requestId,
      nodeId: targetNodeId,
      createdAt: Date.now(),
    }, {
      ttlMs: params.pendingLogTtlMs,
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

    return { ok: true };
  }

  async getNodeLogs(
    connectedNodes: Map<string, WebSocket>,
    params?: LogsGetParams & { timeoutMs?: number },
  ): Promise<LogsGetResult> {
    const lines = this.resolveLogLineLimit(params?.lines);
    const nodeId = this.resolveTargetNodeForLogs(params?.nodeId, connectedNodes);
    const nodeWs = connectedNodes.get(nodeId);
    if (!nodeWs || nodeWs.readyState !== WebSocket.OPEN) {
      throw new Error(`Node not connected: ${nodeId}`);
    }

    const timeoutInput =
      typeof params?.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
        ? Math.floor(params.timeoutMs)
        : DEFAULT_INTERNAL_LOG_TIMEOUT_MS;
    const timeoutMs = Math.max(
      1000,
      Math.min(timeoutInput, MAX_INTERNAL_LOG_TIMEOUT_MS),
    );
    const callId = crypto.randomUUID();

    const responsePromise = new Promise<LogsGetResult>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const pending = this.pendingInternalLogCalls.get(callId);
        if (!pending) {
          return;
        }
        this.pendingInternalLogCalls.delete(callId);
        pending.reject(
          new Error(
            `logs.get timed out for node ${pending.nodeId} after ${timeoutMs}ms`,
          ),
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
      pending.reject(
        new Error("Node not authorized for this internal logs call"),
      );
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

  listNodeTools(connectedNodeIds: Iterable<string>): ToolDefinition[] {
    return Array.from(connectedNodeIds)
      .sort()
      .flatMap((nodeId) =>
        (this.toolRegistry[nodeId] ?? []).map((tool) => ({
          ...tool,
          name: `${nodeId}__${tool.name}`,
          inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)),
        })),
      );
  }

  listTools(connectedNodeIds: Iterable<string>): ToolDefinition[] {
    return [...getNativeToolDefinitions(), ...this.listNodeTools(connectedNodeIds)];
  }

  getExecutionHostId(connectedNodeIds: Iterable<string>): string | null {
    return pickExecutionHostId({
      nodeIds: Array.from(connectedNodeIds),
      runtimes: this.nodeRuntimeRegistry,
    });
  }

  getSpecializedHostIds(connectedNodeIds: Iterable<string>): string[] {
    return listHostsByRole({
      nodeIds: Array.from(connectedNodeIds),
      runtimes: this.nodeRuntimeRegistry,
      role: "specialized",
    });
  }

  getRuntimeNodeInventory(
    connectedNodeIds: Iterable<string>,
  ): RuntimeNodeInventory {
    const connected = new Set(connectedNodeIds);
    const nodeIds = this.getKnownNodeIds(connected);
    const hosts = nodeIds.map((nodeId) => {
      const runtime = this.nodeRuntimeRegistry[nodeId];
      const catalog = this.nodeCatalog[nodeId];
      const tools = (this.toolRegistry[nodeId] ?? [])
        .map((tool) => tool.name)
        .sort();
      const online = connected.has(nodeId);

      if (!runtime) {
        return {
          nodeId,
          online,
          hostRole: "specialized" as const,
          hostCapabilities: [],
          toolCapabilities: {},
          tools,
          hostEnv: [],
          hostBins: [],
          firstSeenAt: catalog?.firstSeenAt,
          lastSeenAt: catalog?.lastSeenAt,
          lastConnectedAt: catalog?.lastConnectedAt,
          lastDisconnectedAt: catalog?.lastDisconnectedAt,
          clientPlatform: catalog?.clientPlatform,
          clientVersion: catalog?.clientVersion,
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
        online,
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
        firstSeenAt: catalog?.firstSeenAt,
        lastSeenAt: catalog?.lastSeenAt,
        lastConnectedAt: catalog?.lastConnectedAt,
        lastDisconnectedAt: catalog?.lastDisconnectedAt,
        clientPlatform: catalog?.clientPlatform,
        clientVersion: catalog?.clientVersion,
      };
    });

    return {
      executionHostId: this.getExecutionHostId(connected),
      specializedHostIds: this.getSpecializedHostIds(connected),
      hosts,
    };
  }
}
