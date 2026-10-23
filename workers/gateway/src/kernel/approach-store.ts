import type { ApproachState, ApproachSummary, SendMessageRequestInput } from "@humansandmachines/gsv/protocol";

const PENDING_STATES = "('preparing', 'pending', 'accepting')";
export const APPROACH_LIFETIME_MS = 30 * 24 * 60 * 60_000;
export const APPROACH_RECEIPT_MS = 8 * 24 * 60 * 60_000;

export class ApproachAdmissionError extends Error {
  constructor(readonly reason: "collision" | "capacity" | "blocked" | "replay", message: string) {
    super(message);
    this.name = "ApproachAdmissionError";
  }
}

type ApproachRow = {
  ship_handles_messages: number;
  approach_id: string; owner_uid: number; direction: ApproachSummary["direction"];
  request_id: string; remote_did: string; remote_handle: string | null;
  remote_display_name: string; local_display_name: string;
  conversation_id: string; contact_id: string; thread_id: string;
  state: ApproachState; revision: number; fingerprint: string; idempotency_key: string | null;
  profile_cid: string | null; message_id: string; sent_at: number;
  pending_text: string | null; pending_text_bytes: number; message_sequence: number | null;
  contact_generation: string | null;
  delivery_state: ApproachSummary["delivery"]; attempts: number; next_attempt_at: number | null;
  accepted_at: number | null; created_at: number; updated_at: number; expires_at: number; cleanup_at: number | null;
};

/** Owning-runtime record. Public APIs return summary() instead. */
export type ApproachRecord = {
  shipHandlesMessages: boolean;
  summary: ApproachSummary;
  ownerUid: number;
  localDisplayName: string;
  contactId: string;
  threadId: string;
  fingerprint: string;
  /** The profile record an outgoing request names; an incoming one's was checked as it arrived. */
  profileCid: string | null;
  /** The request's first message as its sender's Ship names it, and when it was written. */
  messageId: string;
  sentAtMs: number;
  pendingText: string | null;
  messageSequence: number | null;
  generation: string | null;
  attempts: number;
  nextAttemptAt: number | null;
  cleanupAt: number | null;
};

export type PrepareApproach = {
  shipHandlesMessages?: boolean;
  ownerUid: number;
  direction: ApproachSummary["direction"];
  remoteDid: string;
  /** Set only once the handle and the DID name each other. */
  remoteHandle?: string;
  remoteDisplayName: string;
  localDisplayName: string;
  conversationId: string;
  contactId: string;
  threadId: string;
  /** The request as its sender's Ship sends it. */
  content: SendMessageRequestInput;
  fingerprint: string;
  idempotencyKey?: string;
};

