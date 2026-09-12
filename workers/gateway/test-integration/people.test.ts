import { GSVClient } from "@humansandmachines/gsv";
import { createPairingSecret } from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGatewayTestHarness, webSocketUrl } from "./harness";

describe("clean-space human enrollment and removal", () => {
  let harness: TestHarness;
  let url: string;
  const clients: GSVClient[] = [];
  beforeAll(async () => { harness = createGatewayTestHarness(); url = webSocketUrl((await harness.listen()).url); });
  afterAll(async () => { clients.forEach((client) => client.close()); await harness.close(); });

  it("enrolls a local member, recovers the same receipt after eviction, then fences removed credentials", async () => {
    const oneShot = new GSVClient();
    await oneShot.requestOnce(url, "sys.setup", { username: "owner", password: "owner-password", rootPassword: "root-password" });
    const root = new GSVClient({ url, username: "root", password: "root-password", peer: { id: "people-root" } });
    const owner = new GSVClient({ url, username: "owner", password: "owner-password", peer: { id: "people-owner" } });
    clients.push(root, owner);
    await root.connect(); await owner.connect();
    const invite = { id: crypto.randomUUID(), secret: createPairingSecret(), username: "member" };
    await expect(owner.account.invite.create(invite)).rejects.toThrow();
    const minted = await root.account.invite.create(invite);
    expect(minted).toMatchObject({ username: "member", status: "pending" });
    const request = { id: invite.id, secret: invite.secret, proof: createPairingSecret(), password: "member-password" };
    const enrolled = await oneShot.requestOnce(url, "account.invite.redeem", request);
    expect(enrolled.username).toBe("member");
    expect(enrolled.uid).not.toBe(1000);
    const member = new GSVClient({ url, username: "member", password: request.password, peer: { id: "people-member" } });
    clients.push(member); await member.connect();
    const accounts = (await member.account.list({})).accounts;
    expect(accounts.some((account) => account.relation === "personal-agent")).toBe(true);
    expect(accounts.find((account) => account.relation === "self")?.uid).toBe(enrolled.uid);
    const token = await member.sys.token.create({ kind: "human", label: "member browser" });
    await harness.getWorker("gsv").evictDurableObject("KERNEL", { name: "singleton", webSockets: "hibernate" });
    expect(await oneShot.requestOnce(url, "account.invite.redeem", request)).toEqual(enrolled);
    await expect(oneShot.requestOnce(url, "account.invite.redeem", { ...request, proof: createPairingSecret() })).rejects.toMatchObject({ code: 400 });
    await root.account.password.set({ uid: enrolled.uid, password: "reset-password" });
    await expect(member.account.list({})).rejects.toThrow();
    const revoked = new GSVClient({ url, username: "member", token: token.token.token, peer: { id: "old-member-token" } });
    clients.push(revoked); await expect(revoked.connect()).rejects.toMatchObject({ code: 401 });
    const reset = new GSVClient({ url, username: "member", password: "reset-password", peer: { id: "reset-member" } });
    clients.push(reset); await reset.connect();
    // A replay of enrollment never replaces a newer password.
    expect(await oneShot.requestOnce(url, "account.invite.redeem", request)).toEqual(enrolled);
    await root.account.remove({ uid: enrolled.uid });
    await expect(reset.account.list({})).rejects.toThrow();
    const removed = new GSVClient({ url, username: "member", password: "reset-password", peer: { id: "removed-member" } });
    clients.push(removed); await expect(removed.connect()).rejects.toMatchObject({ code: 401 });
    expect((await owner.account.list({})).accounts.find((account) => account.relation === "self")?.uid).toBe(1000);
    expect((await root.account.people.list({})).people.find((person) => person.uid === enrolled.uid)).toMatchObject({ username: "member", disabled: true });
    const ledger = await root.sys.ledger.list({ limit: 100 });
    expect(JSON.stringify(ledger)).not.toContain(invite.secret);
    expect(JSON.stringify(ledger)).not.toContain("reset-password");
  });
});
