import type {
  ContactRequestRecord,
  ContactRequestState,
  ContactState,
  ContactSummary,
  ConversationMessageAuthor,
  ConversationMessageOrigin,
  FederationDeliveryPayload,
  FederationPublicKey,
  FederationResourceDescriptor,
  FederationSubject,
  JsonObject,
  ResourceBlock,
} from "@humansandmachines/gsv/protocol";
import {
  federationDeliveryPayloadSchema,
  federationPublicKeySchema,
  jsonObjectSchema,
  resourceBlockSchema,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";

export type FederationContactRecord = ContactSummary & {
  remotePublicKey: FederationPublicKey;
  sharedSecret: string;
  threadId: string;
};

type FederationInviteBase = {
  inviteId: string;
  ownerUid: number;
  tokenHash: string;
  issuingShipId: string;
  issuingOrigin: string;
  expiresAtMs: number;
  createdAtMs: number;
};

export type FederationInviteRecord = FederationInviteBase & (
  | { state: "issued" }
  | { state: "cancelled"; cancelledAtMs: number }
  | {
      state: "accepted";
      acceptedContactId: string;
      acceptedRemoteShipId: string;
      acceptedRemoteSubjectId: string;
      acceptedGeneration: string;
      acceptedThreadId: string;
      acceptedResponse: JsonObject;
      acceptedAtMs: number;
    }
);

type FederationPairingAttemptBase = {
  tokenHash: string;
  ownerUid: number;
  expiresAtMs: number;
  remoteShipId: string;
  remoteSubjectId: string;
  remoteOrigin: string;
  remotePublicKey: FederationPublicKey;
  createdAtMs: number;
  updatedAtMs: number;
};

export type FederationPairingAttemptRecord = FederationPairingAttemptBase & (
  | { state: "pending" }
  | {
      state: "committed";
      contactId: string;
      generation: string;
      threadId: string;
    }
  | { state: "terminal"; terminalReason: string }
);

export type FederationOutboxLocalMessage = {
  messageId: string;
  text: string;
  media?: ResourceBlock[];
  author: ConversationMessageAuthor;
  origin: ConversationMessageOrigin;
  processId?: string;
  runId?: string;
  createdAtMs: number;
};

export type FederationMessagePreparation = {
  kind: "message";
  messageId: string;
  threadId: string;
  text: string;
  resources: ResourceBlock[];
  localMessage: FederationOutboxLocalMessage;
};

type FederationOutboxBase = {
  deliveryId: string;
  ownerUid: number;
  contactId: string;
  contactGeneration: string;
  idempotencyKey: string;
  fingerprint: string;
  attemptCount: number;
  nextAttemptAtMs?: number;
  lastError?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type FederationPreparingOutboxRecord = FederationOutboxBase & {
  state: "preparing" | "preparation_failed";
  preparation: FederationMessagePreparation;
};

export type FederationReadyOutboxRecord = FederationOutboxBase & {
  state: "pending" | "delivered" | "terminal";
  payload: FederationDeliveryPayload;
  localMessage?: FederationOutboxLocalMessage;
  localSequence?: number;
  deliveredAtMs?: number;
};

export type FederationOutboxRecord =
  | FederationPreparingOutboxRecord
  | FederationReadyOutboxRecord;

export function isReadyFederationOutbox(
  record: FederationOutboxRecord,
): record is FederationReadyOutboxRecord {
  return record.state === "pending"
    || record.state === "delivered"
    || record.state === "terminal";
}

export type FederationInboxRecord = {
  contactId: string;
  contactGeneration: string;
  deliveryId: string;
  payloadHash: string;
  payload: FederationDeliveryPayload;
  state: "received" | "committed" | "rejected";
  response?: JsonObject;
  lastError?: string;
  receivedAtMs: number;
  updatedAtMs: number;
  committedAtMs?: number;
};

export type FederationResourceGrant = {
  resourceId: string;
  contactId: string;
  contactGeneration: string;
  source: ResourceBlock;
  sourceUid: number;
  createdAtMs: number;
};

export type FederationEnqueueResult = {
  record: FederationReadyOutboxRecord;
  created: boolean;
};

export type FederationPrepareResult = {
  record: FederationPreparingOutboxRecord;
  created: boolean;
};

export type FederationReceiveResult = {
  record: FederationInboxRecord;
  created: boolean;
};

export class FederationRequestIdentityConflictError extends Error {
  constructor() {
    super("Contact request identity was reused with different content");
    this.name = "FederationRequestIdentityConflictError";
  }
}

export type FederationRateLimit = {
  scope: string;
  operation: string;
  maximum: number;
  windowMs: number;
};

const conversationMessageAuthorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), uid: z.number().int() }),
  z.strictObject({ kind: z.literal("process"), pid: z.string(), uid: z.number().int() }),
  z.strictObject({
    kind: z.literal("contact"),
    contactId: z.string(),
    shipId: z.string(),
    subjectId: z.string(),
    displayName: z.string(),
  }),
]) satisfies z.ZodType<ConversationMessageAuthor>;

const conversationMessageOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("client"),
    clientId: z.string().optional(),
    platform: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("adapter"),
    adapter: z.string(),
    accountId: z.string(),
    actorId: z.string(),
    surface: z.strictObject({
      kind: z.enum(["dm", "group", "channel", "thread"]),
      id: z.string(),
      threadId: z.string().optional(),
    }),
    providerMessageId: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal("process"), pid: z.string(), runId: z.string() }),
  z.strictObject({ kind: z.literal("device"), deviceId: z.string() }),
  z.strictObject({ kind: z.literal("scheduler"), scheduleId: z.string() }),
  z.strictObject({ kind: z.literal("mail"), messageId: z.string() }),
  z.strictObject({
    kind: z.literal("federation"),
    contactId: z.string(),
    deliveryId: z.string(),
  }),
]) satisfies z.ZodType<ConversationMessageOrigin>;

const federationOutboxLocalMessageSchema = z.strictObject({
  messageId: z.string(),
  text: z.string(),
  media: z.array(resourceBlockSchema).optional(),
  author: conversationMessageAuthorSchema,
  origin: conversationMessageOriginSchema,
  processId: z.string().optional(),
  runId: z.string().optional(),
  createdAtMs: z.number().int().nonnegative(),
}) satisfies z.ZodType<FederationOutboxLocalMessage>;

const federationMessagePreparationSchema = z.strictObject({
  kind: z.literal("message"),
  messageId: z.string(),
  threadId: z.string(),
  text: z.string(),
  resources: z.array(resourceBlockSchema),
  localMessage: federationOutboxLocalMessageSchema,
}) satisfies z.ZodType<FederationMessagePreparation>;

type ContactRow = {
  contact_id: string;
  owner_uid: number;
  state: ContactState;
  generation: string;
  remote_ship_id: string;
  remote_subject_id: string;
  remote_display_name: string;
  remote_origin: string;
  remote_public_key_json: string;
  shared_secret: string;
  conversation_id: string;
  thread_id: string;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  last_received_at: number | null;
  last_delivered_at: number | null;
};

