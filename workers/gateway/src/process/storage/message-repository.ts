import type { ProcessStore } from "../store";
import type {
  AssistantMessage, Message, TextContent, ThinkingContent, ToolCall, ToolResultMessage, UserMessage,
} from "@earendil-works/pi-ai";
import type { ProcToolResultOutcome } from "@humansandmachines/gsv/protocol";
import { buildFallbackMediaBlocks, parseStoredProcessMedia } from "../media";
import { materializeLegacyToolResultImages } from "../tool-result-media";
import { syscallToolName } from "../../syscalls/constants";
import { tagAssistantContextIdentity } from "../context-message-metadata";
import {
  DEFAULT_MESSAGE_READ_LIMIT, buildFallbackUserContent, messageRecordFromRow, normalizeAssistantStopReason,
  parseAssistantMessageMeta, parseMessageMetadata, requiredToolCallId, stringifyMessageMetadata,
  toolResultMetaSchema, usageStateToPiUsage, type MessageMetadata, type MessageRecord, type MessageRole,
  type MessageRow, type MessageStats, type ToolResultMetadata,
} from "./store-codecs";

type ModelHistoryOptions = {
  limit?: number | null;
  offset?: number;
  /** Only usage confirmed against this exact prompt epoch is reusable. */
  contextEpochId?: string;
  /** Only usage confirmed against this exact system-prompt/tool shape is reusable. */
  generationContextId?: string;
};

/** Owns durable Process history messages and model-history projection. */
export class ProcessMessageRepository {
  constructor(private readonly store: ProcessStore) {}

