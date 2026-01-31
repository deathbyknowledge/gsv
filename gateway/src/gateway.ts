import { DurableObject } from "cloudflare:workers";
import { PersistedObject } from "./stored";
import {
  ToolDefinition,
  Frame,
  RequestFrame,
  ConnectParams,
  ChatSendParams,
  ToolRequestParams,
  EventFrame,
  ToolInvokePayload,
  ToolResultParams,
  ResponseFrame,
  ChatEventPayload,
  SessionRegistryEntry,
  SessionsListResult,
  ChannelInboundParams,
  ChannelOutboundPayload,
  ChannelRegistryEntry,
  ChannelId,
  PeerInfo,
} from "./types";
import { isWebSocketRequest, validateFrame, isWsConnected } from "./utils";
import { GsvConfig, DEFAULT_CONFIG, mergeConfig } from "./config";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

export class Gateway extends DurableObject<Env> {
  clients: Map<string, WebSocket> = new Map();
  nodes: Map<string, WebSocket> = new Map();
  channels: Map<string, WebSocket> = new Map();

  toolRegistry = PersistedObject<Record<string, ToolDefinition[]>>(
    this.ctx.storage.kv,
    { prefix: "toolRegistry:" },
  );

  pendingToolCalls = PersistedObject<Record<string, string>>(
    this.ctx.storage.kv,
    { prefix: "pendingToolCalls:" },
  );

  private configStore = PersistedObject<Record<string, unknown>>(
    this.ctx.storage.kv,
    {
      prefix: "config:",
      defaults: {
        model: {
          provider: DEFAULT_CONFIG.model.provider,
          id: DEFAULT_CONFIG.model.id,
        },
        timeouts: {
          llmMs: DEFAULT_CONFIG.timeouts.llmMs,
          toolMs: DEFAULT_CONFIG.timeouts.toolMs,
        },
      },
    },
  );

  sessionRegistry = PersistedObject<Record<string, SessionRegistryEntry>>(
    this.ctx.storage.kv,
    { prefix: "sessionRegistry:" },
  );

