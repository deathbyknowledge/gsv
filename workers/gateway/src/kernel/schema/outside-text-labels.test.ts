import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { ResponsibilityStore } from "../responsibility-store";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("outside text labels upgrade", () => {
  it("labels stored contact records as outside text and leaves other records alone", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 91));
      const responsibilities = new ResponsibilityStore(storage);
      const record = (title: string, dedupeKey: string, details?: Record<string, string>) => {
        const input: Parameters<typeof responsibilities.create>[0] = {
          ownerUid: 1000, title, state: "open", priority: "normal", dedupeKey,
          source: { kind: "system", component: "test" }, assignee: { kind: "ship" },
          actor: { kind: "system", component: "test" }, observedByShip: false, now: 1,
        };
        if (details) input.details = details;
        return responsibilities.create(input).record.id;
      };
      const handoff = record("Pending messages from Mallory", "contact.handoff:contact:1:1:a", { contactId: "contact:1" });
      const bare = record("Pending messages from Eve", "contact.handoff:contact:2:1:b");
      const request = record("Track contact request request:1", "federation.request:contact:1:request:1", {
        eventType: "federation.request", remoteDisplayName: "Mallory", contentTrust: "local",
      });
      const debt = record("Resolve contact delivery delivery:1", "federation.delivery.failed:delivery:1", {
        eventType: "federation.delivery.failed", error: "Refused by the contact",
      });
      const owned = record("Renew the passport", "owner:passport", { note: "Book an appointment" });

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      const details = (id: string) => responsibilities.get(1000, id)?.details;
      expect(details(handoff)).toEqual({ contactId: "contact:1", contentTrust: "untrusted" });
      expect(details(bare)).toEqual({ contentTrust: "untrusted" });
      expect(details(request)).toEqual({ eventType: "federation.request", remoteDisplayName: "Mallory", contentTrust: "untrusted" });
      expect(details(debt)).toEqual({ eventType: "federation.delivery.failed", error: "Refused by the contact", contentTrust: "untrusted" });
      expect(details(owned)).toEqual({ note: "Book an appointment" });
    });
  });
});
