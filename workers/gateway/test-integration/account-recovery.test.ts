import { GSVClient } from "@humansandmachines/gsv";
import type { TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGatewayTestHarness, webSocketUrl } from "./harness";

describe("clean-space owner root recovery", () => {
  let harness: TestHarness;
  let url: string;
  const clients: GSVClient[] = [];
  beforeAll(async () => { harness = createGatewayTestHarness(); url = webSocketUrl((await harness.listen()).url); });
  afterAll(async () => { clients.forEach((client) => client.close()); await harness.close(); });

  it("revokes an existing root session and token while the ordinary human survives recovery and eviction", async () => {
    const oneShot = new GSVClient();
    await oneShot.requestOnce(url, "sys.setup", { username: "person", password: "human-password", rootPassword: "old-root-password" });
    const root = new GSVClient({ url, username: "root", password: "old-root-password", peer: { id: "recovery-root" } });
    const human = new GSVClient({ url, username: "person", password: "human-password", peer: { id: "recovery-human" } });
    clients.push(root, human);
    await root.connect(); await human.connect();
    const oldRootToken = await root.sys.token.create({ kind: "human", label: "old root token" });
    const humanToken = await human.sys.token.create({ kind: "human", label: "retained human token" });
    const proof = crypto.randomUUID() + crypto.randomUUID();
    const secret = crypto.randomUUID() + crypto.randomUUID();
    const secretHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const attemptId = crypto.randomUUID();
    // The dedicated binding's authorization is covered separately. Seed its
    // persisted receipt without retaining a Node RPC reference that prevents eviction.
    const storage = await harness.getWorker("gsv").getDurableObjectStorage("KERNEL", { name: "singleton" });
    await storage.exec(`INSERT INTO account_recovery_claims (id, purpose, secret_hash, credential_epoch, expires_at)
      VALUES (?, 'root-password-reset', ?, 0, ?)`, attemptId, secretHash, Date.now() + 300_000);
    const redemption = { id: attemptId, secret, proof, password: "recovered-root-password" };
    expect(await oneShot.requestOnce(url, "account.recovery.redeem", redemption)).toEqual({ username: "root" });
    await expect(root.account.list({})).rejects.toThrow();
    expect((await human.account.list({})).accounts.some((account) => account.username === "person")).toBe(true);
    const old = new GSVClient({ url, username: "root", token: oldRootToken.token.token, peer: { id: "revoked-root" } });
    clients.push(old);
    await expect(old.connect()).rejects.toMatchObject({ code: 401 });
    const recovered = new GSVClient({ url, username: "root", password: redemption.password, peer: { id: "recovered-root" } });
    clients.push(recovered); await recovered.connect();
    await harness.getWorker("gsv").evictDurableObject("KERNEL", { name: "singleton", webSockets: "hibernate" });
    expect(await oneShot.requestOnce(url, "account.recovery.redeem", redemption)).toEqual({ username: "root" });
    expect((await recovered.account.list({})).accounts.length).toBeGreaterThan(1);
    const retained = new GSVClient({ url, username: "person", token: humanToken.token.token, peer: { id: "retained-human" } });
    clients.push(retained);
    await expect(retained.connect()).resolves.toMatchObject({ peer: { principal: { account: { uid: 1000 } } } });
    await expect(oneShot.requestOnce(url, "account.recovery.redeem", { ...redemption, proof: crypto.randomUUID() + crypto.randomUUID() })).rejects.toMatchObject({ code: 400 });
  });
});
