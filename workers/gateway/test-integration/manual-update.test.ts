import { GSVClient } from "@humansandmachines/gsv";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestHarness } from "wrangler";
import { createGatewayTestHarness, integrationGatewayConfig, webSocketUrl } from "./harness";
import manualVersion from "../src/kernel/sys/manual-version.json";

describe("Manual update admission", () => {
  let harness: TestHarness;
  let client: GSVClient | undefined;
  let url: URL;
  const connect = async () => {
    client = new GSVClient({ url: webSocketUrl(url), username: "manual-user", password: "manual-test-password" });
    await client.connect();
    return client;
  };
  beforeAll(async () => {
    harness = createGatewayTestHarness();
    await harness.update((options) => ({ ...options, workers: options.workers.map((worker, index) => index === 0
      ? { config: { ...integrationGatewayConfig(), vars: { GSV_MANUAL_BOOTSTRAP_REF: "old-manual" } } } : worker) }));
    ({ url } = await harness.listen());
    await new GSVClient().requestOnce(webSocketUrl(url), "sys.setup", {
      onboardingToken: "integration-onboarding-default", username: "manual-user", password: "manual-test-password",
    });
  });
  afterAll(async () => { client?.close(); await harness?.close(); });

  it("updates an existing space on authenticated activity after a deployment", async () => {
    const old = await connect();
    expect((await old.shell.exec({ input: "wiki info gsv-manual" })).output).toContain("revision=old-manual");
    old.close();
    await harness.update((options) => ({ ...options, workers: options.workers.map((worker, index) => index === 0
      ? { config: integrationGatewayConfig() } : worker) }));
    const upgraded = await connect();
    await upgraded.call("repo.list", {});
    await vi.waitFor(async () => {
      const info = await upgraded.shell.exec({ input: "wiki info gsv-manual" });
      expect(info.output).toContain(`revision=${manualVersion.revision}`);
      expect(info.output).toContain("sync=current");
    });
    await harness.getWorker("gsv").evictDurableObject("KERNEL", { name: "inst_integration_default", webSockets: "hibernate" });
    expect((await upgraded.shell.exec({ input: "wiki info gsv-manual" })).output).toContain("sync=current");
  });
});
