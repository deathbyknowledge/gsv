import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage, ProcessIdentity, ProcessScopePolicy } from "@humansandmachines/gsv/protocol";
import * as utils from "../shared/utils";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { AuthStore } from "./auth-store";
import { CapabilityStore } from "./capabilities";
import { FederationStore } from "./federation-store";
import { ProcessRegistry } from "./processes";
import type { KernelContext } from "./context";
import { processScopeMessages } from "./process-scope-runtime";

const owner: ProcessIdentity = { uid: 1000, gid: 1000, gids: [1000], username: "owner", home: "/home/owner", cwd: "/home/owner" };

describe("scoped incoming-message delivery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries one exact Process event after an uncertain response, then honors revocation", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const auth = new AuthStore(sql);
      auth.addUser({ ...owner, gecos: "Owner", shell: "/bin/init" });
      const caps = new CapabilityStore(sql);
      caps.grant(owner.gid, "*");
      const procs = new ProcessRegistry(sql);
      const federation = new FederationStore(storage);
      const contact = federation.activateContact({ ownerUid: owner.uid, remoteShipId: "ship:remote", remoteSubject: { id: "subject:remote", displayName: "Sam" },
        remoteOrigin: "https://sam.example", remotePublicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, sharedSecret: "fixture", generation: "generation:one", threadId: "thread:one" });
      const policy: ProcessScopePolicy = { conversations: [{ contactId: contact.id, conversationId: contact.conversationId, generation: contact.generation, read: true, send: false }],
        resources: [], materials: [], expiresAtMs: now + 3_600_000, budgets: { processes: 1, generations: 16, messages: 0 },
        automatic: { mode: "draft", request: "Prepare a private reply for my review", maxMessages: 2, intervalSeconds: 60 } };
      const scope = federation.transaction(() => {
        const created = procs.scopes.create(owner.uid, "proc:helper", policy);
        procs.spawn("proc:helper", owner, { ownerUid: owner.uid, scopeId: created.id, interactive: true });
        procs.scopes.automation.register(created, 0);
        return created;
      });
      const installationId = `inst_auto_${crypto.randomUUID()}`;
      const conversation = utils.getConversationById(installationId, contact.conversationId);
      await conversation.initialize({ ownerUid: owner.uid, kind: "contact" });
      const appended = await conversation.append({ messageId: "incoming:one", idempotencyKey: "incoming:one", text: "Can you help?", createdAt: now,
        author: { kind: "contact", contactId: contact.id, shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id, displayName: "Sam" },
        origin: { kind: "federation", contactId: contact.id, deliveryId: "delivery:one" },
        social: { threadId: contact.threadId, reference: { actor: { shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id }, messageId: "origin:one" }, provenance: { kind: "human" } } });
      federation.transaction(() => procs.scopes.automation.admit(contact, appended.message));
      // SAFETY: this scheduler boundary uses the real owning stores and Conversation, with Process transport observed below.
      const ctx = { installationId, procs, auth, caps, federation, broadcastToUserUid: vi.fn() } as KernelContext;
      const send = vi.spyOn(utils, "sendFrameToProcess").mockRejectedValueOnce(new Error("Response lost")).mockImplementation(async (_installation, _pid, frame) => {
        if (frame.type !== "req") throw new Error("Expected an event request");
        return { type: "res", id: frame.id, ok: true, data: { eventId: frame.id, runId: frame.id, queued: true } };
      });
      await processScopeMessages(ctx);
      expect(procs.scopes.get(scope.id)?.automation).toMatchObject({ acceptedMessages: 1, pendingMessages: 1 });
      await processScopeMessages(ctx);
      expect(send).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(now + 60_001);
      await processScopeMessages(ctx);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
      expect(send.mock.calls[1][2]).toMatchObject({ call: "proc.runtime.event.deliver", args: { event: { type: "social.message", payload: {
        scopeId: scope.id, ownerRequest: policy.automatic!.request, reference: appended.message.social!.reference,
        message: { text: "Can you help?", contentTrust: "untrusted", attachmentsIncluded: false },
      } } } });
      expect(procs.scopes.get(scope.id)?.automation).toMatchObject({ pendingMessages: 0 });
      const second: ConversationMessage = { ...appended.message, id: "incoming:two", sequence: 2, createdAt: now + 60_002 };
      federation.transaction(() => procs.scopes.automation.admit(contact, second));
      federation.transaction(() => procs.scopes.revoke(scope.id, owner.uid, 1));
      clock.mockReturnValue(now + 120_003);
      await processScopeMessages(ctx);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });
});
