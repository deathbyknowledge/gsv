import type {
  ConversationKind,
  ConversationMessage,
  ConversationMessageAuthor,
  ConversationMessageOrigin,
  ProcMediaInput,
} from "@humansandmachines/gsv/protocol";

type MetaRow = {
  conversation_id: string;
  owner_uid: number;
  kind: ConversationKind;
  created_at: number;
};

type MessageRow = {
  sequence: number;
  message_id: string;
  idempotency_key: string;
  author_json: string;
  text: string;
  media_json: string | null;
  origin_json: string;
  process_id: string | null;
  run_id: string | null;
  created_at: number;
};

export type ConversationAppendInput = {
  messageId: string;
  idempotencyKey: string;
  author: ConversationMessageAuthor;
  text: string;
  media?: ProcMediaInput[];
  origin: ConversationMessageOrigin;
  processId?: string;
  runId?: string;
  createdAt: number;
  payloadHash: string;
};

export type ConversationAppendResult = {
  message: ConversationMessage;
  created: boolean;
};

export type ConversationArchiveSegment = {
  segmentId: string;
  fromSequence: number;
  toSequence: number;
  messageCount: number;
  objectKey: string;
  checksum: string;
  createdAt: number;
};

export class ConversationStore {
  constructor(private readonly sql: SqlStorage) {}

  initialize(conversationId: string, ownerUid: number, kind: ConversationKind): MetaRow {
    this.sql.exec(
      `INSERT OR IGNORE INTO conversation_meta
       (conversation_id, owner_uid, kind, created_at)
       VALUES (?, ?, ?, ?)`,
      conversationId,
      ownerUid,
      kind,
      Date.now(),
    );
    const meta = this.meta();
    if (
      !meta
      || meta.conversation_id !== conversationId
      || meta.owner_uid !== ownerUid
      || meta.kind !== kind
    ) {
      throw new Error("Conversation identity does not match its existing state");
    }
    return meta;
  }

  meta(): MetaRow | null {
    return this.sql.exec<MetaRow>(
      `SELECT conversation_id, owner_uid, kind, created_at
       FROM conversation_meta
       LIMIT 1`,
    ).toArray()[0] ?? null;
  }