type InviteRow = {
  invite_id: string;
  owner_uid: number;
  token_hash: string;
  issuing_ship_id: string;
  issuing_origin: string;
  state: FederationInviteRecord["state"];
  expires_at: number;
  cancelled_at: number | null;
  accepted_contact_id: string | null;
  accepted_remote_ship_id: string | null;
  accepted_remote_subject_id: string | null;
  accepted_generation: string | null;
  accepted_thread_id: string | null;
  accepted_response_json: string | null;
  accepted_at: number | null;
  created_at: number;
};

type PairingAttemptRow = {
  token_hash: string;
  owner_uid: number;
  expires_at: number;
  remote_ship_id: string;
  remote_subject_id: string;
  remote_origin: string;
  remote_public_key_json: string;
  state: FederationPairingAttemptRecord["state"];
  contact_id: string | null;
  generation: string | null;
  thread_id: string | null;
  terminal_reason: string | null;
  created_at: number;
  updated_at: number;
};

type OutboxRow = {
  delivery_id: string;
  owner_uid: number;
  contact_id: string;
  contact_generation: string;
  idempotency_key: string;
  fingerprint: string;
  payload_json: string | null;
  preparation_json: string | null;
  resource_count: number;
  local_message_json: string | null;
  local_sequence: number | null;
  state: FederationOutboxRecord["state"];
  attempt_count: number;
  next_attempt_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
};

type InboxRow = {
  contact_id: string;
  contact_generation: string;
  delivery_id: string;
  payload_hash: string;
  payload_json: string;
  state: FederationInboxRecord["state"];
  response_json: string | null;
  last_error: string | null;
  received_at: number;
  updated_at: number;
  committed_at: number | null;
};

type RequestRow = {
  request_id: string;
  remote_request_id: string | null;
  contact_id: string;
  contact_generation: string;
  direction: ContactRequestRecord["direction"];
  kind: string;
  title: string;
  details_json: string | null;
  state: ContactRequestState;
  revision: number;
  created_at: number;
  updated_at: number;
};

