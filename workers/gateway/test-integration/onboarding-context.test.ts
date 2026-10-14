import { describe, expect, it } from "vitest";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

describe("new Ship browser discovery", () => {
  it("includes cloud browser guidance in the first prompt without a connected browser", async () => {
    const runtime = await startProcessRuntimeHarness();
    const held = runtime.ai.hold({ kind: "tool-calls", calls: [{ id: "wait-for-user", name: "Send", arguments: { yield: true } }] });
    try {
      const ship = (await runtime.client.proc.list({})).processes.find(({ personal }) => personal);
      if (!ship) throw new Error("Setup did not create Ship");
      await runtime.configureAi(ship.pid);
      const sent = await runtime.client.proc.send({ pid: ship.pid, message: "Can you look me up online?" });
      if (!sent.ok) throw new Error(sent.error);
      await held.started;
      const context = JSON.stringify(runtime.ai.requests[0]?.messages).replace(/\\n/g, " ");
      expect(context).toContain("on-demand cloud browser");
      expect(context).toContain("instance catalog");
      expect(context).toContain("skills show browser-target");
      expect(context).toContain("onboarding.initial");
      expect(context).toContain("Available targets: - gsv");
      held.release();
      await runtime.waitFor(async () => {
        const history = await runtime.client.proc.history({ pid: ship.pid });
        return history.ok && history.activeRunId === null;
      }, "first onboarding turn to yield");
    } finally {
      held.release();
      await runtime.close();
    }
  });
});
