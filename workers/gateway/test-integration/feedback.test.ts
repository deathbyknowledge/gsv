import { fileURLToPath } from "node:url";
import { GSVClient } from "@humansandmachines/gsv";
import type { TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGatewayTestHarness, integrationGatewayConfig, webSocketUrl } from "./harness";

describe("clean-space operator feedback", () => {
  let harness: TestHarness;
  let client: GSVClient;
  let url: string;
  beforeAll(async () => {
    harness = createGatewayTestHarness();
    await harness.update((options) => ({ ...options, workers: [
      ...options.workers.map((worker, index) => index ? worker : { config: {
        ...integrationGatewayConfig(), services: [
          ...integrationGatewayConfig().services!, { binding: "FEEDBACK", service: "feedback-fixture" },
        ],
      } }),
      { config: { name: "feedback-fixture", main: fileURLToPath(new URL("./fixtures/feedback.ts", import.meta.url).href), compatibility_date: "2026-09-01" } },
    ] }));
    url = webSocketUrl((await harness.listen()).url);
    await new GSVClient().requestOnce(url, "sys.setup", {
      onboardingToken: "integration-onboarding-default", username: "person", password: "test-password", rootPassword: "root-password",
    });
    client = new GSVClient({ url, username: "person", password: "test-password", peer: { id: "feedback-human" } });
  });
  afterAll(async () => { client?.close(); await harness?.close(); });

  it("advertises feedback after authentication and accepts UI and shell reports", async () => {
    const connection = await client.connect();
    expect(connection.server.features).toContain("operator-feedback");
    const id = crypto.randomUUID();
    expect(await client.sys.feedback({ id, message: "A synthetic UI report", context: { platform: "web", view: "zen" } })).toEqual({ id });
    const shellId = crypto.randomUUID();
    const shell = await client.shell.exec({ input: `feedback --id ${shellId} 'A synthetic shell report'` });
    expect(shell).toMatchObject({ status: "completed", exitCode: 0, output: `${JSON.stringify({ id: shellId })}\n` });
    await expect(client.sys.feedback({ message: " " })).rejects.toThrow("Invalid feedback report");
    await expect(new GSVClient().requestOnce(url, "sys.feedback", { message: "Anonymous report" })).rejects.toThrow();
    const machineToken = await client.sys.token.create({ kind: "machine", peerId: "feedback-machine" });
    const machine = new GSVClient({ url, username: "person", token: machineToken.token.token, peer: { id: "feedback-machine", implements: ["fs.read"] } });
    try {
      const machineConnection = await machine.connect();
      expect(machineConnection.server.features ?? []).not.toContain("operator-feedback");
      await expect(machine.sys.feedback({ message: "Machine report" })).rejects.toThrow();
    } finally { machine.close(); }
  });

  it("ends a stalled inbox call and accepts the same report on retry", async () => {
    const input = { id: crypto.randomUUID(), message: "Stall the first attempt" };
    await expect(client.sys.feedback(input)).rejects.toThrow("Feedback delivery timed out");
    expect(await client.sys.feedback(input)).toEqual({ id: input.id });
  });
});
