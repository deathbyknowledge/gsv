import { GSVClient } from "@humansandmachines/gsv";
import type { TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGatewayTestHarness, webSocketUrl } from "./harness";

describe("one personal account per space", () => {
  let harness: TestHarness;
  let url: string;
  const clients: GSVClient[] = [];
  beforeAll(async () => { harness = createGatewayTestHarness(); url = webSocketUrl((await harness.listen()).url); });
  afterAll(async () => { clients.forEach((client) => client.close()); await harness.close(); });

  it("sets up and signs in without a username, preserves agents, and recovers personal access through root", async () => {
    const oneShot = new GSVClient();
    const setup = await oneShot.requestOnce(url, "sys.setup", { onboardingToken: "integration-onboarding-default", password: "personal-password", rootPassword: "root-password" });
    expect(setup.user.uid).toBe(1000);
    expect(setup.user.username).toBeTruthy();
    const owner = new GSVClient({ url, password: "personal-password", peer: { id: "personal-owner" } });
    const root = new GSVClient({ url, username: "root", password: "root-password", peer: { id: "personal-root" } });
    clients.push(owner, root);
    const connected = await owner.connect(); await root.connect();
    expect(connected.peer.principal.account).toMatchObject({ uid: setup.user.uid, username: setup.user.username, home: setup.user.home });
    const accounts = (await owner.account.list({})).accounts;
    expect(accounts.some((account) => account.relation === "personal-agent")).toBe(true);
    expect((await owner.account.create({ kind: "agent", username: "scout" })).kind).toBe("agent");
    // A pre-upgrade caller cannot create another person, even through root.
    // @ts-expect-error removed from the typed client intentionally
    await expect(root.account.create({ kind: "human", username: "second", password: "second-password" })).rejects.toThrow();
    await expect(oneShot.requestOnce(url, "sys.setup", { onboardingToken: "integration-onboarding-default", password: "second-password" })).rejects.toThrow();
    const old = await owner.sys.token.create({ kind: "human", label: "personal browser" });
    await harness.getWorker("gsv").evictDurableObject("KERNEL", { name: "inst_integration_default", webSockets: "hibernate" });
    await expect(owner.account.password.set({ password: "reset-password" })).rejects.toThrow();
    await root.account.password.set({ password: "reset-password" });
    await expect(owner.account.list({})).rejects.toThrow();
    const revoked = new GSVClient({ url, token: old.token.token, peer: { id: "revoked-personal" } });
    const reset = new GSVClient({ url, password: "reset-password", peer: { id: "reset-personal" } });
    clients.push(revoked, reset);
    await expect(revoked.connect()).rejects.toMatchObject({ code: 401 });
    expect((await reset.connect()).peer.principal.account).toMatchObject({ uid: setup.user.uid, username: setup.user.username, home: setup.user.home });
    expect((await reset.account.list({})).accounts.some((account) => account.username === "scout")).toBe(true);
    const ledger = await root.sys.ledger.list({ limit: 100 });
    expect(JSON.stringify(ledger)).not.toContain("reset-password");
  });
});
