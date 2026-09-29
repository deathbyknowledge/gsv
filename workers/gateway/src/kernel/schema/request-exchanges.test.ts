import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { FederationStore } from "../federation-store";
import { assertRequestTransition } from "../federation/requests";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("request exchange upgrade", () => {
  it.each(["pending", "delivered", "terminal"] as const)("restores retained %s outbound exchange identities", async (state) => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 53));
      for (const direction of ["incoming", "outgoing"]) {
        const id = `request:${direction}`;
        const payload = direction === "outgoing"
          ? { kind: "request", request: { id, state: "offered", revision: 1 } }
          : { kind: "request.update", requestId: "request:remote", state: "accepted", expectedRevision: 1 };
        sql.exec(`INSERT INTO federation_requests (
          request_id, remote_request_id, contact_id, contact_generation, direction, kind, title, state, revision, created_at, updated_at
        ) VALUES (?, 'request:remote', 'contact:old', 'generation:old', ?, 'task', 'Work', ?, ?, 1, 2)`,
        id, direction, direction === "outgoing" ? "offered" : "accepted", direction === "outgoing" ? 1 : 2);
        sql.exec(`INSERT INTO federation_outbox (
          delivery_id, owner_uid, contact_id, contact_generation, idempotency_key, fingerprint, payload_json, state, created_at, updated_at
        ) VALUES (?, 1000, 'contact:old', 'generation:old', ?, 'hash', ?, ?, 2, 3)`,
        `delivery:${direction}`, direction, JSON.stringify(payload), state);
      }
      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      const store = new FederationStore(storage);
      for (const direction of ["incoming", "outgoing"]) {
        const request = store.request(`request:${direction}`)!;
        expect(request.exchange).toMatchObject({ source: "local", deliveryId: `delivery:${direction}`,
          state: state === "delivered" ? "acknowledged" : state === "terminal" ? "failed" : "pending" });
        const advance = () => assertRequestTransition(request, direction === "outgoing" ? "cancelled" : "completed");
        if (state === "delivered") expect(advance).not.toThrow();
        else expect(advance).toThrow("has not been confirmed");
      }
    });
  });

  it("preserves old request states without inventing a remote confirmation", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 53));
      sql.exec(`INSERT INTO federation_requests (
        request_id, contact_id, contact_generation, direction, kind, title, state, revision, created_at, updated_at
      ) VALUES ('request:old', 'contact:old', 'generation:old', 'outgoing', 'task', 'Old work', 'completed', 3, 1, 2)`);
      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      expect(new FederationStore(storage).request("request:old")).toMatchObject({
        state: "completed", revision: 3, createdAtMs: 1, updatedAtMs: 2,
        exchange: { state: "unconfirmed" },
      });
    });
  });
});
