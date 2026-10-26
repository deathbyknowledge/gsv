import { describe, expect, it } from "vitest";
import { startProcessRuntimeHarness } from "./process-runtime-harness";
import { startOpenAiFixture } from "./openai-fixture";
import { z } from "zod";

describe("delegated approval journey", () => {
  it("notifies the human without waking the idle parent and restores the exact child approval after reconnect", async () => {
    const runtime = await startProcessRuntimeHarness();
    const childAi = await startOpenAiFixture();
    try {
      const parent = await runtime.spawn("delegation approval parent");
      await runtime.configureAi(parent.pid);
      const models = await runtime.client.sys.config.get({ key: "users/1000/ai/models" });
      const catalog = z.object({ models: z.array(z.record(z.string(), z.json())) }).parse(JSON.parse(models.entries[0]!.value));
      await runtime.client.sys.config.set({ key: "users/1000/ai/models", value: JSON.stringify({ version: 1, models: [
        ...catalog.models, { id: "child-model", name: "Child fixture", provider: "custom", model: "integration-model",
          baseUrl: childAi.baseUrl, providerStyle: "openai-chat-completions", transportTarget: "gsv" },
      ] }) });
      await runtime.client.sys.config.set({ key: "users/1000/ai/models/child-model/api_key", value: "fixture-only" });
      await runtime.client.sys.config.set({ key: "users/1000/ai/tools/approval", value: JSON.stringify({
        default: "auto", rules: [{ match: "net.fetch", action: "ask" }],
      }) });
      runtime.ai.enqueue(
        { kind: "tool-calls", calls: [{ id: "delegate", name: "Shell", arguments: {
          input: "proc delegate --as crew --model child-model --label ft-news 'Fetch the latest news'",
        } }] },
        { kind: "tool-calls", calls: [{ id: "yield-parent", name: "Shell", arguments: { input: "yield" } }] },
      );
      const heldChild = childAi.hold(
        { kind: "tool-calls", calls: [{ id: "fetch-news", name: "CodeMode", arguments: {
          code: `const response = await net.fetch({ url: ${JSON.stringify(`${runtime.ai.baseUrl}/approval-fixture`)} }); return response.status;`,
        } }] },
      );
      const sent = await runtime.client.proc.send({ pid: parent.pid, message: "Delegate the news lookup." });
      if (!sent.ok) throw new Error(sent.error);
      await heldChild.started;
      await runtime.waitFor(async () => {
        const state = await runtime.client.proc.history({ pid: parent.pid, format: 2 });
        return state.ok && state.activeRunId === null;
      }, "parent to yield before child approval", 20000);
      const parentBefore = await runtime.client.proc.history({ pid: parent.pid, format: 2 });
      const parentCalls = runtime.ai.requests.length;
      heldChild.release();
      await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) => signal === "proc.run.hil.requested"
        && payload.syscall === "net.fetch"), "delegated net.fetch approval", 20000);
      const child = (await runtime.client.proc.list({})).processes.find(({ label }) => label === "ft-news");
      if (!child) throw new Error("Delegated child is missing");
      expect(child.parentPid).toBe(parent.pid);
      expect(child.username).toBe("crew");
      expect(child.state).toBe("waiting_hil");
      const history = await runtime.client.proc.history({ pid: child.pid, includeMessages: false });
      if (!history.ok || !history.pendingHil) throw new Error("Child approval could not be loaded");
      const request = history.pendingHil;
      expect(request).toMatchObject({ pid: child.pid, runId: child.activeRunId, syscall: "net.fetch", target: "gsv" });
      expect(runtime.signals).toContainEqual(expect.objectContaining({ signal: "proc.changed", payload: expect.objectContaining({
        pid: child.pid, runtime: expect.objectContaining({ state: "waiting_hil", activeRunId: request.runId }),
      }) }));
      expect(await runtime.client.proc.history({ pid: parent.pid, format: 2 })).toEqual(parentBefore);
      expect(runtime.ai.requests).toHaveLength(parentCalls);
      runtime.client.close();
      await runtime.client.connect();
      expect(await runtime.client.proc.history({ pid: child.pid, includeMessages: false })).toMatchObject({ ok: true, pendingHil: request });
      expect(await runtime.client.proc.history({ pid: parent.pid, format: 2 })).toEqual(parentBefore);
      expect(runtime.ai.requests).toHaveLength(parentCalls);
      childAi.enqueue({ kind: "text", chunks: ["The fetch completed."] });
      expect(await runtime.client.proc.hil({ pid: child.pid, requestId: request.requestId, decision: "approve" }))
        .toMatchObject({ ok: true, pid: child.pid, requestId: request.requestId });
      await runtime.waitFor(async () => {
        const state = await runtime.client.proc.history({ pid: child.pid, includeMessages: false });
        return state.ok && state.activeRunId === null && state.pendingHil === null;
      }, "approved child completion", 20000);
      expect(await runtime.client.proc.hil({ pid: child.pid, requestId: request.requestId, decision: "approve" }))
        .toMatchObject({ ok: false });
    } finally { await runtime.close(); await childAi.close(); }
  });

  it("lets Always allow on the Ship cover the Crew child it delegates to", async () => {
    const runtime = await startProcessRuntimeHarness();
    const childAi = await startOpenAiFixture();
    try {
      const ship = await runtime.spawn("always allow ship");
      await runtime.configureAi(ship.pid);
      const models = await runtime.client.sys.config.get({ key: "users/1000/ai/models" });
      const catalog = z.object({ models: z.array(z.record(z.string(), z.json())) }).parse(JSON.parse(models.entries[0]!.value));
      await runtime.client.sys.config.set({ key: "users/1000/ai/models", value: JSON.stringify({ version: 1, models: [
        ...catalog.models, { id: "child-model", name: "Child fixture", provider: "custom", model: "integration-model",
          baseUrl: childAi.baseUrl, providerStyle: "openai-chat-completions", transportTarget: "gsv" },
      ] }) });
      await runtime.client.sys.config.set({ key: "users/1000/ai/models/child-model/api_key", value: "fixture-only" });
      await runtime.client.sys.config.set({ key: "users/1000/ai/tools/approval", value: JSON.stringify({
        default: "auto", rules: [{ match: "net.fetch", action: "ask" }],
      }) });
      const fetchFixture = `const response = await net.fetch({ url: ${JSON.stringify(`${runtime.ai.baseUrl}/approval-fixture`)} }); return response.status;`;
      runtime.ai.enqueue(
        { kind: "tool-calls", calls: [{ id: "ship-fetch", name: "CodeMode", arguments: { code: fetchFixture } }] },
        { kind: "tool-calls", calls: [{ id: "ship-yield", name: "Shell", arguments: { input: "yield" } }] },
      );
      const sent = await runtime.client.proc.send({ pid: ship.pid, message: "Fetch the fixture." });
      if (!sent.ok) throw new Error(sent.error);
      await runtime.waitFor(async () => {
        const state = await runtime.client.proc.history({ pid: ship.pid, includeMessages: false });
        return state.ok && state.pendingHil !== null;
      }, "the Ship's net.fetch approval", 20000);
      const asked = await runtime.client.proc.history({ pid: ship.pid, includeMessages: false });
      if (!asked.ok || !asked.pendingHil) throw new Error("The Ship's approval could not be loaded");
      expect(asked.pendingHil).toMatchObject({ syscall: "net.fetch", target: "gsv" });
      expect(await runtime.client.proc.hil({ pid: ship.pid, requestId: asked.pendingHil.requestId, decision: "approve", remember: true }))
        .toMatchObject({ ok: true, remembered: true });
      await runtime.waitFor(async () => {
        const state = await runtime.client.proc.history({ pid: ship.pid, includeMessages: false });
        return state.ok && state.activeRunId === null;
      }, "the Ship to finish its fetch", 20000);
      const policy = await runtime.client.sys.config.get({ key: "users/1000/ai/tools/approval" });
      expect(JSON.parse(policy.entries[0]!.value).rules[0]).toEqual({ match: "net.fetch", target: "gsv", action: "auto" });

      runtime.ai.enqueue(
        { kind: "tool-calls", calls: [{ id: "delegate", name: "Shell", arguments: {
          input: "proc delegate --as crew --model child-model --label fixture-fetch 'Fetch the fixture'",
        } }] },
        { kind: "tool-calls", calls: [{ id: "delegate-yield", name: "Shell", arguments: { input: "yield" } }] },
      );
      childAi.enqueue(
        { kind: "tool-calls", calls: [{ id: "child-fetch", name: "CodeMode", arguments: { code: fetchFixture } }] },
        { kind: "text", chunks: ["The fetch completed."] },
      );
      const delegated = await runtime.client.proc.send({ pid: ship.pid, message: "Have Crew fetch it too." });
      if (!delegated.ok) throw new Error(delegated.error);
      await runtime.waitFor(async () => {
        const child = (await runtime.client.proc.list({})).processes.find(({ label }) => label === "fixture-fetch");
        if (!child) return false;
        const state = await runtime.client.proc.history({ pid: child.pid, includeMessages: false });
        return state.ok && state.activeRunId === null && childAi.requests.length === 2;
      }, "the Crew child to fetch without asking", 20000);
      const child = (await runtime.client.proc.list({})).processes.find(({ label }) => label === "fixture-fetch")!;
      expect(child.username).toBe("crew");
      expect(runtime.signals.filter(({ signal, payload }) => signal === "proc.run.hil.requested" && payload.pid === child.pid)).toEqual([]);
    } finally { await runtime.close(); await childAi.close(); }
  });
});
