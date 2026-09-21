import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { FederationStore } from "../federation-store";
import { ResponsibilityStore } from "../responsibility-store";
import { ResponsibilitySourcePolicyStore } from "../responsibility-source-policies";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

describe("social attention cutover", () => {
  it("preserves admitted work and previous preferences while removing implicit social sources", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 56));
      sql.exec(`INSERT INTO responsibility_source_policies (owner_uid, source_id, enabled, updated_at)
        VALUES (1000, 'contact.added', 0, 1), (1000, 'federation.received', 1, 1),
          (1001, 'federation.received', 0, 1), (1000, 'mail.received', 0, 1)`);
      const responsibilities = new ResponsibilityStore(storage);
      const accepted = responsibilities.create({
        ownerUid: 1000, title: "Already accepted work", state: "active", priority: "normal",
        source: { kind: "event", eventType: "federation.request", eventId: "delivery:accepted" },
        assignee: { kind: "ship" }, actor: { kind: "system", component: "federation.request" },
        observedByShip: false, now: 1,
      });
      const previous = responsibilities.list({ ownerUid: 1000, includeTerminal: true });
      const transitions = responsibilities.changes(1000, 0);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      expect(accepted.created).toBe(true);
      expect(responsibilities.list({ ownerUid: 1000, includeTerminal: true })).toEqual(previous);
      expect(responsibilities.changes(1000, 0)).toEqual(transitions);
      const federation = new FederationStore(storage);
      expect(federation.attentionNotice(1000)).toEqual({ previousContactAdded: false, previousReceived: true });
      expect(federation.attentionNotice(1001)).toEqual({ previousContactAdded: true, previousReceived: false });
      expect(federation.attentionNotice(1002)).toBeUndefined();
      const policies = new ResponsibilitySourcePolicyStore(sql);
      expect(policies.isEnabled(1000, "mail.received")).toBe(false);
      expect(policies.list(1000).map((policy) => policy.id)).not.toContain("federation.received");
      expect(policies.list(1000).map((policy) => policy.id)).not.toContain("contact.added");

      expect(federation.dismissAttentionNotice(1000)).toBe(true);
      expect(federation.dismissAttentionNotice(1000)).toBe(false);
      expect(federation.attentionNotice(1000)).toBeUndefined();
      expect(federation.attentionNotice(1001)).toBeDefined();
      expect(sql.exec<{ previous_received: number }>("SELECT previous_received FROM federation_attention_notices WHERE owner_uid = 1000").one().previous_received).toBe(1);
    });
  });
});
