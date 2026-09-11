import { describe, expect, it } from "vitest";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

describe("process runtime harness isolation", () => {
  it("keeps an unconfigured background process out of the foreground response queue", async () => {
    const runtime = await startProcessRuntimeHarness();
    const held = runtime.ai.hold({ kind: "message", text: "Reserved foreground reply" });
    try {
      const foreground = await runtime.spawn("scripted foreground");
      await runtime.configureAi(foreground.pid);
      const background = await runtime.spawn("unconfigured background");
      expect(await runtime.client.proc.ai.config.get({ pid: background.pid })).toMatchObject({
        ok: true, config: null,
      });
      const backgroundRun = await runtime.client.proc.send({ pid: background.pid, message: "Run background work." });
      if (!backgroundRun.ok) throw new Error(backgroundRun.error);
      await runtime.waitFor(async () => {
        const history = await runtime.client.proc.history({ pid: background.pid });
        return runtime.ai.requests.length > 0 || (history.ok && history.messages.some(({ role }) => role === "assistant"));
      }, "background inference without consuming the reserved response");
      expect(runtime.ai.requests).toHaveLength(0);
      const backgroundHistory = await runtime.client.proc.history({ pid: background.pid });
      expect(backgroundHistory).toMatchObject({ ok: true, context: { provider: "workers-ai" } });
      expect(await runtime.client.proc.abort({ pid: background.pid })).toMatchObject({ ok: true });

      const foregroundRun = await runtime.client.proc.send({ pid: foreground.pid, message: "Run foreground work." });
      if (!foregroundRun.ok) throw new Error(foregroundRun.error);
      await held.started;
      expect(runtime.ai.requests).toHaveLength(1);
      expect(runtime.ai.requests[0]).toMatchObject({ model: "integration-model", usesFixtureCredential: true });
      expect(runtime.ai.requests[0].messages).toContainEqual(expect.objectContaining({
        role: "user", content: expect.stringContaining("Run foreground work."),
      }));
      held.release();
      await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) => (
        signal === "proc.run.finished" && payload.runId === foregroundRun.runId
      )), "reserved foreground response to finish");
      const { conversation } = await runtime.client.conversation.forProcess({ pid: foreground.pid });
      expect((await runtime.client.conversation.history({ conversationId: conversation.id })).messages.at(-1)?.text)
        .toBe("Reserved foreground reply");
      expect(runtime.ai.requests).toHaveLength(1);
    } finally {
      held.release();
      await runtime.close();
    }
  });
});