  append(input: ConversationAppendInput): ConversationAppendResult | null {
    const meta = this.requireMeta();
    const receipt = this.sql.exec<{
      message_id: string;
      sequence: number;
      payload_hash: string;
    }>(
      `SELECT message_id, sequence, payload_hash
       FROM message_receipts WHERE idempotency_key = ? LIMIT 1`,
      input.idempotencyKey,
    ).toArray()[0];
    if (receipt) {
      if (receipt.message_id !== input.messageId || receipt.payload_hash !== input.payloadHash) {
        throw new Error("Conversation message idempotency key payload changed");
      }
      const row = this.rowBySequence(receipt.sequence);
      return row ? { message: toMessage(meta.conversation_id, row), created: false } : null;
    }
    this.sql.exec(
      `INSERT OR IGNORE INTO messages
       (message_id, idempotency_key, author_json, text, media_json, origin_json,
        process_id, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.messageId,
      input.idempotencyKey,
      JSON.stringify(input.author),
      input.text,
      input.media?.length ? JSON.stringify(input.media) : null,
      JSON.stringify(input.origin),
      input.processId ?? null,
      input.runId ?? null,
      input.createdAt,
    );
    const row = this.sql.exec<MessageRow>(
      `SELECT * FROM messages WHERE idempotency_key = ? LIMIT 1`,
      input.idempotencyKey,
    ).toArray()[0];
    if (!row || row.message_id !== input.messageId) {
      throw new Error("Conversation message idempotency key was reused");
    }
    const message = toMessage(meta.conversation_id, row);
    this.sql.exec(
      `INSERT INTO message_receipts
       (idempotency_key, message_id, sequence, payload_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      input.idempotencyKey,
      input.messageId,
      message.sequence,
      input.payloadHash,
      Date.now(),
    );
    return { message, created: true };
  }

  receipt(idempotencyKey: string): {
    messageId: string;
    sequence: number;
    payloadHash: string;
  } | null {
    const row = this.sql.exec<{
      message_id: string;
      sequence: number;
      payload_hash: string;
    }>(
      `SELECT message_id, sequence, payload_hash
       FROM message_receipts WHERE idempotency_key = ? LIMIT 1`,
      idempotencyKey,
    ).toArray()[0];
    return row ? {
      messageId: row.message_id,
      sequence: row.sequence,
      payloadHash: row.payload_hash,
    } : null;
  }

  messageAt(sequence: number): ConversationMessage | null {
    const meta = this.requireMeta();
    const row = this.rowBySequence(sequence);
    return row ? toMessage(meta.conversation_id, row) : null;
  }

  listHot(beforeSequence: number, limit: number): ConversationMessage[] {
    const meta = this.requireMeta();
    return this.sql.exec<MessageRow>(
      `SELECT * FROM messages
       WHERE sequence < ?
       ORDER BY sequence DESC
       LIMIT ?`,
      beforeSequence,
      limit,
    ).toArray().map((row) => toMessage(meta.conversation_id, row));
  }

  latestSequence(): number {
    const hot = this.sql.exec<{ value: number | null }>(
      "SELECT MAX(sequence) AS value FROM messages",
    ).toArray()[0]?.value ?? 0;
    const archived = this.sql.exec<{ value: number | null }>(
      "SELECT MAX(to_sequence) AS value FROM archive_segments",
    ).toArray()[0]?.value ?? 0;
    return Math.max(hot, archived);
  }

  hotCount(): number {
    return this.sql.exec<{ value: number }>(
      "SELECT COUNT(*) AS value FROM messages",
    ).toArray()[0]?.value ?? 0;
  }

  oldestHot(limit: number): ConversationMessage[] {
    const meta = this.requireMeta();
    return this.sql.exec<MessageRow>(
      "SELECT * FROM messages ORDER BY sequence ASC LIMIT ?",
      limit,
    ).toArray().map((row) => toMessage(meta.conversation_id, row));
  }

  archiveSegmentsBefore(beforeSequence: number): ConversationArchiveSegment[] {
    return this.sql.exec<{
      segment_id: string;
      from_sequence: number;
      to_sequence: number;
      message_count: number;
      object_key: string;
      checksum: string;
      created_at: number;
    }>(
      `SELECT * FROM archive_segments
       WHERE from_sequence < ?
       ORDER BY to_sequence DESC`,
      beforeSequence,
    ).toArray().map((row) => ({
      segmentId: row.segment_id,
      fromSequence: row.from_sequence,
      toSequence: row.to_sequence,
      messageCount: row.message_count,
      objectKey: row.object_key,
      checksum: row.checksum,
      createdAt: row.created_at,
    }));
  }

  commitArchive(segment: ConversationArchiveSegment, messages: ConversationMessage[]): void {
    if (messages.length === 0) return;
    const expected = messages.map((message) => message.sequence);
    const current = this.sql.exec<{ sequence: number }>(
      `SELECT sequence FROM messages
       WHERE sequence >= ? AND sequence <= ?
       ORDER BY sequence`,
      segment.fromSequence,
      segment.toSequence,
    ).toArray().map((row) => row.sequence);
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error("Conversation archive candidate changed before commit");
    }
    this.sql.exec(
      `INSERT OR IGNORE INTO archive_segments
       (segment_id, from_sequence, to_sequence, message_count, object_key, checksum, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      segment.segmentId,
      segment.fromSequence,
      segment.toSequence,
      segment.messageCount,
      segment.objectKey,
      segment.checksum,
      segment.createdAt,
    );
    this.sql.exec(
      "DELETE FROM messages WHERE sequence >= ? AND sequence <= ?",
      segment.fromSequence,
      segment.toSequence,
    );
  }

  hasSequenceBefore(sequence: number): boolean {
    const hot = this.sql.exec<{ value: number }>(
      "SELECT COUNT(*) AS value FROM messages WHERE sequence < ?",
      sequence,
    ).toArray()[0]?.value ?? 0;
    if (hot > 0) return true;
    return (this.sql.exec<{ value: number }>(
      "SELECT COUNT(*) AS value FROM archive_segments WHERE from_sequence < ?",
      sequence,
    ).toArray()[0]?.value ?? 0) > 0;
  }

  private requireMeta(): MetaRow {
    const meta = this.meta();
    if (!meta) throw new Error("Conversation is not initialized");
    return meta;
  }

  private rowBySequence(sequence: number): MessageRow | null {
    return this.sql.exec<MessageRow>(
      "SELECT * FROM messages WHERE sequence = ? LIMIT 1",
      sequence,
    ).toArray()[0] ?? null;
  }
}

function toMessage(conversationId: string, row: MessageRow): ConversationMessage {
  return {
    id: row.message_id,
    conversationId,
    sequence: row.sequence,
    author: JSON.parse(row.author_json) as ConversationMessageAuthor,
    text: row.text,
    ...(row.media_json ? { media: JSON.parse(row.media_json) as ProcMediaInput[] } : {}),
    origin: JSON.parse(row.origin_json) as ConversationMessageOrigin,
    ...(row.process_id ? { processId: row.process_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    createdAt: row.created_at,
  };
}
