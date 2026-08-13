import type {
  ManagedMailSummary,
  ManagedMailSummaryCategory,
} from "@humansandmachines/gsv/protocol";

export type MailboxRecord = {
  mailboxId: string;
  ownerUid: number;
  address: string;
  notificationUid: number | null;
  notificationPid: string | null;
  createdAt: number;
  updatedAt: number;
};

export type MailAttachmentRecord = {
  filename?: string;
  mimeType: string;
  disposition?: string;
  contentId?: string;
  size: number;
};

export type MailMessageRecord = {
  messageId: string;
  mailboxId: string;
  digest: string;
  envelopeFrom: string;
  envelopeTo: string;
  headerMessageId: string | null;
  displayFrom: string | null;
  to: string[];
  cc: string[];
  replyTo: string[];
  subject: string | null;
  sentAt: number | null;
  receivedAt: number;
  rawPath: string;
  textPath: string;
  sizeBytes: number;
  attachments: MailAttachmentRecord[];
  summary: string | null;
  category: ManagedMailSummaryCategory | null;
  requiresAttention: boolean | null;
  confidence: number | null;
  summarizedAt: number | null;
  eventDeliveredAt: number | null;
  createdAt: number;
};

export type RecordMailMessageInput = Omit<
  MailMessageRecord,
  | "summary"
  | "category"
  | "requiresAttention"
  | "confidence"
  | "summarizedAt"
  | "eventDeliveredAt"
  | "createdAt"
> & {
  intakeId: string;
};

export type MailIntakeRecord = {
  intakeId: string;
  mailboxId: string;
  messageId: string;
  digest: string;
  receivedAt: number;
  createdAt: number;
};

export type MailMessagePage = {
  messages: MailMessageRecord[];
  count: number;
};

export class MailboxStore {
  constructor(private readonly sql: SqlStorage) {}

  getMailbox(mailboxId: string): MailboxRecord | null {
    const row = this.sql.exec<MailboxRow>(
      "SELECT * FROM mailboxes WHERE mailbox_id = ?",
      mailboxId,
    ).toArray()[0];
    return row ? mailboxFromRow(row) : null;
  }

  getMailboxByAddress(address: string): MailboxRecord | null {
    const row = this.sql.exec<MailboxRow>(
      "SELECT * FROM mailboxes WHERE address = ?",
      address,
    ).toArray()[0];
    return row ? mailboxFromRow(row) : null;
  }

  getMailboxForOwner(ownerUid: number): MailboxRecord | null {
    const row = this.sql.exec<MailboxRow>(
      `SELECT * FROM mailboxes
        WHERE owner_uid = ?
        ORDER BY created_at, mailbox_id
        LIMIT 1`,
      ownerUid,
    ).toArray()[0];
    return row ? mailboxFromRow(row) : null;
  }

  getPrimaryMailbox(): MailboxRecord | null {
    const row = this.sql.exec<MailboxRow>(
      "SELECT * FROM mailboxes ORDER BY created_at, mailbox_id LIMIT 1",
    ).toArray()[0];
    return row ? mailboxFromRow(row) : null;
  }