export class FederationStore {
  private readonly sql: SqlStorage;

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
  }

  transaction<Value>(callback: () => Value): Value {
    return this.storage.transactionSync(callback);
  }

  ensureSubject(ownerUid: number, displayName: string, now = Date.now()): FederationSubject {
    const existing = this.subject(ownerUid);
    if (existing) return existing;
    const subject: FederationSubject = {
      id: `subject:${crypto.randomUUID()}`,
      displayName,
    };
    this.sql.exec(
      `INSERT INTO federation_subjects
       (owner_uid, subject_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ownerUid,
      subject.id,
      subject.displayName,
      now,
      now,
    );
    return subject;
  }

  subject(ownerUid: number): FederationSubject | null {
    const row = this.sql.exec<{ subject_id: string; display_name: string }>(
      `SELECT subject_id, display_name
       FROM federation_subjects WHERE owner_uid = ? LIMIT 1`,
      ownerUid,
    ).toArray()[0];
    return row ? { id: row.subject_id, displayName: row.display_name } : null;
  }

  subjectOwner(subjectId: string): number | null {
    return this.sql.exec<{ owner_uid: number }>(
      "SELECT owner_uid FROM federation_subjects WHERE subject_id = ? LIMIT 1",
      subjectId,
    ).toArray()[0]?.owner_uid ?? null;
  }

  prune(input: {
    now: number;
    receiptCutoff: number;
    requestCutoff: number;
    batchSize: number;
  }): void {
    this.sql.exec(
      `DELETE FROM federation_invites WHERE invite_id IN (
         SELECT invite_id FROM federation_invites
         WHERE (state = 'issued' AND expires_at <= ?)
            OR (state = 'cancelled' AND cancelled_at <= ?)
            OR (state = 'accepted' AND accepted_at <= ?)
         ORDER BY created_at ASC LIMIT ?
       )`,
      input.receiptCutoff,
      input.receiptCutoff,
      input.receiptCutoff,
      input.batchSize,
    );
    this.sql.exec(
      `DELETE FROM federation_pairing_attempts WHERE token_hash IN (
         SELECT token_hash FROM federation_pairing_attempts
         WHERE (state = 'pending' AND expires_at <= ?)
            OR (state IN ('committed', 'terminal') AND updated_at <= ?)
         ORDER BY created_at ASC LIMIT ?
       )`,
      input.receiptCutoff,
      input.receiptCutoff,
      input.batchSize,
    );
    this.sql.exec(
      `DELETE FROM federation_outbox WHERE delivery_id IN (
       SELECT delivery_id FROM federation_outbox
         WHERE state IN ('preparation_failed', 'delivered', 'terminal') AND updated_at <= ?
         ORDER BY updated_at ASC LIMIT ?
       )`,
      input.receiptCutoff,
      input.batchSize,
    );
    this.sql.exec(
      `DELETE FROM federation_inbox WHERE rowid IN (
         SELECT rowid FROM federation_inbox
         WHERE state IN ('committed', 'rejected') AND updated_at <= ?
         ORDER BY updated_at ASC LIMIT ?
       )`,
      input.receiptCutoff,
      input.batchSize,
    );
    this.sql.exec(
      `DELETE FROM federation_requests WHERE request_id IN (
         SELECT request_id FROM federation_requests
         WHERE state IN ('rejected', 'completed', 'cancelled') AND updated_at <= ?
         ORDER BY updated_at ASC LIMIT ?
       )`,
      input.requestCutoff,
      input.batchSize,
    );
    this.sql.exec(
      "DELETE FROM federation_resource_reads WHERE expires_at <= ?",
      input.now,
    );
    this.sql.exec(
      `DELETE FROM federation_rate_limits WHERE rowid IN (
         SELECT rowid FROM federation_rate_limits
         WHERE window_started_at <= ? ORDER BY window_started_at ASC LIMIT ?
       )`,
      input.receiptCutoff,
      input.batchSize,
    );
  }

  consumeRateLimits(limits: FederationRateLimit[], now = Date.now()): number | null {
    const states = limits.map((limit) => {
      const windowStartedAt = Math.floor(now / limit.windowMs) * limit.windowMs;
      const row = this.sql.exec<{ window_started_at: number; count: number }>(
        `SELECT window_started_at, count FROM federation_rate_limits
         WHERE scope = ? AND operation = ? LIMIT 1`,
        limit.scope,
        limit.operation,
      ).toArray()[0];
      const count = row?.window_started_at === windowStartedAt ? row.count : 0;
      return { limit, windowStartedAt, count };
    });
    const exceeded = states.find(({ limit, count }) => count >= limit.maximum);
    if (exceeded) return exceeded.windowStartedAt + exceeded.limit.windowMs;
    for (const { limit, windowStartedAt, count } of states) {
      this.sql.exec(
        `INSERT INTO federation_rate_limits
         (scope, operation, window_started_at, count) VALUES (?, ?, ?, ?)
         ON CONFLICT (scope, operation) DO UPDATE SET
           window_started_at = excluded.window_started_at,
           count = excluded.count`,
        limit.scope,
        limit.operation,
        windowStartedAt,
        count + 1,
      );
    }
    return null;
  }

  outstandingInviteCount(ownerUid: number, now = Date.now()): number {
    return this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM federation_invites
       WHERE owner_uid = ? AND state = 'issued' AND expires_at > ?`,
      ownerUid,
      now,
    ).one().count;
  }

  contactCount(ownerUid?: number): number {
    if (ownerUid === undefined) {
      return this.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM federation_contacts",
      ).one().count;
    }
    return this.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM federation_contacts WHERE owner_uid = ?",
      ownerUid,
    ).one().count;
  }

  createInvite(input: {
    ownerUid: number;
    tokenHash: string;
    issuingShipId: string;
    issuingOrigin: string;
    expiresAtMs: number;
    now?: number;
  }): FederationInviteRecord {
    const now = input.now ?? Date.now();
    const inviteId = `invite:${crypto.randomUUID()}`;
    this.sql.exec(
      `INSERT INTO federation_invites
       (invite_id, owner_uid, token_hash, issuing_ship_id, issuing_origin,
        state, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'issued', ?, ?)`,
      inviteId,
      input.ownerUid,
      input.tokenHash,
      input.issuingShipId,
      input.issuingOrigin,
      input.expiresAtMs,
      now,
    );
    return this.inviteByTokenHash(input.tokenHash)!;
  }

  inviteByTokenHash(tokenHash: string): FederationInviteRecord | null {
    const row = this.sql.exec<InviteRow>(
      "SELECT * FROM federation_invites WHERE token_hash = ? LIMIT 1",
      tokenHash,
    ).toArray()[0];
    return row ? inviteFromRow(row) : null;
  }

  pairingAttempt(tokenHash: string): FederationPairingAttemptRecord | null {
    const row = this.sql.exec<PairingAttemptRow>(
      `SELECT * FROM federation_pairing_attempts
       WHERE token_hash = ? LIMIT 1`,
      tokenHash,
    ).toArray()[0];
    return row ? pairingAttemptFromRow(row) : null;
  }

  beginPairingAttempt(input: {
    tokenHash: string;
    ownerUid: number;
    expiresAtMs: number;
    remoteShipId: string;
    remoteSubjectId: string;
    remoteOrigin: string;
    remotePublicKey: FederationPublicKey;
    now?: number;
  }): FederationPairingAttemptRecord {
    const existing = this.pairingAttempt(input.tokenHash);
    if (existing) {
      if (
        existing.ownerUid !== input.ownerUid
        || existing.expiresAtMs !== input.expiresAtMs
        || existing.remoteShipId !== input.remoteShipId
        || existing.remoteSubjectId !== input.remoteSubjectId
        || existing.remoteOrigin !== input.remoteOrigin
        || JSON.stringify(existing.remotePublicKey) !== JSON.stringify(input.remotePublicKey)
      ) {
        throw new Error("Contact pairing attempt identity changed");
      }
      return existing;
    }
    const now = input.now ?? Date.now();
    this.sql.exec(
      `UPDATE federation_pairing_attempts SET
         state = 'terminal', terminal_reason = 'superseded', updated_at = ?
       WHERE owner_uid = ? AND remote_ship_id = ? AND remote_subject_id = ?
         AND state = 'pending'`,
      now,
      input.ownerUid,
      input.remoteShipId,
      input.remoteSubjectId,
    );
    this.sql.exec(
      `INSERT INTO federation_pairing_attempts (
         token_hash, owner_uid, expires_at, remote_ship_id, remote_subject_id,
         remote_origin, remote_public_key_json, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      input.tokenHash,
      input.ownerUid,
      input.expiresAtMs,
      input.remoteShipId,
      input.remoteSubjectId,
      input.remoteOrigin,
      JSON.stringify(input.remotePublicKey),
      now,
      now,
    );
    return this.pairingAttempt(input.tokenHash)!;
  }

  commitPairingAttempt(input: {
    tokenHash: string;
    contactId: string;
    generation: string;
    threadId: string;
    now?: number;
  }): FederationPairingAttemptRecord {
    const current = this.pairingAttempt(input.tokenHash);
    if (!current) throw new Error("Contact pairing attempt not found");
    if (current.state === "terminal") throw new Error("Contact pairing attempt is terminal");
    if (current.state === "committed") {
      if (
        current.contactId !== input.contactId
        || current.generation !== input.generation
        || current.threadId !== input.threadId
      ) {
        throw new Error("Committed contact pairing attempt changed");
      }
      return current;
    }
    const now = input.now ?? Date.now();
    this.sql.exec(
      `UPDATE federation_pairing_attempts SET
         state = 'committed', contact_id = ?, generation = ?, thread_id = ?, updated_at = ?
       WHERE token_hash = ? AND state = 'pending'`,
      input.contactId,
      input.generation,
      input.threadId,
      now,
      input.tokenHash,
    );
    return this.pairingAttempt(input.tokenHash)!;
  }

  terminatePairingAttempt(
    tokenHash: string,
    reason: string,
    now = Date.now(),
  ): FederationPairingAttemptRecord | null {
    this.sql.exec(
      `UPDATE federation_pairing_attempts SET
         state = 'terminal', terminal_reason = ?, updated_at = ?
       WHERE token_hash = ? AND state = 'pending'`,
      reason,
      now,
      tokenHash,
    );
    return this.pairingAttempt(tokenHash);
  }

  invite(inviteId: string): FederationInviteRecord | null {
    const row = this.sql.exec<InviteRow>(
      "SELECT * FROM federation_invites WHERE invite_id = ? LIMIT 1",
      inviteId,
    ).toArray()[0];
    return row ? inviteFromRow(row) : null;
  }

  listInvites(ownerUid: number, includeTerminal: boolean, now = Date.now()): FederationInviteRecord[] {
    const terminal = includeTerminal
      ? ""
      : "AND state = 'issued' AND expires_at > ?";
    const values = includeTerminal ? [ownerUid] : [ownerUid, now];
    return this.sql.exec<InviteRow>(
      `SELECT * FROM federation_invites
       WHERE owner_uid = ? ${terminal}
       ORDER BY created_at DESC`,
      ...values,
    ).toArray().map(inviteFromRow);
  }

  cancelInvite(inviteId: string, ownerUid: number, now = Date.now()): FederationInviteRecord {
    const current = this.invite(inviteId);
    if (!current || current.ownerUid !== ownerUid) {
      throw new Error(`Contact invite not found: ${inviteId}`);
    }
    if (current.state === "accepted") {
      throw new Error("An accepted contact invite cannot be cancelled");
    }
    if (current.state === "issued" && current.expiresAtMs <= now) {
      throw new Error("An expired contact invite cannot be cancelled");
    }
    if (current.state === "issued") {
      this.sql.exec(
        `UPDATE federation_invites SET state = 'cancelled', cancelled_at = ?
         WHERE invite_id = ? AND owner_uid = ? AND state = 'issued'`,
        now,
        inviteId,
        ownerUid,
      );
    }
    return this.invite(inviteId)!;
  }

  activateContact(input: {
    ownerUid: number;
    remoteShipId: string;
    remoteSubject: FederationSubject;
    remoteOrigin: string;
    remotePublicKey: FederationPublicKey;
    sharedSecret: string;
    generation: string;
    threadId: string;
    pairingAttemptTokenHash?: string;
    preferredContactId?: string;
    preferredConversationId?: string;
    now?: number;
  }): FederationContactRecord {
    const now = input.now ?? Date.now();
    const existing = this.getByRemote(
      input.ownerUid,
      input.remoteShipId,
      input.remoteSubject.id,
    );
    const preservedAttempt = input.pairingAttemptTokenHash
      ? "AND token_hash <> ?"
      : "";
    this.sql.exec(
      `UPDATE federation_pairing_attempts SET
         state = 'terminal', terminal_reason = 'superseded', updated_at = ?
       WHERE owner_uid = ? AND remote_ship_id = ? AND remote_subject_id = ?
         AND state = 'pending' ${preservedAttempt}`,
      ...(input.pairingAttemptTokenHash
        ? [
            now,
            input.ownerUid,
            input.remoteShipId,
            input.remoteSubject.id,
            input.pairingAttemptTokenHash,
          ]
        : [now, input.ownerUid, input.remoteShipId, input.remoteSubject.id]),
    );
    if (existing) {
      if (existing.generation !== input.generation) {
        this.sql.exec(
          `UPDATE federation_requests SET
             state = 'cancelled', revision = revision + 1, updated_at = ?
           WHERE contact_id = ? AND contact_generation <> ?
             AND state NOT IN ('rejected', 'completed', 'cancelled')`,
          now,
          existing.id,
          input.generation,
        );
        this.sql.exec(
          `UPDATE federation_inbox SET
             state = 'rejected', last_error = 'Contact generation changed', updated_at = ?
           WHERE contact_id = ? AND contact_generation <> ? AND state = 'received'`,
          now,
          existing.id,
          input.generation,
        );
        this.sql.exec(
          `DELETE FROM federation_resource_reads
           WHERE contact_id = ? AND contact_generation <> ?`,
          existing.id,
          input.generation,
        );
      }
      this.sql.exec(
        `UPDATE federation_outbox SET
           state = 'terminal', next_attempt_at = NULL,
           last_error = 'Contact generation changed', updated_at = ?
         WHERE contact_id = ? AND state = 'pending' AND contact_generation <> ?`,
        now,
        existing.id,
        input.generation,
      );
      this.sql.exec(
        `UPDATE federation_outbox SET
           state = 'preparation_failed', next_attempt_at = NULL,
           resource_count = 0, last_error = 'Contact generation changed', updated_at = ?
         WHERE contact_id = ? AND state = 'preparing' AND contact_generation <> ?`,
        now,
        existing.id,
        input.generation,
      );
      this.sql.exec(
        `DELETE FROM federation_resource_grants
         WHERE contact_id = ? AND contact_generation <> ?`,
        existing.id,
        input.generation,
      );
      this.sql.exec(
        `UPDATE federation_contacts SET
           state = 'active', generation = ?, remote_display_name = ?, remote_origin = ?,
           remote_public_key_json = ?, shared_secret = ?, thread_id = ?, updated_at = ?,
           revoked_at = NULL
         WHERE contact_id = ?`,
        input.generation,
        input.remoteSubject.displayName,
        input.remoteOrigin,
        JSON.stringify(input.remotePublicKey),
        input.sharedSecret,
        input.threadId,
        now,
        existing.id,
      );
      return this.get(existing.id)!;
    }
    const contactId = input.preferredContactId ?? `contact:${crypto.randomUUID()}`;
    const conversationId = input.preferredConversationId ?? `conv:${crypto.randomUUID()}`;
    this.sql.exec(
      `INSERT INTO federation_contacts (
         contact_id, owner_uid, state, generation, remote_ship_id,
         remote_subject_id, remote_display_name, remote_origin,
         remote_public_key_json, shared_secret, conversation_id, thread_id,
         created_at, updated_at
       ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      contactId,
      input.ownerUid,
      input.generation,
      input.remoteShipId,
      input.remoteSubject.id,
      input.remoteSubject.displayName,
      input.remoteOrigin,
      JSON.stringify(input.remotePublicKey),
      input.sharedSecret,
      conversationId,
      input.threadId,
      now,
      now,
    );
    return this.get(contactId)!;
  }

  acceptInvite(input: {
    tokenHash: string;
    remoteShipId: string;
    remoteSubjectId: string;
    contactId: string;
    generation: string;
    threadId: string;
    response: JsonObject;
    now?: number;
  }): boolean {
    const now = input.now ?? Date.now();
    const cursor = this.sql.exec(
      `UPDATE federation_invites SET
         state = 'accepted',
         accepted_contact_id = ?, accepted_remote_ship_id = ?,
         accepted_remote_subject_id = ?, accepted_generation = ?,
         accepted_thread_id = ?, accepted_response_json = ?, accepted_at = ?
       WHERE token_hash = ? AND state = 'issued' AND expires_at > ?`,
      input.contactId,
      input.remoteShipId,
      input.remoteSubjectId,
      input.generation,
      input.threadId,
      JSON.stringify(input.response),
      now,
      input.tokenHash,
      now,
    );
    return cursor.rowsWritten > 0;
  }

  get(contactId: string): FederationContactRecord | null {
    const row = this.sql.exec<ContactRow>(
      "SELECT * FROM federation_contacts WHERE contact_id = ? LIMIT 1",
      contactId,
    ).toArray()[0];
    return row ? contactFromRow(row) : null;
  }

  getByRemote(
    ownerUid: number,
    remoteShipId: string,
    remoteSubjectId: string,
  ): FederationContactRecord | null {
    const row = this.sql.exec<ContactRow>(
      `SELECT * FROM federation_contacts
       WHERE owner_uid = ? AND remote_ship_id = ? AND remote_subject_id = ?
       LIMIT 1`,
      ownerUid,
      remoteShipId,
      remoteSubjectId,
    ).toArray()[0];
    return row ? contactFromRow(row) : null;
  }

  getForInbound(
    remoteShipId: string,
    remoteSubjectId: string,
    localSubjectId: string,
  ): FederationContactRecord | null {
    const row = this.sql.exec<ContactRow>(
      `SELECT c.*
       FROM federation_contacts c
       JOIN federation_subjects s ON s.owner_uid = c.owner_uid
       WHERE c.remote_ship_id = ? AND c.remote_subject_id = ? AND s.subject_id = ?
       LIMIT 1`,
      remoteShipId,
      remoteSubjectId,
      localSubjectId,
    ).toArray()[0];
    return row ? contactFromRow(row) : null;
  }

  list(ownerUid: number, includeRevoked = false): FederationContactRecord[] {
    const condition = includeRevoked ? "" : "AND state = 'active'";
    return this.sql.exec<ContactRow>(
      `SELECT * FROM federation_contacts
       WHERE owner_uid = ? ${condition}
       ORDER BY updated_at DESC, created_at DESC`,
      ownerUid,
    ).toArray().map(contactFromRow);
  }

  revoke(contactId: string, ownerUid: number, now = Date.now()): FederationContactRecord {
    this.sql.exec(
      `UPDATE federation_contacts SET
         state = 'revoked', revoked_at = ?, updated_at = ?
       WHERE contact_id = ? AND owner_uid = ?`,
      now,
      now,
      contactId,
      ownerUid,
    );
    const contact = this.get(contactId);
    if (!contact || contact.ownerUid !== ownerUid) throw new Error(`Contact not found: ${contactId}`);
    this.sql.exec(
      `UPDATE federation_pairing_attempts SET
         state = 'terminal', terminal_reason = 'contact-revoked', updated_at = ?
       WHERE owner_uid = ? AND remote_ship_id = ? AND remote_subject_id = ?
         AND state = 'pending'`,
      now,
      ownerUid,
      contact.remoteShipId,
      contact.remoteSubject.id,
    );
    this.sql.exec("DELETE FROM federation_resource_grants WHERE contact_id = ?", contactId);
    this.sql.exec(
      `UPDATE federation_requests SET
         state = 'cancelled', revision = revision + 1, updated_at = ?
       WHERE contact_id = ?
         AND contact_generation = ?
         AND state NOT IN ('rejected', 'completed', 'cancelled')`,
      now,
      contactId,
      contact.generation,
    );
    this.sql.exec(
      `DELETE FROM federation_resource_reads
       WHERE contact_id = ? AND contact_generation = ?`,
      contactId,
      contact.generation,
    );
    return contact;
  }

  markContactReceived(
    contactId: string,
    contactGeneration: string,
    now = Date.now(),
  ): void {
    this.sql.exec(
      `UPDATE federation_contacts SET last_received_at = ?, updated_at = ?
       WHERE contact_id = ? AND generation = ?`,
      now,
      now,
      contactId,
      contactGeneration,
    );
  }

  markContactDelivered(
    contactId: string,
    contactGeneration: string,
    now = Date.now(),
  ): boolean {
    const cursor = this.sql.exec(
      `UPDATE federation_contacts SET last_delivered_at = ?, updated_at = ?
       WHERE contact_id = ? AND generation = ?`,
      now,
      now,
      contactId,
      contactGeneration,
    );
    return cursor.rowsWritten > 0;
  }

  enqueue(input: {
    deliveryId: string;
    ownerUid: number;
    contactId: string;
    contactGeneration: string;
    idempotencyKey: string;
    fingerprint: string;
    payload: FederationDeliveryPayload;
    localMessage?: FederationOutboxLocalMessage;
    now?: number;
  }): FederationEnqueueResult {
    const now = input.now ?? Date.now();
    const existing = this.outboxByIdempotency(input.ownerUid, input.idempotencyKey);
    if (existing) {
      if (
        existing.contactId !== input.contactId
        || existing.contactGeneration !== input.contactGeneration
        || existing.fingerprint !== input.fingerprint
      ) {
        throw new Error("Contact delivery idempotency key payload changed");
      }
      if (!isReadyFederationOutbox(existing)) {
        throw new Error("Contact delivery idempotency key was used for message preparation");
      }
      return { record: existing, created: false };
    }
    this.sql.exec(
      `INSERT INTO federation_outbox (
         delivery_id, owner_uid, contact_id, contact_generation, idempotency_key,
         fingerprint, payload_json, local_message_json, state, next_attempt_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      input.deliveryId,
      input.ownerUid,
      input.contactId,
      input.contactGeneration,
      input.idempotencyKey,
      input.fingerprint,
      JSON.stringify(input.payload),
      input.localMessage ? JSON.stringify(input.localMessage) : null,
      now,
      now,
      now,
    );
    const record = this.outbox(input.deliveryId);
    if (!record || !isReadyFederationOutbox(record)) {
      throw new Error("Contact delivery was not persisted");
    }
    return { record, created: true };
  }

  prepareMessage(input: {
    deliveryId: string;
    ownerUid: number;
    contactId: string;
    contactGeneration: string;
    idempotencyKey: string;
    fingerprint: string;
    preparation: FederationMessagePreparation;
    now?: number;
  }): FederationPrepareResult {
    const now = input.now ?? Date.now();
    const existing = this.outboxByIdempotency(input.ownerUid, input.idempotencyKey);
    if (existing) {
      if (
        existing.contactId !== input.contactId
        || existing.contactGeneration !== input.contactGeneration
        || existing.fingerprint !== input.fingerprint
      ) {
        throw new Error("Contact delivery idempotency key payload changed");
      }
      if (existing.state !== "preparing" && existing.state !== "preparation_failed") {
        throw new Error("Contact delivery idempotency key was used for another delivery");
      }
      return { record: existing, created: false };
    }
    this.sql.exec(
      `INSERT INTO federation_outbox (
         delivery_id, owner_uid, contact_id, contact_generation, idempotency_key,
         fingerprint, preparation_json, resource_count, state, next_attempt_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?)`,
      input.deliveryId,
      input.ownerUid,
      input.contactId,
      input.contactGeneration,
      input.idempotencyKey,
      input.fingerprint,
      JSON.stringify(input.preparation),
      input.preparation.resources.length,
      now,
      now,
      now,
    );
    const record = this.outbox(input.deliveryId);
    if (!record || record.state !== "preparing") {
      throw new Error("Contact message preparation was not persisted");
    }
    return { record, created: true };
  }

  completeMessagePreparation(input: {
    deliveryId: string;
    contactGeneration: string;
    payload: Extract<FederationDeliveryPayload, { kind: "message" }>;
    localMessage: FederationOutboxLocalMessage;
    now?: number;
  }): FederationReadyOutboxRecord {
    const now = input.now ?? Date.now();
    this.sql.exec(
      `UPDATE federation_outbox SET
         payload_json = ?, preparation_json = NULL, local_message_json = ?,
         resource_count = 0, state = 'pending', next_attempt_at = ?,
         last_error = NULL, updated_at = ?
       WHERE delivery_id = ? AND contact_generation = ? AND state = 'preparing'`,
      JSON.stringify(input.payload),
      JSON.stringify(input.localMessage),
      now,
      now,
      input.deliveryId,
      input.contactGeneration,
    );
    const record = this.outbox(input.deliveryId);
    if (!record || record.state !== "pending") {
      throw new Error("Contact message preparation did not complete");
    }
    return record;
  }

  outbox(deliveryId: string): FederationOutboxRecord | null {
    const row = this.sql.exec<OutboxRow>(
      "SELECT * FROM federation_outbox WHERE delivery_id = ? LIMIT 1",
      deliveryId,
    ).toArray()[0];
    return row ? outboxFromRow(row) : null;
  }

  outboxByIdempotency(ownerUid: number, key: string): FederationOutboxRecord | null {
    const row = this.sql.exec<OutboxRow>(
      `SELECT * FROM federation_outbox
       WHERE owner_uid = ? AND idempotency_key = ? LIMIT 1`,
      ownerUid,
      key,
    ).toArray()[0];
    return row ? outboxFromRow(row) : null;
  }

  pendingOutboxCount(input: { ownerUid?: number; contactId?: string } = {}): number {
    const conditions = ["state IN ('preparing', 'pending')"];
    const values: Array<string | number> = [];
    if (input.ownerUid !== undefined) {
      conditions.push("owner_uid = ?");
      values.push(input.ownerUid);
    }
    if (input.contactId !== undefined) {
      conditions.push("contact_id = ?");
      values.push(input.contactId);
    }
    return this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM federation_outbox WHERE ${conditions.join(" AND ")}`,
      ...values,
    ).one().count;
  }

  preparingResourceCount(contactId?: string): number {
    const scope = contactId === undefined ? "" : "AND contact_id = ?";
    const values = contactId === undefined ? [] : [contactId];
    return this.sql.exec<{ count: number }>(
      `SELECT COALESCE(SUM(resource_count), 0) AS count
       FROM federation_outbox WHERE state = 'preparing' ${scope}`,
      ...values,
    ).one().count;
  }

  retainedOutboxCount(input: { receiptCutoff: number; ownerUid?: number }): number {
    const owner = input.ownerUid === undefined ? "" : "AND owner_uid = ?";
    const values = input.ownerUid === undefined
      ? [input.receiptCutoff]
      : [input.receiptCutoff, input.ownerUid];
    return this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM federation_outbox
       WHERE (state IN ('preparing', 'pending') OR updated_at > ?) ${owner}`,
      ...values,
    ).one().count;
  }

  recoverableOutbox(limit: number): FederationOutboxRecord[] {
    return this.sql.exec<OutboxRow>(
      `SELECT * FROM federation_outbox
       WHERE state IN ('preparing', 'pending')
       ORDER BY created_at ASC LIMIT ?`,
      limit,
    ).toArray().map(outboxFromRow);
  }

  markLocalMessageCommitted(deliveryId: string, sequence: number, now = Date.now()): void {
    this.sql.exec(
      `UPDATE federation_outbox SET local_sequence = ?, updated_at = ?
       WHERE delivery_id = ? AND local_sequence IS NULL`,
      sequence,
      now,
      deliveryId,
    );
  }

  markDeliverySucceeded(
    deliveryId: string,
    contactGeneration: string,
    now = Date.now(),
  ): boolean {
    const cursor = this.sql.exec(
      `UPDATE federation_outbox SET
         state = 'delivered', delivered_at = ?, next_attempt_at = NULL,
         last_error = NULL, updated_at = ?
       WHERE delivery_id = ? AND state = 'pending' AND contact_generation = ?
         AND EXISTS (
           SELECT 1 FROM federation_contacts
           WHERE contact_id = federation_outbox.contact_id AND generation = ?
         )`,
      now,
      now,
      deliveryId,
      contactGeneration,
      contactGeneration,
    );
    return cursor.rowsWritten > 0;
  }

  markOutboxFailed(
    deliveryId: string,
    contactGeneration: string,
    expectedState: "preparing" | "pending",
    error: string,
    nextAttemptAtMs: number | null,
    terminal: boolean,
    now = Date.now(),
  ): boolean {
    const cursor = this.sql.exec(
      `UPDATE federation_outbox SET
         state = ?, attempt_count = attempt_count + 1, next_attempt_at = ?,
         resource_count = CASE WHEN ? THEN 0 ELSE resource_count END,
         last_error = ?, updated_at = ?
       WHERE delivery_id = ? AND state = ? AND contact_generation = ?`,
      terminal
        ? expectedState === "preparing" ? "preparation_failed" : "terminal"
        : expectedState,
      nextAttemptAtMs,
      terminal ? 1 : 0,
      error,
      now,
      deliveryId,
      expectedState,
      contactGeneration,
    );
    return cursor.rowsWritten > 0;
  }

  terminatePendingForRevokedContact(
    contactId: string,
    contactGeneration: string,
    exceptDeliveryId: string | null,
    now = Date.now(),
  ): void {
    const exception = exceptDeliveryId ? "AND delivery_id <> ?" : "";
    this.sql.exec(
      `UPDATE federation_outbox SET
         state = CASE state WHEN 'preparing' THEN 'preparation_failed' ELSE 'terminal' END,
         resource_count = CASE state WHEN 'preparing' THEN 0 ELSE resource_count END,
         next_attempt_at = NULL,
         last_error = 'Contact was revoked', updated_at = ?
       WHERE contact_id = ? AND contact_generation = ?
         AND state IN ('preparing', 'pending') ${exception}`,
      ...(exceptDeliveryId
        ? [now, contactId, contactGeneration, exceptDeliveryId]
        : [now, contactId, contactGeneration]),
    );
    this.sql.exec(
      `UPDATE federation_inbox SET
         state = 'rejected', last_error = 'Contact was revoked', updated_at = ?
       WHERE contact_id = ? AND contact_generation = ? AND state = 'received' ${exception}`,
      ...(exceptDeliveryId
        ? [now, contactId, contactGeneration, exceptDeliveryId]
        : [now, contactId, contactGeneration]),
    );
    this.sql.exec(
      `DELETE FROM federation_resource_reads
       WHERE contact_id = ? AND contact_generation = ?`,
      contactId,
      contactGeneration,
    );
  }

  receive(input: {
    contactId: string;
    contactGeneration: string;
    deliveryId: string;
    payloadHash: string;
    payload: FederationDeliveryPayload;
    now?: number;
  }): FederationReceiveResult {
    const existing = this.inbox(input.contactId, input.contactGeneration, input.deliveryId);
    if (existing) {
      if (existing.payloadHash !== input.payloadHash) {
        throw new Error("Federation delivery id was reused with a different payload");
      }
      return { record: existing, created: false };
    }
    const now = input.now ?? Date.now();
    this.sql.exec(
      `INSERT INTO federation_inbox (
         contact_id, contact_generation, delivery_id, payload_hash, payload_json,
         state, received_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'received', ?, ?)`,
      input.contactId,
      input.contactGeneration,
      input.deliveryId,
      input.payloadHash,
      JSON.stringify(input.payload),
      now,
      now,
    );
    return {
      record: this.inbox(input.contactId, input.contactGeneration, input.deliveryId)!,
      created: true,
    };
  }

  inbox(
    contactId: string,
    contactGeneration: string,
    deliveryId: string,
  ): FederationInboxRecord | null {
    const row = this.sql.exec<InboxRow>(
      `SELECT * FROM federation_inbox
       WHERE contact_id = ? AND contact_generation = ? AND delivery_id = ? LIMIT 1`,
      contactId,
      contactGeneration,
      deliveryId,
    ).toArray()[0];
    return row ? inboxFromRow(row) : null;
  }

  recoverableInbox(limit = 100): FederationInboxRecord[] {
    return this.sql.exec<InboxRow>(
      `SELECT * FROM federation_inbox
       WHERE state = 'received'
       ORDER BY received_at ASC LIMIT ?`,
      limit,
    ).toArray().map(inboxFromRow);
  }

  pendingInboxCount(contactId?: string): number {
    if (contactId === undefined) {
      return this.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM federation_inbox WHERE state = 'received'",
      ).one().count;
    }
    return this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM federation_inbox
       WHERE state = 'received' AND contact_id = ?`,
      contactId,
    ).one().count;
  }

  retainedInboxCount(contactId: string | undefined, receiptCutoff: number): number {
    const contact = contactId === undefined ? "" : "AND contact_id = ?";
    const values = contactId === undefined
      ? [receiptCutoff]
      : [receiptCutoff, contactId];
    return this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM federation_inbox
       WHERE (state = 'received' OR updated_at > ?) ${contact}`,
      ...values,
    ).one().count;
  }

  commitInbox(
    contactId: string,
    contactGeneration: string,
    deliveryId: string,
    response: JsonObject,
    now = Date.now(),
  ): boolean {
    const cursor = this.sql.exec(
      `UPDATE federation_inbox SET
         state = 'committed', response_json = ?, last_error = NULL,
         committed_at = ?, updated_at = ?
       WHERE contact_id = ? AND contact_generation = ? AND delivery_id = ?
         AND state = 'received'`,
      JSON.stringify(response),
      now,
      now,
      contactId,
      contactGeneration,
      deliveryId,
    );
    return cursor.rowsWritten > 0;
  }

  failInbox(
    contactId: string,
    contactGeneration: string,
    deliveryId: string,
    error: string,
    now = Date.now(),
  ): void {
    this.sql.exec(
      `UPDATE federation_inbox SET last_error = ?, updated_at = ?
       WHERE contact_id = ? AND contact_generation = ?
         AND delivery_id = ? AND state = 'received'`,
      error,
      now,
      contactId,
      contactGeneration,
      deliveryId,
    );
  }

  rejectInbox(
    contactId: string,
    contactGeneration: string,
    deliveryId: string,
    error: string,
    now = Date.now(),
  ): void {
    this.sql.exec(
      `UPDATE federation_inbox SET
         state = 'rejected', last_error = ?, updated_at = ?
       WHERE contact_id = ? AND contact_generation = ?
         AND delivery_id = ? AND state = 'received'`,
      error,
      now,
      contactId,
      contactGeneration,
      deliveryId,
    );
  }

  createGrant(input: {
    contactId: string;
    contactGeneration: string;
    source: ResourceBlock;
    sourceUid: number;
    descriptor: Omit<FederationResourceDescriptor, "id">;
    now?: number;
  }): FederationResourceDescriptor {
    const now = input.now ?? Date.now();
    const resourceId = `resource:${crypto.randomUUID()}`;
    this.sql.exec(
      `INSERT INTO federation_resource_grants (
         resource_id, contact_id, contact_generation, source_ref_json, source_uid, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      resourceId,
      input.contactId,
      input.contactGeneration,
      JSON.stringify(input.source),
      input.sourceUid,
      now,
    );
    return { id: resourceId, ...input.descriptor };
  }

  grant(resourceId: string): FederationResourceGrant | null {
    const row = this.sql.exec<{
      resource_id: string;
      contact_id: string;
      contact_generation: string;
      source_ref_json: string;
      source_uid: number;
      created_at: number;
    }>(
      "SELECT * FROM federation_resource_grants WHERE resource_id = ? LIMIT 1",
      resourceId,
    ).toArray()[0];
    if (!row) return null;
    return {
      resourceId: row.resource_id,
      contactId: row.contact_id,
      contactGeneration: row.contact_generation,
      source: resourceBlockSchema.parse(JSON.parse(row.source_ref_json)),
      sourceUid: row.source_uid,
      createdAtMs: row.created_at,
    };
  }

  activeGrantCount(contactId?: string): number {
    if (contactId === undefined) {
      return this.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM federation_resource_grants",
      ).one().count;
    }
    return this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM federation_resource_grants
       WHERE contact_id = ?`,
      contactId,
    ).one().count;
  }

  beginResourceRead(
    contactId: string,
    contactGeneration: string,
    maximum: number,
    leaseMs: number,
    now = Date.now(),
  ): string | null {
    this.sql.exec("DELETE FROM federation_resource_reads WHERE expires_at <= ?", now);
    const active = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM federation_resource_reads
       WHERE contact_id = ? AND contact_generation = ? AND expires_at > ?`,
      contactId,
      contactGeneration,
      now,
    ).one().count;
    if (active >= maximum) return null;
    const readId = `read:${crypto.randomUUID()}`;
    this.sql.exec(
      `INSERT INTO federation_resource_reads (
         read_id, contact_id, contact_generation, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
      readId,
      contactId,
      contactGeneration,
      now + leaseMs,
      now,
    );
    return readId;
  }

  finishResourceRead(readId: string): void {
    this.sql.exec("DELETE FROM federation_resource_reads WHERE read_id = ?", readId);
  }

  createRequest(input: Omit<ContactRequestRecord, "revision">): ContactRequestRecord {
    const existing = this.request(input.id);
    if (existing) {
      if (
        existing.contactId !== input.contactId
        || existing.contactGeneration !== input.contactGeneration
        || existing.direction !== input.direction
        || existing.kind !== input.kind
        || existing.title !== input.title
        || existing.state !== input.state
        || existing.createdAtMs !== input.createdAtMs
        || JSON.stringify(existing.details) !== JSON.stringify(input.details)
      ) {
        throw new FederationRequestIdentityConflictError();
      }
      return existing;
    }
    this.sql.exec(
      `INSERT INTO federation_requests (
         request_id, remote_request_id, contact_id, contact_generation, direction,
         kind, title, details_json, state, revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      input.id,
      input.remoteId ?? null,
      input.contactId,
      input.contactGeneration,
      input.direction,
      input.kind,
      input.title,
      input.details ? JSON.stringify(input.details) : null,
      input.state,
      input.createdAtMs,
      input.updatedAtMs,
    );
    return this.request(input.id)!;
  }

  requestCount(input: {
    contactId: string;
    activeOnly?: boolean;
    requestCutoff?: number;
  }): number {
    const conditions = ["contact_id = ?"];
    const values: Array<string | number> = [input.contactId];
    if (input.activeOnly) {
      conditions.push("state NOT IN ('rejected', 'completed', 'cancelled')");
    } else if (input.requestCutoff !== undefined) {
      conditions.push(
        "(state NOT IN ('rejected', 'completed', 'cancelled') OR updated_at > ?)",
      );
      values.push(input.requestCutoff);
    }
    return this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM federation_requests
       WHERE ${conditions.join(" AND ")}`,
      ...values,
    ).one().count;
  }

  request(requestId: string): ContactRequestRecord | null {
    const row = this.sql.exec<RequestRow>(
      "SELECT * FROM federation_requests WHERE request_id = ? LIMIT 1",
      requestId,
    ).toArray()[0];
    return row ? requestFromRow(row) : null;
  }

  requestForRemoteUpdate(
    contactId: string,
    contactGeneration: string,
    remoteRequestId: string,
  ): ContactRequestRecord | null {
    const row = this.sql.exec<RequestRow>(
      `SELECT * FROM federation_requests
       WHERE contact_id = ? AND contact_generation = ? AND (
         (direction = 'outgoing' AND request_id = ?)
         OR (direction = 'incoming' AND remote_request_id = ?)
       )
       LIMIT 1`,
      contactId,
      contactGeneration,
      remoteRequestId,
      remoteRequestId,
    ).toArray()[0];
    return row ? requestFromRow(row) : null;
  }

  listRequests(
    ownerUid: number,
    contactId?: string,
    includeTerminal = false,
  ): ContactRequestRecord[] {
    const conditions = ["c.owner_uid = ?"];
    const values: Array<string | number> = [ownerUid];
    if (contactId) {
      conditions.push("r.contact_id = ?");
      values.push(contactId);
    }
    if (!includeTerminal) {
      conditions.push("r.state NOT IN ('rejected', 'completed', 'cancelled')");
    }
    return this.sql.exec<RequestRow>(
      `SELECT r.* FROM federation_requests r
       JOIN federation_contacts c ON c.contact_id = r.contact_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY r.updated_at DESC`,
      ...values,
    ).toArray().map(requestFromRow);
  }

  updateRequest(input: {
    requestId: string;
    expectedRevision: number;
    state: ContactRequestState;
    details?: JsonObject;
    updatedAtMs: number;
  }): ContactRequestRecord {
    const current = this.request(input.requestId);
    if (!current) throw new Error(`Contact request not found: ${input.requestId}`);
    if (current.revision !== input.expectedRevision) {
      throw new Error("Contact request revision changed");
    }
    this.sql.exec(
      `UPDATE federation_requests SET
         state = ?, details_json = COALESCE(?, details_json),
         revision = revision + 1, updated_at = ?
       WHERE request_id = ? AND revision = ?`,
      input.state,
      input.details ? JSON.stringify(input.details) : null,
      input.updatedAtMs,
      input.requestId,
      input.expectedRevision,
    );
    return this.request(input.requestId)!;
  }
}

function contactFromRow(row: ContactRow): FederationContactRecord {
  return {
    id: row.contact_id,
    ownerUid: row.owner_uid,
    state: row.state,
    generation: row.generation,
    remoteShipId: row.remote_ship_id,
    remoteSubject: {
      id: row.remote_subject_id,
      displayName: row.remote_display_name,
    },
    remoteOrigin: row.remote_origin,
    remotePublicKey: federationPublicKeySchema.parse(JSON.parse(row.remote_public_key_json)),
    sharedSecret: row.shared_secret,
    conversationId: row.conversation_id,
    threadId: row.thread_id,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
    ...(row.revoked_at !== null ? { revokedAtMs: row.revoked_at } : undefined),
    ...(row.last_received_at !== null ? { lastReceivedAtMs: row.last_received_at } : undefined),
    ...(row.last_delivered_at !== null ? { lastDeliveredAtMs: row.last_delivered_at } : undefined),
  };
}

function inviteFromRow(row: InviteRow): FederationInviteRecord {
  const base: FederationInviteBase = {
    inviteId: row.invite_id,
    ownerUid: row.owner_uid,
    tokenHash: row.token_hash,
    issuingShipId: row.issuing_ship_id,
    issuingOrigin: row.issuing_origin,
    expiresAtMs: row.expires_at,
    createdAtMs: row.created_at,
  };
  if (row.state === "issued") return { ...base, state: "issued" };
  if (row.state === "cancelled") {
    if (row.cancelled_at === null) throw new Error("Cancelled invite has no cancellation time");
    return { ...base, state: "cancelled", cancelledAtMs: row.cancelled_at };
  }
  if (
    !row.accepted_contact_id
    || !row.accepted_remote_ship_id
    || !row.accepted_remote_subject_id
    || !row.accepted_generation
    || !row.accepted_thread_id
    || !row.accepted_response_json
    || row.accepted_at === null
  ) {
    throw new Error("Accepted invite has an incomplete contact snapshot");
  }
  return {
    ...base,
    state: "accepted",
    acceptedContactId: row.accepted_contact_id,
    acceptedRemoteShipId: row.accepted_remote_ship_id,
    acceptedRemoteSubjectId: row.accepted_remote_subject_id,
    acceptedGeneration: row.accepted_generation,
    acceptedThreadId: row.accepted_thread_id,
    acceptedResponse: jsonObjectSchema.parse(JSON.parse(row.accepted_response_json)),
    acceptedAtMs: row.accepted_at,
  };
}

function pairingAttemptFromRow(row: PairingAttemptRow): FederationPairingAttemptRecord {
  const base: FederationPairingAttemptBase = {
    tokenHash: row.token_hash,
    ownerUid: row.owner_uid,
    expiresAtMs: row.expires_at,
    remoteShipId: row.remote_ship_id,
    remoteSubjectId: row.remote_subject_id,
    remoteOrigin: row.remote_origin,
    remotePublicKey: federationPublicKeySchema.parse(JSON.parse(row.remote_public_key_json)),
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  };
  if (row.state === "pending") return { ...base, state: "pending" };
  if (row.state === "terminal") {
    if (!row.terminal_reason) throw new Error("Terminal pairing attempt has no reason");
    return { ...base, state: "terminal", terminalReason: row.terminal_reason };
  }
  if (!row.contact_id || !row.generation || !row.thread_id) {
    throw new Error("Committed pairing attempt has an incomplete contact snapshot");
  }
  return {
    ...base,
    state: "committed",
    contactId: row.contact_id,
    generation: row.generation,
    threadId: row.thread_id,
  };
}

function outboxFromRow(row: OutboxRow): FederationOutboxRecord {
  const base = {
    deliveryId: row.delivery_id,
    ownerUid: row.owner_uid,
    contactId: row.contact_id,
    contactGeneration: row.contact_generation,
    idempotencyKey: row.idempotency_key,
    fingerprint: row.fingerprint,
    attemptCount: row.attempt_count,
    ...(row.next_attempt_at !== null ? { nextAttemptAtMs: row.next_attempt_at } : undefined),
    ...(row.last_error ? { lastError: row.last_error } : undefined),
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  };
  if (row.state === "preparing" || row.state === "preparation_failed") {
    if (!row.preparation_json || row.payload_json) {
      throw new Error("Federation message preparation has invalid stored content");
    }
    return {
      ...base,
      state: row.state,
      preparation: federationMessagePreparationSchema.parse(JSON.parse(row.preparation_json)),
    };
  }
  if (!row.payload_json || row.preparation_json) {
    throw new Error("Federation delivery has invalid stored content");
  }
  return {
    ...base,
    state: row.state,
    payload: federationDeliveryPayloadSchema.parse(JSON.parse(row.payload_json)),
    ...(row.local_message_json
      ? { localMessage: federationOutboxLocalMessageSchema.parse(JSON.parse(row.local_message_json)) }
      : undefined),
    ...(row.local_sequence !== null ? { localSequence: row.local_sequence } : undefined),
    ...(row.delivered_at !== null ? { deliveredAtMs: row.delivered_at } : undefined),
  };
}

function inboxFromRow(row: InboxRow): FederationInboxRecord {
  return {
    contactId: row.contact_id,
    contactGeneration: row.contact_generation,
    deliveryId: row.delivery_id,
    payloadHash: row.payload_hash,
    payload: federationDeliveryPayloadSchema.parse(JSON.parse(row.payload_json)),
    state: row.state,
    ...(row.response_json
      ? { response: jsonObjectSchema.parse(JSON.parse(row.response_json)) }
      : undefined),
    ...(row.last_error ? { lastError: row.last_error } : undefined),
    receivedAtMs: row.received_at,
    updatedAtMs: row.updated_at,
    ...(row.committed_at !== null ? { committedAtMs: row.committed_at } : undefined),
  };
}

function requestFromRow(row: RequestRow): ContactRequestRecord {
  return {
    id: row.request_id,
    ...(row.remote_request_id ? { remoteId: row.remote_request_id } : undefined),
    contactId: row.contact_id,
    contactGeneration: row.contact_generation,
    direction: row.direction,
    kind: row.kind,
    title: row.title,
    ...(row.details_json
      ? { details: jsonObjectSchema.parse(JSON.parse(row.details_json)) }
      : undefined),
    state: row.state,
    revision: row.revision,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  };
}
