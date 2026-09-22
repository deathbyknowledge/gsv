import { describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { APPROACH_LIFETIME_MS, APPROACH_RECEIPT_MS, ApproachStore, type PrepareApproach } from "./approach-store";
import { FederationStore } from "./federation-store";

describe("durable first-contact records", () => {
  it("counts all requests needing attention independently of pages and keeps owners and decisions separate", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const requests = new ApproachStore(storage);
      const first = requests.prepare(incoming(), () => {});
      const second = requests.prepare(incoming(), () => {});
      requests.prepare(incoming(1001), () => {});
      requests.prepare({ ...incoming(), direction: "outgoing" }, () => {});
      expect(requests.list(1000, { direction: "incoming", status: "active", limit: 1 })).toHaveLength(1);
      expect(requests.count(1000, "incoming", "active")).toBe(2);
      expect(requests.count(1000, "outgoing", "active")).toBe(1);
      expect(requests.count(1001, "incoming", "active")).toBe(1);
      requests.messageCommitted(first.summary.id, 1);
      requests.decide(first.summary.id, 1000, 1, "declined");
      expect(requests.count(1000, "incoming", "active")).toBe(1);
      expect(requests.count(1000, "incoming", "history")).toBe(1);
      requests.expire(second.summary.id, second.summary.expiresAtMs + 1);
      expect(new ApproachStore(storage).count(1000, "incoming", "active")).toBe(0);
      expect(requests.count(1000, "incoming", "history")).toBe(2);
    });
  });

  it("measures the full installation intake budget and frees admission capacity after expiry", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const requests = new ApproachStore(storage);
      const baseline = sql.databaseSize;
      const ids: string[] = [];
      const now = Date.now();
      for (let index = 0; index < 1000; index++) {
        const input = incoming(1000 + Math.floor(index / 250));
        input.content.text = "x".repeat(32_768);
        ids.push(requests.prepare(input, () => {}, now).summary.id);
        if (index % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(() => requests.prepare(incoming(1004), () => {}, now)).toThrow("capacity");
      expect(sql.databaseSize - baseline).toBeLessThan(96 * 1024 * 1024);
      console.info("first-contact Kernel capacity (1000 full-size pending fixtures)", { baseline, bytes: sql.databaseSize });
      const expiry = now + APPROACH_LIFETIME_MS + 1_000;
      requests.expire(ids[0], expiry);
      expect(requests.get(ids[0])).toMatchObject({ pendingText: null, setupToken: null, summary: { state: "expired" } });
      expect(requests.prepare(incoming(1004), () => {}).summary.state).toBe("preparing");
      requests.removeSettled(ids[0], expiry + APPROACH_RECEIPT_MS);
      expect(requests.get(ids[0])).toBeNull();
    });
  }, 30_000);

  it("retains an in-flight acceptance through the receipt grace window and preserves accepted history across blocking", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const requests = new ApproachStore(storage);
      const input = incoming();
      const created = requests.prepare(input, () => {});
      requests.messageCommitted(created.summary.id, 1);
      requests.beginAcceptance(created.summary.id, 1000, 1, "attempt:durable");
      requests.expire(created.summary.id, input.content.expiresAtMs + 1);
      expect(requests.get(created.summary.id)?.summary.state).toBe("accepting");
      const committed = requests.commitClaim(created.summary.id, "attempt:durable", "generation:one", { receipt: "durable" }, input.content.expiresAtMs + 1);
      expect(committed.summary.acceptedAtMs).toBe(input.content.expiresAtMs + 1);
      expect(committed.setupToken).toBeNull();
      requests.blockForActor(1000, input.peer);
      expect(requests.get(created.summary.id)?.summary.acceptedAtMs).toBe(committed.summary.acceptedAtMs);
      expect(() => requests.commitClaim(created.summary.id, "attempt:durable", "generation:one", {})).toThrow("changed");
    });
  });

  it("reserves one request, resumes the same append, and keeps setup material out of summaries", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const requests = new ApproachStore(storage);
      const input = incoming();
      const admit = vi.fn();
      const prepared = requests.prepare(input, admit);
      expect(requests.prepare(input, admit)).toEqual(prepared);
      expect(admit).toHaveBeenCalledOnce();
      expect(prepared.summary.state).toBe("preparing");
      expect(prepared.summary.delivery).toBe("unconfirmed");
      const committed = requests.messageCommitted(prepared.summary.id, 1);
      expect(committed.summary).toMatchObject({ state: "pending", delivery: "received", conversationId: input.conversationId });
      expect(committed.pendingText).toBeNull();
      expect(committed.setupToken).toBe(input.setupToken);
      expect(requests.messageCommitted(prepared.summary.id, 1).summary).toEqual(committed.summary);
      expect(() => requests.messageCommitted(prepared.summary.id, 2)).toThrow("history changed");
      const listed = requests.list(1000, { direction: "incoming", limit: 50 });
      expect(listed).toEqual([committed.summary]);
      expect(JSON.stringify(listed)).not.toContain(input.setupToken);
      expect(listed[0]).not.toHaveProperty("ownerUid");
      expect(listed[0]).not.toHaveProperty("remotePublicKey");
      expect(() => requests.prepare({ ...input, fingerprint: "different" }, admit)).toThrow("differs");
      expect(requests.list(1001, { direction: "incoming", limit: 50 })).toEqual([]);
    });
  });

  it("checks human decision roles, revisions and pinned-actor blocks before acceptance or replay", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const requests = new ApproachStore(storage);
      const input = incoming();
      const prepared = requests.prepare(input, () => {});
      requests.messageCommitted(prepared.summary.id, 1);
      expect(() => requests.decide(prepared.summary.id, 1001, 1, "declined")).toThrow("not found");
      expect(() => requests.decide(prepared.summary.id, 1000, 1, "withdrawn")).toThrow("other participant");
      expect(() => requests.beginAcceptance(prepared.summary.id, 1000, 0, "attempt:first")).toThrow("changed");
      const accepting = requests.beginAcceptance(prepared.summary.id, 1000, 1, "attempt:first");
      expect(accepting.summary).toMatchObject({ state: "accepting", revision: 2 });
      expect(requests.beginAcceptance(prepared.summary.id, 1000, 1, "attempt:replacement").pairingAttemptId).toBe("attempt:first");
      expect(() => requests.decide(prepared.summary.id, 1000, 2, "declined")).toThrow("changed");
      new FederationStore(storage).setActorBlock(1000, input.peer, true);
      requests.blockForActor(1000, input.peer);
      expect(() => requests.beginAcceptance(prepared.summary.id, 1000, 2, "attempt:later")).toThrow("unavailable");
      expect(() => requests.prepare(input, () => {})).toThrow("unavailable");
      new FederationStore(storage).setActorBlock(1000, input.peer, false);
      expect(() => requests.beginAcceptance(prepared.summary.id, 1000, 3, "attempt:after-unblock")).toThrow("changed");
      expect(requests.get(prepared.summary.id)?.setupToken).toBeNull();
    });
  });

  it("rolls back admission side effects and enforces the independent pending-request budget", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const requests = new ApproachStore(storage);
      const federation = new FederationStore(storage);
      const input = incoming();
      expect(() => requests.prepare(input, () => {
        federation.setActorBlock(1000, input.peer, true);
        throw new Error("Policy changed");
      })).toThrow("Policy changed");
      expect(federation.isActorBlocked(1000, input.peer)).toBe(false);
      expect(requests.byReference(1000, input.content.reference)).toBeNull();
      for (let index = 0; index < 250; index++) requests.prepare(incoming(), () => {});
      expect(() => requests.prepare(incoming(), () => {})).toThrow("capacity");
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM federation_contacts").one().count).toBe(0);
      const secondOwner = incoming(1001);
      expect(requests.prepare(secondOwner, () => {}).ownerUid).toBe(1001);
      const page = requests.list(1000, { direction: "incoming", limit: 100 });
      const next = requests.list(1000, { direction: "incoming", limit: 100, before: { createdAtMs: page.at(-1)!.createdAtMs, id: page.at(-1)!.id } });
      expect(new Set([...page, ...next].map((entry) => entry.id)).size).toBe(200);
    });
  });

  it("bounds UTF-8 bytes and expiry, and retains the first outcome on a repeated decision", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const requests = new ApproachStore(storage);
      const input = incoming();
      expect(() => requests.prepare({ ...input, content: { ...input.content, text: "🪐".repeat(8193) } }, () => {})).toThrow("text limit");
      expect(() => requests.prepare({ ...input, content: { ...input.content, expiresAtMs: Date.now() - 1 } }, () => {})).toThrow("expiry");
      const prepared = requests.prepare(input, () => {});
      requests.messageCommitted(prepared.summary.id, 1);
      const declined = requests.decide(prepared.summary.id, 1000, 1, "declined");
      expect(declined.setupToken).toBeNull();
      expect(requests.decide(prepared.summary.id, 1000, 1, "declined")).toEqual(declined);
      expect(() => requests.beginAcceptance(prepared.summary.id, 1000, 2, "attempt:late")).toThrow("changed");
      expect(new ApproachStore(storage).get(prepared.summary.id)).toEqual(declined);
    });
  });
});

function incoming(ownerUid = 1000): PrepareApproach {
  const nonce = crypto.randomUUID();
  const peer = { shipId: `ship:${nonce}`, subjectId: `subject:${nonce}` };
  const now = Date.now();
  return {
    ownerUid, direction: "incoming", peer, remoteOrigin: "https://remote.example",
    remotePublicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, remoteDisplayName: "Visitor", localDisplayName: "Person",
    conversationId: `conv:${nonce}`, contactId: `contact:${nonce}`, threadId: `thread:${nonce}`,
    content: {
      reference: { actor: peer, approachId: `request:${nonce}` }, recipient: { shipId: "ship:local", subjectId: `subject:local-${ownerUid}` },
      profileRevision: 1, displayName: "Visitor", messageId: `message:${nonce}`, text: "A first message", createdAtMs: now, expiresAtMs: now + APPROACH_LIFETIME_MS,
    },
    fingerprint: `fingerprint:${nonce}`, setupToken: `private-setup-${nonce}`, setupTokenHash: `hash:${nonce}`,
  };
}
