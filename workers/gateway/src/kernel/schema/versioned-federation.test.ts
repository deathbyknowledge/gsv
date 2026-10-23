import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { FederationStore } from "../federation-store";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("contacts move to DIDs", () => {
  it("keeps each contact's conversation and parks its old Ship address until the move names its DID", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 73));
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