  appendMessage(
    role: MessageRole,
    content: string,
    opts?: {
      generation?: number;
      toolCalls?: string;
      toolCallId?: string;
      media?: string;
      origin?: string;
      metadata?: MessageMetadata | string | null;
      runId?: string;
      createdAt?: number;
    },
  ): number {
    const {
      generation = this.store.state.getHistoryGeneration(),
      runId = null,
      toolCalls = null,
      toolCallId = null,
      media = null,
      origin = null,
      metadata = null,
      createdAt = Date.now(),
    } = opts ?? {};
    const metadataJson = stringifyMessageMetadata(metadata);
    this.store.sql.exec(
      `INSERT INTO messages (
        generation, run_id, role, content, tool_calls, tool_call_id,
        media_json, origin_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      generation,
      runId,
      role,
      content,
      toolCalls,
      toolCallId,
      media,
      origin,
      metadataJson,
      createdAt,
    );

    const messageId = this.store.first<{ id: number }>("SELECT last_insert_rowid() as id")?.id ?? -1;

    if (role === "assistant") {
      const metadata = parseMessageMetadata(metadataJson);
      if (metadata?.usage) {
        this.store.state.addHistoryUsage(metadata.usage);
      }
    }

    return messageId;
  }

  updateMessageMedia(messageId: number, runId: string, media: string): void {
    this.store.sql.exec(
      "UPDATE messages SET media_json = ? WHERE id = ? AND run_id = ?",
      media,
      messageId,
      runId,
    );
  }

  clearMessageMedia(messageId: number, runId: string): void {
    this.store.sql.exec(
      "UPDATE messages SET media_json = NULL WHERE id = ? AND run_id = ?",
      messageId,
      runId,
    );
  }

  hasMessageMedia(messageId: number, runId: string): boolean {
    return (
      this.store.first<{ present: number }>(
          `SELECT media_json IS NOT NULL AS present
         FROM messages
        WHERE id = ? AND run_id = ?`,
          messageId,
          runId,
        )?.present === 1
    );
  }

  referencesMediaKey(key: string): boolean {
    const rows = this.store.sql.exec<{ media_json: string }>(
      `SELECT media_json FROM messages WHERE media_json IS NOT NULL
       UNION ALL
       SELECT media_json FROM message_queue WHERE media_json IS NOT NULL`,
    );
    for (const row of rows) {
      if (parseStoredProcessMedia(row.media_json).some((item) => item.key === key)) {
        return true;
      }
    }
    return false;
  }

  getMessages(opts?: {
    limit?: number | null;
    offset?: number;
    beforeMessageId?: number;
    afterMessageId?: number;
    tail?: boolean;
  }): MessageRecord[] {
    const limit = opts?.limit === null ? null : (opts?.limit ?? DEFAULT_MESSAGE_READ_LIMIT);
    const offset = opts?.offset ?? 0;
    const beforeMessageId = opts?.beforeMessageId;
    const afterMessageId = opts?.afterMessageId;
    const tail = opts?.tail === true;
    const hasLimit = limit !== null;
    const where: string[] = [];
    const args: Array<number> = [];
    if (beforeMessageId !== undefined) {
      where.push("id < ?");
      args.push(beforeMessageId);
    }
    if (afterMessageId !== undefined) {
      where.push("id > ?");
      args.push(afterMessageId);
    }
    const pagination = hasLimit
      ? { clause: "LIMIT ? OFFSET ?", args: [limit, offset] as const }
      : offset > 0
        ? { clause: "LIMIT -1 OFFSET ?", args: [offset] as const }
        : { clause: "", args: [] as const };
    const order = tail || beforeMessageId !== undefined ? "DESC" : "ASC";
    const filter = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const rows = [
      ...this.store.sql.exec<MessageRow>(
        `SELECT * FROM messages ${filter} ORDER BY id ${order} ${pagination.clause}`,
        ...args,
        ...pagination.args,
      ),
    ];
    if (tail || beforeMessageId !== undefined) {
      rows.reverse();
    }

    return rows.map(messageRecordFromRow);
  }

  hasMessageBefore(messageId: number): boolean {
    return Boolean(this.store.first(
      "SELECT 1 as found FROM messages WHERE id < ? LIMIT 1", messageId,
    ));
  }

  hasMessageAfter(messageId: number): boolean {
    return Boolean(this.store.first(
      "SELECT 1 as found FROM messages WHERE id > ? LIMIT 1", messageId,
    ));
  }

  getMessagesForGeneration(
    generation: number = this.store.state.getHistoryGeneration(),
  ): MessageRecord[] {
    return [
      ...this.store.sql.exec<MessageRow>(
        `SELECT * FROM messages
        WHERE generation = ?
        ORDER BY id ASC`,
        generation,
      ),
    ].map(messageRecordFromRow);
  }

  getRunInputMessageId(runId: string): number | null {
    const row = this.store.first<{ id: number }>(
        `SELECT id FROM messages
        WHERE generation = ? AND run_id = ? AND role = 'user'
        ORDER BY id ASC
        LIMIT 1`,
        this.store.state.getHistoryGeneration(),
        runId,
      );
    return row?.id ?? null;
  }

  getMessagesForGenerationAfter(opts: {
    generation: number;
    afterMessageId: number;
    throughCreatedAt?: number;
  }): MessageRecord[] {
    const args: number[] = [opts.generation, opts.afterMessageId];
    const createdAtFilter = opts.throughCreatedAt === undefined ? "" : "AND created_at <= ?";
    if (opts.throughCreatedAt !== undefined) {
      args.push(opts.throughCreatedAt);
    }

    return [
      ...this.store.sql.exec<MessageRow>(
        `SELECT * FROM messages
        WHERE generation = ?
          AND id > ?
          ${createdAtFilter}
        ORDER BY id ASC`,
        ...args,
      ),
    ].map(messageRecordFromRow);
  }

  messageCount(): number {
    return this.store.first<{ cnt: number }>("SELECT COUNT(*) as cnt FROM messages")?.cnt ?? 0;
  }

  messageStats(): MessageStats {
    const row = this.store.first<{ cnt: number; first_id: number | null; last_id: number | null }>(
      "SELECT COUNT(*) as cnt, MIN(id) as first_id, MAX(id) as last_id FROM messages",
    );
    return {
      count: row?.cnt ?? 0,
      firstMessageId: row?.first_id ?? null,
      lastMessageId: row?.last_id ?? null,
    };
  }

  clearMessages(): number {
    const count = this.messageCount();
    this.store.sql.exec("DELETE FROM messages");
    this.store.state.deleteContextState();
    this.store.state.deleteHistoryUsage();
    return count;
  }

  // --- Message conversion to pi-ai format ---

  toMessages(opts?: ModelHistoryOptions): Message[] {
    return this.getMessages(opts).map((record) => modelHistoryMessage(record, opts));
  }

  /**
   * Append a tool result message. Stores presentation metadata in the
   * tool_calls column so proc.history can expose a structured result.
   */
  appendToolResult(
    toolCallId: string,
    syscallName: string,
    content: string,
    isError: boolean,
    runId?: string,
    outcome?: ProcToolResultOutcome,
    media?: string,
  ): number {
    const toolName = syscallToolName(syscallName) ?? syscallName;
    const toolResultMeta: ToolResultMetadata = {
      toolName,
      isError,
    };
    if (outcome) {
      toolResultMeta.outcome = outcome;
    }
    return this.appendMessage("toolResult", content, {
      runId,
      toolCallId,
      media,
      toolCalls: JSON.stringify(toolResultMeta),
    });
  }
}

function modelHistoryMessage(
  record: MessageRecord,
  options: ModelHistoryOptions | undefined,
): Message {
  switch (record.role) {
    case "user":
      return userHistoryMessage(record);
    case "system":
      return systemHistoryMessage(record);
    case "assistant":
      return assistantHistoryMessage(record, options);
    case "toolResult":
      return toolResultHistoryMessage(record);
  }
}

function userHistoryMessage(record: MessageRecord): UserMessage {
  const media = parseStoredProcessMedia(record.media);
  return {
    role: "user",
    content: media.length === 0 ? record.content : buildFallbackUserContent(record.content, media),
    timestamp: record.createdAt,
  };
}

function systemHistoryMessage(record: MessageRecord): UserMessage {
  return {
    role: "user",
    content: `[GSV EVENT]\n${record.content}`,
    timestamp: record.createdAt,
  };
}

function assistantHistoryMessage(
  record: MessageRecord,
  options: ModelHistoryOptions | undefined,
): AssistantMessage {
  const content: (TextContent | ThinkingContent | ToolCall)[] = [];
  const assistant = parseAssistantMessageMeta(record.toolCalls);
  const metadata = parseMessageMetadata(record.metadata);
  const { provider = null, contextEpochId, generationContextId } = metadata ?? {};
  const { api = "", provider: providerName = "", model = "", stopReason } = provider ?? {};
  if (assistant.thinking) content.push(...assistant.thinking);
  if (record.content) content.push({ type: "text", text: record.content });
  if (assistant.toolCalls) content.push(...assistant.toolCalls);
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api,
    provider: providerName,
    model,
    usage: usageStateToPiUsage(reusableAssistantUsage(metadata, options)),
    stopReason: normalizeAssistantStopReason(stopReason),
    timestamp: record.createdAt,
  };
  if (provider?.responseModel) message.responseModel = provider.responseModel;
  if (provider?.responseId) message.responseId = provider.responseId;
  tagAssistantContextIdentity(message, contextEpochId, generationContextId);
  return message;
}

function reusableAssistantUsage(
  metadata: MessageMetadata | null,
  options: ModelHistoryOptions | undefined,
) {
  const epochMatches =
    options?.contextEpochId === undefined || metadata?.contextEpochId === options.contextEpochId;
  const generationMatches =
    options?.generationContextId === undefined ||
    metadata?.generationContextId === options.generationContextId;
  return epochMatches && generationMatches ? metadata?.usage : undefined;
}

function toolResultHistoryMessage(record: MessageRecord): ToolResultMessage {
  const meta = record.toolCalls ? toolResultMetaSchema.parse(JSON.parse(record.toolCalls)) : {};
  const media = parseStoredProcessMedia(record.media);
  const legacyImageContent =
    media.length === 0 ? materializeLegacyToolResultImages(record.content) : null;
  return {
    role: "toolResult",
    toolCallId: requiredToolCallId(record),
    toolName: meta.toolName ?? "unknown",
    content: legacyImageContent ?? [
      { type: "text", text: record.content },
      ...buildFallbackMediaBlocks(media),
    ],
    isError: meta.isError ?? false,
    timestamp: record.createdAt,
  };
}
