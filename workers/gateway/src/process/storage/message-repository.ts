import type { ProcessStore } from "../store";
import type { Message } from "@earendil-works/pi-ai";
import {
  procHistoryRecordDataSchema, type JsonObject, type JsonValue, type ProcHistoryRecord,
  type ProcHistoryRecordData, type ProcToolResultOutcome, type ResourceBlock,
} from "@humansandmachines/gsv/protocol";
import { parseStoredProcessMedia } from "../media";
import { syscallToolName } from "../../syscalls/constants";
import { storedHistoryMedia } from "./history-media";
import {
  historyOutputResources, inferHistoryRecords, normalizeModelHistoryGroup, readHistoryRecord,
} from "./history-records";
import {
  renderModelHistory, type ModelHistoryGroup, type ModelHistoryRenderOptions,
} from "../history/model-renderer";
import {
  DEFAULT_MESSAGE_READ_LIMIT, messageRecordFromRow, parseMessageMetadata, stringifyMessageMetadata,
  type MessageMetadata, type MessageRecord, type MessageRole,
  type MessageRow, type MessageStats, type ToolResultMetadata,
} from "./store-codecs";

type ModelHistoryOptions = ModelHistoryRenderOptions & {
  limit?: number | null;
  offset?: number;
};

type HistoryDeltaPage = {
  messages: MessageRecord[];
  revision: number | null;
  hasMore: boolean;
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
        id: 0, runId, role, content, toolCalls, toolCallId, media, origin,
      }, opts));
    const record = records[0];
    const modelNeutral = (record?.kind === "event" && record.payload.audience === "person") ||
      (record?.kind === "message" && record.payload.direction === "out");
    const context = modelNeutral ? this.store.state.getContextState() : null;
    const priorStats = context ? this.messageStats() : null;
    const freshContext = context && priorStats && context.messageCount === priorStats.count &&
      context.lastMessageId === priorStats.lastMessageId ? context : null;
    this.store.sql.exec(
      `INSERT INTO messages (
        generation, run_id, role, content, tool_calls, tool_call_id,
        media_json, origin_json, metadata_json, created_at, kind, payload_json, history_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      this.store.state.nextHistoryRevision(),
    );

    const messageId = this.store.first<{ id: number }>("SELECT last_insert_rowid() as id")?.id ?? -1;

    for (const related of records.slice(1)) this.appendRelatedRecord(messageId, related);

    if (role === "assistant") {
      const metadata = parseMessageMetadata(metadataJson);
      if (metadata?.usage) {
        this.store.state.addHistoryUsage(metadata.usage);
      }
    }

    if (freshContext) {
      const stats = this.messageStats();
      // The measurement is unchanged; only its durable coordinates and state revision advance.
      this.store.state.setContextState({
        ...freshContext,
        revision: this.store.state.nextContextStateRevision(),
        messageCount: stats.count,
        lastMessageId: stats.lastMessageId,
      });
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
    const recordId = this.store.first<{ id: number }>("SELECT last_insert_rowid() as id")!.id;
    this.store.sql.exec("UPDATE messages SET history_revision = ? WHERE id = ?",
      this.store.state.nextHistoryRevision(), messageId);
    return recordId;
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
      "UPDATE messages SET media_json = ?, payload_json = ?, history_revision = ? WHERE id = ? AND run_id = ?",
      media, record ? JSON.stringify(record.payload) : null,
      this.store.state.nextHistoryRevision(), messageId, runId,
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

  private relatedRows(rows: ReadonlyArray<{ id: number }>): MessageRow[] {
    if (!rows.length) return [];
    return this.store.sql.exec<MessageRow>(
      `SELECT * FROM messages WHERE group_message_id IN (SELECT value FROM json_each(?)) ORDER BY id ASC`,
      JSON.stringify(rows.map((row) => row.id)),
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
    return this.recordsForMessages(this.getMessages(opts));
  }

  /** Selects whole changed groups; a late companion or media update moves its parent forward. */
  getHistoryDelta(afterRevision: number, limit: number): HistoryDeltaPage {
    const rows = this.store.sql.exec<MessageRow & { history_revision: number }>(
      `SELECT * FROM messages WHERE group_message_id IS NULL AND history_revision > ?
       ORDER BY history_revision ASC, id ASC LIMIT ?`,
      afterRevision, limit + 1,
    ).toArray();
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return {
      messages: this.decodeMessages(rows),
      revision: rows.at(-1)?.history_revision ?? null,
      hasMore,
    };
  }

  recordsForMessages(messages: MessageRecord[]): ProcHistoryRecord[] {
    if (!messages.length) return [];
    const related = this.relatedRows(messages);
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
    this.store.state.invalidateHistoryCursors();
    this.store.sql.exec("DELETE FROM messages");
    this.store.state.deleteContextState();
    this.store.state.deleteHistoryUsage();
    return count;
  }

  // --- Message conversion to pi-ai format ---

  getModelHistoryGroups(
    opts?: Parameters<ProcessMessageRepository["getMessages"]>[0],
  ): ModelHistoryGroup[] {
    return this.getMessages(opts).map(normalizeModelHistoryGroup);
  }

  toMessages(opts?: ModelHistoryOptions): Message[] {
    return renderModelHistory(this.getModelHistoryGroups(opts), opts);
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
