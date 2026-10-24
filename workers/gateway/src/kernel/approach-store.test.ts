import { describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { randomPlcDid } from "../test-support/ship-network";
import { APPROACH_LIFETIME_MS, APPROACH_RECEIPT_MS, ApproachStore, type PrepareApproach } from "./approach-store";
import { FederationStore } from "./federation-store";

describe("durable first-contact records", () => {
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
      expect(requests.get(ids[0])).toMatchObject({ pendingText: null, summary: { state: "expired" } });
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
      requests.beginAcceptance(created.summary.id, 1000, 1);
      requests.expire(created.summary.id, input.content.expiresAtMs + 1);
      expect(requests.get(created.summary.id)?.summary.state).toBe("accepting");
      const accepted = requests.accept(created.summary.id, "generation:one", input.content.expiresAtMs + 1);
      expect(accepted.summary).toMatchObject({ state: "accepted", connection: "connected", acceptedAtMs: input.content.expiresAtMs + 1 });
      expect(accepted.generation).toBe("generation:one");
      // Accepting again with the same connection finds it; another connection doesn't replace it.
      expect(requests.accept(created.summary.id, "generation:one")).toEqual(accepted);
      expect(() => requests.accept(created.summary.id, "generation:two")).toThrow("changed");
      requests.blockForDid(1000, input.remoteDid);
      expect(requests.get(created.summary.id)?.summary.acceptedAtMs).toBe(accepted.summary.acceptedAtMs);
      expect(() => requests.accept(created.summary.id, "generation:one")).toThrow("changed");
    });
  });

  it("reserves one request per sender, resumes the same append, and keeps private fields out of summaries", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const requests = new ApproachStore(storage);
      const input = incoming();
      const admit = vi.fn();
      const prepared = requests.prepare(input, admit);
      expect(requests.prepare(input, admit)).toEqual(prepared);
      expect(admit).toHaveBeenCalledOnce();
      expect(prepared.summary).toMatchObject({ state: "preparing", delivery: "unconfirmed", requestId: input.content.requestId, peerDid: input.remoteDid });
      const committed = requests.messageCommitted(prepared.summary.id, 1);
      expect(committed.summary).toMatchObject({ state: "pending", delivery: "received", conversationId: input.conversationId });
      expect(committed.pendingText).toBeNull();
      expect(requests.messageCommitted(prepared.summary.id, 1).summary).toEqual(committed.summary);
      expect(() => requests.messageCommitted(prepared.summary.id, 2)).toThrow("history changed");
      const listed = requests.list(1000, { direction: "incoming", limit: 50 });
      expect(listed).toEqual([committed.summary]);
      expect(listed[0]).not.toHaveProperty("ownerUid");
      expect(listed[0]).not.toHaveProperty("fingerprint");
      expect(() => requests.prepare({ ...input, fingerprint: "different" }, admit)).toThrow("differs");
      expect(requests.byRequest("incoming", input.remoteDid, input.content.requestId)).toEqual(committed);
      expect(requests.byRequest("outgoing", input.remoteDid, input.content.requestId)).toBeNull();
      // A request is its sender's: the same ID from another DID is another request.
      const elsewhere = requests.prepare({ ...incoming(), content: input.content }, admit);
      expect(elsewhere.summary.id).not.toBe(prepared.summary.id);
      expect(requests.list(1001, { direction: "incoming", limit: 50 })).toEqual([]);
    });
  });

  it("checks human decision roles, revisions and blocks before acceptance or replay", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const requests = new ApproachStore(storage);
      const input = incoming();
      const prepared = requests.prepare(input, () => {});
      requests.messageCommitted(prepared.summary.id, 1);
      expect(() => requests.decide(prepared.summary.id, 1001, 1, "declined")).toThrow("not found");
      expect(() => requests.decide(prepared.summary.id, 1000, 1, "withdrawn")).toThrow("other participant");
      expect(() => requests.beginAcceptance(prepared.summary.id, 1000, 0)).toThrow("changed");
      const accepting = requests.beginAcceptance(prepared.summary.id, 1000, 1);
      expect(accepting.summary).toMatchObject({ state: "accepting", revision: 2, connection: "connecting" });
      expect(requests.beginAcceptance(prepared.summary.id, 1000, 1)).toEqual(accepting);
      expect(() => requests.decide(prepared.summary.id, 1000, 2, "declined")).toThrow("changed");
      new FederationStore(storage).setBlock(1000, input.remoteDid, true);
      requests.blockForDid(1000, input.remoteDid);
      expect(() => requests.beginAcceptance(prepared.summary.id, 1000, 2)).toThrow("unavailable");
      expect(() => requests.prepare(input, () => {})).toThrow("unavailable");
      new FederationStore(storage).setBlock(1000, input.remoteDid, false);
      expect(() => requests.beginAcceptance(prepared.summary.id, 1000, 3)).toThrow("changed");
      expect(requests.get(prepared.summary.id)?.pendingText).toBeNull();
    });
  });

  it("rolls back admission side effects and enforces the independent pending-request budget", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const requests = new ApproachStore(storage);
      const federation = new FederationStore(storage);
      const input = incoming();
      expect(() => requests.prepare(input, () => {
        federation.setBlock(1000, input.remoteDid, true);
        throw new Error("Policy changed");
      })).toThrow("Policy changed");
      expect(federation.isBlocked(1000, input.remoteDid)).toBe(false);
      expect(requests.byRequest("incoming", input.remoteDid, input.content.requestId)).toBeNull();
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
      expect(declined.pendingText).toBeNull();
      expect(requests.decide(prepared.summary.id, 1000, 1, "declined")).toEqual(declined);
      expect(() => requests.beginAcceptance(prepared.summary.id, 1000, 2)).toThrow("changed");
      expect(new ApproachStore(storage).get(prepared.summary.id)).toEqual(declined);
    });
  });
});

function incoming(ownerUid = 1000): PrepareApproach {
  const nonce = crypto.randomUUID();
  const now = Date.now();
  return {
    ownerUid, direction: "incoming", remoteDid: randomPlcDid(), remoteDisplayName: "Visitor", localDisplayName: "Person",
    conversationId: `conv:${nonce}`, contactId: `contact:${nonce}`, threadId: `thread:${nonce}`,
    content: {
      requestId: `request:${nonce}`, profileCid: "bafyprofile", name: "Visitor", messageId: `msg:${nonce}`,
      text: "A first message", createdAtMs: now, expiresAtMs: now + APPROACH_LIFETIME_MS,
    },
    fingerprint: `fingerprint:${nonce}`,
  };
}
