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
  ChannelTypingPayload,
  ChannelRegistryEntry,
  ChannelId,
  PeerInfo,
} from "./types";
import type {
  ChannelWorkerInterface,
  ChannelOutboundMessage,
  ChannelPeer,
  SendResult,
} from "./channel-interface";
import { isWebSocketRequest, validateFrame, isWsConnected } from "./utils";
import { GsvConfig, GsvConfigInput, DEFAULT_CONFIG, mergeConfig, resolveAgentIdFromBinding, getAgentConfig, parseDuration, HeartbeatConfig, isAllowedSender, PendingPair, normalizeE164, resolveLinkedIdentity } from "./config";
import { 
  HeartbeatState, 
  getHeartbeatConfig, 
  getNextHeartbeatTime, 
  isWithinActiveHours,
  shouldDeliverResponse,
  HeartbeatResult,
} from "./heartbeat";
import { loadHeartbeatFile, isHeartbeatFileEmpty } from "./workspace";
import { parseCommand, HELP_TEXT, normalizeThinkLevel, resolveModelAlias, listModelAliases } from "./commands";
import { parseDirectives, isDirectiveOnly, formatDirectiveAck } from "./directives";
import { processMediaWithTranscription } from "./transcription";
import { processInboundMedia } from "./storage";
import { getWorkspaceToolDefinitions } from "./workspace-tools";

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
    { prefix: "config:" },
  );

  sessionRegistry = PersistedObject<Record<string, SessionRegistryEntry>>(
    this.ctx.storage.kv,
    { prefix: "sessionRegistry:" },
  );

  channelRegistry = PersistedObject<Record<string, ChannelRegistryEntry>>(
    this.ctx.storage.kv,
    { prefix: "channelRegistry:" },
  );

  // Heartbeat state per agent
  heartbeatState = PersistedObject<Record<string, HeartbeatState>>(
    this.ctx.storage.kv,
    { prefix: "heartbeatState:" },
  );

  // Last active channel context per agent (for heartbeat delivery)
  lastActiveContext = PersistedObject<Record<string, {
    agentId: string;
    channel: ChannelId;
    accountId: string;
    peer: PeerInfo;
    sessionKey: string;
    timestamp: number;
  }>>(
    this.ctx.storage.kv,
    { prefix: "lastActiveContext:" },
  );

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
      case "channel.start":
        return this.handleChannelStart(ws, frame);
      case "channel.stop":
        return this.handleChannelStop(ws, frame);
      case "channel.status":
        return this.handleChannelStatus(ws, frame);
      case "channel.login":
        return this.handleChannelLogin(ws, frame);
      case "channel.logout":
        return this.handleChannelLogout(ws, frame);
      case "heartbeat.trigger":
        return this.handleHeartbeatTrigger(ws, frame);
      case "heartbeat.status":
        return this.handleHeartbeatStatus(ws, frame);
      case "heartbeat.start":
        return this.handleHeartbeatStart(ws, frame);
      case "pair.list":
        return this.handlePairList(ws, frame);
      case "pair.approve":
        return this.handlePairApprove(ws, frame);
      case "pair.reject":
        return this.handlePairReject(ws, frame);
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
      const nodeId = params.client.id;
      attachments.nodeId = nodeId;
      this.nodes.set(nodeId, ws);
      // Store tools with their original names (namespacing happens in getAllTools)
      this.toolRegistry[nodeId] = params.tools ?? [];
      console.log(
        `[Gateway] Node connected: ${nodeId}, tools: [${(params.tools ?? []).map((t) => `${nodeId}__${t.name}`).join(", ")}]`,
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
        methods: ["tools.list", "chat.send", "tool.request", "tool.result", "channel.inbound", "channel.start", "channel.stop", "channel.status", "channel.login", "channel.logout", "channels.list"],
        events: ["chat", "tool.invoke", "tool.result", "channel.outbound"],
      },
    });

    // Auto-start heartbeat scheduler on first connection (if not already initialized)
    if (!this.heartbeatScheduler.initialized) {
      this.scheduleHeartbeat().then(() => {
        this.heartbeatScheduler.initialized = true;
        console.log(`[Gateway] Heartbeat scheduler auto-initialized on first connection`);
      }).catch(e => {
        console.error(`[Gateway] Failed to auto-initialize heartbeat scheduler:`, e);
      });
    }
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

    const messageText = params.message;

    // Check for slash commands first
    const command = parseCommand(messageText);
    if (command) {
      const commandResult = await this.handleSlashCommandForChat(
        command,
        params.sessionKey,
      );
      
      if (commandResult.handled) {
        this.sendOk(ws, frame.id, { 
          status: "command",
          command: command.name,
          response: commandResult.response,
          error: commandResult.error,
        });
        return;
      }
    }

    // Parse inline directives
    const directives = parseDirectives(messageText);
    
    // If message is only directives, acknowledge and return
    if (isDirectiveOnly(messageText)) {
      const ack = formatDirectiveAck(directives);
      this.sendOk(ws, frame.id, { 
        status: "directive-only",
        response: ack,
        directives: {
          thinkLevel: directives.thinkLevel,
          model: directives.model,
        },
      });
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
      label: existing?.label,
    };

    try {
      // Apply directive overrides for this message
      const messageOverrides: {
        thinkLevel?: string;
        model?: { provider: string; id: string };
      } = {};
      
      if (directives.thinkLevel) {
        messageOverrides.thinkLevel = directives.thinkLevel;
      }
      if (directives.model) {
        messageOverrides.model = directives.model;
      }

      const result = await sessionStub.chatSend(
        directives.cleaned, // Send cleaned message without directives
        params.runId,
        JSON.parse(JSON.stringify(this.getAllTools())),
        params.sessionKey,
        messageOverrides,
      );

      this.sendOk(ws, frame.id, { 
        status: "started", 
        runId: result.runId,
        directives: directives.hasThinkDirective || directives.hasModelDirective ? {
          thinkLevel: directives.thinkLevel,
          model: directives.model,
        } : undefined,
      });
    } catch (e) {
      this.sendError(ws, frame.id, 500, String(e));
    }
  }

  /**
   * Handle a slash command for chat.send (no channel context)
   */
  private async handleSlashCommandForChat(
    command: { name: string; args: string },
    sessionKey: string,
  ): Promise<{ handled: boolean; response?: string; error?: string }> {
    const sessionStub = this.env.SESSION.get(
      this.env.SESSION.idFromName(sessionKey),
    );

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
            return { handled: true, error: "Invalid count. Usage: /compact [N]" };
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
            info.settings.thinkingLevel ? `Thinking: ${info.settings.thinkingLevel}` : null,
            info.resetPolicy ? `Reset: ${info.resetPolicy.mode}` : null,
          ].filter(Boolean);
          
          return { handled: true, response: lines.join("\n") };
        }

        case "model": {
          if (!command.args) {
            const info = await sessionStub.get();
            const config = this.getFullConfig();
            const effectiveModel = info.settings.model || config.model;
            const aliases = listModelAliases().join(", ");
            return {
              handled: true,
              response: `Current model: ${effectiveModel.provider}/${effectiveModel.id}\nAliases: ${aliases}`,
            };
          }
          
          const resolved = resolveModelAlias(command.args);
          if (!resolved) {
            const aliases = listModelAliases().join(", ");
            return {
              handled: true,
              error: `Unknown model: ${command.args}\nAvailable: ${aliases}`,
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

    const resolved = this.findNodeForTool(params.tool);
    if (!resolved) {
      this.sendError(
        ws,
        frame.id,
        404,
        `No node provides tool: ${params.tool}`,
      );
      return;
    }

    const nodeWs = this.nodes.get(resolved.nodeId);
    if (!nodeWs) {
      this.sendError(ws, frame.id, 503, "Node not connected");
      return;
    }

    this.pendingToolCalls[params.callId] = params.sessionKey;

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

    const resolved = this.findNodeForTool(params.tool);
    if (!resolved) {
      this.sendError(
        ws,
        frame.id,
        404,
        `No node provides tool: ${params.tool}`,
      );
      return;
    }

    const nodeWs = this.nodes.get(resolved.nodeId);
    if (!nodeWs) {
      this.sendError(ws, frame.id, 503, "Node not connected");
      return;
    }

    const callId = crypto.randomUUID();
    this.pendingClientCalls.set(callId, { ws, frameId: frame.id });

    // Send the original (un-namespaced) tool name to the node
    const evt: EventFrame<ToolInvokePayload> = {
      type: "evt",
      event: "tool.invoke",
      payload: { callId, tool: resolved.toolName, args: params.args ?? {} },
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
    const resolved = this.findNodeForTool(params.tool);
    if (!resolved) {
      return { ok: false, error: `No node provides tool: ${params.tool}` };
    }

    const nodeWs = this.nodes.get(resolved.nodeId);
    if (!nodeWs) {
      return { ok: false, error: "Node not connected" };
    }

    // Track pending call for routing result back
    this.pendingToolCalls[params.callId] = params.sessionKey;

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
    const res: ResponseFrame = {
      type: "res",
      id,
      ok: false,
      error: { code, message },
    };
    ws.send(JSON.stringify(res));
  }

  /**
   * Find the node for a namespaced tool name.
   * Tool names are formatted as "{nodeId}__{toolName}"
   */
  findNodeForTool(namespacedTool: string): { nodeId: string; toolName: string } | null {
    const separatorIndex = namespacedTool.indexOf("__");
    if (separatorIndex === -1) {
      // Legacy: no namespace, search all nodes
      for (const nodeId of this.nodes.keys()) {
        if (this.toolRegistry[nodeId]?.some((t: ToolDefinition) => t.name === namespacedTool)) {
          return { nodeId, toolName: namespacedTool };
        }
      }
      return null;
    }
    
    const nodeId = namespacedTool.slice(0, separatorIndex);
    const toolName = namespacedTool.slice(separatorIndex + 2); // +2 for '__'
    
    // Verify node exists and has this tool
    if (!this.nodes.has(nodeId)) {
      return null;
    }
    
    const hasTooled = this.toolRegistry[nodeId]?.some((t: ToolDefinition) => t.name === toolName);
    if (!hasTooled) {
      return null;
    }
    
    return { nodeId, toolName };
  }

  getAllTools(): ToolDefinition[] {
    console.log(`[Gateway] getAllTools called`);
    console.log(
      `[Gateway]   nodes in memory: [${[...this.nodes.keys()].join(", ")}]`,
    );
    console.log(
      `[Gateway]   toolRegistry keys: [${Object.keys(this.toolRegistry).join(", ")}]`,
    );
    
    // Start with native workspace tools (always available)
    const workspaceTools = getWorkspaceToolDefinitions();
    
    // Add node tools namespaced as {nodeId}__{toolName}
    const nodeTools = Array.from(this.nodes.keys()).flatMap(
      (nodeId) => (this.toolRegistry[nodeId] ?? []).map((tool) => ({
        ...tool,
        name: `${nodeId}__${tool.name}`,
      })),
    );
    
    const tools = [...workspaceTools, ...nodeTools];
    console.log(`[Gateway]   returning ${tools.length} tools (${workspaceTools.length} workspace + ${nodeTools.length} node): [${tools.map(t => t.name).join(", ")}]`);
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

    const config = await this.getConfig();

    // Check allowlist before processing
    // For DMs, check the peer ID; for groups, check the sender (if provided)
    const senderId = params.sender?.id ?? params.peer.id;
    const senderName = params.sender?.name ?? params.peer.name;
    const allowCheck = isAllowedSender(config, params.channel, senderId, params.peer.id);
    
    if (!allowCheck.allowed) {
      if (allowCheck.needsPairing) {
        // Pairing mode: store pending request
        const pairKey = `${params.channel}:${normalizeE164(senderId)}`;
        
        // Only store if not already pending
        if (!this.pendingPairs[pairKey]) {
          this.pendingPairs[pairKey] = {
            channel: params.channel,
            senderId: normalizeE164(senderId),
            senderName: senderName,
            requestedAt: Date.now(),
            firstMessage: params.message.text?.slice(0, 200), // Store preview
          };
          console.log(`[Gateway] New pairing request from ${senderId} (${senderName})`);
          
          // Optionally send "pending approval" message back
          this.sendChannelResponse(
            params.channel,
            params.accountId,
            params.peer,
            params.message.id,
            "Your message has been received. Awaiting approval from the owner.",
          );
        } else {
          console.log(`[Gateway] Pairing already pending for ${senderId}`);
        }
        
        this.sendOk(ws, frame.id, { 
          status: "pending_pairing",
          senderId: normalizeE164(senderId),
        });
        return;
      }
      
      console.log(`[Gateway] Blocked message from ${senderId}: ${allowCheck.reason}`);
      // Silently acknowledge but don't process
      this.sendOk(ws, frame.id, { 
        status: "blocked",
        reason: allowCheck.reason,
      });
      return;
    }

    // Generate session key from channel context
    // Format: agent:{agentId}:{channel}:{peerKind}:{peerId}
    // Or if identity link matched: agent:{agentId}:{canonicalName}
    // Resolve agentId from bindings configuration
    const agentId = resolveAgentIdFromBinding(
      config,
      params.channel,
      params.accountId,
      params.peer,
    );
    // Pass senderId for identity link resolution (useful for groups where sender != peer)
    // Note: senderId is already declared above for allowlist checking
    const sessionKey = this.buildSessionKeyFromChannel(agentId, params.channel, params.peer, senderId);

    const channelKey = `${params.channel}:${params.accountId}`;
    const existing = this.channelRegistry[channelKey];
    if (existing) {
      this.channelRegistry[channelKey] = {
        ...existing,
        lastMessageAt: Date.now(),
      };
    }

    const messageText = params.message.text;

    // Check for slash commands first
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
        // Send command response back to channel
        this.sendChannelResponse(
          params.channel,
          params.accountId,
          params.peer,
          params.message.id,
          commandResult.response || commandResult.error || "Command executed",
        );
        this.sendOk(ws, frame.id, { 
          status: "command",
          command: command.name,
          response: commandResult.response,
        });
        return;
      }
    }

    // Parse inline directives
    const directives = parseDirectives(messageText);
    
    // If message is only directives, acknowledge and return
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
      this.sendOk(ws, frame.id, { 
        status: "directive-only",
        directives: {
          thinkLevel: directives.thinkLevel,
          model: directives.model,
        },
      });
      return;
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

    const sessionStub = this.env.SESSION.get(
      this.env.SESSION.idFromName(sessionKey),
    );

    // Generate runId before try block so it's accessible in catch for cleanup
    const runId = crypto.randomUUID();

    try {

      // Apply directive overrides for this message
      const messageOverrides: {
        thinkLevel?: string;
        model?: { provider: string; id: string };
      } = {};
      
      if (directives.thinkLevel) {
        messageOverrides.thinkLevel = directives.thinkLevel;
      }
      if (directives.model) {
        messageOverrides.model = directives.model;
      }

      // Process media attachments:
      // 1. Transcribe audio (Workers AI free > OpenAI fallback)
      // 2. Store all media in R2 (returns r2Key references)
      const config = this.getFullConfig();
      const inboundMedia = params.message.media;
      
      let processedMedia = await processMediaWithTranscription(
        inboundMedia,
        {
          workersAi: this.env.AI,
          openaiApiKey: config.apiKeys.openai,
          preferredProvider: config.transcription.provider,
        },
      );
      
      // Store media in R2 (replaces base64 data with r2Key references)
      if (processedMedia.length > 0) {
        processedMedia = await processInboundMedia(
          processedMedia,
          this.env.STORAGE,
          sessionKey,
        );
      }

      // Store channel context by runId (not sessionKey) to handle queued messages correctly.
      // Each message gets its own runId, so responses route back to the correct context.
      this.pendingChannelResponses[runId] = {
        channel: params.channel,
        accountId: params.accountId,
        peer: params.peer,
        inboundMessageId: params.message.id,
      };

      // Update last active context for heartbeat delivery
      // This tracks where the user last messaged from
      this.lastActiveContext[agentId] = {
        agentId,
        channel: params.channel,
        accountId: params.accountId,
        peer: params.peer,
        sessionKey,
        timestamp: Date.now(),
      };

      // Send typing indicator to channel before processing
      this.sendTypingToChannel(
        params.channel,
        params.accountId,
        params.peer,
        sessionKey,
        true,
      );

      const result = await sessionStub.chatSend(
        directives.cleaned, // Send cleaned message without directives
        runId,
        JSON.parse(JSON.stringify(this.getAllTools())),
        sessionKey,
        messageOverrides,
        processedMedia.length > 0 ? processedMedia : undefined,
      );

      this.sendOk(ws, frame.id, { 
        status: "started", 
        runId: result.runId,
        sessionKey,
        directives: directives.hasThinkDirective || directives.hasModelDirective ? {
          thinkLevel: directives.thinkLevel,
          model: directives.model,
        } : undefined,
      });
    } catch (e) {
      // Stop typing indicator on error
      this.sendTypingToChannel(
        params.channel,
        params.accountId,
        params.peer,
        sessionKey,
        false,
      );
      // Clean up pending channel response (keyed by runId)
      delete this.pendingChannelResponses[runId];
      this.sendError(ws, frame.id, 500, String(e));
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
    const sessionStub = this.env.SESSION.get(
      this.env.SESSION.idFromName(sessionKey),
    );

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
            return { handled: true, error: "Invalid count. Usage: /compact [N]" };
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
            info.settings.thinkingLevel ? `• Thinking: ${info.settings.thinkingLevel}` : null,
            info.resetPolicy ? `• Reset: ${info.resetPolicy.mode}` : null,
          ].filter(Boolean);
          
          return { handled: true, response: lines.join("\n") };
        }

        case "model": {
          if (!command.args) {
            // Show current model
            const info = await sessionStub.get();
            const config = this.getFullConfig();
            const effectiveModel = info.settings.model || config.model;
            const aliases = listModelAliases().join(", ");
            return {
              handled: true,
              response: `Current model: ${effectiveModel.provider}/${effectiveModel.id}\n\nAliases: ${aliases}`,
            };
          }
          
          // Set model
          const resolved = resolveModelAlias(command.args);
          if (!resolved) {
            const aliases = listModelAliases().join(", ");
            return {
              handled: true,
              error: `Unknown model: ${command.args}\n\nAvailable: ${aliases}`,
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
  private getChannelBinding(channel: ChannelId): (Fetcher & ChannelWorkerInterface) | undefined {
    // Map channel IDs to service bindings
    // Add new channels here as they're configured
    switch (channel) {
      case "whatsapp":
        return (this.env as any).CHANNEL_WHATSAPP as Fetcher & ChannelWorkerInterface;
      case "discord":
        return (this.env as any).CHANNEL_DISCORD as Fetcher & ChannelWorkerInterface;
      case "test":
        return (this.env as any).CHANNEL_TEST as Fetcher & ChannelWorkerInterface;
      default:
        return undefined;
    }
  }

  /**
   * Send a response back to a channel via Service Binding RPC.
   * Falls back to WebSocket if channel binding not configured.
   * Fire-and-forget - errors are logged but not propagated.
   */
  private sendChannelResponse(
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
      channelBinding.send(accountId, message)
        .then(result => {
          if (!result.ok) {
            console.error(`[Gateway] Channel RPC send failed: ${result.error}`);
          }
        })
        .catch(e => {
          console.error(`[Gateway] Channel RPC error:`, e);
          // Could implement WebSocket fallback here if needed
        });
      return;
    }

    // WebSocket fallback (for backwards compatibility during migration)
    const channelKey = `${channel}:${accountId}`;
    const channelWs = this.channels.get(channelKey);
    
    if (!channelWs || channelWs.readyState !== WebSocket.OPEN) {
      console.log(`[Gateway] Channel ${channelKey} not connected for command response`);
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
      channelBinding.setTyping(accountId, peer as ChannelPeer, typing)
        .then(() => {
          console.log(`[Gateway] Sent typing=${typing} via RPC to ${channel}:${accountId}`);
        })
        .catch(e => {
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
    console.log(`[Gateway] Sent typing=${typing} to ${channelKey} for ${peer.id}`);
  }

  pendingChannelResponses = PersistedObject<Record<string, {
    channel: ChannelId;
    accountId: string;
    peer: PeerInfo;
    inboundMessageId: string;
    agentId?: string; // For heartbeat deduplication
  }>>(this.ctx.storage.kv, { prefix: "pendingChannelResponses:" });

  private buildSessionKeyFromChannel(
    agentId: string, 
    channel: ChannelId, 
    peer: PeerInfo,
    senderId?: string,
  ): string {
    const config = this.getFullConfig();
    
    // Check for identity link - use senderId if provided (for groups), otherwise peer.id
    const idToCheck = senderId || peer.id;
    const linkedIdentity = resolveLinkedIdentity(config, channel, idToCheck);
    
    if (linkedIdentity) {
      // Identity link found - use canonical name for session key
      // Format: agent:{agentId}:{canonicalName}
      console.log(`[Gateway] Identity link: ${idToCheck} -> ${linkedIdentity}`);
      return `agent:${agentId}:${linkedIdentity}`;
    }
    
    // No identity link - use standard channel:peer format
    const sanitizedPeerId = peer.id.replace(/[^a-zA-Z0-9+\-_@.]/g, "_");
    return `agent:${agentId}:${channel}:${peer.kind}:${sanitizedPeerId}`;
  }

  /**
   * Find a connected channel WebSocket for a given channel type
   */
  private findChannelForMessage(channel: string): string | null {
    for (const [channelKey, ws] of this.channels.entries()) {
      if (channelKey.startsWith(`${channel}:`) && ws.readyState === WebSocket.OPEN) {
        return channelKey;
      }
    }
    return null;
  }

  handleChannelsList(ws: WebSocket, frame: RequestFrame) {
    const channels = Object.values(this.channelRegistry);
    this.sendOk(ws, frame.id, { 
      channels,
      count: channels.length,
    });
  }

  // ---- Channel Management RPC handlers ----

  async handleChannelStart(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { channel: string; accountId?: string; config?: Record<string, unknown> } | undefined;

    if (!params?.channel) {
      this.sendError(ws, frame.id, 400, "channel required");
      return;
    }

    const channel = params.channel as ChannelId;
    const accountId = params.accountId ?? "default";
    const config = params.config ?? {};

    const binding = this.getChannelBinding(channel);
    if (!binding) {
      this.sendError(ws, frame.id, 404, `Unknown channel: ${channel}`);
      return;
    }

    try {
      const result = await binding.start(accountId, config);
      if (result.ok) {
        // Update channel registry
        const channelKey = `${channel}:${accountId}`;
        this.channelRegistry[channelKey] = {
          channel,
          accountId,
          connectedAt: Date.now(),
        };
        this.sendOk(ws, frame.id, { ok: true, channel, accountId });
      } else {
        this.sendError(ws, frame.id, 500, result.error);
      }
    } catch (e) {
      this.sendError(ws, frame.id, 500, e instanceof Error ? e.message : String(e));
    }
  }

  async handleChannelStop(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { channel: string; accountId?: string } | undefined;

    if (!params?.channel) {
      this.sendError(ws, frame.id, 400, "channel required");
      return;
    }

    const channel = params.channel as ChannelId;
    const accountId = params.accountId ?? "default";

    const binding = this.getChannelBinding(channel);
    if (!binding) {
      this.sendError(ws, frame.id, 404, `Unknown channel: ${channel}`);
      return;
    }

    try {
      const result = await binding.stop(accountId);
      if (result.ok) {
        // Remove from channel registry
        const channelKey = `${channel}:${accountId}`;
        delete this.channelRegistry[channelKey];
        this.sendOk(ws, frame.id, { ok: true, channel, accountId });
      } else {
        this.sendError(ws, frame.id, 500, result.error);
      }
    } catch (e) {
      this.sendError(ws, frame.id, 500, e instanceof Error ? e.message : String(e));
    }
  }

  async handleChannelStatus(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { channel: string; accountId?: string } | undefined;

    if (!params?.channel) {
      this.sendError(ws, frame.id, 400, "channel required");
      return;
    }

    const channel = params.channel as ChannelId;
    const accountId = params.accountId;

    const binding = this.getChannelBinding(channel);
    if (!binding) {
      this.sendError(ws, frame.id, 404, `Unknown channel: ${channel}`);
      return;
    }

    try {
      const statuses = await binding.status(accountId);
      this.sendOk(ws, frame.id, { channel, accounts: statuses });
    } catch (e) {
      this.sendError(ws, frame.id, 500, e instanceof Error ? e.message : String(e));
    }
  }

  async handleChannelLogin(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { channel: string; accountId?: string; force?: boolean } | undefined;

    if (!params?.channel) {
      this.sendError(ws, frame.id, 400, "channel required");
      return;
    }

    const channel = params.channel as ChannelId;
    const accountId = params.accountId ?? "default";

    const binding = this.getChannelBinding(channel);
    if (!binding) {
      this.sendError(ws, frame.id, 404, `Unknown channel: ${channel}`);
      return;
    }

    if (!binding.login) {
      this.sendError(ws, frame.id, 400, `Channel ${channel} does not support login flow`);
      return;
    }

    try {
      const result = await binding.login(accountId, { force: params.force });
      if (result.ok) {
        this.sendOk(ws, frame.id, { 
          ok: true, 
          channel, 
          accountId,
          qrDataUrl: result.qrDataUrl,
          message: result.message,
        });
      } else {
        this.sendError(ws, frame.id, 500, result.error);
      }
    } catch (e) {
      this.sendError(ws, frame.id, 500, e instanceof Error ? e.message : String(e));
    }
  }

  async handleChannelLogout(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { channel: string; accountId?: string } | undefined;

    if (!params?.channel) {
      this.sendError(ws, frame.id, 400, "channel required");
      return;
    }

    const channel = params.channel as ChannelId;
    const accountId = params.accountId ?? "default";

    const binding = this.getChannelBinding(channel);
    if (!binding) {
      this.sendError(ws, frame.id, 404, `Unknown channel: ${channel}`);
      return;
    }

    if (!binding.logout) {
      this.sendError(ws, frame.id, 400, `Channel ${channel} does not support logout`);
      return;
    }

    try {
      const result = await binding.logout(accountId);
      if (result.ok) {
        // Remove from channel registry
        const channelKey = `${channel}:${accountId}`;
        delete this.channelRegistry[channelKey];
        this.sendOk(ws, frame.id, { ok: true, channel, accountId });
      } else {
        this.sendError(ws, frame.id, 500, result.error);
      }
    } catch (e) {
      this.sendError(ws, frame.id, 500, e instanceof Error ? e.message : String(e));
    }
  }

  // ---- Heartbeat RPC handlers ----

  async handleHeartbeatTrigger(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { agentId?: string } | undefined;
    const agentId = params?.agentId ?? "main";
    
    const result = await this.triggerHeartbeat(agentId);
    this.sendOk(ws, frame.id, result);
  }

  async handleHeartbeatStatus(ws: WebSocket, frame: RequestFrame) {
    const status = await this.getHeartbeatStatus();
    this.sendOk(ws, frame.id, { agents: status });
  }

  async handleHeartbeatStart(ws: WebSocket, frame: RequestFrame) {
    await this.scheduleHeartbeat();
    const status = await this.getHeartbeatStatus();
    this.sendOk(ws, frame.id, { 
      message: "Heartbeat scheduler started",
      agents: status,
    });
  }

  // ---- Pairing System ----

  handlePairList(ws: WebSocket, frame: RequestFrame) {
    const pairs = { ...this.pendingPairs };
    this.sendOk(ws, frame.id, { pairs });
  }

  async handlePairApprove(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { channel: string; senderId: string } | undefined;
    
    if (!params?.channel || !params?.senderId) {
      this.sendError(ws, frame.id, 400, "channel and senderId required");
      return;
    }
    
    const normalizedId = normalizeE164(params.senderId);
    const pairKey = `${params.channel}:${normalizedId}`;
    
    const pending = this.pendingPairs[pairKey];
    if (!pending) {
      this.sendError(ws, frame.id, 404, `No pending pairing for ${pairKey}`);
      return;
    }
    
    // Add to allowFrom
    const config = this.getFullConfig();
    const channelConfig = config.channels[params.channel];
    const currentAllowFrom = channelConfig?.allowFrom ?? [];
    
    if (!currentAllowFrom.includes(normalizedId)) {
      const newAllowFrom = [...currentAllowFrom, normalizedId];
      this.setConfigPath(`channels.${params.channel}.allowFrom`, newAllowFrom);
    }
    
    // Remove from pending
    delete this.pendingPairs[pairKey];
    
    console.log(`[Gateway] Approved pairing for ${normalizedId}`);
    
    // Send confirmation message back to the channel
    // Find a connected channel to send through
    const channelKey = this.findChannelForMessage(params.channel);
    if (channelKey) {
      const [channel, accountId] = channelKey.split(":");
      this.sendChannelResponse(
        params.channel as ChannelId,
        accountId,
        { kind: "dm", id: normalizedId }, // peer
        "", // no replyToId
        `You're now connected! Feel free to send me a message.`,
      );
    }
    
    this.sendOk(ws, frame.id, { 
      approved: true,
      senderId: normalizedId,
      senderName: pending.senderName,
    });
  }

  handlePairReject(ws: WebSocket, frame: RequestFrame) {
    const params = frame.params as { channel: string; senderId: string } | undefined;
    
    if (!params?.channel || !params?.senderId) {
      this.sendError(ws, frame.id, 400, "channel and senderId required");
      return;
    }
    
    const normalizedId = normalizeE164(params.senderId);
    const pairKey = `${params.channel}:${normalizedId}`;
    
    if (!this.pendingPairs[pairKey]) {
      this.sendError(ws, frame.id, 404, `No pending pairing for ${pairKey}`);
      return;
    }
    
    // Remove from pending
    delete this.pendingPairs[pairKey];
    
    console.log(`[Gateway] Rejected pairing for ${normalizedId}`);
    
    this.sendOk(ws, frame.id, { 
      rejected: true,
      senderId: normalizedId,
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
      return;
    }
    
    // Handle nested paths like "channels.whatsapp.allowFrom"
    // Get a plain object copy of the config store (PersistedObject proxy can't be cloned)
    const plainConfig = JSON.parse(JSON.stringify(this.configStore)) as Record<string, unknown>;
    
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

  private getFullConfig(): GsvConfig {
    return mergeConfig(DEFAULT_CONFIG, { ...this.configStore } as GsvConfigInput);
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
    // Deep clone to avoid returning Proxy objects that can't be serialized in RPC
    return JSON.parse(JSON.stringify(this.getFullConfig()));
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

    // Check if this is a heartbeat response (inboundMessageId starts with "heartbeat:")
    const isHeartbeat = context.inboundMessageId.startsWith("heartbeat:");
    
    if (isHeartbeat) {
      const { deliver, cleanedText } = shouldDeliverResponse(text);
      
      if (!deliver) {
        console.log(`[Gateway] Heartbeat response suppressed (HEARTBEAT_OK or short ack)`);
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
          (now - state.lastHeartbeatSentAt) < DEDUP_WINDOW_MS
        ) {
          console.log(`[Gateway] Heartbeat response deduplicated for ${agentId} (same text within 24h)`);
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
      const message: ChannelOutboundMessage = JSON.parse(JSON.stringify({
        peer: {
          kind: context.peer.kind,
          id: context.peer.id,
          name: context.peer.name,
        },
        text,
        replyToId,
      }));
      channelBinding.send(context.accountId, message)
        .then(result => {
          if (result.ok) {
            console.log(`[Gateway] Routed response via RPC to ${context.channel}:${context.accountId}${isHeartbeat ? ' (heartbeat)' : ''}`);
          } else {
            console.error(`[Gateway] Channel RPC send failed: ${result.error}`);
          }
        })
        .catch(e => {
          console.error(`[Gateway] Channel RPC error:`, e);
        });
      return;
    }

    // WebSocket fallback (for channels that connect via WebSocket)
    const channelKey = `${context.channel}:${context.accountId}`;
    const channelWs = this.channels.get(channelKey);
    
    if (!channelWs || channelWs.readyState !== WebSocket.OPEN) {
      console.log(`[Gateway] Channel ${channelKey} not connected for outbound (no RPC binding, no WebSocket)`);
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
    console.log(`[Gateway] Routed response to channel ${channelKey}${isHeartbeat ? ' (heartbeat)' : ''}`);
  }

  // ---- Heartbeat System ----

  /**
   * Schedule the next heartbeat alarm
   */
  private async scheduleHeartbeat(): Promise<void> {
    const config = this.getConfig();
    const agents = config.agents.list.length > 0 ? config.agents.list : [{ id: "main", default: true }];
    
    let nextAlarmTime: number | null = null;
    
    for (const agent of agents) {
      const heartbeatConfig = getHeartbeatConfig(config, agent.id);
      const nextTime = getNextHeartbeatTime(heartbeatConfig);
      
      if (nextTime !== null) {
        // Update state
        const state = this.heartbeatState[agent.id] ?? {
          agentId: agent.id,
          nextHeartbeatAt: null,
          lastHeartbeatAt: null,
          lastHeartbeatText: null,
          lastHeartbeatSentAt: null,
        };
        state.nextHeartbeatAt = nextTime;
        this.heartbeatState[agent.id] = state;
        
        // Track earliest alarm
        if (nextAlarmTime === null || nextTime < nextAlarmTime) {
          nextAlarmTime = nextTime;
        }
      }
    }
    
    if (nextAlarmTime !== null) {
      await this.ctx.storage.setAlarm(nextAlarmTime);
      console.log(`[Gateway] Heartbeat alarm scheduled for ${new Date(nextAlarmTime).toISOString()}`);
    }
  }

  /**
   * Handle alarm (heartbeat trigger)
   */
  async alarm(): Promise<void> {
    console.log(`[Gateway] Heartbeat alarm fired`);
    
    const config = await this.getConfig();
    const now = Date.now();
    
    // Find agents whose heartbeat is due
    for (const agentId of Object.keys(this.heartbeatState)) {
      const state = this.heartbeatState[agentId];
      if (!state.nextHeartbeatAt || state.nextHeartbeatAt > now) continue;
      
      const heartbeatConfig = getHeartbeatConfig(config, agentId);
      
      // Check active hours
      if (!isWithinActiveHours(heartbeatConfig.activeHours)) {
        console.log(`[Gateway] Heartbeat for ${agentId} skipped (outside active hours)`);
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
    
    // Schedule next alarm
    await this.scheduleHeartbeat();
  }

  /**
   * Run a heartbeat for an agent
   */
  private async runHeartbeat(
    agentId: string,
    config: HeartbeatConfig,
    reason: "interval" | "manual" | "cron",
  ): Promise<HeartbeatResult> {
    console.log(`[Gateway] Running heartbeat for agent ${agentId} (reason: ${reason})`);
    
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
        console.log(`[Gateway] Skipping heartbeat for ${agentId}: outside active hours`);
        result.skipped = true;
        result.skipReason = "outside_active_hours";
        return result;
      }
    }
    
    // Skip check 2: Empty HEARTBEAT.md file (unless manual trigger)
    if (reason !== "manual") {
      const heartbeatFile = await loadHeartbeatFile(this.env.STORAGE, agentId);
      if (!heartbeatFile.exists || isHeartbeatFileEmpty(heartbeatFile.content)) {
        console.log(`[Gateway] Skipping heartbeat for ${agentId}: HEARTBEAT.md is empty or missing`);
        result.skipped = true;
        result.skipReason = heartbeatFile.exists ? "empty_heartbeat_file" : "no_heartbeat_file";
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
        console.log(`[Gateway] Skipping heartbeat for ${agentId}: session is busy (queue: ${stats.queueSize})`);
        result.skipped = true;
        result.skipReason = "session_busy";
        return result;
      }
    }
    
    // Resolve delivery target from config
    const target = config.target ?? "last";
    
    // Determine session and delivery context
    let sessionKey: string;
    let deliveryContext: { channel: ChannelId; accountId: string; peer: PeerInfo } | null = null;
    
    if (target === "none") {
      // Silent heartbeat - run in isolated session, no delivery
      sessionKey = `agent:${agentId}:heartbeat:system:internal`;
      console.log(`[Gateway] Heartbeat target=none, using isolated session`);
    } else if (target === "last" && lastActive) {
      // Use last active session and deliver to that channel
      sessionKey = lastActive.sessionKey;
      deliveryContext = {
        channel: lastActive.channel,
        accountId: lastActive.accountId,
        peer: lastActive.peer,
      };
      console.log(`[Gateway] Heartbeat target=last, delivering to ${lastActive.channel}:${lastActive.peer.id}`);
    } else if (target !== "last" && target !== "none") {
      // Specific channel target (e.g., "whatsapp")
      // For now, use last active if channel matches
      if (lastActive && lastActive.channel === target) {
        sessionKey = lastActive.sessionKey;
        deliveryContext = {
          channel: lastActive.channel,
          accountId: lastActive.accountId,
          peer: lastActive.peer,
        };
        console.log(`[Gateway] Heartbeat target=${target}, matched last active`);
      } else {
        // No matching context, run silently
        sessionKey = `agent:${agentId}:heartbeat:system:internal`;
        console.log(`[Gateway] Heartbeat target=${target}, no matching context, running silently`);
      }
    } else {
      // No last active context, run in isolated session
      sessionKey = `agent:${agentId}:heartbeat:system:internal`;
      console.log(`[Gateway] Heartbeat: no last active context, running silently`);
    }
    
    // Set sessionKey in result
    result.sessionKey = sessionKey;
    
    // Get the session DO
    const session = this.env.SESSION.get(
      this.env.SESSION.idFromName(sessionKey),
    );
    
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
    
    try {
      await session.chatSend(prompt, runId, [], sessionKey);
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
  async triggerHeartbeat(agentId: string): Promise<{ ok: boolean; message: string; skipped?: boolean; skipReason?: string }> {
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
      return { ok: false, message: `Heartbeat failed for agent ${agentId}: ${result.error}` };
    }
    
    return { ok: true, message: `Heartbeat triggered for agent ${agentId} (session: ${result.sessionKey})` };
  }

  /**
   * Get heartbeat status for all agents
   */
  async getHeartbeatStatus(): Promise<Record<string, HeartbeatState & { 
    lastActive?: {
      channel: ChannelId;
      accountId: string;
      peer: PeerInfo;
      timestamp: number;
    } 
  }>> {
    const result: Record<string, HeartbeatState & { lastActive?: { channel: ChannelId; accountId: string; peer: PeerInfo; timestamp: number } }> = {};
    
    // Merge heartbeat state with last active context
    for (const [agentId, state] of Object.entries(this.heartbeatState)) {
      const lastActive = this.lastActiveContext[agentId];
      result[agentId] = {
        ...state,
        lastActive: lastActive ? {
          channel: lastActive.channel,
          accountId: lastActive.accountId,
          peer: lastActive.peer,
          timestamp: lastActive.timestamp,
        } : undefined,
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
  }> {
    if (!params?.channel || !params?.accountId || !params?.peer || !params?.message) {
      return { ok: false, error: "channel, accountId, peer, and message required" };
    }

    const config = await this.getConfig();

    // Check allowlist
    const senderId = params.sender?.id ?? params.peer.id;
    const senderName = params.sender?.name ?? params.peer.name;
    const allowCheck = isAllowedSender(config, params.channel, senderId, params.peer.id);
    
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
          console.log(`[Gateway] New pairing request from ${senderId} (${senderName})`);
          
          // Send "pending approval" message back via channel
          this.sendChannelResponse(
            params.channel,
            params.accountId,
            params.peer,
            params.message.id,
            "Your message has been received. Awaiting approval from the owner.",
          );
        }
        return { ok: true, status: "pending_pairing" };
      }
      
      console.log(`[Gateway] Blocked message from ${senderId}: ${allowCheck.reason}`);
      return { ok: true, status: "blocked" };
    }

    // Build session key
    const agentId = resolveAgentIdFromBinding(config, params.channel, params.accountId, params.peer);
    const sessionKey = this.buildSessionKeyFromChannel(agentId, params.channel, params.peer, senderId);

    // Update channel registry
    const channelKey = `${params.channel}:${params.accountId}`;
    const existing = this.channelRegistry[channelKey];
    if (existing) {
      this.channelRegistry[channelKey] = { ...existing, lastMessageAt: Date.now() };
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
        return { ok: true, sessionKey, status: "command" };
      }
    }

    // Parse directives
    const directives = parseDirectives(messageText);
    
    if (isDirectiveOnly(messageText)) {
      const ack = formatDirectiveAck(directives);
      if (ack) {
        this.sendChannelResponse(params.channel, params.accountId, params.peer, params.message.id, ack);
      }
      return { ok: true, sessionKey, status: "directive-only" };
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

    const sessionStub = this.env.SESSION.get(this.env.SESSION.idFromName(sessionKey));

    // Generate runId before try block so it's accessible in catch for cleanup
    const runId = crypto.randomUUID();

    try {
      const messageOverrides: { thinkLevel?: string; model?: { provider: string; id: string } } = {};
      if (directives.thinkLevel) messageOverrides.thinkLevel = directives.thinkLevel;
      if (directives.model) messageOverrides.model = directives.model;

      // Process media
      const fullConfig = this.getFullConfig();
      let processedMedia = await processMediaWithTranscription(
        params.message.media,
        {
          workersAi: this.env.AI,
          openaiApiKey: fullConfig.apiKeys.openai,
          preferredProvider: fullConfig.transcription.provider,
        },
      );
      
      if (processedMedia.length > 0) {
        processedMedia = await processInboundMedia(processedMedia, this.env.STORAGE, sessionKey);
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
      this.sendTypingToChannel(params.channel, params.accountId, params.peer, sessionKey, true);

      await sessionStub.chatSend(
        directives.cleaned,
        runId,
        JSON.parse(JSON.stringify(this.getAllTools())),
        sessionKey,
        messageOverrides,
        processedMedia.length > 0 ? processedMedia : undefined,
      );

      return { ok: true, sessionKey, status: "started" };
    } catch (e) {
      this.sendTypingToChannel(params.channel, params.accountId, params.peer, sessionKey, false);
      delete this.pendingChannelResponses[runId];
      return { ok: false, sessionKey, error: e instanceof Error ? e.message : String(e) };
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
    console.log(`[Gateway] Channel status changed: ${channelKey} connected=${status.connected}`);
    
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
