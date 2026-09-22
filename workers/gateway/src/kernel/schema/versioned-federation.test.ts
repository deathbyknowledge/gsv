import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { FederationStore } from "../federation-store";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("federation wire version upgrade", () => {
  it("preserves pinned contacts and pending v1 deliveries without inventing v2 provenance", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 55));
      const payload = { kind: "message", messageId: "message:old", threadId: "thread:old", text: "Before upgrade" };
      sql.exec(`INSERT INTO federation_contacts (
        contact_id, owner_uid, state, generation, remote_ship_id, remote_subject_id, remote_display_name,
        remote_origin, remote_public_key_json, shared_secret, conversation_id, thread_id, created_at, updated_at
      ) VALUES ('contact:old', 1000, 'active', 'generation:old', 'ship:remote', 'subject:remote', 'Remote',
        'https://remote.example', ?, 'fixture-secret', 'conv:old', 'thread:old', 1, 2)`,
      JSON.stringify({ kty: "EC", crv: "P-256", x: "remote-x", y: "remote-y" }));
      sql.exec(`INSERT INTO federation_outbox (
        delivery_id, owner_uid, contact_id, contact_generation, idempotency_key, fingerprint,
        payload_json, state, created_at, updated_at
      ) VALUES ('delivery:out', 1000, 'contact:old', 'generation:old', 'key:old', 'hash:old', ?, 'pending', 1, 2)`, JSON.stringify(payload));
      sql.exec(`INSERT INTO federation_inbox (
        contact_id, contact_generation, delivery_id, payload_hash, payload_json, state, received_at, updated_at
      ) VALUES ('contact:old', 'generation:old', 'delivery:in', 'hash:old', ?, 'received', 1, 2)`, JSON.stringify(payload));
      const localMessage = {
        messageId: "message:preparing", text: "Still preparing",
        author: { kind: "user", uid: 1000 }, origin: { kind: "client", clientId: "client:old" }, createdAtMs: 1,
      };
      const preparation = { kind: "message", messageId: localMessage.messageId, text: localMessage.text, threadId: "thread:old", resources: [], localMessage };
      sql.exec(`INSERT INTO federation_outbox (
        delivery_id, owner_uid, contact_id, contact_generation, idempotency_key, fingerprint,
        preparation_json, state, created_at, updated_at
      ) VALUES ('delivery:preparing', 1000, 'contact:old', 'generation:old', 'key:preparing', 'hash:preparing', ?, 'preparing', 1, 2)`, JSON.stringify(preparation));

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      const store = new FederationStore(storage);
      expect(store.get("contact:old")).toMatchObject({
        generation: "generation:old", sharedSecret: "fixture-secret", conversationId: "conv:old", threadId: "thread:old",
      });
      expect(store.get("contact:old")?.protocol).toBeUndefined();
      expect(store.outbox("delivery:out")).toMatchObject({ wireVersion: 1, payload, state: "pending" });
      expect(store.inbox("contact:old", "generation:old", "delivery:in")).toMatchObject({ wireVersion: 1, payload, state: "received" });
      expect(store.outbox("delivery:preparing")).toMatchObject({ wireVersion: 1, state: "preparing", preparation });
    });
  });
});
