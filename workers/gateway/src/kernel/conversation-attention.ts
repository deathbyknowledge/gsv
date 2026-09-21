import { z } from "zod/mini";
import type {
  ContactSummary, ConversationAttentionEntry, ConversationAttentionListArgs, ConversationAttentionListResult,
  ConversationAttentionDismissArgs, ConversationAttentionDismissResult, ConversationPreview,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import { requireContactHuman } from "./federation/authority";

const DAY_MS = 24 * 60 * 60_000;
const VISIBLE = `FROM conversation_attention a
  JOIN conversations c ON c.conversation_id = a.conversation_id AND c.owner_uid = a.owner_uid
  JOIN federation_contacts f ON f.contact_id = a.contact_id AND f.owner_uid = a.owner_uid AND f.conversation_id = a.conversation_id
  WHERE f.state = 'active' AND f.generation = a.contact_generation AND f.muted = 0
    AND f.notification_policy = a.policy AND c.archived = 0 AND c.read_through_sequence < a.sequence`;
type AttentionRow = {
  conversation_id: string; contact_id: string; sequence: number; policy: "notify" | "digest";
  available_at: number; preview_json: string; display_name: string; origin: string;
};
type AttentionCounts = { ready: number; waiting: number; next_digest: number | null };

export class ConversationAttention {
  constructor(private readonly sql: SqlStorage) {}

  record(contact: ContactSummary, preview: ConversationPreview, now = Date.now()): boolean {
    const admitted = this.sql.exec<{ read_through_sequence: number; archived: number }>(
      `UPDATE conversations SET attention_processed_sequence = ? WHERE conversation_id = ? AND owner_uid = ?
       AND kind = 'contact' AND attention_processed_sequence < ? RETURNING read_through_sequence, archived`,
      preview.sequence, contact.conversationId, contact.ownerUid, preview.sequence,
    ).toArray()[0];
    if (!admitted || admitted.read_through_sequence >= preview.sequence || admitted.archived
      || contact.state !== "active" || contact.blocked || !contact.preferences || contact.preferences.muted
      || contact.preferences.notifications === "quiet") return false;
    const policy = contact.preferences.notifications;
    const row = this.sql.exec<{ announced: number }>(`INSERT INTO conversation_attention
      (conversation_id, owner_uid, contact_id, contact_generation, sequence, policy, available_at, announced, preview_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        available_at = CASE WHEN contact_generation = excluded.contact_generation AND policy = excluded.policy THEN available_at ELSE excluded.available_at END,
        announced = CASE WHEN contact_generation = excluded.contact_generation AND policy = excluded.policy THEN announced ELSE excluded.announced END,
        contact_generation = excluded.contact_generation, sequence = excluded.sequence, policy = excluded.policy, preview_json = excluded.preview_json
      RETURNING announced`,
      contact.conversationId, contact.ownerUid, contact.id, contact.generation, preview.sequence, policy,
      policy === "digest" ? now + DAY_MS : now, policy === "digest" ? 0 : 1, JSON.stringify(preview)).one();
    return policy === "digest" && row.announced === 0;
  }

  list(ownerUid: number, args: ConversationAttentionListArgs, now = Date.now()): ConversationAttentionListResult {
    const counts = this.sql.exec<AttentionCounts>(`SELECT COALESCE(SUM(a.available_at <= ?), 0) AS ready,
      COALESCE(SUM(a.available_at > ?), 0) AS waiting, MIN(CASE WHEN a.available_at > ? THEN a.available_at END) AS next_digest
      ${VISIBLE} AND a.owner_uid = ?`, now, now, now, ownerUid).one();
    const limit = args.limit ?? 30;
    const cursor = args.before;
    const rows = this.sql.exec<AttentionRow>(`SELECT a.*, COALESCE(f.local_alias, f.remote_display_name) AS display_name,
      f.remote_origin AS origin ${VISIBLE} AND a.owner_uid = ? AND a.available_at <= ?
      ${cursor ? "AND (a.available_at < ? OR (a.available_at = ? AND a.conversation_id < ?))" : ""}
      ORDER BY a.available_at DESC, a.conversation_id DESC LIMIT ?`,
      ownerUid, now, ...(cursor ? [cursor.availableAt, cursor.availableAt, cursor.conversationId] : []), limit).toArray();
    const entries: ConversationAttentionEntry[] = rows.map((row) => ({
      conversationId: row.conversation_id, contactId: row.contact_id, displayName: row.display_name, origin: row.origin,
      throughSequence: row.sequence, kind: row.policy, availableAt: row.available_at,
      // SAFETY: only committed, typed message previews are persisted by record().
      preview: JSON.parse(row.preview_json) as ConversationPreview,
    }));
    const last = entries.at(-1);
    return { entries, readyCount: counts.ready, digestWaitingCount: counts.waiting,
      ...(counts.next_digest !== null ? { nextDigestAt: counts.next_digest } : undefined),
      ...(last && entries.length === limit ? { next: { availableAt: last.availableAt, conversationId: last.conversationId } } : undefined) };
  }

  dismiss(ownerUid: number, conversationId: string, throughSequence: number): void {
    this.sql.exec("DELETE FROM conversation_attention WHERE owner_uid = ? AND conversation_id = ? AND sequence <= ?", ownerUid, conversationId, throughSequence);
  }

  clear(ownerUid: number, conversationId: string): void {
    this.sql.exec("DELETE FROM conversation_attention WHERE owner_uid = ? AND conversation_id = ?", ownerUid, conversationId);
  }

  nextDigestAt(): number | null {
    return this.sql.exec<{ due: number | null }>(`SELECT MIN(a.available_at) AS due ${VISIBLE} AND a.policy = 'digest' AND a.announced = 0`).one().due;
  }

  announceDue(now = Date.now()): number[] {
    const due = this.sql.exec<{ owner_uid: number; conversation_id: string }>(`SELECT a.owner_uid, a.conversation_id ${VISIBLE}
      AND a.policy = 'digest' AND a.announced = 0 AND a.available_at <= ? ORDER BY a.available_at LIMIT 100`, now).toArray();
    for (const row of due) this.sql.exec("UPDATE conversation_attention SET announced = 1 WHERE conversation_id = ?", row.conversation_id);
    return [...new Set(due.map((row) => row.owner_uid))];
  }
}

const idSchema = z.string().check(z.minLength(1), z.maxLength(256));
const sequenceSchema = z.int().check(z.nonnegative());
const listArgsSchema = z.strictObject({ before: z.optional(z.strictObject({ availableAt: sequenceSchema, conversationId: idSchema })), limit: z.optional(z.int().check(z.minimum(1), z.maximum(100))) });
const dismissArgsSchema = z.strictObject({ entries: z.array(z.strictObject({ conversationId: idSchema, throughSequence: sequenceSchema })).check(z.maxLength(100)) });

export function handleConversationAttentionList(args: ConversationAttentionListArgs, ctx: KernelContext): ConversationAttentionListResult {
  return ctx.conversations.attention.list(requireContactHuman(ctx), listArgsSchema.parse(args));
}

export function handleConversationAttentionDismiss(args: ConversationAttentionDismissArgs, ctx: KernelContext): ConversationAttentionDismissResult {
  const ownerUid = requireContactHuman(ctx);
  const input = dismissArgsSchema.parse(args);
  ctx.federation.transaction(() => { for (const entry of input.entries) ctx.conversations.attention.dismiss(ownerUid, entry.conversationId, entry.throughSequence); });
  ctx.broadcastToUserUid(ownerUid, "conversation.attention.changed", {});
  return {};
}
