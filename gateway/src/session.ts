import { DurableObject } from "cloudflare:workers";
import { PersistedObject } from "./stored";
import type { ToolDefinition } from "./types";
import type { GsvConfig } from "./config";
import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Tool,
  Context,
  TextContent,
  ToolCall,
} from "@mariozechner/pi-ai";
import { completeSimple, getModel, type Model, type Api } from "@mariozechner/pi-ai";
import { archivePartialMessages, archiveSession } from "./storage";

type PendingToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

type ChatSendResult = {
  ok: boolean;
  runId: string;
};

type ToolResultInput = {
  callId: string;
  result?: unknown;
  error?: string;
};

export type SessionSettings = {
  model?: { provider: string; id: string };
  thinkingLevel?: "none" | "low" | "medium" | "high";
  systemPrompt?: string;
  maxTokens?: number;
};

export type ResetPolicy = {
  mode: "manual" | "daily" | "idle";
  atHour?: number; // For daily mode (0-23)
  idleMinutes?: number; // For idle mode
};

export type TokenUsage = {
  input: number;
  output: number;
  total: number;
};

export type SessionState = {
  sessionId: string;
  sessionKey: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];

  inputTokens: number;
  outputTokens: number;
  totalTokens: number;

  settings: SessionSettings;

  resetPolicy?: ResetPolicy;
  lastResetAt?: number;

  previousSessionIds: string[];

  label?: string;
  origin?: {
    channel?: string;
    clientId?: string;
  };
};

export type SessionInfo = {
  sessionId: string;
  sessionKey: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  tokens: TokenUsage;
  settings: SessionSettings;
  resetPolicy?: ResetPolicy;
  lastResetAt?: number;
  previousSessionIds: string[];
  label?: string;
};

export type SessionStats = {
  sessionKey: string;
  sessionId: string;
  messageCount: number;
  tokens: TokenUsage;
  createdAt: number;
  updatedAt: number;
  uptime: number; // ms since createdAt
};

export type ResetResult = {
  ok: boolean;
  sessionKey: string;
  oldSessionId: string;
  newSessionId: string;
  archivedMessages: number;
  archivedTo?: string;
  tokensCleared: TokenUsage;
};

export type SessionPatchParams = {
  settings?: Partial<SessionSettings>;
  label?: string;
  resetPolicy?: ResetPolicy;
};

export class Session extends DurableObject<Env> {
  private static generateSessionId(): string {
    return crypto.randomUUID();
  }

  state = PersistedObject<SessionState>(this.ctx.storage.kv, {
    prefix: "state:",
    defaults: {
      sessionId: Session.generateSessionId(),
      sessionKey: "", // set on first chatSend
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      settings: {},
      previousSessionIds: [],
    },
  });

  pendingToolCalls = PersistedObject<Record<string, PendingToolCall>>(
    this.ctx.storage.kv,
    { prefix: "pendingToolCalls:" },
  );

  currentRunId: string | null = null;
  currentTools: ToolDefinition[] = [];

  async chatSend(message: string, runId: string, tools: ToolDefinition[], sessionKey: string): Promise<ChatSendResult> {
    this.currentRunId = runId;
    this.currentTools = tools;

    if (!this.state.sessionKey) {
      this.state.sessionKey = sessionKey;
    }

    if (this.shouldAutoReset()) {
      console.log(`[Session] Auto-reset triggered for ${sessionKey}`);
      await this.doReset();
    }

    const userMessage: UserMessage = {
      role: "user",
      content: message,
      timestamp: Date.now(),
    };
    this.state.messages = [...this.state.messages, userMessage];
    this.state.updatedAt = Date.now();

    await this.continueAgentLoop();

    return { ok: true, runId };
  }

  private shouldAutoReset(): boolean {
    const policy = this.state.resetPolicy;
    if (!policy || policy.mode === "manual") return false;

    const now = Date.now();

    if (policy.mode === "daily") {
      const atHour = policy.atHour ?? 4; // Default 4am
      const resetTime = this.getDailyResetTime(now, atHour);
      return this.state.updatedAt < resetTime;
    }

    if (policy.mode === "idle") {
      const idleMs = (policy.idleMinutes ?? 60) * 60_000;
      return now - this.state.updatedAt > idleMs;
    }

    return false;
  }

