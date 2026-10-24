import type {
  ApproachState,
  FederationDeliveryPayload,
  SocialMessageMetadata,
  SocialMessageProvenance,
} from "@humansandmachines/gsv/protocol";
import { federationDeliveryPayloadSchema, socialMessageMetadataSchema } from "@humansandmachines/gsv/protocol";
import {
  MAX_IDENTITY_MOVE_PEOPLE,
  type OperatorIdentityMove,
  type OperatorIdentitySurvey,
  type OperatorLegacyPerson,
  type OperatorPersonDid,
} from "@humansandmachines/gsv/services/operator";
import { z } from "zod/mini";
import { socialBeforeDidsSchema, type SocialBeforeDids } from "../../conversation/store";
import { getConversationById } from "../../shared/utils";
import { APPROACH_RECEIPT_MS } from "../approach-store";
import { ensureShipAccount } from "../atproto";
import type { KernelContext } from "../context";
import { federationPayloadHash } from "../federation";
import {
  federationMessagePreparationSchema,
  federationOutboxLocalMessageSchema,
  type FederationMessagePreparation,
  type FederationOutboxLocalMessage,
} from "../federation-store";
import { profileOwnerActive, publishPendingProfile } from "../profiles";
import { revokeFederationContact } from "./pairing";

/*
 * The operator's move to DIDs. Rows from before DIDs named a person by their
 * Ship's key (its shipId) and their account's subject on it. Accounts surveys
 * every Ship on the deployment, then gives each the DIDs of the people its
 * rows name; the move renames those rows and ends the ones naming anyone else.
 * Release 2 drops this module with the legacy tables.
 */

/** Where the Ship kept its key from before DIDs; the move deletes it last, which marks the move finished. */
const OLD_IDENTITY_KEY = "federation_identity_v1";
const IDENTITY_MOVE_LOCK = "identity-move";
const HOST_TIMEOUT_MS = 60_000;
const CONVERSATION_BATCH = 10;

type OldName = { shipId: string; subjectId: string };
type Person = { did: string; handle?: string };
type MoveCounts = OperatorIdentityMove["moved"];

type LegacyContactRow = {
  contact_id: string; owner_uid: number; state: "active" | "revoked";
  remote_ship_id: string; remote_subject_id: string; thread_id: string;
};
type LegacyBlockRow = { owner_uid: number; ship_id: string; subject_id: string; display_name: string | null; created_at: number };
type LegacyApproachRow = {
  approach_id: string; owner_uid: number; direction: "incoming" | "outgoing"; origin_id: string;
  remote_ship_id: string; remote_subject_id: string; remote_display_name: string; local_display_name: string;
  conversation_id: string; contact_id: string; thread_id: string; state: ApproachState; revision: number;
  fingerprint: string; idempotency_key: string | null; metadata_json: string;
  pending_text: string | null; pending_text_bytes: number; message_sequence: number | null; contact_generation: string | null;
  delivery_state: "queued" | "received" | "failed" | "unconfirmed"; attempts: number; next_attempt_at: number | null;
  accepted_at: number | null; created_at: number; updated_at: number; expires_at: number; cleanup_at: number | null;
  ship_handles_messages: number;
};
type LegacyOutboxRow = {
  delivery_id: string; owner_uid: number; contact_id: string; contact_generation: string; idempotency_key: string;
  fingerprint: string; payload_json: string | null; preparation_json: string | null; resource_count: number;
  local_message_json: string | null; local_sequence: number | null;
  state: "preparing" | "preparation_failed" | "pending" | "delivered" | "terminal";
  attempt_count: number; next_attempt_at: number | null; last_error: string | null;
  created_at: number; updated_at: number; delivered_at: number | null; retry_epoch: number; retryable: number;
};
type LegacyInboxRow = {
  contact_id: string; contact_generation: string; delivery_id: string; payload_json: string;
  state: "received" | "committed" | "rejected"; last_error: string | null;
  received_at: number; updated_at: number; committed_at: number | null; attention_recorded: number;
};

const legacyText = z.string().check(z.minLength(1));
/** A request's first message as its sender's Ship named it before DIDs. */
const requestMetadataSchema = z.object({ messageId: legacyText, createdAtMs: z.int() });
/**
 * A message the outbox kept before DIDs. The move reads its author and origin
 * details; the outbox's own schema checks the whole message once it converts.
 */
