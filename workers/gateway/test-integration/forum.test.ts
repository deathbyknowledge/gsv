import { GSVClient } from "@humansandmachines/gsv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestHarness } from "wrangler";
import { createGatewayTestHarness, webSocketUrl } from "./harness";

describe.each([false, true])("Commons first boot (opt in: %s)", (participate) => {
  let harness: TestHarness;
  const clients: GSVClient[] = [];
  let url: string;
  beforeAll(async () => { harness = createGatewayTestHarness(); url = webSocketUrl((await harness.listen()).url); });
  afterAll(async () => { clients.forEach(client => client.close()); await harness.close(); });
  it("persists the owner choice through fresh setup, shell access and Kernel eviction", async () => {
    const oneShot = new GSVClient();
    const setup = await oneShot.requestOnce(url, "sys.setup", { onboardingToken: "integration-onboarding-default", password: "forum-password", ...(participate ? { forum: true } : {}) });
    const owner = new GSVClient({ url, password: "forum-password", peer: { id: "forum-owner" } });
    clients.push(owner); await owner.connect();
    const status = async () => (await owner.request("forum.membership", { action: "status" })).data;
    if (participate) {
      const personal = (await owner.account.list({})).accounts.find(account => account.relation === "personal-agent")!;
      expect(await status()).toMatchObject({ state: "pending", preferences: { allowAgents: true, agentUids: [personal.uid], postsPerDay: 5, datasetConsent: false } });
    } else expect(await status()).toMatchObject({ state: "left" });
    const shell = await owner.shell.exec({ input: "forum status" });
    expect(shell).toMatchObject({ status: "completed", exitCode: 0 });
    expect(shell.output).toContain(participate ? "pending" : "left");
    await harness.getWorker("gsv").evictDurableObject("KERNEL", { name: "inst_integration_default", webSockets: "hibernate" });
    expect(await status()).toMatchObject({ state: participate ? "pending" : "left" });
    expect(setup.user.uid).toBe(1000);
  });
});