  ensureMailbox(mailboxId: string, ownerUid: number, address: string): MailboxRecord {
    const now = Date.now();
    this.sql.exec(
      `INSERT OR IGNORE INTO mailboxes
         (mailbox_id, owner_uid, address, notification_pid, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
      mailboxId,
      ownerUid,
      address,
      now,
      now,
    );
    const mailbox = this.getMailbox(mailboxId);
    if (!mailbox) {
      throw new Error("Mailbox could not be created");
    }
    if (mailbox.ownerUid !== ownerUid || mailbox.address !== address) {
      throw new Error("Mailbox identity conflicts with existing state");
    }
    return mailbox;
  }

  setNotificationPid(mailboxId: string, processId: string | null): void {
    this.sql.exec(
      `UPDATE mailboxes
          SET notification_pid = ?, updated_at = ?
        WHERE mailbox_id = ?`,
      processId,
      Date.now(),
      mailboxId,
    );
    if (!this.getMailbox(mailboxId)) {
      throw new Error("Unknown mailbox");
    }
  }

  setNotificationUid(mailboxId: string, uid: number): void {
    this.sql.exec(
      `UPDATE mailboxes
          SET notification_uid = ?, updated_at = ?
        WHERE mailbox_id = ? AND (notification_uid IS NULL OR notification_uid = ?)`,
      uid,
      Date.now(),
      mailboxId,
      uid,
    );
    const mailbox = this.getMailbox(mailboxId);
    if (!mailbox) throw new Error("Unknown mailbox");
    if (mailbox.notificationUid !== uid) {
      throw new Error("Mailbox notification identity conflicts with existing state");
    }
  }

  findMessageByDelivery(
    mailboxId: string,
    intakeId: string,
    digest: string,
  ): MailMessageRecord | null {
    const intake = this.getIntake(intakeId);
    if (intake) {
      if (intake.mailboxId !== mailboxId || intake.digest !== digest) {
        throw new Error("Mail intake identity conflicts with existing state");
      }
      const message = this.getMessageById(intake.messageId);
      if (!message || message.mailboxId !== mailboxId || message.digest !== digest) {
        throw new Error("Mail intake points to invalid message state");
      }
      return message;
    }

    const row = this.sql.exec<MailMessageRow>(
      `SELECT * FROM mail_messages
        WHERE mailbox_id = ? AND digest = ?
        LIMIT 1`,
      mailboxId,
      digest,
    ).toArray()[0];
    if (!row) return null;
    return messageFromRow(row);
  }

  getIntake(intakeId: string): MailIntakeRecord | null {
    const row = this.sql.exec<MailIntakeRow>(
      "SELECT * FROM mail_intakes WHERE intake_id = ?",
      intakeId,
    ).toArray()[0];
    return row ? intakeFromRow(row) : null;
  }

  acceptReplay(input: {
    mailboxId: string;
    intakeId: string;
    digest: string;
    receivedAt: number;
  }): MailMessageRecord | null {
    const existing = this.findMessageByDelivery(
      input.mailboxId,
      input.intakeId,
      input.digest,
    );
    if (!existing) return null;
    this.recordIntake(input, existing.messageId);
    return existing;
  }

  recordMessage(input: RecordMailMessageInput): {
    created: boolean;
    message: MailMessageRecord;
  } {
    const existing = this.findMessageByDelivery(
      input.mailboxId,
      input.intakeId,
      input.digest,
    );
    if (existing) {
      this.recordIntake(input, existing.messageId);
      return { created: false, message: existing };
    }

    const createdAt = Date.now();
    this.recordIntake(input, input.messageId);
    try {
      this.sql.exec(
        `INSERT INTO mail_messages (
           message_id, mailbox_id, digest, envelope_from, envelope_to,
           header_message_id, display_from, to_json, cc_json, reply_to_json,
           subject, sent_at,
           received_at, raw_path, text_path, size_bytes, attachments_json,
           summary, category, requires_attention, confidence, summarized_at,
           event_delivered_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL,
                   NULL, NULL, NULL, NULL, NULL, ?)`,
        input.messageId,
        input.mailboxId,
        input.digest,
        input.envelopeFrom,
        input.envelopeTo,
        input.headerMessageId,
        input.displayFrom,
        JSON.stringify(input.to),
        JSON.stringify(input.cc),
        JSON.stringify(input.replyTo),
        input.subject,
        input.sentAt,
        input.receivedAt,
        input.rawPath,
        input.textPath,
        input.sizeBytes,
        JSON.stringify(input.attachments),
        createdAt,
      );
    } catch (error) {
      this.sql.exec(
        "DELETE FROM mail_intakes WHERE intake_id = ? AND message_id = ?",
        input.intakeId,
        input.messageId,
      );
      throw error;
    }
    const message = this.getMessageById(input.messageId);
    if (!message) {
      this.sql.exec(
        "DELETE FROM mail_intakes WHERE intake_id = ? AND message_id = ?",
        input.intakeId,
        input.messageId,
      );
      throw new Error("Mail message could not be recorded");
    }
    return { created: true, message };
  }

  assertIntakeMessage(intakeId: string, messageId: string): MailMessageRecord {
    const intake = this.getIntake(intakeId);
    if (!intake || intake.messageId !== messageId) {
      throw new Error("Mail completion does not match an accepted intake");
    }
    const message = this.getMessageById(messageId);
    if (!message || message.mailboxId !== intake.mailboxId || message.digest !== intake.digest) {
      throw new Error("Mail completion points to invalid message state");
    }
    return message;
  }

  completeSummary(
    messageId: string,
    summary: ManagedMailSummary,
  ): { completed: boolean; message: MailMessageRecord } {
    const existing = this.getMessageById(messageId);
    if (!existing) throw new Error("Unknown mail message");
    if (existing.summarizedAt !== null) {
      if (
        existing.summary !== summary.summary
        || existing.category !== summary.category
        || existing.requiresAttention !== summary.requiresAttention
        || existing.confidence !== summary.confidence
      ) {
        throw new Error("Mail summary conflicts with existing state");
      }
      return { completed: false, message: existing };
    }

    this.sql.exec(
      `UPDATE mail_messages
          SET summary = ?, category = ?, requires_attention = ?, confidence = ?,
              summarized_at = ?
        WHERE message_id = ? AND summarized_at IS NULL`,
      summary.summary,
      summary.category,
      summary.requiresAttention ? 1 : 0,
      summary.confidence,
      Date.now(),
      messageId,
    );
    const message = this.getMessageById(messageId);
    if (!message) throw new Error("Mail message disappeared after summarization");
    return { completed: true, message };
  }

  markEventDelivered(messageId: string, deliveredAt = Date.now()): void {
    this.sql.exec(
      `UPDATE mail_messages
          SET event_delivered_at = COALESCE(event_delivered_at, ?)
        WHERE message_id = ?`,
      deliveredAt,
      messageId,
    );
    if (!this.getMessageById(messageId)) {
      throw new Error("Unknown mail message");
    }
  }

  getMessage(ownerUid: number, messageIdOrPrefix: string): MailMessageRecord | null {
    const exact = this.sql.exec<MailMessageRow>(
      `SELECT mail_messages.*
         FROM mail_messages
         JOIN mailboxes USING (mailbox_id)
        WHERE mailboxes.owner_uid = ? AND mail_messages.message_id = ?`,
      ownerUid,
      messageIdOrPrefix,
    ).toArray()[0];
    if (exact) return messageFromRow(exact);

    const matches = this.sql.exec<MailMessageRow>(
      `SELECT mail_messages.*
         FROM mail_messages
         JOIN mailboxes USING (mailbox_id)
        WHERE mailboxes.owner_uid = ? AND mail_messages.message_id LIKE ? ESCAPE '\\'
        ORDER BY mail_messages.received_at DESC
        LIMIT 2`,
      ownerUid,
      `${escapeLike(messageIdOrPrefix)}%`,
    ).toArray();
    if (matches.length > 1) {
      throw new Error("Mail message id prefix is ambiguous");
    }
    return matches[0] ? messageFromRow(matches[0]) : null;
  }

  getMessageById(messageId: string): MailMessageRecord | null {
    const row = this.sql.exec<MailMessageRow>(
      "SELECT * FROM mail_messages WHERE message_id = ?",
      messageId,
    ).toArray()[0];
    return row ? messageFromRow(row) : null;
  }

  list(ownerUid: number, limit = 50, offset = 0): MailMessagePage {
    return this.query(ownerUid, undefined, limit, offset);
  }

  search(ownerUid: number, query: string, limit = 50, offset = 0): MailMessagePage {
    return this.query(ownerUid, query, limit, offset);
  }

  private query(
    ownerUid: number,
    query: string | undefined,
    limitValue: number,
    offsetValue: number,
  ): MailMessagePage {
    const limit = normalizePageNumber(limitValue, 1, 200, 50);
    const offset = normalizePageNumber(offsetValue, 0, 1_000_000, 0);
    const normalizedQuery = query?.trim().toLowerCase() ?? "";
    const filter = normalizedQuery
      ? `AND (
          LOWER(COALESCE(mail_messages.subject, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(mail_messages.display_from, '')) LIKE ? ESCAPE '\\'
          OR LOWER(mail_messages.envelope_from) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(mail_messages.summary, '')) LIKE ? ESCAPE '\\'
        )`
      : "";
    const args: unknown[] = [ownerUid];
    if (normalizedQuery) {
      const pattern = `%${escapeLike(normalizedQuery)}%`;
      args.push(pattern, pattern, pattern, pattern);
    }
    const count = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM mail_messages
         JOIN mailboxes USING (mailbox_id)
        WHERE mailboxes.owner_uid = ? ${filter}`,
      ...args,
    ).toArray()[0]?.count ?? 0;
    const rows = this.sql.exec<MailMessageRow>(
      `SELECT mail_messages.*
         FROM mail_messages
         JOIN mailboxes USING (mailbox_id)
        WHERE mailboxes.owner_uid = ? ${filter}
        ORDER BY mail_messages.received_at DESC, mail_messages.message_id DESC
        LIMIT ? OFFSET ?`,
      ...args,
      limit,
      offset,
    ).toArray();
    return { messages: rows.map(messageFromRow), count };
  }