  private getDailyResetTime(now: number, atHour: number): number {
    const date = new Date(now);
    date.setHours(atHour, 0, 0, 0);
    // If the reset time is in the future, use yesterday's reset time
    if (date.getTime() > now) {
      date.setDate(date.getDate() - 1);
    }
    return date.getTime();
  }

  async toolResult(input: ToolResultInput): Promise<{ ok: boolean }> {
    const toolCall = this.pendingToolCalls[input.callId];
    if (!toolCall) {
      console.warn(`Unknown tool call: ${input.callId}`);
      return { ok: false };
    }

    if (input.error) {
      toolCall.error = input.error;
    } else {
      toolCall.result = input.result;
    }
    this.pendingToolCalls[input.callId] = toolCall;

    if (this.allToolsResolved()) {
      this.ctx.storage.deleteAlarm();
      await this.continueAgentLoop();
    }

    return { ok: true };
  }

  private allToolsResolved(): boolean {
    for (const callId of Object.keys(this.pendingToolCalls)) {
      const call = this.pendingToolCalls[callId];
      if (call.result === undefined && !call.error) return false;
    }
    return true;
  }

  private async continueAgentLoop(): Promise<void> {
    const pendingCallIds = Object.keys(this.pendingToolCalls);
    if (pendingCallIds.length > 0) {
      for (const callId of pendingCallIds) {
        const call = this.pendingToolCalls[callId];
        const content = call.error
          ? `Error: ${call.error}`
          : typeof call.result === "string"
            ? call.result
            : JSON.stringify(call.result);

        const toolResultMessage: ToolResultMessage = {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: content }],
          isError: !!call.error,
          timestamp: Date.now(),
        };
        this.state.messages = [...this.state.messages, toolResultMessage];
        delete this.pendingToolCalls[callId];
      }
    }

    let response: AssistantMessage;
    try {
      response = await this.callLlm();
    } catch (e) {
      await this.broadcastToClients({
        runId: this.currentRunId,
        sessionKey: this.state.sessionKey,
        state: "error",
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    if (!response.content || response.content.length === 0) {
      console.error("[Session] LLM returned empty content, not saving to history");
      await this.broadcastToClients({
        runId: this.currentRunId,
        sessionKey: this.state.sessionKey,
        state: "error",
        error: "LLM returned empty response",
      });
      return;
    }
    
    this.state.messages = [...this.state.messages, response];
    this.state.updatedAt = Date.now();

    const toolCalls = response.content.filter(
      (block): block is ToolCall => block.type === "toolCall"
    );

    if (toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        await this.requestToolExecution({
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.arguments,
        });
      }
      this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }

    await this.broadcastToClients({
      runId: this.currentRunId,
      sessionKey: this.state.sessionKey,
      state: "final",
      message: response,
    });
  }

  private async callLlm(): Promise<AssistantMessage> {
    const gateway = this.env.GATEWAY.get(this.env.GATEWAY.idFromName("singleton"));
    const config: GsvConfig = await gateway.getConfig();

    const sessionSettings = this.state.settings;
    const effectiveModel = sessionSettings.model || config.model;
    const effectiveSystemPrompt =
      sessionSettings.systemPrompt || config.systemPrompt || "You are a helpful assistant with access to tools.";

    const tools: Tool[] = this.currentTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Tool["parameters"],
    }));

    const context: Context = {
      systemPrompt: effectiveSystemPrompt,
      messages: this.state.messages,
      tools: tools.length > 0 ? tools : undefined,
    };

    console.log("[Session] Messages being sent to LLM:", this.state.messages.length);

    let model: Model<Api> | undefined;
    try {
      const provider = effectiveModel.provider;
      const modelId = effectiveModel.id;

      if (provider === "anthropic") {
        model = getModel("anthropic", modelId as Parameters<typeof getModel<"anthropic", any>>[1]);
      } else if (provider === "openai") {
        model = getModel("openai", modelId as Parameters<typeof getModel<"openai", any>>[1]);
      } else if (provider === "google") {
        model = getModel("google", modelId as Parameters<typeof getModel<"google", any>>[1]);
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }
    } catch (e) {
      throw new Error(`Model not found: ${effectiveModel.provider}/${effectiveModel.id}`);
    }

    if (!model) {
      throw new Error(`Model not found: ${effectiveModel.provider}/${effectiveModel.id}`);
    }

    let apiKey: string | undefined;
    if (effectiveModel.provider === "anthropic") {
      apiKey = config.apiKeys.anthropic;
    } else if (effectiveModel.provider === "openai") {
      apiKey = config.apiKeys.openai;
    } else if (effectiveModel.provider === "google") {
      apiKey = config.apiKeys.google;
    }

    if (!apiKey) {
      throw new Error(`API key not configured for provider: ${effectiveModel.provider}`);
    }

    const response = await completeSimple(model, context, { apiKey });

    // Track token usage from response
    if (response.usage) {
      const usage = response.usage;
      this.state.inputTokens += usage.input || 0;
      this.state.outputTokens += usage.output || 0;
      this.state.totalTokens += usage.totalTokens || 0;
      console.log(
        `[Session] Token usage: +${usage.input}/${usage.output} (total: ${this.state.inputTokens}/${this.state.outputTokens})`
      );
    }

    return response;
  }

  private async broadcastToClients(payload: {
    runId: string | null;
    sessionKey: string;
    state: "partial" | "final" | "error";
    message?: unknown;
    error?: string;
  }): Promise<void> {
    if (!this.state.sessionKey) {
      return;
    }
    const gateway = this.env.GATEWAY.get(this.env.GATEWAY.idFromName("singleton"));
    gateway.broadcastToSession(this.state.sessionKey, payload);
  }

  private async requestToolExecution(toolCall: PendingToolCall): Promise<void> {
    if (!this.state.sessionKey) {
      console.error("Cannot request tool: sessionKey not set");
      return;
    }

    // Store pending call
    this.pendingToolCalls[toolCall.id] = toolCall;

    // Request tool execution via Gateway RPC
    const gateway = this.env.GATEWAY.get(this.env.GATEWAY.idFromName("singleton"));
    const result = await gateway.toolRequest({
      callId: toolCall.id,
      tool: toolCall.name,
      args: toolCall.args,
      sessionKey: this.state.sessionKey,
    });

    if (!result.ok) {
      // Tool request failed immediately - mark as error
      toolCall.error = result.error || "Tool request failed";
      this.pendingToolCalls[toolCall.id] = toolCall;
    }
  }

  async alarm(): Promise<void> {
    // Tool timeout - mark all pending as timed out
    for (const callId of Object.keys(this.pendingToolCalls)) {
      const call = this.pendingToolCalls[callId];
      if (call.result === undefined && !call.error) {
        call.error = "Tool execution timed out";
        this.pendingToolCalls[callId] = call;
      }
    }
    await this.continueAgentLoop();
  }

  private async doReset(): Promise<ResetResult> {
    const oldSessionId = this.state.sessionId;
    const sessionKey = this.state.sessionKey;
    const messageCount = this.state.messages.length;
    const tokensCleared: TokenUsage = {
      input: this.state.inputTokens,
      output: this.state.outputTokens,
      total: this.state.totalTokens,
    };

    let archivedTo: string | undefined;

    if (messageCount > 0 && sessionKey) {
      try {
        archivedTo = await archiveSession(
          this.env.STORAGE,
          sessionKey,
          oldSessionId,
          this.state.messages,
          tokensCleared
        );
        console.log(`[Session] Archived ${messageCount} messages to ${archivedTo}`);
      } catch (e) {
        console.error(`[Session] Failed to archive session: ${e}`);
      }
    }

    const newSessionId = Session.generateSessionId();

    if (oldSessionId) {
      this.state.previousSessionIds = [...this.state.previousSessionIds, oldSessionId];
    }

    this.state.sessionId = newSessionId;
    this.state.messages = [];
    this.state.inputTokens = 0;
    this.state.outputTokens = 0;
    this.state.totalTokens = 0;
    this.state.lastResetAt = Date.now();
    this.state.updatedAt = Date.now();

    for (const callId of Object.keys(this.pendingToolCalls)) {
      delete this.pendingToolCalls[callId];
    }

    return {
      ok: true,
      sessionKey: sessionKey || "",
      oldSessionId,
      newSessionId,
      archivedMessages: messageCount,
      archivedTo,
      tokensCleared,
    };
  }

  async reset(): Promise<ResetResult> {
    return this.doReset();
  }

  async get(): Promise<SessionInfo> {
    return {
      sessionId: this.state.sessionId,
      sessionKey: this.state.sessionKey,
      createdAt: this.state.createdAt,
      updatedAt: this.state.updatedAt,
      messageCount: this.state.messages.length,
      tokens: {
        input: this.state.inputTokens,
        output: this.state.outputTokens,
        total: this.state.totalTokens,
      },
      settings: this.state.settings,
      resetPolicy: this.state.resetPolicy,
      lastResetAt: this.state.lastResetAt,
      previousSessionIds: this.state.previousSessionIds,
      label: this.state.label,
    };
  }

  async stats(): Promise<SessionStats> {
    const now = Date.now();
    return {
      sessionKey: this.state.sessionKey,
      sessionId: this.state.sessionId,
      messageCount: this.state.messages.length,
      tokens: {
        input: this.state.inputTokens,
        output: this.state.outputTokens,
        total: this.state.totalTokens,
      },
      createdAt: this.state.createdAt,
      updatedAt: this.state.updatedAt,
      uptime: now - this.state.createdAt,
    };
  }

  async patch(params: SessionPatchParams): Promise<{ ok: boolean }> {
    if (params.settings) {
      this.state.settings = { ...this.state.settings, ...params.settings };
    }
    if (params.label !== undefined) {
      this.state.label = params.label;
    }
    if (params.resetPolicy !== undefined) {
      this.state.resetPolicy = params.resetPolicy;
    }
    this.state.updatedAt = Date.now();
    return { ok: true };
  }

  async compact(keepMessages: number = 20): Promise<{
    ok: boolean;
    trimmedMessages: number;
    keptMessages: number;
    archivedTo?: string;
  }> {
    const totalMessages = this.state.messages.length;
    if (totalMessages <= keepMessages) {
      return {
        ok: true,
        trimmedMessages: 0,
        keptMessages: totalMessages,
      };
    }

    const trimCount = totalMessages - keepMessages;
    const messagesToArchive = this.state.messages.slice(0, trimCount);
    const messagesToKeep = this.state.messages.slice(trimCount);

    let archivedTo: string | undefined;
    if (messagesToArchive.length > 0 && this.state.sessionKey) {
      try {
        const partNumber = Date.now();
        archivedTo = await archivePartialMessages(
          this.env.STORAGE,
          this.state.sessionKey,
          this.state.sessionId,
          messagesToArchive,
          partNumber
        );
        console.log(`[Session] Compacted: archived ${trimCount} messages to ${archivedTo}`);
      } catch (e) {
        console.error(`[Session] Failed to archive compacted messages: ${e}`);
      }
    }

    this.state.messages = messagesToKeep;
    this.state.updatedAt = Date.now();

    return {
      ok: true,
      trimmedMessages: trimCount,
      keptMessages: keepMessages,
      archivedTo,
    };
  }

  async history(): Promise<{
    sessionKey: string;
    currentSessionId: string;
    previousSessionIds: string[];
  }> {
    return {
      sessionKey: this.state.sessionKey,
      currentSessionId: this.state.sessionId,
      previousSessionIds: this.state.previousSessionIds,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/state") {
      return Response.json({
        sessionKey: this.state.sessionKey,
        sessionId: this.state.sessionId,
        messageCount: this.state.messages.length,
        pendingToolCalls: Object.keys(this.pendingToolCalls).length,
        tokens: {
          input: this.state.inputTokens,
          output: this.state.outputTokens,
          total: this.state.totalTokens,
        },
      });
    }

    return new Response("Use RPC methods", { status: 400 });
  }
}
