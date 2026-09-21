import type { ActorRef, ApproachContent, ApproachRef, ApproachState, ApproachSummary, FederationPublicKey, JsonObject } from "@humansandmachines/gsv/protocol";
import { approachMetadataSchema, federationPublicKeySchema, jsonObjectSchema } from "@humansandmachines/gsv/protocol";

const PENDING_STATES = "('preparing', 'pending', 'accepting')";
export const APPROACH_LIFETIME_MS = 30 * 24 * 60 * 60_000;
export const APPROACH_RECEIPT_MS = 8 * 24 * 60 * 60_000;

type ApproachRow = {
  approach_id: string; owner_uid: number; direction: ApproachSummary["direction"];
  origin_ship_id: string; origin_subject_id: string; origin_id: string;
  remote_ship_id: string; remote_subject_id: string; remote_origin: string; remote_public_key_json: string;
  remote_display_name: string; local_display_name: string;
  conversation_id: string; contact_id: string; thread_id: string;
  state: ApproachState; revision: number; fingerprint: string; idempotency_key: string | null;
  metadata_json: string; pending_text: string | null; pending_text_bytes: number; message_sequence: number | null;
  setup_token: string | null; setup_token_hash: string; setup_invite_id: string | null;
  pairing_attempt_id: string | null; contact_generation: string | null; claim_receipt_json: string | null;
  delivery_state: ApproachSummary["delivery"]; attempts: number; next_attempt_at: number | null;
  accepted_at: number | null; created_at: number; updated_at: number; expires_at: number; cleanup_at: number | null;
};

/** Owning-runtime record. Public APIs return summary() instead. */
export type ApproachRecord = {
  summary: ApproachSummary;
  ownerUid: number;
  remoteOrigin: string;
  remotePublicKey: FederationPublicKey;
  localDisplayName: string;
  contactId: string;
  threadId: string;
  fingerprint: string;
  metadata: Omit<ApproachContent, "text">;
  pendingText: string | null;
  messageSequence: number | null;
  setupToken: string | null;
  setupTokenHash: string;
  setupInviteId: string | null;
  pairingAttemptId: string | null;
  generation: string | null;
  claimReceipt: JsonObject | null;
};

export type PrepareApproach = {
  ownerUid: number;
  direction: ApproachSummary["direction"];
  peer: ActorRef;
  remoteOrigin: string;
  remotePublicKey: FederationPublicKey;
  remoteDisplayName: string;
  localDisplayName: string;
  conversationId: string;
  contactId: string;
  threadId: string;
  content: ApproachContent;
  fingerprint: string;
  idempotencyKey?: string;
  setupToken: string;
  setupTokenHash: string;
  setupInviteId?: string;
};