  channelRegistry = PersistedObject<Record<string, ChannelRegistryEntry>>(
    this.ctx.storage.kv,
    { prefix: "channelRegistry:" },
  );

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);

    const websockets = this.ctx.getWebSockets();
    console.log(
      `[Gateway] Constructor: rehydrating ${websockets.length} WebSockets`,
    );

    for (const ws of websockets) {
      const { connected, mode, clientId, nodeId, channelKey } = ws.deserializeAttachment();
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

    const staleNodeIds = Object.keys(this.toolRegistry).filter(
      (nodeId) => !this.nodes.has(nodeId),
    );
    for (const nodeId of staleNodeIds) {
      delete this.toolRegistry[nodeId];
    }
    if (staleNodeIds.length > 0) {
      console.log(
        `[Gateway] Cleaned ${staleNodeIds.length} stale registry entries`,
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

    switch (frame.method) {
      case "connect":
        return this.handleConnect(ws, frame);
      case "tools.list":
        return this.handleToolsList(ws, frame);
      case "chat.send":
        return this.handleChatSend(ws, frame);
      case "tool.request":
        return this.handleToolRequest(ws, frame);
      case "tool.result":
        return this.handleToolResult(ws, frame);
      case "tool.invoke":
        return this.handleToolInvoke(ws, frame);
      case "config.get":
        return this.handleConfigGet(ws, frame);
      case "config.set":
        return this.handleConfigSet(ws, frame);
      case "session.reset":
        return this.handleSessionReset(ws, frame);
      case "session.get":
        return this.handleSessionGet(ws, frame);
      case "session.stats":
        return this.handleSessionStats(ws, frame);
      case "session.patch":
        return this.handleSessionPatch(ws, frame);
      case "session.compact":
        return this.handleSessionCompact(ws, frame);
      case "session.history":
        return this.handleSessionHistory(ws, frame);
      case "session.preview":
        return this.handleSessionPreview(ws, frame);
      case "sessions.list":
        return this.handleSessionsList(ws, frame);
      case "channel.inbound":
        return this.handleChannelInbound(ws, frame);
      case "channels.list":
        return this.handleChannelsList(ws, frame);
      default:
        this.sendError(ws, frame.id, 404, `Unknown method: ${frame.method}`);
    }
  }

  handleConnect(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as ConnectParams;
    if (params?.minProtocol !== 1) {
      this.sendError(ws, frame.id, 102, "Unsupported protocol version");
      return;
    }

    // Check auth token if configured
    const authToken = this.getConfigPath("auth.token") as string | undefined;
    if (authToken) {
      const providedToken = params?.auth?.token;
      if (!providedToken || !timingSafeEqual(providedToken, authToken)) {
        this.sendError(ws, frame.id, 401, "Unauthorized: invalid or missing token");
        ws.close(4001, "Unauthorized");
        return;
      }
    }

    const mode = params?.client?.mode;
    if (!mode || !["client", "node", "channel"].includes(mode)) {
      this.sendError(ws, frame.id, 103, "Invalid client mode");
      return;
    }

    let attachments = ws.deserializeAttachment();
    attachments = { ...attachments, connected: true, mode };

    if (mode === "client") {
      attachments.clientId = params.client.id;
      this.clients.set(params.client.id, ws);
      console.log(`[Gateway] Client connected: ${params.client.id}`);
    } else if (mode === "node") {
      attachments.nodeId = params.client.id;
      this.nodes.set(params.client.id, ws);
      this.toolRegistry[params.client.id] = params.tools ?? [];
      console.log(
        `[Gateway] Node connected: ${params.client.id}, tools: [${(params.tools ?? []).map((t) => t.name).join(", ")}]`,
      );
    } else if (mode === "channel") {
      const channel = params.client.channel;
      const accountId = params.client.accountId ?? params.client.id;
      if (!channel) {
        this.sendError(ws, frame.id, 103, "Channel mode requires channel field");
        return;
      }
      const channelKey = `${channel}:${accountId}`;
      attachments.channelKey = channelKey;
      attachments.channel = channel;
      attachments.accountId = accountId;
      this.channels.set(channelKey, ws);
      // Update channel registry
      this.channelRegistry[channelKey] = {
        channel,
        accountId,
        connectedAt: Date.now(),
      };
      console.log(`[Gateway] Channel connected: ${channelKey}`);
    }

    ws.serializeAttachment(attachments);
    this.sendOk(ws, frame.id, {
      type: "hello-ok",
      protocol: 1,
      server: { version: "0.0.1", connectionId: attachments.id },
      features: {
        methods: ["tools.list", "chat.send", "tool.request", "tool.result", "channel.inbound"],
        events: ["chat", "tool.invoke", "tool.result", "channel.outbound"],
      },
    });
  }

  handleToolsList(ws: WebSocket, frame: RequestFrame) {
    const tools = this.getAllTools();
    this.sendOk(ws, frame.id, { tools });
  }

  async handleChatSend(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as ChatSendParams;
    if (!params?.sessionKey || !params?.message) {
      this.sendError(ws, frame.id, 400, "sessionKey and message required");
      return;
    }

    const sessionStub = this.env.SESSION.get(
      this.env.SESSION.idFromName(params.sessionKey),
    );

    const now = Date.now();
    const existing = this.sessionRegistry[params.sessionKey];
    this.sessionRegistry[params.sessionKey] = {
      sessionKey: params.sessionKey,
      createdAt: existing?.createdAt ?? now,
      lastActiveAt: now,
      messageCount: (existing?.messageCount ?? 0) + 1,
      label: existing?.label,
    };

    try {
      const result = await sessionStub.chatSend(
        params.message,
        params.runId,
        JSON.parse(JSON.stringify(this.getAllTools())),
        params.sessionKey,
      );

      this.sendOk(ws, frame.id, { status: "started", runId: result.runId });
    } catch (e) {
      this.sendError(ws, frame.id, 500, String(e));
    }
  }

  handleToolRequest(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as ToolRequestParams;
    if (!params?.callId || !params?.tool || !params?.sessionKey) {
      this.sendError(
        ws,
        frame.id,
        400,
        "callId, tool, and sessionKey required",
      );
      return;
    }

    const nodeId = this.findNodeForTool(params.tool);
    if (!nodeId) {
      this.sendError(
        ws,
        frame.id,
        404,
        `No node provides tool: ${params.tool}`,
      );
      return;
    }

    const nodeWs = this.nodes.get(nodeId);
    if (!nodeWs) {
      this.sendError(ws, frame.id, 503, "Node not connected");
      return;
    }

    this.pendingToolCalls[params.callId] = params.sessionKey;

    const evt: EventFrame<ToolInvokePayload> = {
      type: "evt",
      event: "tool.invoke",
      payload: {
        callId: params.callId,
        tool: params.tool,
        args: params.args ?? {},
      },
    };
    nodeWs.send(JSON.stringify(evt));

    this.sendOk(ws, frame.id, { status: "sent" });
  }

  async handleToolResult(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as ToolResultParams;
    if (!params?.callId) {
      this.sendError(ws, frame.id, 400, "callId required");
      return;
    }

    const clientCall = this.pendingClientCalls.get(params.callId);
    if (clientCall) {
      this.pendingClientCalls.delete(params.callId);
      if (params.error) {
        this.sendError(clientCall.ws, clientCall.frameId, 500, params.error);
      } else {
        this.sendOk(clientCall.ws, clientCall.frameId, {
          result: params.result,
        });
      }
      this.sendOk(ws, frame.id, { ok: true });
      return;
    }

    const sessionKey = this.pendingToolCalls[params.callId];
    if (!sessionKey) {
      this.sendError(ws, frame.id, 404, "Unknown callId");
      return;
    }

    delete this.pendingToolCalls[params.callId];

    const sessionStub = this.env.SESSION.get(
      this.env.SESSION.idFromName(sessionKey),
    );
    await sessionStub.toolResult({
      callId: params.callId,
      result: params.result,
      error: params.error,
    });

    this.sendOk(ws, frame.id, { ok: true });
  }

  pendingClientCalls = new Map<string, { ws: WebSocket; frameId: string }>();

  handleToolInvoke(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as {
      tool: string;
      args?: Record<string, unknown>;
    };
    if (!params?.tool) {
      this.sendError(ws, frame.id, 400, "tool required");
      return;
    }

    const nodeId = this.findNodeForTool(params.tool);
    if (!nodeId) {
      this.sendError(
        ws,
        frame.id,
        404,
        `No node provides tool: ${params.tool}`,
      );
      return;
    }

    const nodeWs = this.nodes.get(nodeId);
    if (!nodeWs) {
      this.sendError(ws, frame.id, 503, "Node not connected");
      return;
    }

    const callId = crypto.randomUUID();
    this.pendingClientCalls.set(callId, { ws, frameId: frame.id });

    const evt: EventFrame<ToolInvokePayload> = {
      type: "evt",
      event: "tool.invoke",
      payload: { callId, tool: params.tool, args: params.args ?? {} },
    };
    nodeWs.send(JSON.stringify(evt));
  }

  webSocketClose(ws: WebSocket) {
    const { mode, clientId, nodeId, channelKey } = ws.deserializeAttachment();
    console.log(
      `[Gateway] WebSocket closed: mode=${mode}, clientId=${clientId}, nodeId=${nodeId}, channelKey=${channelKey}`,
    );
    if (mode === "client") this.clients.delete(clientId);
    else if (mode === "node") {
      this.nodes.delete(nodeId);
      delete this.toolRegistry[nodeId];
      console.log(`[Gateway] Node ${nodeId} removed from registry`);
    } else if (mode === "channel" && channelKey) {
      this.channels.delete(channelKey);
      console.log(`[Gateway] Channel ${channelKey} disconnected`);
    }
  }

  async toolRequest(
    params: ToolRequestParams,
  ): Promise<{ ok: boolean; error?: string }> {
    const nodeId = this.findNodeForTool(params.tool);
    if (!nodeId) {
      return { ok: false, error: `No node provides tool: ${params.tool}` };
    }

    const nodeWs = this.nodes.get(nodeId);
    if (!nodeWs) {
      return { ok: false, error: "Node not connected" };
    }

    // Track pending call for routing result back
    this.pendingToolCalls[params.callId] = params.sessionKey;

    // Send tool.invoke event to node
    const evt: EventFrame<ToolInvokePayload> = {
      type: "evt",
      event: "tool.invoke",
      payload: {
        callId: params.callId,
        tool: params.tool,
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
    const res: ResponseFrame = {
      type: "res",
      id,
      ok: false,
      error: { code, message },
    };
    ws.send(JSON.stringify(res));
  }

  findNodeForTool(toolName: string): string | null {
    for (const nodeId of this.nodes.keys()) {
      if (
        this.toolRegistry[nodeId]?.some(
          (t: ToolDefinition) => t.name === toolName,
        )
      ) {
        return nodeId;
      }
    }
    return null;
  }

  getAllTools(): ToolDefinition[] {
    console.log(`[Gateway] getAllTools called`);
    console.log(
      `[Gateway]   nodes in memory: [${[...this.nodes.keys()].join(", ")}]`,
    );
    console.log(
      `[Gateway]   toolRegistry keys: [${Object.keys(this.toolRegistry).join(", ")}]`,
    );
    const tools = Array.from(this.nodes.keys()).flatMap(
      (nodeId) => this.toolRegistry[nodeId] ?? [],
    );
    console.log(`[Gateway]   returning ${tools.length} tools`);
    return tools;
  }

  // Config methods
  handleConfigGet(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { path?: string } | undefined;

    if (params?.path) {
      // Get specific path
      const value = this.getConfigPath(params.path);
      this.sendOk(ws, frame.id, { path: params.path, value });
    } else {
      // Get full config (but mask API keys)
      const safeConfig = this.getSafeConfig();
      this.sendOk(ws, frame.id, { config: safeConfig });
    }
  }

  handleConfigSet(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { path: string; value: unknown } | undefined;

    if (!params?.path) {
      this.sendError(ws, frame.id, 400, "path required");
      return;
    }

    this.setConfigPath(params.path, params.value);
    this.sendOk(ws, frame.id, { ok: true, path: params.path });
  }

  async handleSessionReset(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { sessionKey: string } | undefined;

    if (!params?.sessionKey) {
      this.sendError(ws, frame.id, 400, "sessionKey required");
      return;
    }

    const sessionStub = this.env.SESSION.get(
      this.env.SESSION.idFromName(params.sessionKey),
    );

    try {
      const result = await sessionStub.reset();
      this.sendOk(ws, frame.id, result);
    } catch (e) {
      this.sendError(ws, frame.id, 500, String(e));
    }
  }

  async handleSessionGet(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { sessionKey: string } | undefined;

    if (!params?.sessionKey) {
      this.sendError(ws, frame.id, 400, "sessionKey required");
      return;
    }

    const sessionStub = this.env.SESSION.get(
      this.env.SESSION.idFromName(params.sessionKey),
    );

    try {
      const result = await sessionStub.get();
      this.sendOk(ws, frame.id, result);
    } catch (e) {
      this.sendError(ws, frame.id, 500, String(e));
    }
  }

  async handleSessionStats(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { sessionKey: string } | undefined;

    if (!params?.sessionKey) {
      this.sendError(ws, frame.id, 400, "sessionKey required");
      return;
    }

    const sessionStub = this.env.SESSION.get(
      this.env.SESSION.idFromName(params.sessionKey),
    );

    try {
      const result = await sessionStub.stats();
      this.sendOk(ws, frame.id, result);
    } catch (e) {
      this.sendError(ws, frame.id, 500, String(e));
    }
  }

  async handleSessionPatch(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as
      | {
          sessionKey: string;
          settings?: Record<string, unknown>;
          label?: string;
          resetPolicy?: { mode: string; atHour?: number; idleMinutes?: number };
        }
      | undefined;

    if (!params?.sessionKey) {
      this.sendError(ws, frame.id, 400, "sessionKey required");
      return;
    }

    const sessionStub = this.env.SESSION.get(
      this.env.SESSION.idFromName(params.sessionKey),
    );

    try {
      const result = await sessionStub.patch({
        settings: params.settings,
        label: params.label,
        resetPolicy: params.resetPolicy as any,
      });
      this.sendOk(ws, frame.id, result);
    } catch (e) {
      this.sendError(ws, frame.id, 500, String(e));
    }
  }

  async handleSessionCompact(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as
      | { sessionKey: string; keepMessages?: number }
      | undefined;

    if (!params?.sessionKey) {
      this.sendError(ws, frame.id, 400, "sessionKey required");
      return;
    }

    const sessionStub = this.env.SESSION.get(
      this.env.SESSION.idFromName(params.sessionKey),
    );

    try {
      const result = await sessionStub.compact(params.keepMessages ?? 20);
      this.sendOk(ws, frame.id, result);
    } catch (e) {
      this.sendError(ws, frame.id, 500, String(e));
    }
  }

  async handleSessionHistory(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { sessionKey: string } | undefined;

    if (!params?.sessionKey) {
      this.sendError(ws, frame.id, 400, "sessionKey required");
      return;
    }

    const sessionStub = this.env.SESSION.get(
      this.env.SESSION.idFromName(params.sessionKey),
    );

    try {
      const result = await sessionStub.history();
      this.sendOk(ws, frame.id, result);
    } catch (e) {
      this.sendError(ws, frame.id, 500, String(e));
    }
  }

  handleSessionsList(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { limit?: number; offset?: number } | undefined;
    const limit = params?.limit ?? 100;
    const offset = params?.offset ?? 0;

    const allSessions = Object.values(this.sessionRegistry)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    const sessions = allSessions.slice(offset, offset + limit);

    const result: SessionsListResult = {
      sessions,
      count: allSessions.length,
    };

    this.sendOk(ws, frame.id, result);
  }

  async handleSessionPreview(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { sessionKey: string; limit?: number } | undefined;

    if (!params?.sessionKey) {
      this.sendError(ws, frame.id, 400, "sessionKey required");
      return;
    }

    const sessionStub = this.env.SESSION.get(
      this.env.SESSION.idFromName(params.sessionKey),
    );

    try {
      const result = await sessionStub.preview(params.limit);
      this.sendOk(ws, frame.id, result);
    } catch (e) {
      this.sendError(ws, frame.id, 500, String(e));
    }
  }

  async handleChannelInbound(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as ChannelInboundParams;
    if (!params?.channel || !params?.accountId || !params?.peer || !params?.message) {
      this.sendError(ws, frame.id, 400, "channel, accountId, peer, and message required");
      return;
    }

    // Generate session key from channel context
    // Format: agent:{agentId}:{channel}:{peerKind}:{peerId}
    // TODO: Add agent binding resolution (for now, default to "main")
    const agentId = "main";
    const sessionKey = this.buildSessionKeyFromChannel(agentId, params.channel, params.peer);

    const channelKey = `${params.channel}:${params.accountId}`;
    const existing = this.channelRegistry[channelKey];
    if (existing) {
      this.channelRegistry[channelKey] = {
        ...existing,
        lastMessageAt: Date.now(),
      };
    }

    const now = Date.now();
    const existingSession = this.sessionRegistry[sessionKey];
    this.sessionRegistry[sessionKey] = {
      sessionKey,
      createdAt: existingSession?.createdAt ?? now,
      lastActiveAt: now,
      messageCount: (existingSession?.messageCount ?? 0) + 1,
      label: existingSession?.label ?? params.peer.name,
    };

    const sessionStub = this.env.SESSION.get(
      this.env.SESSION.idFromName(sessionKey),
    );

    try {
      const messageText = params.message.text;
      const runId = crypto.randomUUID();

      const result = await sessionStub.chatSend(
        messageText,
        runId,
        JSON.parse(JSON.stringify(this.getAllTools())),
        sessionKey,
      );

      this.pendingChannelResponses[sessionKey] = {
        channel: params.channel,
        accountId: params.accountId,
        peer: params.peer,
        inboundMessageId: params.message.id,
      };

      this.sendOk(ws, frame.id, { 
        status: "started", 
        runId: result.runId,
        sessionKey,
      });
    } catch (e) {
      this.sendError(ws, frame.id, 500, String(e));
    }
  }

  pendingChannelResponses = PersistedObject<Record<string, {
    channel: ChannelId;
    accountId: string;
    peer: PeerInfo;
    inboundMessageId: string;
  }>>(this.ctx.storage.kv, { prefix: "pendingChannelResponses:" });

  private buildSessionKeyFromChannel(agentId: string, channel: ChannelId, peer: PeerInfo): string {
    const sanitizedPeerId = peer.id.replace(/[^a-zA-Z0-9+\-_@.]/g, "_");
    return `agent:${agentId}:${channel}:${peer.kind}:${sanitizedPeerId}`;
  }

  handleChannelsList(ws: WebSocket, frame: RequestFrame) {
    const channels = Object.values(this.channelRegistry);
    this.sendOk(ws, frame.id, { 
      channels,
      count: channels.length,
    });
  }

  private getConfigPath(path: string): unknown {
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

  private setConfigPath(path: string, value: unknown): void {
    const parts = path.split(".");
    
    if (parts.length === 1) {
      this.configStore[path] = value;
    } else if (parts.length === 2) {
      const [group, field] = parts;
      
      const existing = this.configStore[group];
      const groupObj = (typeof existing === "object" && existing !== null) 
        ? { ...existing as Record<string, unknown> }
        : {};
      
      groupObj[field] = value;
      this.configStore[group] = groupObj;
      
      delete this.configStore[path];
    }
  }

  private getFullConfig(): GsvConfig {
    return mergeConfig(DEFAULT_CONFIG, { ...this.configStore } as Partial<GsvConfig>);
  }

  private getSafeConfig(): GsvConfig {
    const full = this.getFullConfig();
    const apiKeys = Object.fromEntries(
      Object.entries(full.apiKeys).map(([key, value]) => [key, value ? "***" : undefined]),
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

    if (payload.state === "final" && payload.message) {
      const channelContext = this.pendingChannelResponses[sessionKey];
      if (channelContext) {
        this.routeToChannel(sessionKey, channelContext, payload);
        delete this.pendingChannelResponses[sessionKey];
      } else {
        console.log(`[Gateway] No pending channel context for session ${sessionKey}`);
      }
    }
  }

  private routeToChannel(
    sessionKey: string,
    context: {
      channel: ChannelId;
      accountId: string;
      peer: PeerInfo;
      inboundMessageId: string;
    },
    payload: ChatEventPayload,
  ): void {
    const channelKey = `${context.channel}:${context.accountId}`;
    const channelWs = this.channels.get(channelKey);
    
    if (!channelWs || channelWs.readyState !== WebSocket.OPEN) {
      console.log(`[Gateway] Channel ${channelKey} not connected for outbound`);
      return;
    }

    let text = "";
    const msg = payload.message as { content?: unknown } | undefined;
    if (msg?.content) {
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (typeof block === "object" && block && "type" in block) {
            if ((block as { type: string }).type === "text" && "text" in block) {
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

    const outbound: ChannelOutboundPayload = {
      channel: context.channel,
      accountId: context.accountId,
      peer: context.peer,
      sessionKey,
      message: {
        text,
        replyToId: context.inboundMessageId,
      },
    };

    const evt: EventFrame<ChannelOutboundPayload> = {
      type: "evt",
      event: "channel.outbound",
      payload: outbound,
    };

    channelWs.send(JSON.stringify(evt));
    console.log(`[Gateway] Routed response to channel ${channelKey}`);
  }
}
