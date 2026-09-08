import type { ProcessStore } from "../store";
import type {
  AssistantMessage, Message, TextContent, ThinkingContent, ToolCall, ToolResultMessage, UserMessage,
} from "@earendil-works/pi-ai";
import {
  procHistoryRecordDataSchema, type JsonObject, type JsonValue, type ProcHistoryRecord,
  type ProcHistoryRecordData, type ProcToolResultOutcome, type ResourceBlock,
} from "@humansandmachines/gsv/protocol";
import { buildFallbackMediaBlocks, parseStoredProcessMedia } from "../media";
import { materializeLegacyToolResultImages } from "../tool-result-media";
import { syscallToolName } from "../../syscalls/constants";
import { storedHistoryMedia } from "./history-media";
import { historyOutputResources, inferHistoryRecords, readHistoryRecord } from "./history-records";
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
      record?: ProcHistoryRecordData;
      records?: ProcHistoryRecordData[];
      queueKind?: string;
      provenance?: JsonObject;
      legacy?: boolean;
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
    const records = opts?.legacy ? [] : opts?.records ?? (opts?.record
      ? [opts.record]
      : inferHistoryRecords({
        id: 0, generation, runId, role, content, toolCalls, toolCallId, media, origin,
        metadata: metadataJson, createdAt,
      }, opts));
    const record = records[0];
    this.store.sql.exec(
      `INSERT INTO messages (
        generation, run_id, role, content, tool_calls, tool_call_id,
        media_json, origin_json, metadata_json, created_at, kind, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      record?.kind ?? null,
      record ? JSON.stringify(record.payload) : null,
    );

    const messageId = this.store.first<{ id: number }>("SELECT last_insert_rowid() as id")?.id ?? -1;

    for (const related of records.slice(1)) this.appendRelatedRecord(messageId, related);

    if (role === "assistant") {
      const metadata = parseMessageMetadata(metadataJson);
      if (metadata?.usage) {
        this.store.state.addHistoryUsage(metadata.usage);
      }
    }

    return messageId;
  }

  /** A typed member shares its compatibility message's ordering, lifetime, and timestamp. */
  appendRelatedRecord(messageId: number, record: ProcHistoryRecordData): number {
    const parent = this.store.first<MessageRow>(
      "SELECT * FROM messages WHERE id = ? AND group_message_id IS NULL", messageId,
    );
    if (!parent) throw new Error(`History message not found: ${messageId}`);
    if (parent.kind == null) {
      const inferred = inferHistoryRecords(messageRecordFromRow(parent));
      const first = inferred[0]!;
      this.store.sql.exec("UPDATE messages SET kind = ?, payload_json = ? WHERE id = ?",
        first.kind, JSON.stringify(first.payload), messageId);
      for (const member of inferred.slice(1)) this.appendRelatedRecord(messageId, member);
    }
    this.store.sql.exec(
      `INSERT INTO messages (generation, run_id, role, content, created_at, kind, payload_json, group_message_id)
       VALUES (?, ?, ?, '', ?, ?, ?, ?)`,
      parent.generation, parent.run_id, parent.role, parent.created_at,
      record.kind, JSON.stringify(record.payload), messageId,
    );
    return this.store.first<{ id: number }>("SELECT last_insert_rowid() as id")!.id;
  }

  appendRunRecord(runId: string, record: ProcHistoryRecordData): number {
    const generation = this.store.state.getHistoryGeneration();
    let existing: { id: number } | undefined;
    if (record.kind === "message" && record.payload.direction === "out" && record.payload.conversationMessageId) {
      existing = this.store.first<{ id: number }>(
        `SELECT id FROM messages WHERE generation = ? AND run_id = ? AND kind = 'message'
         AND json_extract(payload_json, '$.direction') = 'out'
         AND json_extract(payload_json, '$.conversationId') IS ?
         AND json_extract(payload_json, '$.conversationMessageId') = ? LIMIT 1`,
        generation, runId, record.payload.conversationId ?? null, record.payload.conversationMessageId,
      );
    } else if (record.kind === "event" && record.payload.kind === "correction.exhausted") {
      existing = this.store.first<{ id: number }>(
        `SELECT id FROM messages WHERE generation = ? AND run_id = ? AND kind = 'event'
         AND json_extract(payload_json, '$.kind') = 'correction.exhausted' LIMIT 1`,
        generation, runId,
      );
    }
    if (existing) return existing.id;
    const parent = this.store.first<{ id: number }>(
      `SELECT id FROM messages WHERE run_id = ? AND generation = ?
       AND group_message_id IS NULL ORDER BY id DESC LIMIT 1`,
      runId, this.store.state.getHistoryGeneration(),
    );
    if (!parent) throw new Error(`Run has no history message: ${runId}`);
    return this.appendRelatedRecord(parent.id, record);
  }

  updateMessageMedia(messageId: number, runId: string, media: string): void {
    this.setMessageMedia(messageId, runId, media);
  }

  clearMessageMedia(messageId: number, runId: string): void {
    this.setMessageMedia(messageId, runId, null);
  }

  private setMessageMedia(messageId: number, runId: string, media: string | null): void {
    const row = this.store.first<MessageRow>(
      "SELECT * FROM messages WHERE id = ? AND run_id = ? AND group_message_id IS NULL",
      messageId, runId,
    );
    if (!row) return;
    const record = readHistoryRecord(row);
    if (record && (record.kind === "message" || record.kind === "note" || record.kind === "result")) {
      record.payload.media = parseStoredProcessMedia(media);
    }
    this.store.sql.exec(
      "UPDATE messages SET media_json = ?, payload_json = ? WHERE id = ? AND run_id = ?",
      media, record ? JSON.stringify(record.payload) : null, messageId, runId,
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
    if (this.getMessages({ limit: null }).some((message) => storedHistoryMedia(message).some((media) => media.key === key))) {
      return true;
    }
    const rows = this.store.sql.exec<{ media_json: string | null; record_json: string | null }>(
      "SELECT media_json, record_json FROM message_queue WHERE media_json IS NOT NULL OR record_json IS NOT NULL",
    );
    for (const row of rows) {
      if (parseStoredProcessMedia(row.media_json).some((item) => item.key === key)) return true;
      if (row.record_json) {
        const record = procHistoryRecordDataSchema.parse(JSON.parse(row.record_json));
        if ((record.kind === "message" || record.kind === "note" || record.kind === "result") &&
            record.payload.media?.some((item) => item.type !== "resource" && item.key === key)) return true;
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
    const where: string[] = ["group_message_id IS NULL"];
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

    return this.decodeMessages(rows);
  }

  private relatedRows(rows: MessageRow[]): MessageRow[] {
    if (!rows.length) return [];
    return this.store.sql.exec<MessageRow>(
      `SELECT * FROM messages WHERE group_message_id >= ? AND group_message_id <= ? ORDER BY id ASC`,
      rows[0]!.id, rows[rows.length - 1]!.id,
    ).toArray();
  }

  private decodeMessages(rows: MessageRow[]): MessageRecord[] {
    const related = this.relatedRows(rows);
    const groups = new Map<number, ProcHistoryRecordData[]>();
    for (const row of related) {
      const record = readHistoryRecord(row);
      if (!record || row.group_message_id == null) throw new Error(`Invalid related history record ${row.id}`);
      const group = groups.get(row.group_message_id) ?? [];
      group.push(record);
      groups.set(row.group_message_id, group);
    }
    return rows.map((row) => {
      const message = messageRecordFromRow(row);
      const record = readHistoryRecord(row);
      if (record) message.records = [record, ...(groups.get(row.id) ?? [])];
      return message;
    });
  }

  getRecords(opts?: Parameters<ProcessMessageRepository["getMessages"]>[0]): ProcHistoryRecord[] {
    const messages = this.getMessages(opts);
    if (!messages.length) return [];
    const related = this.store.sql.exec<MessageRow>(
      "SELECT * FROM messages WHERE group_message_id >= ? AND group_message_id <= ? ORDER BY id ASC",
      messages[0]!.id, messages[messages.length - 1]!.id,
    ).toArray();
    const groups = new Map<number, MessageRow[]>();
    for (const row of related) {
      const group = groups.get(row.group_message_id!) ?? [];
      group.push(row);
      groups.set(row.group_message_id!, group);
    }
    return messages.flatMap((message) => {
      const records = message.records ?? inferHistoryRecords(message);
      const companions = groups.get(message.id) ?? [];
      const metadata = parseMessageMetadata(message.metadata);
      return records.map((record, index): ProcHistoryRecord => {
        const result: ProcHistoryRecord = {
          ...record,
          id: index === 0 || !message.records ? message.id : companions[index - 1]!.id,
          messageId: message.id, index, generation: message.generation,
          runId: message.runId ?? null, createdAt: message.createdAt,
          source: message.records ? "typed" : "legacy",
        };
        if (metadata) result.metadata = metadata;
        return result;
      });
    });
  }

  hasMessageBefore(messageId: number): boolean {
    return Boolean(this.store.first(
      "SELECT 1 as found FROM messages WHERE group_message_id IS NULL AND id < ? LIMIT 1", messageId,
    ));
  }

  hasMessageAfter(messageId: number): boolean {
    return Boolean(this.store.first(
      "SELECT 1 as found FROM messages WHERE group_message_id IS NULL AND id > ? LIMIT 1", messageId,
    ));
  }

  getMessagesForGeneration(
    generation: number = this.store.state.getHistoryGeneration(),
  ): MessageRecord[] {
    return this.decodeMessages([
      ...this.store.sql.exec<MessageRow>(
        `SELECT * FROM messages
        WHERE generation = ? AND group_message_id IS NULL
        ORDER BY id ASC`,
        generation,
      ),
    ]);
  }

  getRunInputMessageId(runId: string): number | null {
    const row = this.store.first<{ id: number }>(
        `SELECT id FROM messages
        WHERE generation = ? AND run_id = ? AND role = 'user' AND group_message_id IS NULL
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

    return this.decodeMessages([
      ...this.store.sql.exec<MessageRow>(
        `SELECT * FROM messages
        WHERE generation = ? AND group_message_id IS NULL
          AND id > ?
          ${createdAtFilter}
        ORDER BY id ASC`,
        ...args,
      ),
    ]);
  }

  messageCount(): number {
    return this.store.first<{ cnt: number }>("SELECT COUNT(*) as cnt FROM messages WHERE group_message_id IS NULL")?.cnt ?? 0;
  }

  messageStats(): MessageStats {
    const row = this.store.first<{ cnt: number; first_id: number | null; last_id: number | null }>(
      "SELECT COUNT(*) as cnt, MIN(id) as first_id, MAX(id) as last_id FROM messages WHERE group_message_id IS NULL",
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
    options?: {
      output: JsonValue;
      resources?: ResourceBlock[];
      error?: Extract<ProcHistoryRecordData, { kind: "result" }>["payload"]["error"];
      records?: ProcHistoryRecordData[];
    },
  ): number {
    const toolName = syscallToolName(syscallName) ?? syscallName;
    const toolResultMeta: ToolResultMetadata = {
      toolName,
      isError,
    };
    if (outcome) {
      toolResultMeta.outcome = outcome;
    }
    let records: ProcHistoryRecordData[] | undefined;
    if (options) {
      const payload: Extract<ProcHistoryRecordData, { kind: "result" }>["payload"] = {
        callId: toolCallId, tool: toolName, outcome: outcome ?? (isError ? "failed" : "completed"),
        output: options.output, media: parseStoredProcessMedia(media ?? null),
        resources: options.resources ?? historyOutputResources(options.output),
      };
      if (options.error) payload.error = options.error;
      else if (isError) payload.error = { message: content };
      records = [{ kind: "result", payload }, ...(options.records ?? [])];
    }
    return this.appendMessage("toolResult", content, {
      runId,
      toolCallId,
      media,
      toolCalls: JSON.stringify(toolResultMeta),
      records,
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
