import { fileURLToPath } from "node:url";
import { GSVClient } from "@humansandmachines/gsv";
import { bodyFromText } from "@humansandmachines/gsv/protocol";
import type { FeedbackReport } from "@humansandmachines/gsv/services/feedback";
import type { TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGatewayTestHarness, integrationGatewayConfig, webSocketUrl } from "./harness";

describe("clean-space operator feedback", () => {
  let harness: TestHarness;
  let client: GSVClient;
  let url: string;
  async function submit(report: FeedbackReport, caller = client) {
    const { id, context, ...content } = report;
    return (await caller.request("sys.feedback", { id, context }, { body: bodyFromText(JSON.stringify(content)) })).data;
  }
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
    expect(await submit({ id, message: "A synthetic UI report", context: { platform: "web", view: "zen" } })).toEqual({ id });
    expect(await submit({ id, message: "A report with activity", activity: {
      pid: "proc:ship", messageCount: 1, text: "Synthetic user-authorized snapshot", truncated: false,
    } })).toEqual({ id });
    const shellId = crypto.randomUUID();
    const report = "PRIVATE_SHELL_REPORT_CONTENT";
    const uploaded = await client.request("fs.transfer.receive", { path: "/home/person/report.txt" }, { body: bodyFromText(report) });
    expect(uploaded.data.ok).toBe(true);
    const shell = await client.shell.exec({ input: `feedback --id ${shellId} < /home/person/report.txt` });
    expect(shell).toMatchObject({ status: "completed", exitCode: 0, output: `${JSON.stringify({ id: shellId })}\n` });
    expect(JSON.stringify(await client.sys.ledger.list({ limit: 200 }))).not.toContain(report);
    expect(await client.shell.exec({ input: "feedback unsupported-argument" })).toMatchObject({ status: "failed", exitCode: 1 });
    await expect(submit({ message: " " })).rejects.toThrow("Invalid feedback report");
    await expect(new GSVClient().requestOnce(url, "sys.feedback", {})).rejects.toThrow();
    const machineToken = await client.sys.token.create({ kind: "machine", peerId: "feedback-machine" });
    const machine = new GSVClient({ url, username: "person", token: machineToken.token.token, peer: { id: "feedback-machine", implements: ["fs.read"] } });
    try {
      const machineConnection = await machine.connect();
      expect(machineConnection.server.features ?? []).not.toContain("operator-feedback");
      await expect(submit({ message: "Machine report" }, machine)).rejects.toThrow();
    } finally { machine.close(); }
  });

  it("ends a stalled inbox call and accepts the same report on retry", async () => {
    const input = { id: crypto.randomUUID(), message: "Stall the first attempt" };
    await expect(submit(input)).rejects.toThrow("Feedback delivery timed out");
    expect(await submit(input)).toEqual({ id: input.id });
  });

  it("keeps report and activity content out of the syscall ledger", async () => {
    const id = crypto.randomUUID();
    const message = "PRIVATE_REPORT_CONTENT";
    const text = `PRIVATE_ACTIVITY_CONTENT ${"🛰️".repeat(10_000)}`;
    expect(await submit({ id, message, activity: { pid: "proc:ship", messageCount: 20, text, truncated: false } })).toEqual({ id });
    const { lines } = await client.sys.ledger.list({ callPrefix: "sys.feedback", limit: 20 });
    const line = lines.find(line => JSON.parse(line.args).id === id);
    expect(line).toBeDefined();
    expect(JSON.parse(line!.args)).toEqual({ id });
    expect(JSON.stringify(lines)).not.toContain("PRIVATE_REPORT_CONTENT");
    expect(JSON.stringify(lines)).not.toContain("PRIVATE_ACTIVITY_CONTENT");
  });

  it("rejects another report's receipt and accepts a matching receipt on retry", async () => {
    const input = { id: crypto.randomUUID(), message: "Misreport the first receipt" };
    await expect(submit(input)).rejects.toThrow("Invalid feedback receipt");
    expect(await submit(input)).toEqual({ id: input.id });
  });

  it("keeps rejected report content out of syscall errors, shell output and the full ledger", async () => {
    const input = { id: crypto.randomUUID(), message: "PRIVATE_REJECTED_REPORT_CONTENT", activity: {
      pid: "proc:ship", messageCount: 1, text: "PRIVATE_REJECTED_ACTIVITY_CONTENT", truncated: false,
    } };
    await expect(submit(input)).rejects.toThrow(/^Feedback delivery failed$/);
    const shellId = crypto.randomUUID();
    const uploaded = await client.request("fs.transfer.receive", { path: "/home/person/rejected-report.txt" }, { body: bodyFromText(input.message) });
    expect(uploaded.data.ok).toBe(true);
    expect(await client.shell.exec({ input: `feedback --id ${shellId} < /home/person/rejected-report.txt` })).toMatchObject({
      status: "failed", exitCode: 1, output: "feedback: Feedback delivery failed\n",
    });
    const ledger = await client.sys.ledger.list({ limit: 200 });
    for (const id of [input.id, shellId]) {
      expect(ledger.lines.find(line => line.call === "sys.feedback" && JSON.parse(line.args).id === id)).toMatchObject({
        outcome: "failed", error: "Feedback delivery failed",
      });
    }
    expect(JSON.stringify(ledger)).not.toContain(input.message);
    expect(JSON.stringify(ledger)).not.toContain(input.activity.text);
    expect(await submit(input)).toEqual({ id: input.id });
  });
});