const legacyLocalMessageSchema = z.looseObject({
  messageId: legacyText,
  author: z.looseObject({ kind: z.string(), pid: z.optional(z.string()) }),
  social: z.optional(socialBeforeDidsSchema),
});
const legacyPreparationSchema = z.looseObject({ threadId: legacyText, localMessage: legacyLocalMessageSchema });
/** A delivery as Ships carried it before DIDs; the delivery schema checks it once it converts. */
const legacyPayloadSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("message"), messageId: legacyText, social: z.optional(socialBeforeDidsSchema) }),
  z.looseObject({ kind: z.literal("contact.revoked") }),
  z.looseObject({ kind: z.literal("request") }),
  z.looseObject({ kind: z.literal("request.update") }),
]);
type LegacyLocalMessage = z.infer<typeof legacyLocalMessageSchema>;
type LegacyPreparation = z.infer<typeof legacyPreparationSchema>;
type LegacyPayload = z.infer<typeof legacyPayloadSchema>;
type LegacyApproach = { row: LegacyApproachRow; firstMessage: z.infer<typeof requestMetadataSchema> };
type LegacyOutboxDelivery = {
  row: LegacyOutboxRow;
  payload: LegacyPayload | null;
  preparation: LegacyPreparation | null;
  localMessage: LegacyLocalMessage | null;
};
type LegacyInboxDelivery = { row: LegacyInboxRow; payload: LegacyPayload };

type ApproachChanges = {
  state: ApproachState; revision: number; deliveryState: LegacyApproachRow["delivery_state"];
  attempts: number; nextAttemptAt: number | null; acceptedAt: number | null; cleanupAt: number | null;
  pendingText: string | null; pendingTextBytes: number; updatedAt: number;
};

/** Each waiting row, already converted; the commit only writes. */
type PreparedMove = {
  contacts: { contactId: string; person: Person }[];
  /** Active contacts the move ends, because they name no one with a DID here. */
  endedContacts: string[];
  blocks: { ownerUid: number; did: string; displayName: string | null; createdAt: number }[];
  approaches: { row: LegacyApproachRow; person: Person; messageId: string; sentAt: number; changes: ApproachChanges }[];
  outbox: {
    row: LegacyOutboxRow; payloadJson: string | null; preparationJson: string | null; localMessageJson: string | null;
    localSequence: number | null; updatedAt: number;
  }[];
  inbox: { row: LegacyInboxRow; payloadJson: string; payloadHash: string; committed: boolean }[];
  /** Accounts whose contacts or requests the move changed. */
  owners: Set<number>;
  moved: MoveCounts;
  ended: MoveCounts;
};