  private recordIntake(
    input: Pick<RecordMailMessageInput, "intakeId" | "mailboxId" | "digest" | "receivedAt">,
    messageId: string,
  ): void {
    const createdAt = Date.now();
    this.sql.exec(
      `INSERT OR IGNORE INTO mail_intakes
         (intake_id, mailbox_id, message_id, digest, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.intakeId,
      input.mailboxId,
      messageId,
      input.digest,
      input.receivedAt,
      createdAt,
    );
    const intake = this.getIntake(input.intakeId);
    if (
      !intake
      || intake.mailboxId !== input.mailboxId
      || intake.messageId !== messageId
      || intake.digest !== input.digest
    ) {
      throw new Error("Mail intake identity conflicts with existing state");
    }
  }
}

type MailboxRow = {
  mailbox_id: string;
  owner_uid: number;
  address: string;
  notification_uid: number | null;
  notification_pid: string | null;
  created_at: number;
  updated_at: number;
};

type MailMessageRow = {
  message_id: string;
  mailbox_id: string;
  digest: string;
  envelope_from: string;
  envelope_to: string;
  header_message_id: string | null;
  display_from: string | null;
  to_json: string;
  cc_json: string;
  reply_to_json: string;
  subject: string | null;
  sent_at: number | null;
  received_at: number;
  raw_path: string;
  text_path: string;
  size_bytes: number;
  attachments_json: string;
  summary: string | null;
  category: ManagedMailSummaryCategory | null;
  requires_attention: number | null;
  confidence: number | null;
  summarized_at: number | null;
  event_delivered_at: number | null;
  created_at: number;
};

type MailIntakeRow = {
  intake_id: string;
  mailbox_id: string;
  message_id: string;
  digest: string;
  received_at: number;
  created_at: number;
};

function mailboxFromRow(row: MailboxRow): MailboxRecord {
  return {
    mailboxId: row.mailbox_id,
    ownerUid: row.owner_uid,
    address: row.address,
    notificationUid: row.notification_uid,
    notificationPid: row.notification_pid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageFromRow(row: MailMessageRow): MailMessageRecord {
  return {
    messageId: row.message_id,
    mailboxId: row.mailbox_id,
    digest: row.digest,
    envelopeFrom: row.envelope_from,
    envelopeTo: row.envelope_to,
    headerMessageId: row.header_message_id,
    displayFrom: row.display_from,
    to: parseStringArray(row.to_json, "mail to recipients"),
    cc: parseStringArray(row.cc_json, "mail cc recipients"),
    replyTo: parseStringArray(row.reply_to_json, "mail reply-to recipients"),
    subject: row.subject,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    rawPath: row.raw_path,
    textPath: row.text_path,
    sizeBytes: row.size_bytes,
    attachments: parseAttachments(row.attachments_json),
    summary: row.summary,
    category: row.category,
    requiresAttention: row.requires_attention === null
      ? null
      : row.requires_attention === 1,
    confidence: row.confidence,
    summarizedAt: row.summarized_at,
    eventDeliveredAt: row.event_delivered_at,
    createdAt: row.created_at,
  };
}

function intakeFromRow(row: MailIntakeRow): MailIntakeRecord {
  return {
    intakeId: row.intake_id,
    mailboxId: row.mailbox_id,
    messageId: row.message_id,
    digest: row.digest,
    receivedAt: row.received_at,
    createdAt: row.created_at,
  };
}

function parseStringArray(value: string, field: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`Stored ${field} are invalid`);
  }
  return parsed;
}

function parseAttachments(value: string): MailAttachmentRecord[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed)
    || !parsed.every((item) => (
      item
      && typeof item === "object"
      && !Array.isArray(item)
      && typeof (item as Partial<MailAttachmentRecord>).mimeType === "string"
      && Number.isSafeInteger((item as Partial<MailAttachmentRecord>).size)
      && ((item as Partial<MailAttachmentRecord>).size ?? -1) >= 0
      && (
        (item as Partial<MailAttachmentRecord>).filename === undefined
        || typeof (item as Partial<MailAttachmentRecord>).filename === "string"
      )
      && (
        (item as Partial<MailAttachmentRecord>).disposition === undefined
        || typeof (item as Partial<MailAttachmentRecord>).disposition === "string"
      )
      && (
        (item as Partial<MailAttachmentRecord>).contentId === undefined
        || typeof (item as Partial<MailAttachmentRecord>).contentId === "string"
      )
    ))
  ) {
    throw new Error("Stored mail attachments are invalid");
  }
  return parsed as MailAttachmentRecord[];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function normalizePageNumber(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Number.isSafeInteger(value) && value >= minimum
    ? Math.min(value, maximum)
    : fallback;
}
