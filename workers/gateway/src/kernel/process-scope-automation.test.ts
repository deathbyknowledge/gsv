import { describe, expect, it } from "vitest";
import type { ContactSummary, ConversationMessage, ProcessScopePolicy } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ProcessScopeStore } from "./process-scope-store";

const contact: ContactSummary = { id: "contact:auto", ownerUid: 1000, state: "active", generation: "generation:auto", remoteShipId: "ship:remote",
  remoteSubject: { id: "subject:remote", displayName: "Sam" }, remoteOrigin: "https://sam.example", conversationId: "conversation:auto", createdAtMs: 1, updatedAtMs: 1 };
function message(id: string, sequence: number, now: number): ConversationMessage {
  return { id, sequence, conversationId: contact.conversationId, createdAt: now, text: "An incoming human message",
    author: { kind: "contact", contactId: contact.id, shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id, displayName: "Sam" },
    origin: { kind: "federation", contactId: contact.id, deliveryId: `delivery:${id}` },
    social: { reference: { actor: { shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id }, messageId: id }, threadId: "thread:auto", provenance: { kind: "human" } } };
}
const policy = (now: number): ProcessScopePolicy => ({ conversations: [{ contactId: contact.id, conversationId: contact.conversationId, generation: contact.generation, read: true, send: true }],
  resources: [], materials: [], expiresAtMs: now + 3_600_000, budgets: { processes: 1, generations: 16, messages: 2 },
  automatic: { mode: "reply", request: "Help with messages in this conversation", maxMessages: 2, intervalSeconds: 60 } });

describe("bounded automatic message admission", () => {
  it("admits only new human messages and retains exact causes across reload and retries", async () => {
    await runWithRealKernelSql((sql, storage) => {
      const now = Date.now();
      const scopes = new ProcessScopeStore(sql);
      const scope = storage.transactionSync(() => {
        const created = scopes.create(1000, "proc:auto", policy(now), now);
        scopes.automation.register(created, 5, now);
        return created;
      });
      const incoming = message("incoming:one", 6, now + 1);
      expect(scopes.automation.admit(contact, { ...incoming, social: undefined }, now)).toEqual([]);
      expect(scopes.automation.admit(contact, { ...incoming, social: { ...incoming.social!, provenance: { kind: "process", processId: "proc:remote" } } }, now)).toEqual([]);
      expect(scopes.automation.admit(contact, message("before", 5, now), now)).toEqual([]);
      expect(scopes.automation.admit({ ...contact, generation: "generation:new" }, incoming, now)).toEqual([]);
      expect(scopes.automation.admit({ ...contact, preferences: { saved: true, muted: true, notifications: "notify", revision: 1 } }, incoming, now)).toEqual([]);
      expect(storage.transactionSync(() => scopes.automation.admit(contact, incoming, now))).toEqual(["proc:auto"]);
      const restored = new ProcessScopeStore(sql);
      expect(restored.automation.admit(contact, incoming, now)).toEqual([]);
      expect(restored.get(scope.id, now)?.automation).toMatchObject({ acceptedMessages: 1, pendingMessages: 1 });
      const queued = restored.automation.due(now)[0];
      expect(queued).toMatchObject({ message_id: incoming.id, message_sequence: 6 });
      expect(() => restored.automation.claimReply(scope.id, incoming.social!.reference, "effect:early")).toThrow("admitted");
      restored.automation.reserveAdmission(queued, 60, now);
      expect(restored.automation.due(now + 59_000)).toHaveLength(0);
      restored.automation.admitted(queued, policy(now).automatic!, now);
      storage.transactionSync(() => restored.automation.claimReply(scope.id, incoming.social!.reference, "effect:one"));
      storage.transactionSync(() => restored.automation.claimReply(scope.id, incoming.social!.reference, "effect:one"));
      expect(() => storage.transactionSync(() => restored.automation.claimReply(scope.id, incoming.social!.reference, "effect:two"))).toThrow("already replied");
      expect(() => restored.automation.claimReply(scope.id, message("unadmitted", 8, now).social!.reference, "effect:other")).toThrow("admitted");
      storage.transactionSync(() => restored.revoke(scope.id, 1000, 1));
      expect(restored.automation.admit(contact, message("after-revoke", 8, now + 1), now + 1)).toEqual([]);
    });
  });

  it("processes already accepted messages at the allowance boundary and requires fresh consent for replacement", async () => {
    await runWithRealKernelSql((sql, storage) => {
      const now = Date.now();
      const scopes = new ProcessScopeStore(sql);
      const scope = storage.transactionSync(() => {
        const created = scopes.create(1000, "proc:auto", policy(now), now);
        scopes.automation.register(created, 0, now);
        return created;
      });
      for (let index = 1; index <= 3; index++) storage.transactionSync(() => scopes.automation.admit(contact, message(`incoming:${index}`, index, now + 1), now));
      expect(scopes.automation.due(now)).toHaveLength(2);
      expect(scopes.get(scope.id, now)?.automation).toMatchObject({ acceptedMessages: 2, pendingMessages: 2 });
      const first = scopes.automation.due(now)[0];
      scopes.automation.admitted(first, policy(now).automatic!, now);
      const second = scopes.automation.due(now + 60_001)[0];
      scopes.automation.admitted(second, policy(now).automatic!, now + 60_001);
      expect(scopes.get(scope.id, now)?.automation).toMatchObject({ pendingMessages: 0, pausedReason: "message allowance used" });
      expect(() => storage.transactionSync(() => {
        const replacement = scopes.create(1000, "proc:second", policy(now), now);
        scopes.automation.register(replacement, 3, now);
      })).toThrow("Stop the existing");
      storage.transactionSync(() => scopes.revoke(scope.id, 1000, 1));
      expect(() => storage.transactionSync(() => {
        const replacement = scopes.create(1000, "proc:second", policy(now), now);
        scopes.automation.register(replacement, 3, now);
      })).not.toThrow();
    });
  });
});
