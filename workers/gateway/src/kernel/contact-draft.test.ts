import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContactDraftCreateArgs, ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import type { KernelContext } from "./context";
import { FederationStore } from "./federation-store";
import { handleContactDraftApprove, handleContactDraftGet } from "./contact-draft-handlers";
import * as federation from "./federation";

const OWNER: ProcessIdentity = { uid: 1000, gid: 1000, gids: [1000], username: "owner", home: "/home/owner", cwd: "/home/owner" };
const content = (): ContactDraftCreateArgs => ({ contactId: "contact:one", expectedGeneration: "generation:one",
  source: { conversationId: "work:one", messageId: "message:reply", sequence: 2 },
  text: "The exact reviewed reply", idempotencyKey: "draft:intent" });

describe("exact contact drafts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retains immutable content across reload and prevents crossed discard/approval decisions", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new FederationStore(storage);
      const draft = store.transaction(() => store.drafts.create(1000, "proc:helper", content(), "fingerprint:one"));
      const restored = new FederationStore(storage);
      expect(restored.drafts.replay(1000, "draft:intent", "fingerprint:one")?.id).toBe(draft.id);
      expect(() => restored.drafts.replay(1000, "draft:intent", "fingerprint:changed")).toThrow("different content");
      expect(restored.drafts.get(1001, draft.id)).toBeNull();
      const approved = restored.transaction(() => restored.drafts.decide(1000, draft.id, 1, "approve"));
      expect(approved).toMatchObject({ state: "sending", revision: 2, content: content() });
      expect(() => restored.transaction(() => restored.drafts.decide(1000, draft.id, 1, "discard"))).toThrow("changed");
      expect(restored.transaction(() => restored.drafts.decide(1000, draft.id, 1, "approve"))).toEqual(approved);
      expect(() => restored.drafts.assertSending(1000, draft.id, draft.expiresAtMs)).toThrow("no longer");
      const second = restored.transaction(() => restored.drafts.create(1000, "proc:helper", { ...content(), idempotencyKey: "draft:discard" }, "fingerprint:two"));
      restored.transaction(() => restored.drafts.decide(1000, second.id, 1, "discard"));
      expect(() => restored.transaction(() => restored.drafts.decide(1000, second.id, 1, "approve"))).toThrow("changed");
    });
  });

  it("retries only the saved exact send after an uncertain result and never lets a Process approve", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const store = new FederationStore(storage);
      const draft = store.transaction(() => store.drafts.create(1000, "proc:helper", content(), "fingerprint:one"));
      // SAFETY: the review handlers here use this real store and authenticated owner; transport is observed at its owning send boundary.
      const ctx = { federation: store, broadcastToUserUid: vi.fn(), peer: testPeer({ account: OWNER, calls: ["contact.send"] }) } as KernelContext;
      const send = vi.spyOn(federation, "handleContactSend");
      send.mockRejectedValueOnce(new Error("Response lost")).mockResolvedValue({ deliveryId: "delivery:one", conversationId: "conversation:one", state: "queued" });
      const decision = { draftId: draft.id, expectedRevision: 1 };
      await expect(handleContactDraftApprove(decision, { ...ctx, processId: "proc:helper" })).rejects.toThrow("signed-in human");
      await expect(handleContactDraftApprove(decision, { ...ctx, peer: testPeer({ account: OWNER, calls: [] }) })).rejects.toThrow("cannot send");
      expect(send).not.toHaveBeenCalled();
      await expect(handleContactDraftApprove(decision, ctx)).rejects.toThrow("Response lost");
      expect(handleContactDraftGet({ draftId: draft.id }, ctx).draft.state).toBe("sending");
      const retried = await handleContactDraftApprove(decision, ctx);
      expect(retried.draft).toMatchObject({ state: "sent", content: content() });
      expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0]);
      expect(send.mock.calls[1][0]).toMatchObject({ contactId: "contact:one", expectedGeneration: "generation:one", text: "The exact reviewed reply", idempotencyKey: `approved:${draft.id}` });
      expect(send.mock.calls[1][2]).toMatchObject({ processId: "proc:helper", approvalId: draft.id });
      await handleContactDraftApprove(decision, ctx);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });
});
