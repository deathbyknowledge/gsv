import { originMessageRefSchema, type ContactSummary, type ConversationMessage, type OriginMessageRef, type ProcessScope, type ProcessScopePolicy } from "@humansandmachines/gsv/protocol";

export type ScopeInboxItem = {
  scope_id: string; message_id: string; message_sequence: number; reference_json: string;
  event_id: string; state: "pending" | "admitted"; next_attempt_at: number; attempts: number; dispatched_at: number | null; reply_key: string | null;
};
type AutomaticRow = { scope_id: string; contact_id: string; conversation_id: string; generation: string; start_sequence: number;
  accepted_messages: number; next_admission_at: number; paused_reason: string | null };

/** A bounded admission queue feeding ordinary Process events, never a second agent loop. */
export class ProcessScopeAutomation {
  constructor(private readonly sql: SqlStorage) {}

  register(scope: ProcessScope, sequence: number, now = Date.now()): void {
    if (!scope.policy.automatic) return;
    const contact = scope.policy.conversations[0];
    const active = this.sql.exec("SELECT 1 FROM process_scope_automation a JOIN process_scopes s ON a.scope_id = s.id WHERE a.contact_id = ? AND a.generation = ? AND s.state = 'active' AND s.expires_at > ?", contact.contactId, contact.generation, now).toArray();
    if (active.length) throw new Error("Stop the existing automatic helper for this person before enabling another");
    this.sql.exec("INSERT INTO process_scope_automation (scope_id, contact_id, conversation_id, generation, start_sequence) VALUES (?, ?, ?, ?, ?)",
      scope.id, contact.contactId, contact.conversationId, contact.generation, sequence);
  }

  status(scopeId: string): ProcessScope["automation"] {
    const row = this.sql.exec<AutomaticRow>("SELECT * FROM process_scope_automation WHERE scope_id = ?", scopeId).toArray()[0];
    if (!row) return undefined;
    const pending = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM process_scope_inbox WHERE scope_id = ? AND state = 'pending'", scopeId).one().n;
    return { acceptedMessages: row.accepted_messages, pendingMessages: pending, pausedReason: row.paused_reason ?? undefined };
  }

  /** Called in the same local transaction that projects a committed incoming message. */
  admit(contact: ContactSummary, message: ConversationMessage, now = Date.now()): string[] {
    if (message.author.kind !== "contact" || message.author.contactId !== contact.id
      || (message.social?.provenance.kind !== "human" && message.social?.provenance.kind !== "approved")
      || !message.text.trim() || contact.state !== "active" || contact.preferences?.muted) return [];
    const rows = this.sql.exec<AutomaticRow & { created_at: number; policy_json: string; root_pid: string; generations_used: number }>(
      `SELECT a.*, s.created_at, s.policy_json, s.root_pid, s.generations_used FROM process_scope_automation a
       JOIN process_scopes s ON s.id = a.scope_id WHERE a.contact_id = ? AND a.generation = ?
       AND s.state = 'active' AND s.expires_at > ? AND a.paused_reason IS NULL`, contact.id, contact.generation, now,
    ).toArray();
    const changed: string[] = [];
    for (const row of rows) {
      if (row.conversation_id !== message.conversationId || message.sequence <= row.start_sequence || message.createdAt < row.created_at) continue;
      if (this.sql.exec("SELECT 1 FROM process_scope_inbox WHERE scope_id = ? AND message_id = ?", row.scope_id, message.id).toArray().length) continue;
      // SAFETY: only ProcessScopeStore.create writes the validated immutable policy.
      const policy = JSON.parse(row.policy_json) as ProcessScopePolicy;
      if (!policy.automatic) throw new Error("Automatic helper is missing its policy");
      const pending = this.status(row.scope_id)!.pendingMessages;
      if (row.accepted_messages >= policy.automatic.maxMessages) continue;
      const reason = row.generations_used >= policy.budgets.generations ? "model-request allowance used" : pending >= 4 ? "incoming messages need owner review" : null;
      if (reason) this.pause(row.scope_id, reason);
      else {
        const eventId = `social:${crypto.randomUUID()}`;
        this.sql.exec("INSERT INTO process_scope_inbox (scope_id, message_id, message_sequence, reference_json, event_id, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?)",
          row.scope_id, message.id, message.sequence, JSON.stringify(message.social.reference), eventId, Math.max(now, row.next_admission_at));
        this.sql.exec("UPDATE process_scope_automation SET accepted_messages = accepted_messages + 1 WHERE scope_id = ?", row.scope_id);
      }
      changed.push(row.root_pid);
    }
    return changed;
  }

