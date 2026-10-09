import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startOpenAiFixture } from "./openai-fixture";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

describe("delegated cancellation journey", () => {
  it("returns an interrupted child's assignment to Ship with an aborted outcome", async () => {
    const runtime = await startProcessRuntimeHarness();
    const childAi = await startOpenAiFixture();
    const heldChild = childAi.hold({ kind: "text", chunks: ["Late child output"] });
    let childPid: string | undefined;
    let responsibilityId: string | undefined;
    try {
      const parent = (await runtime.client.proc.list({})).processes.find(({ personal }) => personal);
      if (!parent) throw new Error("Setup did not create Ship");
      const initial = await runtime.client.r12y.list({});
      for (const responsibility of initial.responsibilities) {
        await runtime.client.r12y.update({ id: responsibility.id, patch: { state: "resolved" } });
      }
      const created = await runtime.client.r12y.create({ title: "Review the synthetic deployment" });
      responsibilityId = created.responsibility.id;
      await runtime.client.r12y.update({ id: responsibilityId, patch: { state: "waiting", blocker: "Waiting for the test request" } });
      await runtime.waitFor(async () => {
        const history = await runtime.client.proc.history({ pid: parent.pid, includeMessages: false });
        return history.ok && history.activeRunId === null;
      }, "Ship to finish setup");
      await runtime.configureAi(parent.pid);
      const models = await runtime.client.sys.config.get({ key: "users/1000/ai/models" });
      const catalog = z.object({ models: z.array(z.record(z.string(), z.json())) }).parse(JSON.parse(models.entries[0]!.value));
      await runtime.client.sys.config.set({ key: "users/1000/ai/models", value: JSON.stringify({ version: 1, models: [
        ...catalog.models, { id: "child-model", name: "Child fixture", provider: "custom", model: "integration-model",
          baseUrl: childAi.baseUrl, providerStyle: "openai-chat-completions", transportTarget: "gsv" },
      ] }) });
      await runtime.client.sys.config.set({ key: "users/1000/ai/models/child-model/api_key", value: "fixture-only" });
      await runtime.client.sys.config.set({ key: "users/1000/ai/tools/approval", value: JSON.stringify({ default: "auto", rules: [] }) });
      runtime.ai.enqueue(
        { kind: "tool-calls", calls: [{ id: "delegate", name: "Shell", arguments: {
          input: `proc delegate --as crew --model child-model --label cancelled-worker --responsibility ${responsibilityId} 'Review the deployment'`,
        } }] },
        { kind: "tool-calls", calls: [{ id: "yield-parent", name: "Shell", arguments: { input: "yield" } }] },
      );
      const sent = await runtime.client.proc.send({ pid: parent.pid, message: "Delegate the deployment review." });
      if (!sent.ok) throw new Error(sent.error);
      await childAi.waitForRequests(1);
      const child = (await runtime.client.proc.list({})).processes.find(({ label }) => label === "cancelled-worker");
      if (!child) throw new Error("Delegated child is missing");
      childPid = child.pid;
      expect((await runtime.client.r12y.get({ id: responsibilityId })).responsibility.assignee)
        .toEqual({ kind: "process", processId: childPid });
      await runtime.waitFor(async () => {
        const history = await runtime.client.proc.history({ pid: parent.pid, includeMessages: false });
        return history.ok && history.activeRunId === null;
      }, "the parent to yield");

      expect(await runtime.client.proc.abort({ pid: childPid })).toMatchObject({ ok: true });
      await runtime.waitFor(async () => {
        const { responsibility } = await runtime.client.r12y.get({ id: responsibilityId! });
        return responsibility.assignee.kind === "ship";
      }, "the interrupted assignment to return to Ship");
      const { responsibility } = await runtime.client.r12y.get({ id: responsibilityId });
      expect(responsibility).toMatchObject({
        state: "open",
        assignee: { kind: "ship" },
        blocker: expect.stringContaining("Target run was aborted"),
        details: { delegation: {
          eventType: "process.delegation.aborted", processId: childPid,
          runId: child.activeRunId, status: "completed", runStatus: "aborted",
        } },
      });
      heldChild.release();
      runtime.client.close();
      await runtime.client.connect();
      expect((await runtime.client.r12y.get({ id: responsibilityId })).responsibility.details?.delegation)
        .toEqual(responsibility.details?.delegation);
    } finally {
      heldChild.release();
      if (childPid) await runtime.client.proc.kill({ pid: childPid, archive: false }).catch(() => {});
      if (responsibilityId) await runtime.client.r12y.update({ id: responsibilityId, patch: { state: "resolved" } }).catch(() => {});
      await runtime.close();
      await childAi.close();
    }
  });
});
