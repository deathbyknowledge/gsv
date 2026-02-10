import { DurableObject } from "cloudflare:workers";
import { PersistedObject } from "../shared/persisted-object";
import type { ChatEventPayload } from "../protocol/chat";
import type { RuntimeNodeInventory, ToolDefinition } from "../protocol/tools";
import type { MediaAttachment } from "../protocol/channel";
import type { GsvConfig } from "../config";
import type { SkillSummary } from "../skills";
import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Tool,
  Context,
  TextContent,
  ImageContent,
  ToolCall,
} from "@mariozechner/pi-ai";
import {
  completeSimple,
  getModel,
  type Model,
  type Api,
} from "@mariozechner/pi-ai";
import { archivePartialMessages, archiveSession } from "../storage/archive";
import { fetchMediaFromR2, deleteSessionMedia } from "../storage/media";
import { loadAgentWorkspace, isMainSession } from "../workspace/loader";
import { buildSystemPromptFromWorkspace } from "../workspace/prompt";
import { isWorkspaceTool, executeWorkspaceTool } from "../workspace/tools";

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
  queued?: boolean;
  queuePosition?: number;
  started?: boolean;
};

type ToolResultInput = {
  callId: string;
  result?: unknown;
  error?: string;
};

export type SessionSettings = {
  model?: { provider: string; id: string };
  thinkingLevel?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
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

// Queued message waiting to be processed
export type QueuedMessage = {
  id: string;
  text: string;
  runId: string;
  // Optional for backward compatibility with already-persisted queue entries.
  tools?: ToolDefinition[];
  runtimeNodes?: RuntimeNodeInventory;
  media?: MediaAttachment[];
  messageOverrides?: {
    thinkLevel?: string;
    model?: { provider: string; id: string };
  };
  queuedAt: number;
};

// Current run state (persisted so it survives hibernation)
export type CurrentRun = {
  runId: string;
  tools: ToolDefinition[];
  runtimeNodes?: RuntimeNodeInventory;
  skillsSnapshot?: SkillSummary[];
  messageOverrides?: {
    thinkLevel?: string;
    model?: { provider: string; id: string };
  };
  startedAt: number;
  aborted?: boolean;
};

// State stored in PersistedObject (small, no messages)
export type SessionMeta = {
  sessionId: string;
  sessionKey: string;
  createdAt: number;
  updatedAt: number;

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

// Stored message row (SQLite)
type StoredMessage = {
  idx: number;
  role: string;
  data: string; // JSON stringified full message
  timestamp: number;
};

export type SessionStats = {
  sessionKey: string;
  sessionId: string;
  messageCount: number;
  tokens: TokenUsage;
  createdAt: number;
  updatedAt: number;
  uptime: number;
  // Queue status
  isProcessing: boolean;
  queueSize: number;
};

export type ResetResult = {
  ok: boolean;
  sessionKey: string;
  oldSessionId: string;
  newSessionId: string;
  archivedMessages: number;
  archivedTo?: string;
  tokensCleared: TokenUsage;
  mediaDeleted?: number;
};

export type SessionPatchParams = {
  settings?: Partial<SessionSettings>;
  label?: string;
  resetPolicy?: ResetPolicy;
};

export type AbortResult = {
  ok: boolean;
  wasRunning: boolean;
  runId?: string;
  pendingToolsCancelled: number;
};

// LRU cache for fetched media (in-memory, survives within request but not hibernation)
const MEDIA_CACHE_MAX_SIZE = 50 * 1024 * 1024; // 50MB budget

class MediaCache {
  private cache = new Map<
    string,
    { data: string; mimeType: string; size: number }
  >();
  private totalSize = 0;

  get(r2Key: string): { data: string; mimeType: string } | undefined {
    return this.cache.get(r2Key);
  }

  set(r2Key: string, data: string, mimeType: string): void {
    const size = data.length;

    // Evict if needed
    while (
      this.totalSize + size > MEDIA_CACHE_MAX_SIZE &&
      this.cache.size > 0
    ) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        const entry = this.cache.get(firstKey);
        if (entry) this.totalSize -= entry.size;
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(r2Key, { data, mimeType, size });
    this.totalSize += size;
  }

  clear(): void {
    this.cache.clear();
    this.totalSize = 0;
  }
}

export class Session extends DurableObject<Env> {
  private static generateSessionId(): string {
    return crypto.randomUUID();
  }

  /**
   * Extract agentId from session key.
   * Session key format: agent:{agentId}:{channel}:{peerKind}:{peerId}
   * Or with identity link: agent:{agentId}:{canonicalName}
   * Falls back to "main" if not parseable.
   */
  private getAgentId(): string {
    const sessionKey = this.meta.sessionKey;
    if (!sessionKey) return "main";

    const parts = sessionKey.split(":");
    // Format: agent:{agentId}:...
    if (parts[0] === "agent" && parts[1]) {
      return parts[1];
    }

    return "main";
  }

  private async loadRuntimeNodeInventory(): Promise<RuntimeNodeInventory | undefined> {
    try {
      const gateway = this.env.GATEWAY.getByName("singleton");
      const inventory = await gateway.getRuntimeNodeInventory();
      return inventory as RuntimeNodeInventory;
    } catch (error) {
      console.warn(
        `[Session] Failed to load runtime node inventory for prompt: ${error}`,
      );
      return undefined;
    }
  }

  // Metadata (small, uses PersistedObject)
  meta = PersistedObject<SessionMeta>(this.ctx.storage.kv, {
    prefix: "meta:",
    defaults: {
      sessionId: Session.generateSessionId(),
      sessionKey: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
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

  // Current run state (persisted for hibernation)
  private _currentRun = PersistedObject<{ run: CurrentRun | null }>(
    this.ctx.storage.kv,
    { prefix: "currentRun:", defaults: { run: null } },
  );

  private get currentRun(): CurrentRun | null {
    return this._currentRun.run;
  }

  private set currentRun(run: CurrentRun | null) {
    this._currentRun.run = run;
  }

  // Message queue for sequential processing (wrapped in object for PersistedObject)
  private _messageQueue = PersistedObject<{ items: QueuedMessage[] }>(
    this.ctx.storage.kv,
    { prefix: "messageQueue:", defaults: { items: [] } },
  );

  // Helper to access queue items
  private get messageQueue(): QueuedMessage[] {
    return this._messageQueue.items;
  }

  private set messageQueue(items: QueuedMessage[]) {
    this._messageQueue.items = items;
  }

  // In-memory cache for fetched media
  private mediaCache = new MediaCache();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initSqlite();
  }

  private initSqlite(): void {
    // Check if we need to migrate from old schema (content) to new schema (data)
    const hasDataColumn = this.ctx.storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(messages)`)
      .toArray()
      .some((col) => col.name === "data");

    if (!hasDataColumn) {
      // Create new table or migrate
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages_new (
          idx INTEGER PRIMARY KEY,
          role TEXT NOT NULL,
          data TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `);

      // Check if old table exists and has data
      const oldTableExists =
        this.ctx.storage.sql
          .exec<{
            name: string;
          }>(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='messages'`,
          )
          .toArray().length > 0;

      if (oldTableExists) {
        // Migrate old messages - wrap content in a basic message structure
        const oldMessages = this.ctx.storage.sql
          .exec<{
            idx: number;
            role: string;
            content: string;
            timestamp: number;
          }>(`SELECT idx, role, content, timestamp FROM messages ORDER BY idx`)
          .toArray();

        for (const row of oldMessages) {
          const message = {
            role: row.role,
            content: JSON.parse(row.content),
            timestamp: row.timestamp,
          };
          this.ctx.storage.sql.exec(
            `INSERT INTO messages_new (idx, role, data, timestamp) VALUES (?, ?, ?, ?)`,
            row.idx,
            row.role,
            JSON.stringify(message),
            row.timestamp,
          );
        }

        this.ctx.storage.sql.exec(`DROP TABLE messages`);
      }

      this.ctx.storage.sql.exec(`ALTER TABLE messages_new RENAME TO messages`);
    }
  }

  // ---- Message Storage (SQLite) ----

  private getMessageCount(): number {
    const result = this.ctx.storage.sql
      .exec<{ count: number }>(`SELECT COUNT(*) as count FROM messages`)
      .one();
    return result?.count ?? 0;
  }

  private addMessage(message: Message): void {
    const timestamp = (message as any).timestamp || Date.now();
    const messageWithTimestamp = { ...message, timestamp };
    const data = JSON.stringify(messageWithTimestamp);

    // Use NULL for idx to auto-increment via ROWID
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (idx, role, data, timestamp) VALUES ((SELECT COALESCE(MAX(idx), -1) + 1 FROM messages), ?, ?, ?)`,
      message.role,
      data,
      timestamp,
    );
  }

  private getMessages(): Message[] {
    const rows = this.ctx.storage.sql
      .exec<StoredMessage>(
        `SELECT idx, role, data, timestamp FROM messages ORDER BY idx`,
      )
      .toArray();

    return rows.map((row) => JSON.parse(row.data) as Message);
  }

  private clearMessages(): void {
    this.ctx.storage.sql.exec(`DELETE FROM messages`);
  }

  // ---- Media Fetching ----

  /**
   * Fetch media from R2 and return base64 (with caching)
   */
  private async fetchMedia(
    r2Key: string,
  ): Promise<{ data: string; mimeType: string } | null> {
    // Check cache first
    const cached = this.mediaCache.get(r2Key);
    if (cached) {
      console.log(`[Session] Media cache hit: ${r2Key}`);
      return cached;
    }

    // Fetch from R2
    const result = await fetchMediaFromR2(r2Key, this.env.STORAGE);
    if (result) {
      this.mediaCache.set(r2Key, result.data, result.mimeType);
    }
    return result;
  }

  /**
   * Hydrate messages with media from R2 for LLM call
   * Replaces r2Key references with actual base64 data
   */
  private async hydrateMessagesWithMedia(
    messages: Message[],
  ): Promise<Message[]> {
    const hydrated: Message[] = [];

    for (const msg of messages) {
      if (msg.role !== "user" || typeof msg.content === "string") {
        hydrated.push(msg);
        continue;
      }

      // Check if content has media references
      const content = msg.content as Array<
        | TextContent
        | ImageContent
        | { type: string; r2Key?: string; mimeType?: string }
      >;
      const hasMediaRefs = content.some(
        (block) => block.type === "image" && "r2Key" in block && block.r2Key,
      );

      if (!hasMediaRefs) {
        hydrated.push(msg);
        continue;
      }

      // Hydrate media references
      const hydratedContent: Array<TextContent | ImageContent> = [];
      for (const block of content) {
        if (block.type === "image" && "r2Key" in block && block.r2Key) {
          const media = await this.fetchMedia(block.r2Key);
          if (media) {
            hydratedContent.push({
              type: "image",
              data: media.data,
              mimeType: media.mimeType,
            });
          } else {
            // Media not found, add placeholder text
            hydratedContent.push({
              type: "text",
              text: "[Image no longer available]",
            });
          }
        } else if (block.type === "text" || block.type === "image") {
          hydratedContent.push(block as TextContent | ImageContent);
        }
      }

      hydrated.push({
        ...msg,
        content: hydratedContent,
      } as UserMessage);
    }

    return hydrated;
  }

  // ---- Main API ----

  /**
   * Check if currently processing a run
   */
  private get isProcessing(): boolean {
    return this.currentRun !== null;
  }

  /**
   * Send a message to the agent.
   * If another message is being processed, this will be queued.
   */
  async chatSend(
    message: string,
    runId: string,
    tools: ToolDefinition[],
    runtimeNodes: RuntimeNodeInventory | undefined,
    sessionKey: string,
    messageOverrides?: {
      thinkLevel?: string;
      model?: { provider: string; id: string };
    },
    media?: MediaAttachment[],
  ): Promise<ChatSendResult> {
    // Initialize session key if needed
    if (!this.meta.sessionKey) {
      this.meta.sessionKey = sessionKey;
    }

    // If currently processing, queue this message
    if (this.isProcessing) {
      const queuedMessage: QueuedMessage = {
        id: crypto.randomUUID(),
        text: message,
        runId,
        tools: JSON.parse(JSON.stringify(tools)),
        runtimeNodes: runtimeNodes
          ? JSON.parse(JSON.stringify(runtimeNodes))
          : undefined,
        media,
        messageOverrides,
        queuedAt: Date.now(),
      };

      this.messageQueue = [...this.messageQueue, queuedMessage];
      console.log(
        `[Session] Queued message ${queuedMessage.id}, queue size: ${this.messageQueue.length}`,
      );

      return {
        ok: true,
        runId,
        queued: true,
        queuePosition: this.messageQueue.length,
      };
    }

    // Start processing this message (async - don't await!)
    this.startRun(message, runId, tools, runtimeNodes, messageOverrides, media);

    return { ok: true, runId, started: true };
  }

  /**
   * Start processing a message. Does NOT block the caller.
   * Uses ctx.waitUntil() to keep the DO alive during async processing.
   */
  private startRun(
    message: string,
    runId: string,
    tools: ToolDefinition[],
    runtimeNodes: RuntimeNodeInventory | undefined,
    messageOverrides?: {
      thinkLevel?: string;
      model?: { provider: string; id: string };
    },
    media?: MediaAttachment[],
  ): void {
    // Set current run state (persisted)
    this.currentRun = {
      runId,
      tools,
      runtimeNodes: runtimeNodes
        ? JSON.parse(JSON.stringify(runtimeNodes))
        : undefined,
      messageOverrides,
      startedAt: Date.now(),
    };

    console.log(`[Session] Starting run ${runId}`);

    // Build user message and evaluate freshness before touching updatedAt
    const userMessage = this.buildUserMessage(message, media);
    const shouldResetBeforeRun = this.shouldAutoReset(this.meta.updatedAt);

    // Persist message immediately for normal runs.
    // If a reset is due, runAgentLoop will reset first, then add this message.
    if (!shouldResetBeforeRun) {
      this.addMessage(userMessage);
      this.meta.updatedAt = Date.now();
    }

    // Kick off the agent loop asynchronously
    // ctx.waitUntil() keeps the DO alive but doesn't block the RPC response
    this.ctx.waitUntil(
      this.runAgentLoop({ shouldResetBeforeRun, userMessage }),
    );
  }

  /**
   * The main agent loop. Runs asynchronously after chatSend returns.
   * Calls LLM, handles tool calls, broadcasts results.
   */
  private async runAgentLoop(params?: {
    shouldResetBeforeRun?: boolean;
    userMessage?: UserMessage;
  }): Promise<void> {
    try {
      // Check for auto-reset
      const shouldReset = params?.shouldResetBeforeRun ?? this.shouldAutoReset();
      if (shouldReset) {
        console.log(
          `[Session] Auto-reset triggered for ${this.meta.sessionKey}`,
        );
        await this.doReset();

        // If this run triggered reset, record the triggering message in the fresh session.
        if (params?.userMessage) {
          this.addMessage(params.userMessage);
          this.meta.updatedAt = Date.now();
        }
      }

      await this.continueAgentLoop();
    } catch (e) {
      console.error(`[Session] Agent loop error:`, e);
      await this.broadcastToClients({
        runId: this.currentRun?.runId ?? null,
        sessionKey: this.meta.sessionKey,
        state: "error",
        error: e instanceof Error ? e.message : String(e),
      });
      this.finishRun();
    }
  }

  /**
   * Continue the agent loop after tool results come back.
   * Called from toolResult() via waitUntil().
   */
  private async continueAgentLoop(): Promise<void> {
    // Check if run was aborted
    if (this.currentRun?.aborted) {
      console.log(
        `[Session] Run ${this.currentRun.runId} was aborted, stopping agent loop`,
      );
      return;
    }

    // Process pending tool results
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
        this.addMessage(toolResultMessage);
        delete this.pendingToolCalls[callId];
      }
    }

    let response: AssistantMessage;
    try {
      response = await this.callLlm();
    } catch (e) {
      console.error(`[Session] LLM call failed:`, e);
      await this.broadcastToClients({
        runId: this.currentRun?.runId ?? null,
        sessionKey: this.meta.sessionKey,
        state: "error",
        error: e instanceof Error ? e.message : String(e),
      });
      this.finishRun();
      return;
    }

    // Check if run was aborted while waiting for LLM
    if (this.currentRun?.aborted) {
      console.log(
        `[Session] Run ${this.currentRun.runId} was aborted during LLM call`,
      );
      return;
    }

    if (!response.content || response.content.length === 0) {
      // Check if there's an error message from the LLM
      const errorDetail = response.errorMessage
        ? `LLM error: ${response.errorMessage}`
        : "LLM returned empty response";
      console.error(`[Session] ${errorDetail}`);
      await this.broadcastToClients({
        runId: this.currentRun?.runId ?? null,
        sessionKey: this.meta.sessionKey,
        state: "error",
        error: errorDetail,
      });
      this.finishRun();
      return;
    }

    this.addMessage(response);
    this.meta.updatedAt = Date.now();

    const toolCalls = response.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );

    if (toolCalls.length > 0) {
      // Check if response has text content alongside tool calls
      // If so, broadcast it as partial before executing tools (so user sees it immediately)
      const hasTextContent = response.content.some(
        (block) =>
          block.type === "text" && (block as { text?: string }).text?.trim(),
      );
      if (hasTextContent) {
        await this.broadcastToClients({
          runId: this.currentRun?.runId ?? null,
          sessionKey: this.meta.sessionKey,
          state: "partial",
          message: response,
        });
      }

      // Request tool executions (fire and forget - don't await results here)
      for (const toolCall of toolCalls) {
        await this.requestToolExecution({
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.arguments,
        });
      }

      // Check if all tools already resolved (workspace tools complete synchronously)
      if (this.allToolsResolved()) {
        console.log(
          `[Session] All ${toolCalls.length} tools already resolved (workspace tools), scheduling immediate continuation`,
        );
        // Schedule continuation via short alarm to reset DO timeouts/limits
        // This prevents long-running agent loops from hitting Worker limits
        this.ctx.storage.setAlarm(Date.now() + 100);
        return;
      }

      // Some tools still pending (node tools) - set alarm and wait
      this.ctx.storage.setAlarm(Date.now() + 60_000);
      // DO can now hibernate - will wake on toolResult() or alarm()
      console.log(
        `[Session] Waiting for ${toolCalls.length} tool results, run ${this.currentRun?.runId}`,
      );
      return;
    }

    // Final response - broadcast and finish
    await this.broadcastToClients({
      runId: this.currentRun?.runId ?? null,
      sessionKey: this.meta.sessionKey,
      state: "final",
      message: response,
    });
    this.finishRun();
  }

  /**
   * Clean up after a run completes (success or error)
   */
  private finishRun(): void {
    const runId = this.currentRun?.runId;
    this.currentRun = null;
    console.log(`[Session] Finished run ${runId}`);

    // Process next queued message if any (async)
    if (this.messageQueue.length > 0) {
      this.ctx.waitUntil(this.processNextQueued());
    }
  }

  /**
   * Process the next message in the queue
   */
  private async processNextQueued(): Promise<void> {
    if (this.messageQueue.length === 0 || this.isProcessing) {
      return;
    }

    const [next, ...remaining] = this.messageQueue;
    this.messageQueue = remaining;

    console.log(
      `[Session] Processing queued message ${next.id}, ${remaining.length} remaining`,
    );

    // Start the next run (this sets currentRun)
    this.startRun(
      next.text,
      next.runId,
      next.tools ?? [],
      next.runtimeNodes,
      next.messageOverrides,
      next.media,
    );
  }

  /**
   * Get queue status (for heartbeat skip checks)
   */
  getQueueStatus(): { isProcessing: boolean; queueSize: number } {
    return {
      isProcessing: this.isProcessing,
      queueSize: this.messageQueue.length,
    };
  }

  /**
   * Build a UserMessage with text and optional media attachments
   * Media with r2Key are stored as references (not base64)
   */
  private buildUserMessage(
    text: string,
    media?: MediaAttachment[],
  ): UserMessage {
    // Separate media by type
    const images = media?.filter((m) => m.type === "image") ?? [];
    const documents = media?.filter((m) => m.type === "document") ?? [];
    const audioWithTranscript =
      media?.filter((m) => m.type === "audio" && m.transcription) ?? [];
    const audioWithoutTranscript =
      media?.filter((m) => m.type === "audio" && !m.transcription) ?? [];

    // If no processable media, use simple string content
    if (
      images.length === 0 &&
      documents.length === 0 &&
      audioWithTranscript.length === 0 &&
      audioWithoutTranscript.length === 0
    ) {
      return {
        role: "user",
        content: text || "[Empty message]",
        timestamp: Date.now(),
      };
    }

    // Build content array
    const content: Array<
      | TextContent
      | ImageContent
      | { type: "image"; r2Key: string; mimeType: string }
    > = [];

    // Add text first (if any)
    if (text && text !== "[Media]") {
      content.push({ type: "text", text });
    }

    // Add images (as r2Key references or base64)
    for (const img of images) {
      if (img.r2Key) {
        content.push({
          type: "image",
          r2Key: img.r2Key,
          mimeType: img.mimeType,
        });
      } else if (img.data && img.mimeType) {
        content.push({
          type: "image",
          data: img.data,
          mimeType: img.mimeType,
        });
      }
    }

    // Add audio transcriptions as text
    for (const audio of audioWithTranscript) {
      const transcription = audio.transcription!;
      content.push({
        type: "text",
        text: `[Voice message transcription: ${transcription}]`,
      });
    }

    // Add placeholder for audio that failed transcription
    for (const audio of audioWithoutTranscript) {
      content.push({
        type: "text",
        text: `[Voice message received - transcription unavailable]`,
      });
    }

    // Add documents as text placeholders
    // TODO: Future enhancement - extract text or convert to images for vision models
    for (const doc of documents) {
      const filename = doc.filename || "document";
      const mimeType = doc.mimeType || "application/octet-stream";
      const size = doc.size ? ` (${Math.round(doc.size / 1024)}KB)` : "";
      content.push({
        type: "text",
        text: `[Document attached: ${filename}${size}, type: ${mimeType}]`,
      });
    }

    // If content is still empty (shouldn't happen, but safety), add placeholder
    if (content.length === 0) {
      content.push({ type: "text", text: "[Media message]" });
    }

    return {
      role: "user",
      content: content as UserMessage["content"],
      timestamp: Date.now(),
    };
  }

  private shouldAutoReset(lastActivityAt: number = this.meta.updatedAt): boolean {
    const policy = this.meta.resetPolicy;
    if (!policy || policy.mode === "manual") return false;

    const now = Date.now();

    if (policy.mode === "daily") {
      const atHour = policy.atHour ?? 4;
      const resetTime = this.getDailyResetTime(now, atHour);
      return lastActivityAt < resetTime;
    }

    if (policy.mode === "idle") {
      const idleMs = (policy.idleMinutes ?? 60) * 60_000;
      return now - lastActivityAt > idleMs;
    }

    return false;
  }

  private getDailyResetTime(now: number, atHour: number): number {
    const date = new Date(now);
    date.setHours(atHour, 0, 0, 0);
    if (date.getTime() > now) {
      date.setDate(date.getDate() - 1);
    }
    return date.getTime();
  }

  /**
   * Receive a tool result. Returns IMMEDIATELY.
   * If all tools are resolved, continues the agent loop asynchronously.
   */
  async toolResult(input: ToolResultInput): Promise<{ ok: boolean }> {
    const toolCall = this.pendingToolCalls[input.callId];
    if (!toolCall) {
      console.warn(`[Session] Unknown tool call: ${input.callId}`);
      return { ok: false };
    }

    if (input.error) {
      toolCall.error = input.error;
    } else {
      toolCall.result = input.result;
    }
    this.pendingToolCalls[input.callId] = toolCall;
    console.log(
      `[Session] Tool result received for ${input.callId} (${toolCall.name})`,
    );

    if (this.allToolsResolved()) {
      this.ctx.storage.deleteAlarm();
      // Continue the loop asynchronously - don't await!
      this.ctx.waitUntil(this.continueAgentLoop());
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

  private async callLlm(): Promise<AssistantMessage> {
    const gateway = this.env.GATEWAY.get(
      this.env.GATEWAY.idFromName("singleton"),
    );
    const config: GsvConfig = await gateway.getConfig();

    const sessionSettings = this.meta.settings;
    const messageOverrides = this.currentRun?.messageOverrides ?? {};

    const effectiveModel =
      messageOverrides.model || sessionSettings.model || config.model;

    // Build system prompt from workspace files + config
    const effectiveSystemPrompt = await this.buildEffectiveSystemPrompt(
      config,
      sessionSettings,
      effectiveModel,
      this.currentRun?.tools ?? [],
      this.currentRun?.runtimeNodes,
    );

    if (messageOverrides.model) {
      console.log(
        `[Session] Using directive model override: ${messageOverrides.model.provider}/${messageOverrides.model.id}`,
      );
    }
    if (messageOverrides.thinkLevel) {
      console.log(
        `[Session] Using directive thinking level: ${messageOverrides.thinkLevel}`,
      );
    }

    const tools: Tool[] = (this.currentRun?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Tool["parameters"],
    }));

    // Get messages and hydrate media references
    const storedMessages = this.getMessages();
    const hydratedMessages =
      await this.hydrateMessagesWithMedia(storedMessages);

    const context: Context = {
      systemPrompt: effectiveSystemPrompt,
      messages: hydratedMessages,
      tools: tools.length > 0 ? tools : undefined,
    };

    console.log(
      "[Session] Messages being sent to LLM:",
      hydratedMessages.length,
    );

    let model: Model<Api> | undefined;
    const provider = effectiveModel.provider;
    const modelId = effectiveModel.id;

    if (provider === "anthropic") {
      model = getModel(
        "anthropic",
        modelId as Parameters<typeof getModel<"anthropic", any>>[1],
      );
    } else if (provider === "openai") {
      model = getModel(
        "openai",
        modelId as Parameters<typeof getModel<"openai", any>>[1],
      );
    } else if (provider === "google") {
      model = getModel(
        "google",
        modelId as Parameters<typeof getModel<"google", any>>[1],
      );
    } else if (provider === "openrouter") {
      model = getModel(
        "openrouter",
        modelId as Parameters<typeof getModel<"openrouter", any>>[1],
      );
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    if (!model) {
      throw new Error(`Model not found: ${provider}/${modelId}`);
    }

    let apiKey: string | undefined;
    if (provider === "anthropic") {
      apiKey = config.apiKeys.anthropic;
    } else if (provider === "openai") {
      apiKey = config.apiKeys.openai;
    } else if (provider === "google") {
      apiKey = config.apiKeys.google;
    } else if (provider === "openrouter") {
      apiKey = config.apiKeys.openrouter;
    }

    if (!apiKey) {
      throw new Error(`API key not configured for provider: ${provider}`);
    }

    const effectiveThinkLevel =
      messageOverrides.thinkLevel || sessionSettings.thinkingLevel;

    // Map to pi-ai reasoning levels: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    const reasoningLevel =
      effectiveThinkLevel && effectiveThinkLevel !== "none"
        ? (effectiveThinkLevel as
            | "minimal"
            | "low"
            | "medium"
            | "high"
            | "xhigh")
        : undefined;

    console.log(
      `[Session] Calling LLM: ${provider}/${modelId}${reasoningLevel ? ` (reasoning: ${reasoningLevel})` : ""}`,
    );
    const response = await completeSimple(model, context, {
      apiKey,
      reasoning: reasoningLevel,
    });
    console.log(
      `[Session] LLM response received, content blocks: ${response.content?.length ?? 0}, stopReason: ${response.stopReason}, error: ${response.errorMessage || "none"}`,
    );
    if (response.content?.length === 0) {
      console.log(
        `[Session] Empty response details: ${JSON.stringify({ stopReason: response.stopReason, errorMessage: response.errorMessage, usage: response.usage })}`,
      );
    }

    if (response.usage) {
      const usage = response.usage;
      this.meta.inputTokens += usage.input || 0;
      this.meta.outputTokens += usage.output || 0;
      this.meta.totalTokens += usage.totalTokens || 0;
      console.log(
        `[Session] Token usage: +${usage.input}/${usage.output} (total: ${this.meta.inputTokens}/${this.meta.outputTokens})`,
      );
    }

    return response;
  }

  /**
   * Build the effective system prompt by combining workspace files with config
   *
   * Loads agent identity files from R2 and merges with session/config settings
   */
  private async buildEffectiveSystemPrompt(
    config: GsvConfig,
    sessionSettings: SessionSettings,
    effectiveModel: { provider: string; id: string },
    runTools: ToolDefinition[],
    runRuntimeNodes: RuntimeNodeInventory | undefined,
  ): Promise<string> {
    const agentId = this.getAgentId();

    // Check if this is main session (for MEMORY.md security)
    const mainSession = isMainSession(this.meta.sessionKey || "");

    console.log(
      `[Session] Loading workspace for agent: ${agentId} (mainSession: ${mainSession})`,
    );

    // Load workspace from R2
    const workspace = await loadAgentWorkspace(
      this.env.STORAGE,
      agentId,
      mainSession,
    );

    if (this.currentRun?.skillsSnapshot) {
      workspace.skills = JSON.parse(
        JSON.stringify(this.currentRun.skillsSnapshot),
      ) as SkillSummary[];
    } else if (workspace.skills && this.currentRun) {
      this.currentRun.skillsSnapshot = JSON.parse(
        JSON.stringify(workspace.skills),
      ) as SkillSummary[];
    }

    // Log what was loaded
    const loaded = [
      workspace.agents?.exists && "AGENTS.md",
      workspace.soul?.exists && "SOUL.md",
      workspace.identity?.exists && "IDENTITY.md",
      workspace.user?.exists && "USER.md",
      workspace.memory?.exists && "MEMORY.md",
      workspace.tools?.exists && "TOOLS.md",
      workspace.heartbeat?.exists && "HEARTBEAT.md",
      workspace.bootstrap?.exists && "BOOTSTRAP.md",
      workspace.dailyMemory?.exists && "daily",
      workspace.yesterdayMemory?.exists && "yesterday",
    ].filter(Boolean);

    if (loaded.length > 0) {
      console.log(`[Session] Workspace files loaded: ${loaded.join(", ")}`);
    }

    // Get base prompt from settings or config
    const basePrompt = sessionSettings.systemPrompt || config.systemPrompt;
    const agentConfig = config.agents.list.find((agent) => agent.id === agentId);
    const heartbeatPrompt =
      agentConfig?.heartbeat?.prompt || config.agents.defaultHeartbeat.prompt;
    const runtimeNodes =
      runRuntimeNodes ?? (await this.loadRuntimeNodeInventory());

    // Build combined prompt
    return buildSystemPromptFromWorkspace(basePrompt, workspace, {
      tools: runTools,
      heartbeatPrompt,
      skillEntries: config.skills.entries,
      runtime: {
        agentId,
        sessionKey: this.meta.sessionKey,
        isMainSession: mainSession,
        model: effectiveModel,
        nodes: runtimeNodes,
      },
    });
  }

  private async broadcastToClients(payload: ChatEventPayload): Promise<void> {
    if (!this.meta.sessionKey) return;
    const gateway = this.env.GATEWAY.getByName("singleton");
    gateway.broadcastToSession(this.meta.sessionKey, payload);
  }

  private async requestToolExecution(toolCall: PendingToolCall): Promise<void> {
    if (!this.meta.sessionKey) {
      console.error("[Session] Cannot request tool: sessionKey not set");
      return;
    }

    this.pendingToolCalls[toolCall.id] = toolCall;

    // Check if this is a workspace tool (gsv__*) - handle locally
    if (isWorkspaceTool(toolCall.name)) {
      const agentId = this.getAgentId();

      console.log(
        `[Session] Executing workspace tool ${toolCall.name} for agent ${agentId}`,
      );

      const result = await executeWorkspaceTool(
        this.env.STORAGE,
        agentId,
        toolCall.name,
        toolCall.args,
      );

      if (result.ok) {
        toolCall.result = result.result;
      } else {
        toolCall.error = result.error || "Workspace tool failed";
      }
      this.pendingToolCalls[toolCall.id] = toolCall;
      console.log(`[Session] Workspace tool ${toolCall.name} completed`);
      return;
    }

    // Node tool - dispatch to Gateway for routing to appropriate node
    const gateway = this.env.GATEWAY.get(
      this.env.GATEWAY.idFromName("singleton"),
    );
    // Fire and forget - don't await the tool execution, just the request dispatch
    const result = await gateway.toolRequest({
      callId: toolCall.id,
      tool: toolCall.name,
      args: toolCall.args,
      sessionKey: this.meta.sessionKey,
    });

    if (!result.ok) {
      toolCall.error = result.error || "Tool request failed";
      this.pendingToolCalls[toolCall.id] = toolCall;
    }
  }

  async alarm(): Promise<void> {
    // Check if any tools are still pending (not resolved)
    let timedOutCount = 0;
    for (const callId of Object.keys(this.pendingToolCalls)) {
      const call = this.pendingToolCalls[callId];
      if (call.result === undefined && !call.error) {
        call.error = "Tool execution timed out";
        this.pendingToolCalls[callId] = call;
        timedOutCount++;
        console.log(`[Session] Tool ${call.name} (${callId}) timed out`);
      }
    }

    if (timedOutCount > 0) {
      console.log(
        `[Session] Alarm: ${timedOutCount} tools timed out, continuing with errors`,
      );
    } else {
      console.log(`[Session] Alarm: all tools resolved, continuing agent loop`);
    }

    await this.continueAgentLoop();
  }

  private async doReset(): Promise<ResetResult> {
    const oldSessionId = this.meta.sessionId;
    const sessionKey = this.meta.sessionKey;
    const messageCount = this.getMessageCount();
    const tokensCleared: TokenUsage = {
      input: this.meta.inputTokens,
      output: this.meta.outputTokens,
      total: this.meta.totalTokens,
    };

    let archivedTo: string | undefined;
    let mediaDeleted = 0;

    // Archive messages if any
    if (messageCount > 0 && sessionKey) {
      try {
        const messages = this.getMessages();
        const agentId = this.getAgentId();
        archivedTo = await archiveSession(
          this.env.STORAGE,
          sessionKey,
          oldSessionId,
          messages,
          tokensCleared,
          agentId,
        );
        console.log(
          `[Session] Archived ${messageCount} messages to ${archivedTo}`,
        );
      } catch (e) {
        console.error(`[Session] Failed to archive session: ${e}`);
      }
    }

    // Delete media from R2
    if (sessionKey) {
      try {
        mediaDeleted = await deleteSessionMedia(this.env.STORAGE, sessionKey);
      } catch (e) {
        console.error(`[Session] Failed to delete media: ${e}`);
      }
    }

    // Clear messages from SQLite
    this.clearMessages();

    // Clear media cache
    this.mediaCache.clear();

    // Clear current run
    this.currentRun = null;
    // Clear queued messages and pending tool timeout alarm
    this.messageQueue = [];
    this.ctx.storage.deleteAlarm();

    // Update metadata
    const newSessionId = Session.generateSessionId();

    if (oldSessionId) {
      this.meta.previousSessionIds = [
        ...this.meta.previousSessionIds,
        oldSessionId,
      ];
    }

    this.meta.sessionId = newSessionId;
    this.meta.inputTokens = 0;
    this.meta.outputTokens = 0;
    this.meta.totalTokens = 0;
    this.meta.lastResetAt = Date.now();
    this.meta.updatedAt = Date.now();

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
      mediaDeleted,
    };
  }

  async reset(): Promise<ResetResult> {
    return this.doReset();
  }

  /**
   * Abort the current run if one is in progress.
   * Sets the aborted flag and clears pending tool calls.
   * The agent loop will check this flag and exit early.
   */
  async abort(): Promise<AbortResult> {
    if (!this.currentRun) {
      return {
        ok: true,
        wasRunning: false,
        pendingToolsCancelled: 0,
      };
    }

    const runId = this.currentRun.runId;
    const pendingToolsCancelled = Object.keys(this.pendingToolCalls).length;

    // Mark the run as aborted
    this.currentRun.aborted = true;

    // Clear pending tool calls
    for (const callId of Object.keys(this.pendingToolCalls)) {
      delete this.pendingToolCalls[callId];
    }

    // Clear any alarm (tool timeout)
    this.ctx.storage.deleteAlarm();

    console.log(
      `[Session] Aborted run ${runId}, cancelled ${pendingToolsCancelled} pending tools`,
    );

    // Broadcast abort event
    await this.broadcastToClients({
      runId,
      sessionKey: this.meta.sessionKey,
      state: "error",
      error: "Run cancelled by user",
    });

    // Clean up run state
    this.finishRun();

    return {
      ok: true,
      wasRunning: true,
      runId,
      pendingToolsCancelled,
    };
  }

  async get() {
    return {
      sessionId: this.meta.sessionId,
      sessionKey: this.meta.sessionKey,
      createdAt: this.meta.createdAt,
      updatedAt: this.meta.updatedAt,
      messageCount: this.getMessageCount(),
      tokens: {
        input: this.meta.inputTokens,
        output: this.meta.outputTokens,
        total: this.meta.totalTokens,
      },
      settings: { ...this.meta.settings },
      resetPolicy: this.meta.resetPolicy
        ? { ...this.meta.resetPolicy }
        : undefined,
      lastResetAt: this.meta.lastResetAt,
      previousSessionIds: [...this.meta.previousSessionIds],
      label: this.meta.label,
    };
  }

  async stats(): Promise<SessionStats> {
    const now = Date.now();
    const queueStatus = this.getQueueStatus();
    return {
      sessionKey: this.meta.sessionKey,
      sessionId: this.meta.sessionId,
      messageCount: this.getMessageCount(),
      tokens: {
        input: this.meta.inputTokens,
        output: this.meta.outputTokens,
        total: this.meta.totalTokens,
      },
      createdAt: this.meta.createdAt,
      updatedAt: this.meta.updatedAt,
      uptime: now - this.meta.createdAt,
      isProcessing: queueStatus.isProcessing,
      queueSize: queueStatus.queueSize,
    };
  }

  async patch(params: SessionPatchParams): Promise<{ ok: boolean }> {
    if (params.settings) {
      this.meta.settings = { ...this.meta.settings, ...params.settings };
    }
    if (params.label !== undefined) {
      this.meta.label = params.label;
    }
    if (params.resetPolicy !== undefined) {
      this.meta.resetPolicy = params.resetPolicy;
    }
    this.meta.updatedAt = Date.now();
    return { ok: true };
  }

  async compact(keepMessages: number = 20) {
    const totalMessages = this.getMessageCount();
    if (totalMessages <= keepMessages) {
      return {
        ok: true,
        trimmedMessages: 0,
        keptMessages: totalMessages,
      };
    }

    const trimCount = totalMessages - keepMessages;
    const messages = this.getMessages();
    const messagesToArchive = messages.slice(0, trimCount);
    const messagesToKeep = messages.slice(trimCount);

    let archivedTo: string | undefined;
    if (messagesToArchive.length > 0 && this.meta.sessionKey) {
      try {
        const partNumber = Date.now();
        const agentId = this.getAgentId();
        archivedTo = await archivePartialMessages(
          this.env.STORAGE,
          this.meta.sessionKey,
          this.meta.sessionId,
          messagesToArchive,
          partNumber,
          agentId,
        );
        console.log(
          `[Session] Compacted: archived ${trimCount} messages to ${archivedTo}`,
        );
      } catch (e) {
        console.error(`[Session] Failed to archive compacted messages: ${e}`);
      }
    }

    // Rewrite messages table with only kept messages
    this.clearMessages();
    for (const msg of messagesToKeep) {
      this.addMessage(msg);
    }
    this.meta.updatedAt = Date.now();

    return {
      ok: true,
      trimmedMessages: trimCount,
      keptMessages: this.getMessageCount(),
      archivedTo,
    };
  }

  async history(): Promise<{
    sessionKey: string;
    currentSessionId: string;
    previousSessionIds: string[];
  }> {
    return {
      sessionKey: this.meta.sessionKey,
      currentSessionId: this.meta.sessionId,
      previousSessionIds: [...this.meta.previousSessionIds],
    };
  }

  async preview(limit?: number): Promise<{
    sessionKey: string;
    sessionId: string;
    messageCount: number;
    messages: Message[];
  }> {
    const messages = this.getMessages();
    const limitedMessages = limit ? messages.slice(-limit) : messages;

    return {
      sessionKey: this.meta.sessionKey,
      sessionId: this.meta.sessionId,
      messageCount: this.getMessageCount(),
      messages: JSON.parse(JSON.stringify(limitedMessages)),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/state") {
      return Response.json({
        sessionKey: this.meta.sessionKey,
        sessionId: this.meta.sessionId,
        messageCount: this.getMessageCount(),
        pendingToolCalls: Object.keys(this.pendingToolCalls).length,
        isProcessing: this.isProcessing,
        currentRunId: this.currentRun?.runId,
        tokens: {
          input: this.meta.inputTokens,
          output: this.meta.outputTokens,
          total: this.meta.totalTokens,
        },
      });
    }

    return new Response("Use RPC methods", { status: 400 });
  }
}
