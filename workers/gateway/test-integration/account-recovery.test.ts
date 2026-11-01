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
    await oneShot.requestOnce(url, "sys.setup", { onboardingToken: "integration-onboarding-default", username: "person", password: "human-password", rootPassword: "old-root-password" });
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
    const storage = await harness.getWorker("gsv").getDurableObjectStorage("KERNEL", { name: "inst_integration_default" });
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
    await harness.getWorker("gsv").evictDurableObject("KERNEL", { name: "inst_integration_default", webSockets: "hibernate" });
    expect(await oneShot.requestOnce(url, "account.recovery.redeem", redemption)).toEqual({ username: "root" });
    expect((await recovered.account.list({})).accounts.length).toBeGreaterThan(1);
    const retained = new GSVClient({ url, username: "person", token: humanToken.token.token, peer: { id: "retained-human" } });
    clients.push(retained);
    await expect(retained.connect()).resolves.toMatchObject({ peer: { principal: { account: { uid: 1000 } } } });
    await expect(oneShot.requestOnce(url, "account.recovery.redeem", { ...redemption, proof: crypto.randomUUID() + crypto.randomUUID() })).rejects.toMatchObject({ code: 400 });
  });

  it("lets a verified owner email set the personal password without administrator access", async () => {
    const oneShot = new GSVClient();
    // The Ship set up above now has known credentials; reuse it for the personal path.
    const human = new GSVClient({ url, username: "person", password: "human-password", peer: { id: "personal-recovery-human" } });
    clients.push(human);
    await human.connect();
    const oldToken = await human.sys.token.create({ kind: "human", label: "old personal token" });
    const secret = crypto.randomUUID() + crypto.randomUUID();
    const secretHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const attemptId = crypto.randomUUID();
    const storage = await harness.getWorker("gsv").getDurableObjectStorage("KERNEL", { name: "inst_integration_default" });
    await storage.exec(`INSERT INTO account_recovery_claims (id, purpose, secret_hash, credential_epoch, personal_uid, personal_credential_epoch, expires_at)
      VALUES (?, 'root-password-reset', ?, 1, 1000, 0, ?)`, attemptId, secretHash, Date.now() + 300_000);
    const redemption = { id: attemptId, secret, proof: crypto.randomUUID() + crypto.randomUUID(), password: "recovered-personal-password", account: "personal" as const };
    expect(await oneShot.requestOnce(url, "account.recovery.redeem", redemption)).toEqual({ username: "person" });
    await expect(human.account.list({})).rejects.toThrow();
    const old = new GSVClient({ url, username: "person", password: "human-password", peer: { id: "old-personal-password" } });
    const oldTokenClient = new GSVClient({ url, username: "person", token: oldToken.token.token, peer: { id: "old-personal-token" } });
    clients.push(old, oldTokenClient);
    await expect(old.connect()).rejects.toMatchObject({ code: 401 });
    await expect(oldTokenClient.connect()).rejects.toMatchObject({ code: 401 });
    // Signs in with no administrator step.
    const recovered = new GSVClient({ url, password: redemption.password, peer: { id: "recovered-personal" } });
    clients.push(recovered);
    await expect(recovered.connect()).resolves.toMatchObject({ peer: { principal: { account: { uid: 1000 } } } });
    await harness.getWorker("gsv").evictDurableObject("KERNEL", { name: "inst_integration_default", webSockets: "hibernate" });
    expect(await oneShot.requestOnce(url, "account.recovery.redeem", redemption)).toEqual({ username: "person" });
    await expect(oneShot.requestOnce(url, "account.recovery.redeem", { ...redemption, proof: crypto.randomUUID() + crypto.randomUUID() })).rejects.toMatchObject({ code: 400 });
    await expect(oneShot.requestOnce(url, "account.recovery.options", {})).resolves.toEqual({ emailUrl: "https://accounts.example/owner/recover?handle=default" });
  });
});
