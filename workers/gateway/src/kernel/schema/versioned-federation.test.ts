import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { APPROACH_LIFETIME_MS, ApproachStore } from "../approach-store";
import { FederationStore } from "../federation-store";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

const STORAGE_BEFORE_DIDS = [
  "federation_contacts_legacy", "federation_actor_blocks_legacy", "federation_outbox_legacy", "federation_inbox_legacy",
  "social_approaches_legacy", "federation_subjects",
];

function storageBeforeDids(sql: SqlStorage): string[] {
  return sql.exec<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${STORAGE_BEFORE_DIDS.map(() => "?").join(", ")})`,
    ...STORAGE_BEFORE_DIDS,
  ).toArray().map((row) => row.name);
}

describe("contacts from before DIDs", () => {
  it("ends a contact the move never named and keeps its conversation", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 74));
      sql.exec(`INSERT INTO federation_invites (
        invite_id, owner_uid, token_hash, issuing_ship_id, issuing_origin, state, expires_at, created_at
      ) VALUES ('invite:old', 1000, 'token:old', 'ship:local', 'https://local.example', 'issued', 9999999999999, 1)`);
      sql.exec(`INSERT INTO federation_contacts (
        contact_id, owner_uid, state, generation, remote_ship_id, remote_subject_id, remote_display_name, local_alias,
        remote_origin, remote_public_key_json, shared_secret, conversation_id, thread_id, created_at, updated_at,
        saved, muted, ship_handles_messages, policy_revision
      ) VALUES ('contact:old', 1000, 'active', 'generation:old', 'ship:remote', 'subject:remote', 'Remote', 'Rem',
        'https://remote.example', '{}', 'fixture-secret', 'conv:old', 'thread:old', 1, 2, 1, 1, 1, 4)`);
      sql.exec(`INSERT INTO federation_resource_grants (resource_id, contact_id, contact_generation, source_ref_json, source_uid, created_at)
        VALUES ('resource:old', 'contact:old', 'generation:old', '{}', 1000, 1)`);
      sql.exec(`INSERT INTO federation_actor_blocks (owner_uid, ship_id, subject_id, display_name, created_at)
        VALUES (1000, 'ship:blocked', 'subject:blocked', 'Blocked', 3)`);
      sql.exec(`INSERT INTO federation_outbox (
        delivery_id, owner_uid, contact_id, contact_generation, idempotency_key, fingerprint,
        payload_json, state, created_at, updated_at
      ) VALUES ('delivery:out', 1000, 'contact:old', 'generation:old', 'key:old', 'hash:old', ?, 'pending', 1, 2)`,
      JSON.stringify({ kind: "message", messageId: "message:old", threadId: "thread:old", text: "Before DIDs" }));

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      const store = new FederationStore(storage);
      const contact = store.get("contact:old");
      expect(contact).toMatchObject({
        state: "revoked", generation: "generation:old", remoteName: "Remote", localAlias: "Rem",
        conversationId: "conv:old", threadId: "thread:old",
        preferences: { saved: true, muted: true, shipHandlesMessages: false, revision: 5 },
      });
      expect(contact?.remoteDid).toBeUndefined();
      expect(contact?.revokedAtMs).toBeGreaterThan(2);
      expect(sql.exec("SELECT resource_id FROM federation_resource_grants").toArray()).toEqual([]);
      expect(store.outbox("delivery:out")).toBeNull();
      // Codes issued before DIDs lapse.
      expect(store.invite("invite:old")).toBeNull();
      expect(storageBeforeDids(sql)).toEqual([]);
    });
  });

  it("keeps the contacts the move named or ended, and refuses an active contact without a DID", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 77));
      const did = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
      sql.exec(`INSERT INTO federation_contacts (
        contact_id, owner_uid, state, generation, remote_did, remote_name, remote_handle, local_alias,
        conversation_id, thread_id, created_at, updated_at, revoked_at, saved, muted, ship_handles_messages, policy_revision
      ) VALUES
        ('contact:moved', 1000, 'active', 'generation:moved', ?, 'Moved', 'moved.ship.space', NULL,
          'conv:moved', 'thread:moved', 1, 2, NULL, 1, 0, 1, 3),
        ('contact:ended', 1000, 'revoked', 'generation:ended', NULL, 'Ended', NULL, 'End',
          'conv:ended', 'thread:ended', 1, 5, 5, 0, 1, 0, 6)`, did);
      const before = sql.exec("SELECT * FROM federation_contacts ORDER BY contact_id").toArray();

      runKernelSqlMigrations(storage);
      expect(sql.exec("SELECT * FROM federation_contacts ORDER BY contact_id").toArray()).toEqual(before);
      const store = new FederationStore(storage);
      expect(store.get("contact:moved")).toMatchObject({ state: "active", remoteDid: did, remoteHandle: "moved.ship.space" });
      expect(store.get("contact:ended")).toMatchObject({ state: "revoked", remoteName: "Ended", conversationId: "conv:ended" });
      expect(store.get("contact:ended")?.remoteDid).toBeUndefined();
      expect(() => sql.exec("UPDATE federation_contacts SET state = 'active' WHERE contact_id = 'contact:ended'")).toThrow(/CHECK/);
      expect(sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'federation_contacts'
        AND name NOT LIKE 'sqlite_%'`).toArray().map((row) => row.name)).toEqual(["federation_contacts_owner_state_idx"]);
    });
  });

  it("has nothing to drop on a Ship that never had contacts", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runKernelSqlMigrations(storage);
      expect(storageBeforeDids(sql)).toEqual([]);
      expect(sql.exec("SELECT COUNT(*) AS count FROM federation_contacts").one().count).toBe(0);
    });
  });
});