export class ApproachStore {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: DurableObjectStorage) { this.sql = storage.sql; }

  prepare(input: PrepareApproach, admit: () => void, now = Date.now()): ApproachRecord {
    return this.storage.transactionSync(() => {
      this.requireUnblocked(input.ownerUid, input.remoteDid);
      const existing = input.idempotencyKey
        ? this.byIdempotencyKey(input.ownerUid, input.idempotencyKey)
        : this.byRequest(input.direction, input.remoteDid, input.content.requestId);
      if (existing) {
        if (existing.fingerprint !== input.fingerprint || existing.summary.direction !== input.direction
          || existing.summary.peerDid !== input.remoteDid || existing.ownerUid !== input.ownerUid) {
          throw new ApproachAdmissionError("replay", "Message request replay differs from the original");
        }
        return existing;
      }
      const { content } = input;
      if (content.expiresAtMs <= now || content.expiresAtMs - content.createdAtMs > APPROACH_LIFETIME_MS
        || content.createdAtMs > now + 5 * 60_000 || !content.text.trim()) throw new Error("Message request content or expiry is invalid");
      const bytes = new TextEncoder().encode(content.text).length;
      if (bytes > 32_768) throw new Error("Message request exceeds the text limit");
      if (this.unresolved(input.ownerUid, input.remoteDid)) throw new ApproachAdmissionError("collision", "A message request is already pending for this person");
      this.requireCapacity(input.ownerUid, input.direction, bytes);
      admit();
      const id = `approach:${crypto.randomUUID()}`;
      this.sql.exec(`INSERT INTO social_approaches (
        approach_id, owner_uid, direction, request_id, remote_did, remote_handle,
        remote_display_name, local_display_name, conversation_id, contact_id, thread_id,
        state, fingerprint, idempotency_key, profile_cid, message_id, sent_at, pending_text, pending_text_bytes,
        delivery_state, next_attempt_at, created_at, updated_at, expires_at, ship_handles_messages
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.ownerUid, input.direction, content.requestId, input.remoteDid, input.remoteHandle ?? null,
      input.remoteDisplayName, input.localDisplayName, input.conversationId, input.contactId, input.threadId,
      input.fingerprint, input.idempotencyKey ?? null, content.profileCid, content.messageId, content.createdAtMs, content.text, bytes,
      input.direction === "outgoing" ? "queued" : "unconfirmed", now, now, now, content.expiresAtMs, input.shipHandlesMessages ? 1 : 0);
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

  /** A request as both Ships name it: its sender's ID for it, exchanged with the DID of the person on the other side. */
  byRequest(direction: ApproachSummary["direction"], remoteDid: string, requestId: string): ApproachRecord | null {
    const row = this.sql.exec<ApproachRow>(`SELECT * FROM social_approaches
      WHERE direction = ? AND remote_did = ? AND request_id = ?`, direction, remoteDid, requestId).toArray()[0];
    return row ? record(row) : null;
  }

  byIdempotencyKey(ownerUid: number, key: string): ApproachRecord | null {
    const row = this.sql.exec<ApproachRow>("SELECT * FROM social_approaches WHERE owner_uid = ? AND idempotency_key = ?", ownerUid, key).toArray()[0];
    return row ? record(row) : null;
  }

  lastDisplayName(ownerUid: number, did: string): string | undefined {
    return this.sql.exec<{ remote_display_name: string }>(`SELECT remote_display_name FROM social_approaches
      WHERE owner_uid = ? AND remote_did = ? ORDER BY created_at DESC LIMIT 1`, ownerUid, did).toArray()[0]?.remote_display_name;
  }

  forConversation(conversationId: string): ApproachRecord | null {
    const row = this.sql.exec<ApproachRow>("SELECT * FROM social_approaches WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1", conversationId).toArray()[0];
    return row ? record(row) : null;
  }

  nextWake(now = Date.now()): number | null {
    const row = this.sql.exec<{ due: number | null }>(`SELECT MIN(due) AS due FROM (
      SELECT next_attempt_at AS due FROM social_approaches WHERE next_attempt_at IS NOT NULL
      UNION ALL SELECT expires_at + CASE WHEN state = 'accepting' THEN ${APPROACH_RECEIPT_MS} ELSE 0 END FROM social_approaches WHERE state IN ${PENDING_STATES} AND accepted_at IS NULL
      UNION ALL SELECT cleanup_at FROM social_approaches WHERE cleanup_at IS NOT NULL
    )`).one();
    return row.due === null ? null : Math.max(now + 10, row.due);
  }

  due(now = Date.now()): ApproachRecord[] {
    return this.sql.exec<ApproachRow>(`SELECT * FROM social_approaches WHERE
      next_attempt_at <= ? OR (expires_at + CASE WHEN state = 'accepting' THEN ${APPROACH_RECEIPT_MS} ELSE 0 END <= ? AND state IN ${PENDING_STATES} AND accepted_at IS NULL)
      OR cleanup_at <= ? ORDER BY COALESCE(next_attempt_at, cleanup_at, expires_at), approach_id LIMIT 20`, now, now, now).toArray().map(record);
  }

  retry(id: string, ownerUid: number, expectedRevision: number, now = Date.now()): ApproachRecord {
    const current = this.owned(id, ownerUid);
    this.requireUnblocked(ownerUid, current.summary.peerDid);
    const retryDeadline = current.summary.expiresAtMs + (current.summary.state === "accepting" ? APPROACH_RECEIPT_MS : 0);
    if (current.summary.revision !== expectedRevision || retryDeadline <= now
      || !["preparing", "pending", "accepting"].includes(current.summary.state)) throw new Error("Message request changed; reload before retrying");
    if (current.summary.direction === "incoming" && current.summary.state === "pending") throw new Error("This request is waiting for your decision");
    if (current.summary.direction === "outgoing" && current.summary.delivery === "received") throw new Error("This request is waiting for the other person");
    this.sql.exec("UPDATE social_approaches SET attempts = 0, next_attempt_at = ?, updated_at = ? WHERE approach_id = ?", now, now, id);
    return this.get(id)!;
  }

  deliveryReceived(id: string, expectedRevision: number): void {
    this.sql.exec(`UPDATE social_approaches SET delivery_state = 'received', next_attempt_at = NULL, pending_text = NULL,
      pending_text_bytes = 0, updated_at = ? WHERE approach_id = ? AND revision = ?`, Date.now(), id, expectedRevision);
  }

  defer(id: string, expectedRevision: number, terminal: boolean, now = Date.now()): void {
    const current = this.get(id);
    if (!current || current.summary.revision !== expectedRevision) return;
    const exhausted = terminal || current.attempts >= 11;
    const next = exhausted ? null : now + Math.min(30 * 60_000, 1000 * 2 ** Math.min(current.attempts, 11));
    this.sql.exec(`UPDATE social_approaches SET attempts = ?, next_attempt_at = ?,
      delivery_state = CASE WHEN delivery_state = 'received' THEN delivery_state ELSE ? END,
      cleanup_at = CASE WHEN cleanup_at <= ? THEN ? ELSE cleanup_at END,
      updated_at = ? WHERE approach_id = ? AND revision = ?`, terminal ? 12 : current.attempts + 1, next, exhausted ? "failed" : "queued",
    now, now + 3_600_000, now, id, expectedRevision);
  }

  /**
   * Records the connection an acceptance made: on the sender's Ship as the
   * recipient's call arrives, on the recipient's once the sender's Ship answers.
   * Accepting again with the same generation finds the same record.
   */
  accept(id: string, generation: string, now = Date.now()): ApproachRecord {
    const current = this.get(id);
    if (!current) throw new Error("Message request not found");
    this.requireUnblocked(current.ownerUid, current.summary.peerDid);
    if (current.generation) {
      if (current.generation !== generation || current.summary.state !== "accepted") throw new Error("Message request acceptance changed");
      return current;
    }
    const incoming = current.summary.direction === "incoming";
    const deadline = current.summary.expiresAtMs + (incoming ? APPROACH_RECEIPT_MS : 0);
    if (deadline <= now || current.summary.state !== (incoming ? "accepting" : "pending")) throw new Error("Message request is no longer available");
    this.sql.exec(`UPDATE social_approaches SET state = 'accepted', revision = revision + 1,
      contact_generation = ?, accepted_at = ?, pending_text = NULL, pending_text_bytes = 0, delivery_state = 'received',
      attempts = 0, next_attempt_at = NULL, cleanup_at = ?, updated_at = ? WHERE approach_id = ?`,
    generation, now, now + APPROACH_RECEIPT_MS, now, id);
    return this.get(id)!;
  }

  expire(id: string, now = Date.now()): ApproachRecord | null {
    this.sql.exec(`UPDATE social_approaches SET state = 'expired', revision = revision + 1,
      pending_text = NULL, pending_text_bytes = 0, next_attempt_at = NULL,
      cleanup_at = ?, updated_at = ? WHERE approach_id = ? AND expires_at + CASE WHEN state = 'accepting' THEN ${APPROACH_RECEIPT_MS} ELSE 0 END <= ?
      AND state IN ${PENDING_STATES} AND accepted_at IS NULL`, now + APPROACH_RECEIPT_MS, now, id, now);
    return this.get(id);
  }

  removeSettled(id: string, now = Date.now()): void {
    this.sql.exec("DELETE FROM social_approaches WHERE approach_id = ? AND cleanup_at <= ?", id, now);
  }

  withdrawnRemotely(id: string, now = Date.now()): void {
    this.sql.exec(`UPDATE social_approaches SET state = 'withdrawn', revision = revision + 1,
      pending_text = NULL, pending_text_bytes = 0, next_attempt_at = NULL,
      cleanup_at = ?, updated_at = ? WHERE approach_id = ? AND direction = 'incoming'
      AND state IN ${PENDING_STATES} AND accepted_at IS NULL`, now + APPROACH_RECEIPT_MS, now, id);
  }

  unresolved(ownerUid: number, did: string): ApproachRecord | null {
    const row = this.sql.exec<ApproachRow>(`SELECT * FROM social_approaches WHERE owner_uid = ?
      AND remote_did = ? AND state IN ${PENDING_STATES}`, ownerUid, did).toArray()[0];
    return row ? record(row) : null;
  }

  list(ownerUid: number, input: { direction: ApproachSummary["direction"]; status?: "active" | "history"; before?: { createdAtMs: number; id: string }; limit: number }): ApproachSummary[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error("Message request page limit must be between 1 and 100");
    const active = `state IN ${PENDING_STATES}`;
    const status = input.status === "active" ? `AND ${active}` : input.status === "history" ? `AND NOT ${active}` : "";
    const before = input.before ? "AND (created_at, approach_id) < (?, ?)" : "";
    const values: (string | number)[] = [ownerUid, input.direction];
    if (input.before) values.push(input.before.createdAtMs, input.before.id);
    values.push(input.limit);
    const rows = this.sql.exec<ApproachRow>(`SELECT * FROM social_approaches WHERE owner_uid = ? AND direction = ?
      ${status} ${before} ORDER BY created_at DESC, approach_id DESC LIMIT ?`, ...values);
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

  beginAcceptance(id: string, ownerUid: number, expectedRevision: number, shipHandlesMessages = false, now = Date.now()): ApproachRecord {
    return this.storage.transactionSync(() => {
      const current = this.owned(id, ownerUid);
      this.requireUnblocked(ownerUid, current.summary.peerDid);
      if (current.summary.direction !== "incoming") throw new Error("Only a received request can be accepted");
      if (current.summary.state === "accepting" || current.summary.state === "accepted") return current;
      if (current.summary.state !== "pending" || current.summary.revision !== expectedRevision || current.summary.expiresAtMs <= now) {
        throw new Error("Message request changed; reload before accepting");
      }
      this.sql.exec(`UPDATE social_approaches SET state = 'accepting', revision = revision + 1,
        next_attempt_at = ?, updated_at = ?, ship_handles_messages = ? WHERE approach_id = ?`,
      now, now, shipHandlesMessages ? 1 : 0, id);
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
        pending_text = NULL, pending_text_bytes = 0,
        next_attempt_at = ?, cleanup_at = ?, updated_at = ? WHERE approach_id = ?`, decision,
      decision === "withdrawn" ? now : null, now + APPROACH_RECEIPT_MS, now, id);
      return this.get(id)!;
    });
  }

  /** Ends every unsettled request with the DID; the caller's block transaction records the block itself. */
  blockForDid(ownerUid: number, did: string, now = Date.now()): void {
    this.sql.exec(`UPDATE social_approaches SET state = 'blocked', revision = revision + 1,
      pending_text = NULL, pending_text_bytes = 0, next_attempt_at = NULL,
      cleanup_at = ?, updated_at = ?
      WHERE owner_uid = ? AND remote_did = ?
      AND state IN ('preparing', 'pending', 'accepting', 'accepted')`, now + APPROACH_RECEIPT_MS, now, ownerUid, did);
  }

  private requireUnblocked(ownerUid: number, did: string): void {
    const blocked = this.sql.exec("SELECT 1 FROM federation_actor_blocks WHERE owner_uid = ? AND did = ?", ownerUid, did).toArray().length > 0;
    if (blocked) throw new ApproachAdmissionError("blocked", "Message requests are unavailable for this person");
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
      throw new ApproachAdmissionError("capacity", "Message request capacity reached");
    }
  }
}