  nextDue(): number | null {
    return this.sql.exec<{ due: number | null }>(`SELECT min(max(i.next_attempt_at, a.next_admission_at)) AS due
      FROM process_scope_inbox i JOIN process_scope_automation a ON a.scope_id = i.scope_id
      JOIN process_scopes s ON s.id = i.scope_id WHERE i.state = 'pending' AND a.paused_reason IS NULL
      AND s.state = 'active' AND s.expires_at > ?`, Date.now()).one().due;
  }

  due(now = Date.now()): ScopeInboxItem[] {
    return this.sql.exec<ScopeInboxItem>(`SELECT i.* FROM process_scope_inbox i
      JOIN process_scope_automation a ON a.scope_id = i.scope_id JOIN process_scopes s ON s.id = i.scope_id
      WHERE i.state = 'pending' AND a.paused_reason IS NULL AND s.state = 'active' AND s.expires_at > ?
      AND i.next_attempt_at <= ? AND a.next_admission_at <= ? ORDER BY i.next_attempt_at, i.message_sequence LIMIT 10`, now, now, now).toArray();
  }

  current(item: ScopeInboxItem, now = Date.now()): boolean {
    return !!this.sql.exec(`SELECT 1 FROM process_scope_inbox i JOIN process_scope_automation a ON a.scope_id = i.scope_id
      JOIN process_scopes s ON s.id = i.scope_id WHERE i.scope_id = ? AND i.message_id = ? AND i.state = 'pending'
      AND a.paused_reason IS NULL AND a.next_admission_at <= ? AND s.state = 'active' AND s.expires_at > ?`, item.scope_id, item.message_id, now, now).toArray().length;
  }

  admitted(item: ScopeInboxItem, policy: NonNullable<ProcessScopePolicy["automatic"]>, now = Date.now()): void {
    this.sql.exec("UPDATE process_scope_inbox SET state = 'admitted' WHERE scope_id = ? AND message_id = ?", item.scope_id, item.message_id);
    this.sql.exec("UPDATE process_scope_automation SET next_admission_at = ? WHERE scope_id = ?", now + policy.intervalSeconds * 1000, item.scope_id);
    const status = this.status(item.scope_id)!;
    if (status.acceptedMessages >= policy.maxMessages && status.pendingMessages === 0) this.pause(item.scope_id, "message allowance used");
  }

  reserveAdmission(item: ScopeInboxItem, intervalSeconds: number, now = Date.now()): void {
    this.sql.exec("UPDATE process_scope_inbox SET dispatched_at = coalesce(dispatched_at, ?) WHERE scope_id = ? AND message_id = ?", now, item.scope_id, item.message_id);
    this.sql.exec("UPDATE process_scope_automation SET next_admission_at = ? WHERE scope_id = ?", now + intervalSeconds * 1000, item.scope_id);
  }

  failed(item: ScopeInboxItem, now = Date.now()): void {
    if (item.attempts >= 4) { this.pause(item.scope_id, "helper admission needs owner review"); return; }
    this.sql.exec("UPDATE process_scope_inbox SET attempts = attempts + 1, next_attempt_at = ? WHERE scope_id = ? AND message_id = ?",
      now + Math.min(300_000, 10_000 * 2 ** item.attempts), item.scope_id, item.message_id);
  }

  pause(scopeId: string, reason: string): void {
    this.sql.exec("UPDATE process_scope_automation SET paused_reason = ? WHERE scope_id = ?", reason, scopeId);
  }

  /** One remote response per admitted human message, shared by every descendant. */
  claimReply(scopeId: string, reference: OriginMessageRef, effectId: string): void {
    const rows = this.sql.exec<ScopeInboxItem>("SELECT * FROM process_scope_inbox WHERE scope_id = ?", scopeId).toArray();
    const cause = rows.find((row) => {
      const ref = originMessageRefSchema.parse(JSON.parse(row.reference_json));
      return ref.messageId === reference.messageId && ref.actor.shipId === reference.actor.shipId && ref.actor.subjectId === reference.actor.subjectId;
    });
    if (!cause || cause.dispatched_at === null) throw new Error("Automatic replies must answer a human message admitted to this helper");
    if (cause.reply_key && cause.reply_key !== effectId) throw new Error("This helper has already replied to that message");
    this.sql.exec("UPDATE process_scope_inbox SET reply_key = ? WHERE scope_id = ? AND message_id = ?", effectId, scopeId, cause.message_id);
  }

  remove(scopeId: string): void {
    this.sql.exec("DELETE FROM process_scope_inbox WHERE scope_id = ?", scopeId);
    this.sql.exec("DELETE FROM process_scope_automation WHERE scope_id = ?", scopeId);
  }
}