describe("message requests from before DIDs", () => {
  it("drops each request that named a Ship address, and takes new requests by DID", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 76));
      sql.exec(`INSERT INTO social_approaches (
        approach_id, owner_uid, direction, origin_ship_id, origin_subject_id, origin_id, remote_ship_id, remote_subject_id,
        remote_origin, remote_public_key_json, remote_display_name, local_display_name, conversation_id, contact_id, thread_id,
        state, fingerprint, metadata_json, pending_text, pending_text_bytes, setup_token_hash, delivery_state,
        next_attempt_at, created_at, updated_at, expires_at
      ) VALUES ('approach:old', 1000, 'outgoing', 'ship:local', 'subject:local', 'approach:origin', 'ship:remote', 'subject:remote',
        'https://remote.example', '{}', 'Remote', 'Local', 'conv:old', 'contact:old', 'thread:old',
        'pending', 'hash:old', '{}', 'Before DIDs', 11, 'token:old', 'queued', 1, 1, 2, 9999999999999)`);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      expect(storageBeforeDids(sql)).toEqual([]);
      const requests = new ApproachStore(storage);
      expect(requests.get("approach:old")).toBeNull();
      expect(requests.due()).toEqual([]);
      expect(sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'social_approaches'
        AND name NOT LIKE 'sqlite_%' ORDER BY name`).toArray().map((row) => row.name)).toEqual([
        "social_approaches_cleanup", "social_approaches_conversation", "social_approaches_expiry", "social_approaches_generation",
        "social_approaches_inbox", "social_approaches_recovery", "social_approaches_unresolved_peer",
      ]);

      const did = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
      const now = Date.now();
      const received = requests.prepare({
        ownerUid: 1000, direction: "incoming", remoteDid: did, remoteDisplayName: "Visitor", localDisplayName: "Local",
        conversationId: "conv:new", contactId: "contact:new", threadId: "thread:new",
        content: {
          requestId: "request:new", profileCid: "bafyprofile", name: "Visitor", messageId: "msg:new",
          text: "By DID", createdAtMs: now, expiresAtMs: now + APPROACH_LIFETIME_MS,
        },
        fingerprint: "hash:new",
      }, () => {});
      expect(requests.unresolved(1000, did)?.summary.id).toBe(received.summary.id);
    });
  });
});
