import type {
  ConversationKind,
  ConversationMember,
  ConversationSummary,
} from "@humansandmachines/gsv/protocol";

type ConversationRow = {
  conversation_id: string;
  owner_uid: number;
  kind: ConversationKind;
  title: string | null;
  handler_pid: string;
  latest_sequence: number;
  created_at: number;
  updated_at: number;
};

export class ConversationRegistry {
  constructor(private readonly sql: SqlStorage) {}

  ensureShip(ownerUid: number, handlerPid: string): ConversationSummary {
    const existing = this.getShip(ownerUid);
    if (existing) {
      if (existing.handlerPid !== handlerPid) {
        this.setHandler(existing.id, handlerPid);
      }
      return this.get(existing.id)!;
    }
    return this.create({
      id: `conv:${crypto.randomUUID()}`,
      ownerUid,
      kind: "ship",
      title: "Ship",
      handlerPid,
    });
  }

  ensureWork(
    ownerUid: number,
    handlerPid: string,
    title: string | null,
  ): ConversationSummary {
    const existing = this.getForWorkProcess(handlerPid);
    if (existing) {
      if (existing.ownerUid !== ownerUid) {
        throw new Error("Work conversation ownership does not match its process");
      }
      return existing;
    }
    return this.create({
      id: `conv:${crypto.randomUUID()}`,
      ownerUid,
      kind: "work",
      title,
      handlerPid,
    });
  }

  ensureGroup(
    ownerUid: number,
    handlerPid: string,
    title: string | null,
    surfaceKey: string,
  ): ConversationSummary {
    const existing = this.getForSurface(surfaceKey);
    if (existing) {
      if (existing.ownerUid !== ownerUid) {
        throw new Error("Group conversation ownership does not match its surface");
      }
      if (existing.handlerPid !== handlerPid) {
        this.setHandler(existing.id, handlerPid);
      }
      return this.get(existing.id)!;
    }
    const conversation = this.create({
      id: `conv:${crypto.randomUUID()}`,
      ownerUid,
      kind: "group",
      title,
      handlerPid,
    });
    this.sql.exec(
      `INSERT INTO conversation_surfaces
       (surface_key, conversation_id, owner_uid, created_at)
       VALUES (?, ?, ?, ?)`,
      surfaceKey,
      conversation.id,
      ownerUid,
      Date.now(),
    );
    return conversation;
  }

  ensureContact(
    ownerUid: number,
    handlerPid: string,
    title: string,
    conversationId: string,
  ): ConversationSummary {
    const existing = this.get(conversationId);
    if (existing) {
      if (existing.ownerUid !== ownerUid || existing.kind !== "contact") {
        throw new Error("Contact conversation identity does not match its contact");
      }
      if (existing.handlerPid !== handlerPid) {
        this.setHandler(existing.id, handlerPid);
      }
      return this.get(existing.id)!;
    }
    return this.create({
      id: conversationId,
      ownerUid,
      kind: "contact",
      title,
      handlerPid,
    });
  }

  create(input: {
    id: string;
    ownerUid: number;
    kind: ConversationKind;
    title: string | null;
    handlerPid: string;
  }): ConversationSummary {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO conversations
       (conversation_id, owner_uid, kind, title, handler_pid, latest_sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      input.id,
      input.ownerUid,
      input.kind,
      input.title,
      input.handlerPid,
      now,
      now,
    );
    this.addMember(input.id, { kind: "account", id: String(input.ownerUid), role: "member" });
    this.addMember(input.id, { kind: "process", id: input.handlerPid, role: "handler" });
    return this.get(input.id)!;
  }

  get(id: string): ConversationSummary | null {
    const row = this.sql.exec<ConversationRow>(
      "SELECT * FROM conversations WHERE conversation_id = ? LIMIT 1",
      id,
    ).toArray()[0];
    return row ? toSummary(row) : null;
  }

  getShip(ownerUid: number): ConversationSummary | null {
    const row = this.sql.exec<ConversationRow>(
      `SELECT * FROM conversations
       WHERE owner_uid = ? AND kind = 'ship'
       LIMIT 1`,
      ownerUid,
    ).toArray()[0];
    return row ? toSummary(row) : null;
  }

  getForWorkProcess(pid: string): ConversationSummary | null {
    const row = this.sql.exec<ConversationRow>(
      `SELECT * FROM conversations
       WHERE handler_pid = ? AND kind = 'work'
       LIMIT 1`,
      pid,
    ).toArray()[0];
    return row ? toSummary(row) : null;
  }

  getForSurface(surfaceKey: string): ConversationSummary | null {
    const row = this.sql.exec<ConversationRow>(
      `SELECT c.*
       FROM conversation_surfaces s
       JOIN conversations c ON c.conversation_id = s.conversation_id
       WHERE s.surface_key = ?
       LIMIT 1`,
      surfaceKey,
    ).toArray()[0];
    return row ? toSummary(row) : null;
  }

  list(ownerUid: number): ConversationSummary[] {
    return this.sql.exec<ConversationRow>(
      `SELECT * FROM conversations
       WHERE owner_uid = ?
       ORDER BY updated_at DESC, created_at DESC`,
      ownerUid,
    ).toArray().map(toSummary);
  }

  setHandler(id: string, handlerPid: string): void {
    const current = this.get(id);
    if (!current) throw new Error("Conversation does not exist");
    this.sql.exec(
      `UPDATE conversation_members
       SET role = 'observer'
       WHERE conversation_id = ? AND member_kind = 'process' AND role = 'handler'`,
      id,
    );
    this.addMember(id, { kind: "process", id: handlerPid, role: "handler" });
    this.sql.exec(
      `UPDATE conversation_members
       SET role = 'handler'
       WHERE conversation_id = ? AND member_kind = 'process' AND member_id = ?`,
      id,
      handlerPid,
    );
    this.sql.exec(
      `UPDATE conversations SET handler_pid = ?, updated_at = ?
       WHERE conversation_id = ?`,
      handlerPid,
      Date.now(),
      id,
    );
  }

  recordSequence(id: string, sequence: number): void {
    this.sql.exec(
      `UPDATE conversations
       SET latest_sequence = MAX(latest_sequence, ?), updated_at = ?
       WHERE conversation_id = ?`,
      sequence,
      Date.now(),
      id,
    );
  }

  members(id: string): ConversationMember[] {
    return this.sql.exec<{
      member_kind: ConversationMember["kind"];
      member_id: string;
      role: ConversationMember["role"];
    }>(
      `SELECT member_kind, member_id, role
       FROM conversation_members
       WHERE conversation_id = ?
       ORDER BY created_at, member_kind, member_id`,
      id,
    ).toArray().map((row) => ({
      kind: row.member_kind,
      id: row.member_id,
      role: row.role,
    }));
  }

  private addMember(conversationId: string, member: ConversationMember): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO conversation_members
       (conversation_id, member_kind, member_id, role, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      conversationId,
      member.kind,
      member.id,
      member.role,
      Date.now(),
    );
  }
}

function toSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.conversation_id,
    ownerUid: row.owner_uid,
    kind: row.kind,
    title: row.title,
    handlerPid: row.handler_pid,
    latestSequence: row.latest_sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