/** Reads the rows that still name people the old way, and writes them under their DIDs. */
export class IdentityMoveStore {
  private readonly sql: SqlStorage;

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
  }

  /** The shipId the Ship's key from before DIDs named it by; null once the move has finished. */
  oldShipId(): string | null {
    return this.storage.kv.get<{ document: { shipId: string } }>(OLD_IDENTITY_KEY)?.document.shipId ?? null;
  }

  /** The subject other Ships named an account by. */
  subjectOf(uid: number): string | null {
    return this.sql.exec<{ subject_id: string }>("SELECT subject_id FROM federation_subjects WHERE owner_uid = ?", uid)
      .toArray()[0]?.subject_id ?? null;
  }

  /** Everyone the waiting rows name, once each. */
  references(): OperatorLegacyPerson[] {
    return this.sql.exec<{ ship_id: string; subject_id: string }>(`
      SELECT remote_ship_id AS ship_id, remote_subject_id AS subject_id FROM federation_contacts_legacy
      UNION SELECT ship_id, subject_id FROM federation_actor_blocks_legacy
      UNION SELECT remote_ship_id, remote_subject_id FROM social_approaches_legacy
      ORDER BY ship_id, subject_id`).toArray().map((row) => ({ shipId: row.ship_id, subjectId: row.subject_id }));
  }

  waiting(): OperatorIdentitySurvey["waiting"] {
    return this.sql.exec<OperatorIdentitySurvey["waiting"]>(`SELECT
      (SELECT COUNT(*) FROM federation_contacts_legacy) AS contacts,
      (SELECT COUNT(*) FROM federation_actor_blocks_legacy) AS blocks,
      (SELECT COUNT(*) FROM social_approaches_legacy) AS requests,
      (SELECT COUNT(*) FROM federation_outbox_legacy) + (SELECT COUNT(*) FROM federation_inbox_legacy) AS deliveries`).one();
  }

  /** Active contacts of any account but `personUid`; with no person, all of them. */
  otherAccounts(personUid: number | null): number {
    return this.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM federation_contacts_legacy WHERE state = 'active' AND owner_uid IS NOT ?",
      personUid,
    ).one().count;
  }

  /** Each contact conversation, with the people other than the Ship's own whom its waiting rows name. */
  contactConversations(): Map<string, OldName[]> {
    const conversations = new Map<string, OldName[]>();
    for (const row of this.sql.exec<{ conversation_id: string }>(
      "SELECT conversation_id FROM conversations WHERE kind = 'contact' ORDER BY conversation_id",
    )) conversations.set(row.conversation_id, []);
    for (const row of this.sql.exec<{ conversation_id: string; ship_id: string; subject_id: string }>(`
      SELECT conversation_id, remote_ship_id AS ship_id, remote_subject_id AS subject_id FROM federation_contacts_legacy
      UNION SELECT conversation_id, remote_ship_id, remote_subject_id FROM social_approaches_legacy`)) {
      conversations.get(row.conversation_id)?.push({ shipId: row.ship_id, subjectId: row.subject_id });
    }
    return conversations;
  }

  /** Conversation appends the Kernel may still make for deliveries from before the move. */
  pendingAppends(): { conversationId: string; idempotencyKey: string }[] {
    return this.sql.exec<{ conversation_id: string; idempotency_key: string }>(`
      SELECT c.conversation_id, 'federation:' || i.contact_id || ':' || i.contact_generation || ':' || i.delivery_id AS idempotency_key
        FROM federation_inbox_legacy i JOIN federation_contacts_legacy c ON c.contact_id = i.contact_id
        WHERE i.state = 'received'
      UNION ALL
      SELECT c.conversation_id, 'federation-local:' || o.delivery_id
        FROM federation_outbox_legacy o JOIN federation_contacts_legacy c ON c.contact_id = o.contact_id
        WHERE o.local_sequence IS NULL AND (o.local_message_json IS NOT NULL OR o.preparation_json IS NOT NULL)`,
    ).toArray().map((row) => ({ conversationId: row.conversation_id, idempotencyKey: row.idempotency_key }));
  }

  contacts(): LegacyContactRow[] {
    return this.sql.exec<LegacyContactRow>(
      "SELECT contact_id, owner_uid, state, remote_ship_id, remote_subject_id, thread_id FROM federation_contacts_legacy",
    ).toArray();
  }

  blocks(): LegacyBlockRow[] {
    return this.sql.exec<LegacyBlockRow>(
      "SELECT owner_uid, ship_id, subject_id, display_name, created_at FROM federation_actor_blocks_legacy",
    ).toArray();
  }

  approaches(): LegacyApproach[] {
    return this.sql.exec<LegacyApproachRow>("SELECT * FROM social_approaches_legacy").toArray().map((row) => ({
      row,
      firstMessage: requestMetadataSchema.parse(JSON.parse(row.metadata_json)),
    }));
  }

  outbox(): LegacyOutboxDelivery[] {
    return this.sql.exec<LegacyOutboxRow>("SELECT * FROM federation_outbox_legacy").toArray().map((row) => ({
      row,
      payload: row.payload_json ? legacyPayloadSchema.parse(JSON.parse(row.payload_json)) : null,
      preparation: row.preparation_json ? legacyPreparationSchema.parse(JSON.parse(row.preparation_json)) : null,
      localMessage: row.local_message_json ? legacyLocalMessageSchema.parse(JSON.parse(row.local_message_json)) : null,
    }));
  }

  inbox(): LegacyInboxDelivery[] {
    return this.sql.exec<LegacyInboxRow>("SELECT * FROM federation_inbox_legacy").toArray().map((row) => ({
      row,
      payload: legacyPayloadSchema.parse(JSON.parse(row.payload_json)),
    }));
  }

  /** Writes the prepared rows, empties the legacy tables and forgets the old key. The caller holds the transaction. */
  commit(move: PreparedMove, now: number): void {
    for (const { contactId, person } of move.contacts) {
      this.sql.exec(
        "UPDATE federation_contacts SET remote_did = ?, remote_handle = COALESCE(remote_handle, ?) WHERE contact_id = ? AND remote_did IS NULL",
        person.did, person.handle ?? null, contactId,
      );
    }
    for (const block of move.blocks) {
      this.sql.exec(
        "INSERT OR IGNORE INTO federation_actor_blocks (owner_uid, did, display_name, created_at) VALUES (?, ?, ?, ?)",
        block.ownerUid, block.did, block.displayName, block.createdAt,
      );
    }
    for (const { row, person, messageId, sentAt, changes } of move.approaches) {
      this.sql.exec(`INSERT INTO social_approaches (
        approach_id, owner_uid, direction, request_id, remote_did, remote_handle, remote_display_name, local_display_name,
        conversation_id, contact_id, thread_id, state, revision, fingerprint, idempotency_key, profile_cid, message_id, sent_at,
        pending_text, pending_text_bytes, message_sequence, contact_generation, delivery_state, attempts, next_attempt_at,
        accepted_at, ship_handles_messages, created_at, updated_at, expires_at, cleanup_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.approach_id, row.owner_uid, row.direction, row.origin_id, person.did, person.handle ?? null,
      row.remote_display_name, row.local_display_name, row.conversation_id, row.contact_id, row.thread_id,
      changes.state, changes.revision, row.fingerprint, row.idempotency_key, messageId, sentAt,
      changes.pendingText, changes.pendingTextBytes, row.message_sequence, row.contact_generation, changes.deliveryState,
      changes.attempts, changes.nextAttemptAt, changes.acceptedAt, row.ship_handles_messages, row.created_at,
      changes.updatedAt, row.expires_at, changes.cleanupAt);
    }
    for (const { row, payloadJson, preparationJson, localMessageJson, localSequence, updatedAt } of move.outbox) {
      this.sql.exec(`INSERT INTO federation_outbox (
        delivery_id, owner_uid, contact_id, contact_generation, idempotency_key, fingerprint, payload_json, preparation_json,
        resource_count, local_message_json, local_sequence, state, attempt_count, next_attempt_at, last_error,
        created_at, updated_at, delivered_at, retry_epoch, retryable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.delivery_id, row.owner_uid, row.contact_id, row.contact_generation, row.idempotency_key, row.fingerprint,
      payloadJson, preparationJson, row.resource_count, localMessageJson, localSequence, row.state, row.attempt_count,
      row.next_attempt_at, row.last_error, row.created_at, updatedAt, row.delivered_at, row.retry_epoch, row.retryable);
    }
    for (const { row, payloadJson, payloadHash, committed } of move.inbox) {
      this.sql.exec(`INSERT INTO federation_inbox (
        contact_id, contact_generation, delivery_id, payload_hash, payload_json, state, last_error,
        received_at, updated_at, committed_at, attention_recorded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.contact_id, row.contact_generation, row.delivery_id, payloadHash, payloadJson,
      committed ? "committed" : row.state, row.last_error, row.received_at,
      committed ? now : row.updated_at, committed ? now : row.committed_at, row.attention_recorded);
    }
    for (const table of [
      "federation_contacts_legacy", "federation_actor_blocks_legacy", "social_approaches_legacy",
      "federation_outbox_legacy", "federation_inbox_legacy",
    ]) {
      this.sql.exec(`DELETE FROM ${table}`);
    }
    this.storage.kv.delete(OLD_IDENTITY_KEY);
  }
}

/**
 * The Ship's own old and new names, and everyone its rows still name the old
 * way. A Ship that had contacts gets its DID now, so the move can name it to
 * the people it knows; an active Ship also writes a profile published before
 * profiles were records to its repository, so it stays public.
 */
export async function surveyIdentityMove(ctx: KernelContext, store: IdentityMoveStore, active: boolean): Promise<OperatorIdentitySurvey> {
  return await ctx.coordinateFederationContact(IDENTITY_MOVE_LOCK, async () => {
    const human = ctx.auth.getHumanAccount();
    const shipId = store.oldShipId();
    const subjectId = human ? store.subjectOf(human.uid) : null;
    const references = store.references().filter((person) => person.shipId !== shipId || person.subjectId !== subjectId);
    if (references.length > MAX_IDENTITY_MOVE_PEOPLE) throw new Error(`This Ship names more than ${MAX_IDENTITY_MOVE_PEOPLE} people the old way`);
    let person: OperatorPersonDid | null = null;
    if (shipId && subjectId) {
      const account = await withHostTimeout(ctx, async (timed) => await ensureShipAccount(timed));
      person = { shipId, subjectId, did: account.did, handle: account.handle };
    }
    if (active && human && profileOwnerActive(human.uid, ctx)) {
      await withHostTimeout(ctx, async (timed) => await publishPendingProfile(human.uid, timed));
    }
    return {
      version: 1,
      installationId: ctx.installationId,
      person,
      references,
      waiting: store.waiting(),
      otherAccounts: store.otherAccounts(human?.uid ?? null),
    };
  });
}

/**
 * Names the people in the Ship's rows by DID, conversations first: once the
 * Kernel's rows move, deliveries resume, and a reply must find the message it
 * answers. Rows naming no one in `people` end: a contact is removed, a request
 * or block dropped, and a request the other person never received expires.
 */
export async function moveIdentities(ctx: KernelContext, store: IdentityMoveStore, people: OperatorPersonDid[]): Promise<OperatorIdentityMove> {
  return await ctx.coordinateFederationContact(IDENTITY_MOVE_LOCK, async () => {
    const shipId = store.oldShipId();
    if (!shipId) return { version: 1, installationId: ctx.installationId, moved: noRows(), ended: noRows() };
    const byOldName = new Map(people.map((person) => [oldName(person), person]));
    const personOf = (name: OldName): Person | undefined => {
      const person = byOldName.get(oldName(name));
      return person && { did: person.did, ...(person.handle ? { handle: person.handle } : undefined) };
    };
    const human = ctx.auth.getHumanAccount();
    const subjectId = human ? store.subjectOf(human.uid) : null;
    const own = subjectId ? byOldName.get(oldName({ shipId, subjectId })) : undefined;
    const ownDid = ctx.shipIdentity.current();
    if (subjectId && (!own || own.did !== ownDid)) throw new Error("The move names this Ship's person with another DID, or none");

    const moved = noRows();
    const ended = noRows();
    const appended = new Map<string, number>();
    const pending = store.pendingAppends();
    const conversations = [...store.contactConversations()];
    for (let index = 0; index < conversations.length; index += CONVERSATION_BATCH) {
      await Promise.all(conversations.slice(index, index + CONVERSATION_BATCH).map(async ([conversationId, remotes]) => {
        const named = remotes.flatMap((name) => byOldName.get(oldName(name)) ?? []);
        const result = await getConversationById(ctx.installationId, conversationId).moveToDids({
          people: own ? [own, ...named] : named,
          idempotencyKeys: pending.filter((entry) => entry.conversationId === conversationId).map((entry) => entry.idempotencyKey),
        });
        moved.messages += result.moved;
        ended.messages += result.ended;
        for (const entry of result.appended) appended.set(entry.idempotencyKey, entry.sequence);
      }));
    }

    const now = Date.now();
    // Only the Ship's person has a DID, so another account's rows end.
    const person = own && human ? { uid: human.uid, did: own.did } : null;
    const prepared = await prepareMove(store, { personOf, person, appended, now }, { moved, ended });
    ctx.federation.transaction(() => {
      for (const contactId of prepared.endedContacts) {
        const contact = ctx.federation.get(contactId);
        if (contact?.state === "active") revokeFederationContact(contact, now, ctx);
      }
      store.commit(prepared, now);
    });
    for (const ownerUid of prepared.owners) {
      ctx.broadcastToUserUid(ownerUid, "contact.changed");
      ctx.broadcastToUserUid(ownerUid, "approach.changed");
    }
    return { version: 1, installationId: ctx.installationId, moved: prepared.moved, ended: prepared.ended };
  });
}

type MoveNames = {
  personOf: (name: OldName) => Person | undefined;
  /** The Ship's person, the only account whose rows move; null when it has no DID. */
  person: { uid: number; did: string } | null;
  /** Appends that already reached a message, by idempotency key. */
  appended: ReadonlyMap<string, number>;
  now: number;
};

async function prepareMove(store: IdentityMoveStore, names: MoveNames, counts: { moved: MoveCounts; ended: MoveCounts }): Promise<PreparedMove> {
  const { moved, ended } = counts;
  const move: PreparedMove = {
    contacts: [], endedContacts: [], blocks: [], approaches: [], outbox: [], inbox: [], owners: new Set(), moved, ended,
  };
  const personOwnedBy = (ownerUid: number, name: OldName) => ownerUid === names.person?.uid ? names.personOf(name) : undefined;
  const didOf = (name: OldName) => names.personOf(name)?.did;

  const contacts = new Map<string, { did: string; threadId: string }>();
  for (const row of store.contacts()) {
    move.owners.add(row.owner_uid);
    const person = personOwnedBy(row.owner_uid, { shipId: row.remote_ship_id, subjectId: row.remote_subject_id });
    if (person) {
      move.contacts.push({ contactId: row.contact_id, person });
      contacts.set(row.contact_id, { did: person.did, threadId: row.thread_id });
      moved.contacts += 1;
    } else if (row.state === "active") {
      move.endedContacts.push(row.contact_id);
      ended.contacts += 1;
    }
  }

  for (const row of store.blocks()) {
    const person = personOwnedBy(row.owner_uid, { shipId: row.ship_id, subjectId: row.subject_id });
    if (!person) {
      ended.blocks += 1;
      continue;
    }
    move.blocks.push({ ownerUid: row.owner_uid, did: person.did, displayName: row.display_name, createdAt: row.created_at });
    moved.blocks += 1;
  }

  for (const { row, firstMessage } of store.approaches()) {
    move.owners.add(row.owner_uid);
    const person = personOwnedBy(row.owner_uid, { shipId: row.remote_ship_id, subjectId: row.remote_subject_id });
    if (!person) {
      ended.requests += 1;
      continue;
    }
    const changes = approachAfterMove(row, contacts.has(row.contact_id), names.now);
    move.approaches.push({ row, person, messageId: firstMessage.messageId, sentAt: firstMessage.createdAtMs, changes });
    if (changes.state === "expired" && row.state !== "expired") ended.requests += 1;
    else moved.requests += 1;
  }

  for (const { row, payload, preparation, localMessage } of store.outbox()) {
    const contact = contacts.get(row.contact_id);
    if (!contact || !names.person) {
      ended.deliveries += 1;
      continue;
    }
    const origin = { threadId: contact.threadId, author: names.person.did, didOf };
    const localSequence = row.local_sequence ?? names.appended.get(`federation-local:${row.delivery_id}`) ?? null;
    move.outbox.push({
      row,
      payloadJson: payload ? JSON.stringify(payloadAfterMove(payload, origin)) : null,
      preparationJson: preparation ? JSON.stringify(preparationAfterMove(preparation, origin)) : null,
      localMessageJson: localMessage ? JSON.stringify(localMessageAfterMove(localMessage, origin)) : null,
      localSequence,
      updatedAt: localSequence === row.local_sequence ? row.updated_at : names.now,
    });
    moved.deliveries += 1;
  }

  for (const { row, payload: legacy } of store.inbox()) {
    const contact = contacts.get(row.contact_id);
    if (!contact) {
      ended.deliveries += 1;
      continue;
    }
    const payload = payloadAfterMove(legacy, { threadId: contact.threadId, author: contact.did, didOf });
    move.inbox.push({
      row,
      payloadJson: JSON.stringify(payload),
      payloadHash: await federationPayloadHash(payload),
      committed: row.state === "received"
        && names.appended.has(`federation:${row.contact_id}:${row.contact_generation}:${row.delivery_id}`),
    });
    moved.deliveries += 1;
  }
  return move;
}

/**
 * A request keeps its state, with two exceptions. One its sender's Ship never
 * delivered expires, and its sender sees that. One its recipient was accepting
 * accepts again over DIDs, unless the connection it made has already moved.
 */
function approachAfterMove(row: LegacyApproachRow, contactMoved: boolean, now: number): ApproachChanges {
  const kept: ApproachChanges = {
    state: row.state, revision: row.revision, deliveryState: row.delivery_state, attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at, acceptedAt: row.accepted_at, cleanupAt: row.cleanup_at,
    pendingText: row.pending_text, pendingTextBytes: row.pending_text_bytes, updatedAt: row.updated_at,
  };
  const unsettled = row.state === "preparing" || row.state === "pending" || row.state === "accepting";
  if (row.direction === "outgoing" && unsettled && row.delivery_state !== "received") {
    return {
      ...kept, state: "expired", revision: row.revision + 1, nextAttemptAt: null, pendingText: null, pendingTextBytes: 0,
      cleanupAt: now + APPROACH_RECEIPT_MS, updatedAt: now,
    };
  }
  if (row.direction === "incoming" && row.state === "accepting") {
    if (row.contact_generation && contactMoved) {
      return {
        ...kept, state: "accepted", revision: row.revision + 1, deliveryState: "received", attempts: 0, nextAttemptAt: null,
        acceptedAt: row.accepted_at ?? now, pendingText: null, pendingTextBytes: 0, cleanupAt: now + APPROACH_RECEIPT_MS, updatedAt: now,
      };
    }
    return { ...kept, attempts: 0, nextAttemptAt: now, updatedAt: now };
  }
  return kept;
}

/** Who a message's origin details name: its author, and anyone it replies to, by DID. */
type OriginNames = { threadId: string; author: string; didOf: (name: OldName) => string | undefined };

/**
 * A Ship of the first version named no origin for a message, and so said
 * nothing about who wrote it. Its delivery reads as its person's on both
 * Ships, so each one's copy still matches the other's.
 */
const UNNAMED_AUTHOR: SocialMessageProvenance = { kind: "human" };

/** A delivery as Ships now carry it: a message names its origin by DID, and a removal no longer repeats its generation. */
function payloadAfterMove(legacy: LegacyPayload, origin: OriginNames): FederationDeliveryPayload {
  if (legacy.kind === "contact.revoked") return { kind: "contact.revoked" };
  if (legacy.kind !== "message") return federationDeliveryPayloadSchema.parse(legacy);
  const { social, ...message } = legacy;
  return federationDeliveryPayloadSchema.parse({ ...message, social: socialAfterMove(social, message.messageId, origin, UNNAMED_AUTHOR) });
}

function localMessageAfterMove(legacy: LegacyLocalMessage, origin: OriginNames): FederationOutboxLocalMessage {
  const { social, ...message } = legacy;
  return federationOutboxLocalMessageSchema.parse({
    ...message,
    social: socialAfterMove(social, message.messageId, origin, provenanceOf(message.author)),
  });
}

function preparationAfterMove(legacy: LegacyPreparation, origin: OriginNames): FederationMessagePreparation {
  return federationMessagePreparationSchema.parse({
    ...legacy,
    localMessage: localMessageAfterMove(legacy.localMessage, { ...origin, threadId: legacy.threadId }),
  });
}

/**
 * Origin details naming their author by DID. Details from before DIDs keep
 * their thread, message and provenance, and a reply keeps its link only to
 * someone with a DID here. A message whose Ship named no origin gets one.
 */
function socialAfterMove(
  legacy: SocialBeforeDids | undefined,
  messageId: string,
  origin: OriginNames,
  unnamed: SocialMessageProvenance,
): SocialMessageMetadata {
  if (!legacy) {
    return socialMessageMetadataSchema.parse({
      threadId: origin.threadId,
      reference: { did: origin.author, messageId },
      provenance: unnamed,
    });
  }
  const repliedTo = legacy.replyTo ? origin.didOf(legacy.replyTo.actor) : undefined;
  return socialMessageMetadataSchema.parse({
    threadId: legacy.threadId,
    reference: { did: origin.author, messageId: legacy.reference.messageId },
    provenance: legacy.provenance,
    ...(legacy.replyTo && repliedTo ? { replyTo: { did: repliedTo, messageId: legacy.replyTo.messageId } } : undefined),
  });
}

function provenanceOf(author: LegacyLocalMessage["author"]): SocialMessageProvenance {
  return author.kind === "process" && author.pid ? { kind: "process", processId: author.pid } : { kind: "human" };
}

function noRows(): MoveCounts {
  return { contacts: 0, blocks: 0, requests: 0, deliveries: 0, messages: 0 };
}

function oldName(name: OldName): string {
  return `${name.shipId} ${name.subjectId}`;
}

/** Bounds the open-network host's answers during the survey; the timer ends with them, so it can't hold the Kernel awake. */
async function withHostTimeout<T>(ctx: KernelContext, use: (timed: KernelContext) => Promise<T>): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("The open-network host took too long to answer")), HOST_TIMEOUT_MS);
  try {
    return await use({ ...ctx, requestSignal: ctx.requestSignal ? AbortSignal.any([ctx.requestSignal, timeout.signal]) : timeout.signal });
  } finally {
    clearTimeout(timer);
  }
}
