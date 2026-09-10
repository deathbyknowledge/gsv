import { describe, expect, it } from "vitest";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

describe("waiting responsibility reviews", () => {
  it("persists the default and wakes Ship to review an elapsed check without sending a reminder automatically", async () => {
    const runtime = await startProcessRuntimeHarness();
    const held = runtime.ai.hold({ kind: "tool-calls", calls: [{ id: "initial-wait", name: "Shell", arguments: { input: "yield" } }] });
    const releases = [held.release];
    let responsibilityId: string | undefined;
    try {
      const ship = (await runtime.client.proc.list({})).processes.find(({ personal }) => personal);
      if (!ship) throw new Error("Setup did not create Ship");
      await runtime.configureAi(ship.pid);
      await runtime.client.sys.config.set({ key: `users/${ship.uid}/ai/tools/approval`, value: JSON.stringify({ default: "auto", rules: [] }) });
      const { conversation } = await runtime.client.conversation.ship({});
      const beforeMessages = await runtime.client.conversation.history({ conversationId: conversation.id });
      const created = await runtime.client.r12y.create({ title: "Confirm a synthetic plan" });
      responsibilityId = created.responsibility.id;
      const beforeWaiting = Date.now();
      const waiting = await runtime.client.r12y.update({
        id: responsibilityId, expectedRevision: created.responsibility.revision,
        patch: { state: "waiting", blocker: "Waiting for your answer" },
      });
      const check = waiting.responsibility.nextCheckAtMs!;
      expect(check).toBeGreaterThanOrEqual(beforeWaiting + 86_400_000);
      expect(check).toBeLessThanOrEqual(Date.now() + 86_400_000);
      await held.started;
      held.release();
      await runtime.waitFor(async () => {
        const history = await runtime.client.proc.history({ pid: ship.pid });
        return history.ok && history.activeRunId === null;
      }, "initial waiting decision to yield");
      runtime.client.close();
      await runtime.client.connect();
      expect((await runtime.client.r12y.get({ id: responsibilityId })).responsibility.nextCheckAtMs).toBe(check);

      runtime.ai.enqueue({ kind: "tool-calls", calls: [{ id: "explicit-deferral", name: "Shell", arguments: { input: "yield" } }] });
      const review = runtime.ai.hold({ kind: "tool-calls", calls: [{ id: "attempt-skip-review", name: "Shell", arguments: { input: "yield" } }] });
      releases.push(review.release);
      const checkAt = Date.now() + 5_000;
      await runtime.client.r12y.update({ id: responsibilityId, patch: { nextCheckAtMs: checkAt } });
      await review.started;
      expect(Date.now()).toBeGreaterThanOrEqual(checkAt);
      const dueRequestIndex = runtime.ai.requests.length;
      runtime.ai.enqueue(
        { kind: "tool-calls", calls: [{ id: "resolve-reviewed-question", name: "Shell", arguments: { input: `r12y update ${responsibilityId} --json '{"state":"resolved"}'` } }] },
        { kind: "tool-calls", calls: [{ id: "finish-review", name: "Shell", arguments: { input: "yield" } }] },
      );
      review.release();
      await runtime.waitFor(async () => (await runtime.client.r12y.get({ id: responsibilityId! })).responsibility.state === "resolved", "Ship to resolve the reviewed question");
      await runtime.waitFor(async () => {
        const history = await runtime.client.proc.history({ pid: ship.pid });
        return history.ok && history.activeRunId === null;
      }, "review run to yield");
      expect(JSON.stringify(runtime.ai.requests[dueRequestIndex]?.messages)).toContain("responsibility batch still contains unhandled work");
      expect((await runtime.client.conversation.history({ conversationId: conversation.id })).messages).toEqual(beforeMessages.messages);
    } finally {
      for (const release of releases) release();
      if (responsibilityId) await runtime.client.r12y.update({ id: responsibilityId, patch: { state: "resolved" } }).catch(() => {});
      await runtime.close();
    }
  });
});