export class ApproachStore {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: DurableObjectStorage) { this.sql = storage.sql; }

  prepare(input: PrepareApproach, admit: () => void, now = Date.now()): ApproachRecord {
    return this.storage.transactionSync(() => {
      this.requireUnblocked(input.ownerUid, input.peer);
      const existing = input.idempotencyKey
        ? this.byIdempotencyKey(input.ownerUid, input.idempotencyKey)
        : this.byReference(input.ownerUid, input.content.reference);
      if (existing) {
        if (existing.fingerprint !== input.fingerprint || existing.summary.direction !== input.direction
          || existing.summary.peer.shipId !== input.peer.shipId || existing.summary.peer.subjectId !== input.peer.subjectId) {
          throw new Error("Message request replay differs from the original");
        }
        return existing;
      }
      if (input.content.expiresAtMs <= now || input.content.expiresAtMs - input.content.createdAtMs > APPROACH_LIFETIME_MS
        || input.content.createdAtMs > now + 5 * 60_000 || !input.content.text.trim()) throw new Error("Message request content or expiry is invalid");
      const bytes = new TextEncoder().encode(input.content.text).length;
      if (bytes > 32_768) throw new Error("Message request exceeds the text limit");
      if (this.unresolved(input.ownerUid, input.peer)) throw new Error("A message request is already pending for this person");
      this.requireCapacity(input.ownerUid, input.direction, bytes);
      admit();
      const { text, ...metadata } = input.content;
      const id = `approach:${crypto.randomUUID()}`;
      this.sql.exec(`INSERT INTO social_approaches (
        approach_id, owner_uid, direction, origin_ship_id, origin_subject_id, origin_id,
        remote_ship_id, remote_subject_id, remote_origin, remote_public_key_json,
        remote_display_name, local_display_name, conversation_id, contact_id, thread_id,
        state, fingerprint, idempotency_key, metadata_json, pending_text, pending_text_bytes,
        setup_token, setup_token_hash, setup_invite_id, delivery_state, next_attempt_at,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.ownerUid, input.direction, metadata.reference.actor.shipId, metadata.reference.actor.subjectId, metadata.reference.approachId,
      input.peer.shipId, input.peer.subjectId, input.remoteOrigin, JSON.stringify(input.remotePublicKey),
      input.remoteDisplayName, input.localDisplayName, input.conversationId, input.contactId, input.threadId,
      input.fingerprint, input.idempotencyKey ?? null, JSON.stringify(metadata), text, bytes,
      input.setupToken, input.setupTokenHash, input.setupInviteId ?? null, input.direction === "outgoing" ? "queued" : "unconfirmed", now,
      now, now, metadata.expiresAtMs);
      return this.get(id)!;
    });
  }

  get(id: string): ApproachRecord | null {
    const row = this.sql.exec<ApproachRow>("SELECT * FROM social_approaches WHERE approach_id = ?", id).toArray()[0];
    return row ? record(row) : null;
  }

  owned(id: string, ownerUid: number): ApproachRecord {
    const result = this.get(id);
    if (!result || result.ownerUid !== ownerUid) throw new Error("Message request not found");
    return result;
  }

  byReference(ownerUid: number, reference: ApproachRef): ApproachRecord | null {
    const row = this.sql.exec<ApproachRow>(`SELECT * FROM social_approaches WHERE owner_uid = ?
      AND origin_ship_id = ? AND origin_subject_id = ? AND origin_id = ?`, ownerUid, reference.actor.shipId, reference.actor.subjectId, reference.approachId).toArray()[0];
    return row ? record(row) : null;
  }

  byIdempotencyKey(ownerUid: number, key: string): ApproachRecord | null {
    const row = this.sql.exec<ApproachRow>("SELECT * FROM social_approaches WHERE owner_uid = ? AND idempotency_key = ?", ownerUid, key).toArray()[0];
    return row ? record(row) : null;
  }

  boundInvitation(inviteId: string): ApproachRecord | null {
    const row = this.sql.exec<ApproachRow>("SELECT * FROM social_approaches WHERE setup_invite_id = ?", inviteId).toArray()[0];
    return row ? record(row) : null;
  }

  unresolved(ownerUid: number, actor: ActorRef): ApproachRecord | null {
    const row = this.sql.exec<ApproachRow>(`SELECT * FROM social_approaches WHERE owner_uid = ?
      AND remote_ship_id = ? AND remote_subject_id = ? AND state IN ${PENDING_STATES}`, ownerUid, actor.shipId, actor.subjectId).toArray()[0];
    return row ? record(row) : null;
  }

  list(ownerUid: number, input: { direction: ApproachSummary["direction"]; before?: { createdAtMs: number; id: string }; limit: number }): ApproachSummary[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error("Message request page limit must be between 1 and 100");
    const rows = input.before
      ? this.sql.exec<ApproachRow>(`SELECT * FROM social_approaches WHERE owner_uid = ? AND direction = ?
        AND (created_at, approach_id) < (?, ?) ORDER BY created_at DESC, approach_id DESC LIMIT ?`, ownerUid, input.direction, input.before.createdAtMs, input.before.id, input.limit)
      : this.sql.exec<ApproachRow>(`SELECT * FROM social_approaches WHERE owner_uid = ? AND direction = ?
        ORDER BY created_at DESC, approach_id DESC LIMIT ?`, ownerUid, input.direction, input.limit);
    return rows.toArray().map(summary);
  }

  messageCommitted(id: string, sequence: number, now = Date.now()): ApproachRecord {
    const current = this.get(id);
    if (!current) throw new Error("Message request not found");
    if (current.messageSequence !== null && current.messageSequence !== sequence) throw new Error("Message request history changed");
    if (current.messageSequence === sequence) return current;
    this.sql.exec(`UPDATE social_approaches SET message_sequence = ?,
      state = CASE WHEN state = 'preparing' THEN 'pending' ELSE state END,
      delivery_state = CASE WHEN direction = 'incoming' THEN 'received' ELSE delivery_state END,
      pending_text = CASE WHEN direction = 'incoming' THEN NULL ELSE pending_text END,
      pending_text_bytes = CASE WHEN direction = 'incoming' THEN 0 ELSE pending_text_bytes END,
      next_attempt_at = CASE WHEN direction = 'incoming' THEN NULL ELSE next_attempt_at END, updated_at = ? WHERE approach_id = ?`, sequence, now, id);
    return this.get(id)!;
  }

  beginAcceptance(id: string, ownerUid: number, expectedRevision: number, attemptId: string, now = Date.now()): ApproachRecord {
    return this.storage.transactionSync(() => {
      const current = this.owned(id, ownerUid);
      this.requireUnblocked(ownerUid, current.summary.peer);
      if (current.summary.direction !== "incoming") throw new Error("Only a received request can be accepted");
      if (current.summary.state === "accepting" || current.summary.state === "accepted") return current;
      if (current.summary.state !== "pending" || current.summary.revision !== expectedRevision || current.summary.expiresAtMs <= now) {
        throw new Error("Message request changed; reload before accepting");
      }
      this.sql.exec(`UPDATE social_approaches SET state = 'accepting', revision = revision + 1,
        pairing_attempt_id = ?, next_attempt_at = ?, updated_at = ? WHERE approach_id = ?`, attemptId, now, now, id);
      return this.get(id)!;
    });
  }

  decide(id: string, ownerUid: number, expectedRevision: number, decision: "declined" | "withdrawn", now = Date.now()): ApproachRecord {
    return this.storage.transactionSync(() => {
      const current = this.owned(id, ownerUid);
      if ((decision === "declined") !== (current.summary.direction === "incoming")) throw new Error("Message request decision belongs to the other participant");
      if (current.summary.state === decision) return current;
      if (current.summary.revision !== expectedRevision || !["preparing", "pending"].includes(current.summary.state)) {
        throw new Error("Message request changed; reload before deciding");
      }
      this.sql.exec(`UPDATE social_approaches SET state = ?, revision = revision + 1,
        setup_token = NULL, pending_text = NULL, pending_text_bytes = 0,
        next_attempt_at = NULL, cleanup_at = ?, updated_at = ? WHERE approach_id = ?`, decision, now + APPROACH_RECEIPT_MS, now, id);
      return this.get(id)!;
    });
  }

  /** The caller's block transaction also retires these bound invitations. */
  blockForActor(ownerUid: number, actor: ActorRef, now = Date.now()): string[] {
    const invitations = this.sql.exec<{ setup_invite_id: string | null }>(`SELECT setup_invite_id FROM social_approaches
      WHERE owner_uid = ? AND remote_ship_id = ? AND remote_subject_id = ?
      AND state IN ('preparing', 'pending', 'accepting', 'accepted')`, ownerUid, actor.shipId, actor.subjectId).toArray();
    this.sql.exec(`UPDATE social_approaches SET state = 'blocked', revision = revision + 1,
      setup_token = NULL, pending_text = NULL, pending_text_bytes = 0, next_attempt_at = NULL,
      cleanup_at = CASE WHEN accepted_at IS NULL THEN ? ELSE NULL END, updated_at = ?
      WHERE owner_uid = ? AND remote_ship_id = ? AND remote_subject_id = ?
      AND state IN ('preparing', 'pending', 'accepting', 'accepted')`, now + APPROACH_RECEIPT_MS, now, ownerUid, actor.shipId, actor.subjectId);
    return invitations.flatMap((entry) => entry.setup_invite_id ? [entry.setup_invite_id] : []);
  }

  private requireUnblocked(ownerUid: number, actor: ActorRef): void {
    const blocked = this.sql.exec("SELECT 1 FROM federation_actor_blocks WHERE owner_uid = ? AND ship_id = ? AND subject_id = ?", ownerUid, actor.shipId, actor.subjectId).toArray().length > 0;
    if (blocked) throw new Error("Message requests are unavailable for this person");
  }

  private requireCapacity(ownerUid: number, direction: ApproachSummary["direction"], bytes: number): void {
    const counts = this.sql.exec<{ pending: number; owner_pending: number; total: number; owner_total: number; bytes: number }>(`SELECT
      COALESCE(SUM(direction = ? AND state IN ${PENDING_STATES}), 0) AS pending,
      COALESCE(SUM(owner_uid = ? AND direction = ? AND state IN ${PENDING_STATES}), 0) AS owner_pending,
      COUNT(*) AS total, COALESCE(SUM(owner_uid = ?), 0) AS owner_total,
      COALESCE(SUM(pending_text_bytes), 0) AS bytes FROM social_approaches`, direction, ownerUid, direction, ownerUid).one();
    if (counts.pending >= (direction === "incoming" ? 1000 : 500)
      || counts.owner_pending >= (direction === "incoming" ? 250 : 100)
      || counts.total >= 20_000 || counts.owner_total >= 5_000 || counts.bytes + bytes > 64 * 1024 * 1024) {
      throw new Error("Message request capacity reached");
    }
  }
}

function summary(row: ApproachRow): ApproachSummary {
  const result: ApproachSummary = {
    id: row.approach_id, direction: row.direction,
    reference: { actor: { shipId: row.origin_ship_id, subjectId: row.origin_subject_id }, approachId: row.origin_id },
    peer: { shipId: row.remote_ship_id, subjectId: row.remote_subject_id }, displayName: row.remote_display_name,
    conversationId: row.conversation_id, state: row.state, revision: row.revision, delivery: row.delivery_state,
    createdAtMs: row.created_at, updatedAtMs: row.updated_at, expiresAtMs: row.expires_at,
  };
  if (row.accepted_at !== null) result.acceptedAtMs = row.accepted_at;
  return result;
}

function record(row: ApproachRow): ApproachRecord {
  return {
    summary: summary(row), ownerUid: row.owner_uid, remoteOrigin: row.remote_origin,
    remotePublicKey: federationPublicKeySchema.parse(JSON.parse(row.remote_public_key_json)), localDisplayName: row.local_display_name,
    contactId: row.contact_id, threadId: row.thread_id, fingerprint: row.fingerprint,
    metadata: approachMetadataSchema.parse(JSON.parse(row.metadata_json)), pendingText: row.pending_text, messageSequence: row.message_sequence,
    setupToken: row.setup_token, setupTokenHash: row.setup_token_hash, setupInviteId: row.setup_invite_id,
    pairingAttemptId: row.pairing_attempt_id, generation: row.contact_generation,
    claimReceipt: row.claim_receipt_json ? jsonObjectSchema.parse(JSON.parse(row.claim_receipt_json)) : null,
  };
}