function summary(row: ApproachRow): ApproachSummary {
  const result: ApproachSummary = {
    id: row.approach_id, direction: row.direction, requestId: row.request_id, peerDid: row.remote_did,
    displayName: row.remote_display_name, conversationId: row.conversation_id, state: row.state, revision: row.revision,
    delivery: row.delivery_state, createdAtMs: row.created_at, updatedAtMs: row.updated_at, expiresAtMs: row.expires_at,
  };
  if (row.remote_handle !== null) result.peerHandle = row.remote_handle;
  if (row.accepted_at !== null) result.acceptedAtMs = row.accepted_at;
  if (row.message_sequence !== null) result.messageSequence = row.message_sequence;
  if (row.contact_generation !== null) result.contactId = row.contact_id;
  if (row.state === "accepting" || row.state === "accepted") {
    result.connection = row.attempts >= 12 ? "failed" : row.state === "accepting" ? "connecting" : "connected";
  }
  return result;
}

function record(row: ApproachRow): ApproachRecord {
  return {
    shipHandlesMessages: row.ship_handles_messages === 1,
    summary: summary(row), ownerUid: row.owner_uid, localDisplayName: row.local_display_name,
    contactId: row.contact_id, threadId: row.thread_id, fingerprint: row.fingerprint,
    profileCid: row.profile_cid, messageId: row.message_id, sentAtMs: row.sent_at,
    pendingText: row.pending_text, messageSequence: row.message_sequence, generation: row.contact_generation,
    attempts: row.attempts, nextAttemptAt: row.next_attempt_at, cleanupAt: row.cleanup_at,
  };
}
