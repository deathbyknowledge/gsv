import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { APPROACH_LIFETIME_MS, ApproachStore } from "../approach-store";
import { FederationStore } from "../federation-store";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("contacts move to DIDs", () => {
  it("keeps each contact's conversation and parks its old Ship address until the move names its DID", async () => {
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
      sql.exec(`INSERT INTO federation_actor_blocks (owner_uid, ship_id, subject_id, display_name, created_at)
        VALUES (1000, 'ship:blocked', 'subject:blocked', 'Blocked', 3)`);
      sql.exec(`INSERT INTO federation_outbox (
        delivery_id, owner_uid, contact_id, contact_generation, idempotency_key, fingerprint,
        payload_json, state, created_at, updated_at
      ) VALUES ('delivery:out', 1000, 'contact:old', 'generation:old', 'key:old', 'hash:old', ?, 'pending', 1, 2)`,
      JSON.stringify({ kind: "message", messageId: "message:old", threadId: "thread:old", text: "Before the move" }));
      sql.exec(`INSERT INTO federation_reply_waits (contact_id, contact_generation, message_id, ship_id, subject_id, responsibility_id)
        VALUES ('contact:old', 'generation:old', 'message:mine', 'ship:local', 'subject:local', 'r12y:waiting')`);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      const store = new FederationStore(storage);
      const contact = store.get("contact:old");
      expect(contact).toMatchObject({
        state: "active", generation: "generation:old", remoteName: "Remote", localAlias: "Rem",
        conversationId: "conv:old", threadId: "thread:old",
        preferences: { saved: true, muted: true, shipHandlesMessages: true, revision: 4 },
      });
      expect(contact?.remoteDid).toBeUndefined();
      expect(store.awaitingMove()).toBe(true);
      expect(sql.exec("SELECT remote_ship_id, remote_subject_id FROM federation_contacts_legacy").toArray())
        .toEqual([{ remote_ship_id: "ship:remote", remote_subject_id: "subject:remote" }]);
      expect(sql.exec("SELECT ship_id, display_name FROM federation_actor_blocks_legacy").toArray())
        .toEqual([{ ship_id: "ship:blocked", display_name: "Blocked" }]);
      expect(sql.exec("SELECT delivery_id FROM federation_outbox_legacy").toArray()).toEqual([{ delivery_id: "delivery:out" }]);
      expect(store.outbox("delivery:out")).toBeNull();
      // Codes issued before DIDs lapse.
      expect(store.invite("invite:old")).toBeNull();
      expect(sql.exec("SELECT message_id, responsibility_id FROM federation_reply_waits").toArray())
        .toEqual([{ message_id: "message:mine", responsibility_id: "r12y:waiting" }]);
    });
  });

  it("has nothing to move on a Ship that never had contacts", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      await storage.deleteAll();
      runKernelSqlMigrations(storage);
      expect(new FederationStore(storage).awaitingMove()).toBe(false);
    });
  });
});

describe("message requests move to DIDs", () => {
  it("parks each request that named a Ship address until the move names its DID, and takes new requests by DID", async () => {
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
        'pending', 'hash:old', '{}', 'Before the move', 15, 'token:old', 'queued', 1, 1, 2, 9999999999999)`);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      expect(sql.exec("SELECT approach_id, remote_ship_id, pending_text FROM social_approaches_legacy").toArray())
        .toEqual([{ approach_id: "approach:old", remote_ship_id: "ship:remote", pending_text: "Before the move" }]);
      const requests = new ApproachStore(storage);
      expect(requests.get("approach:old")).toBeNull();
      expect(requests.due()).toEqual([]);
      expect(new FederationStore(storage).awaitingMove()).toBe(true);
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
          text: "After the move", createdAtMs: now, expiresAtMs: now + APPROACH_LIFETIME_MS,
        },
        fingerprint: "hash:new",
      }, () => {});
      expect(requests.unresolved(1000, did)?.summary.id).toBe(received.summary.id);
    });
  });
});
