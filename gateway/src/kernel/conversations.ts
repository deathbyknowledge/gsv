/**
 * ConversationRegistry — kernel-side index of durable conversations.
 *
 * A conversation is the unit of persistence in the agent-accounts model: it is
 * owned by a human (`owner_uid`), runs as an agent account (`agent_uid`), and
 * its transcript lives under the agent's home at `archive_base`
 * (`/home/<agent>/conversations/<id>`). It outlives any individual executor.
 *
 * The executor (Process DO / `pid`) is fungible. `active_pid` points at the
 * executor currently servicing the conversation, or NULL when none is live.
 * The transcript itself is the durable source of truth, not the DO.
 *
 * This registry is the kernel's source of truth for *who owns a conversation*
 * and *where its transcript lives*; the durable bytes are R2 blobs under the
 * agent home written by the Process DO.
 */

export type ConversationRecord = {
  conversationId: string;
  ownerUid: number;
  agentUid: number;
  title: string | null;
  isDefault: boolean;
  activePid: string | null;
  archiveBase: string;
  createdAt: number;
  lastActiveAt: number | null;
};

/**
 * Deterministic id for the well-known default ("inbox") conversation between a
 * human owner and an agent account. Replaces the old `init:<owner>` surface.
 */
export function defaultConversationId(ownerUid: number, agentUid: number): string {
  return `default:${ownerUid}:${agentUid}`;
}

/**
 * R2-key / FS path under the agent home where a conversation's transcript
 * archives are stored. Home is `/home/<agent>`; transcripts land under
 * `/home/<agent>/conversations/<id>`.
 */
export function conversationArchiveBase(agentHome: string, conversationId: string): string {
  const home = agentHome.replace(/\/+$/, "");
  return `${home}/conversations/${encodeURIComponent(conversationId)}`;
}

export class ConversationRegistry {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        agent_uid INTEGER NOT NULL,
        title TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        active_pid TEXT,
        archive_base TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS conversations_owner ON conversations (owner_uid, agent_uid)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS conversations_active_pid ON conversations (active_pid)",
    );
  }

  /**
   * Ensure the well-known default conversation between `ownerUid` and the agent
   * (whose home is `agentHome`) exists. Returns the record and whether it was
   * created. Idempotent.
   */
  ensureDefault(
    ownerUid: number,
    agentUid: number,
    agentHome: string,
  ): { record: ConversationRecord; created: boolean } {
    const conversationId = defaultConversationId(ownerUid, agentUid);
    const existing = this.get(conversationId);
    if (existing) return { record: existing, created: false };

    const record = this.create({
      conversationId,
      ownerUid,
      agentUid,
      agentHome,
      isDefault: true,
    });
    return { record, created: true };
  }

  create(opts: {
    conversationId?: string;
    ownerUid: number;
    agentUid: number;
    agentHome: string;
    title?: string | null;
    isDefault?: boolean;
  }): ConversationRecord {
    const conversationId = opts.conversationId ?? crypto.randomUUID();
    const archiveBase = conversationArchiveBase(opts.agentHome, conversationId);
    const createdAt = Date.now();
    this.sql.exec(
      `INSERT OR REPLACE INTO conversations
        (conversation_id, owner_uid, agent_uid, title, is_default, active_pid, archive_base, created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
      conversationId,
      opts.ownerUid,
      opts.agentUid,
      opts.title ?? null,
      opts.isDefault ? 1 : 0,
      archiveBase,
      createdAt,
    );
    return {
      conversationId,
      ownerUid: opts.ownerUid,
      agentUid: opts.agentUid,
      title: opts.title ?? null,
      isDefault: opts.isDefault ?? false,
      activePid: null,
      archiveBase,
      createdAt,
      lastActiveAt: null,
    };
  }

  get(conversationId: string): ConversationRecord | null {
    const rows = [...this.sql.exec<RowShape>(
      "SELECT * FROM conversations WHERE conversation_id = ?",
      conversationId,
    )];
    if (rows.length === 0) return null;
    return toRecord(rows[0]);
  }

  getDefault(ownerUid: number, agentUid: number): ConversationRecord | null {
    return this.get(defaultConversationId(ownerUid, agentUid));
  }

  /** Conversations owned by a human, most-recently-active first. */
  listByOwner(ownerUid: number): ConversationRecord[] {
    return [...this.sql.exec<RowShape>(
      `SELECT * FROM conversations WHERE owner_uid = ?
       ORDER BY COALESCE(last_active_at, created_at) DESC`,
      ownerUid,
    )].map(toRecord);
  }

  /** Conversation currently serviced by a given executor pid, if any. */
  getByActivePid(pid: string): ConversationRecord | null {
    const rows = [...this.sql.exec<RowShape>(
      "SELECT * FROM conversations WHERE active_pid = ? LIMIT 1",
      pid,
    )];
    if (rows.length === 0) return null;
    return toRecord(rows[0]);
  }

  /** Bind/unbind the live executor servicing a conversation. */
  setActivePid(conversationId: string, pid: string | null): boolean {
    this.sql.exec(
      "UPDATE conversations SET active_pid = ?, last_active_at = ? WHERE conversation_id = ?",
      pid,
      Date.now(),
      conversationId,
    );
    return this.get(conversationId) !== null;
  }

  /** Clear the active executor for any conversations bound to `pid`. */
  clearActivePid(pid: string): void {
    this.sql.exec(
      "UPDATE conversations SET active_pid = NULL WHERE active_pid = ?",
      pid,
    );
  }

  setTitle(conversationId: string, title: string | null): boolean {
    this.sql.exec(
      "UPDATE conversations SET title = ? WHERE conversation_id = ?",
      title,
      conversationId,
    );
    return this.get(conversationId) !== null;
  }

  touch(conversationId: string): void {
    this.sql.exec(
      "UPDATE conversations SET last_active_at = ? WHERE conversation_id = ?",
      Date.now(),
      conversationId,
    );
  }

  remove(conversationId: string): boolean {
    const existing = this.get(conversationId);
    if (!existing) return false;
    this.sql.exec("DELETE FROM conversations WHERE conversation_id = ?", conversationId);
    return true;
  }
}

type RowShape = {
  conversation_id: string;
  owner_uid: number;
  agent_uid: number;
  title: string | null;
  is_default: number;
  active_pid: string | null;
  archive_base: string;
  created_at: number;
  last_active_at: number | null;
};

function toRecord(row: RowShape): ConversationRecord {
  return {
    conversationId: row.conversation_id,
    ownerUid: row.owner_uid,
    agentUid: row.agent_uid,
    title: row.title,
    isDefault: row.is_default !== 0,
    activePid: row.active_pid,
    archiveBase: row.archive_base,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}
