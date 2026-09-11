import { GSVClient } from "@humansandmachines/gsv";
import { createPairingSecret } from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RecordedOutboundMessage } from "./fixtures/dependencies";
import { createGatewayTestHarness, webSocketUrl } from "./harness";

describe("clean-space messenger member recovery", () => {
  let harness: TestHarness;
  let url: string;
  const clients: GSVClient[] = [];
  beforeAll(async () => { harness = createGatewayTestHarness(); url = webSocketUrl((await harness.listen()).url); });
  afterAll(async () => { clients.forEach((client) => client.close()); await harness.close(); });

  it("delivers the code directly and recovers only the linked member after Kernel eviction", async () => {
    const oneShot = new GSVClient();
    await oneShot.requestOnce(url, "sys.setup", { username: "person", password: "old-password", rootPassword: "root-password" });
    const root = new GSVClient({ url, username: "root", password: "root-password", peer: { id: "recovery-root" } });
    const human = new GSVClient({ url, username: "person", password: "old-password", peer: { id: "recovery-member" } });
    clients.push(root, human); await root.connect(); await human.connect();
    const oldToken = await human.sys.token.create({ kind: "human", label: "old member token" });
    const processes = await root.proc.list({});
    // Direct human pairing authorization has separate boundary coverage. Seed the
    // resulting durable route, then use the real anonymous protocol and adapter service.
    const storage = await harness.getWorker("gsv").getDurableObjectStorage("KERNEL", { name: "singleton" });
    await storage.exec(`INSERT INTO identity_links (adapter, account_id, actor_id, uid, created_at, linked_by_uid, metadata_json)
      VALUES ('telegram', 'recovery-account', 'recovery-person', 1000, ?, 1000, ?)`, Date.now(), JSON.stringify({ managed: true, surfaceKind: "dm", surfaceId: "recovery-dm", routeGeneration: "confirmed-generation" }));
    const attempt = { id: crypto.randomUUID(), username: "person", proof: createPairingSecret() };
    expect(await oneShot.requestOnce(url, "account.recovery.code.start", attempt)).toMatchObject({ accepted: true });
    const response = await harness.getWorker("gsv-test-dependencies").fetch("http://gsv-test-dependencies/__test/outbound?installationId=singleton&accountId=recovery-account");
    // SAFETY: this fixture endpoint returns its declared outbound record contract.
    const outbound = await response.json() as RecordedOutboundMessage[];
    expect(outbound).toHaveLength(1);
    expect(outbound[0].message.surface).toEqual({ kind: "dm", id: "recovery-dm" });
    const code = outbound[0].message.text!.match(/code is ([A-F0-9]{4}-[A-F0-9]{4})/)![1];
    expect(await root.proc.list({})).toEqual(processes);
    await harness.getWorker("gsv").evictDurableObject("KERNEL", { name: "singleton", webSockets: "hibernate" });
    const redemption = { id: attempt.id, proof: attempt.proof, code, password: "recovered-password" };
    expect(await oneShot.requestOnce(url, "account.recovery.code.redeem", redemption)).toEqual({ username: "person" });
    await expect(human.account.list({})).rejects.toThrow();
    const revoked = new GSVClient({ url, username: "person", token: oldToken.token.token, peer: { id: "revoked-member" } });
    clients.push(revoked); await expect(revoked.connect()).rejects.toMatchObject({ code: 401 });
    const recovered = new GSVClient({ url, username: "person", password: redemption.password, peer: { id: "recovered-member" } });
    clients.push(recovered); await recovered.connect();
    expect((await recovered.sys.link.list({})).links).toHaveLength(0);
    await root.account.password.set({ uid: 1000, password: "later-password" });
    expect(await oneShot.requestOnce(url, "account.recovery.code.redeem", redemption)).toEqual({ username: "person" });
    const later = new GSVClient({ url, username: "person", password: "later-password", peer: { id: "later-member" } });
    clients.push(later); await later.connect();
    expect((await root.account.people.list({})).people.find((person) => person.uid === 1000)?.disabled).toBe(false);
    await expect(oneShot.requestOnce(url, "account.recovery.code.redeem", { ...redemption, proof: createPairingSecret() })).rejects.toMatchObject({ code: 400 });
  });
});
