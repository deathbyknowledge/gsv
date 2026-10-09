import { describe, expect, it } from "vitest";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

describe("waiting responsibility reviews", () => {
  it("commits an onboarding reply before Ship handles the work that blocks yielding", async () => {
    const runtime = await startProcessRuntimeHarness();
    const releases: Array<() => void> = [];
    try {
      const ship = (await runtime.client.proc.list({})).processes.find(({ personal }) => personal);
      if (!ship) throw new Error("Setup did not create Ship");
      await runtime.configureAi(ship.pid);
      await runtime.client.sys.config.set({ key: `users/${ship.uid}/ai/tools/approval`, value: JSON.stringify({ default: "auto", rules: [] }) });
      const onboarding = (await runtime.client.r12y.list({})).responsibilities.find(
        ({ details }) => details?.responsibilityType === "onboarding.initial",
      );
      if (!onboarding) throw new Error("Setup did not create the onboarding responsibility");
      const { conversation } = await runtime.client.conversation.ship({});
      const text = "What would you like me to look up?";
      runtime.ai.enqueue(
        { kind: "tool-calls", calls: [{ id: "begin-onboarding", name: "Shell", arguments: { input: `r12y update ${onboarding.id} --json '{"state":"active","blocker":null}'` } }] },
      );
      const reply = runtime.ai.hold({ kind: "tool-calls", calls: [{ id: "onboarding-question", name: "Send", arguments: { text, yield: true } }] });
      releases.push(reply.release);
      const held = runtime.ai.hold({
        kind: "tool-calls", calls: [{ id: "wait-for-answer", name: "Shell", arguments: { input: `r12y update ${onboarding.id} --json '{"state":"waiting","blocker":"Waiting for your answer"}'` } }],
      });
      releases.push(held.release);
      runtime.ai.enqueue({ kind: "tool-calls", calls: [{ id: "finish-onboarding-turn", name: "Send", arguments: { yield: true } }] });
      const sent = await runtime.client.proc.send({ pid: ship.pid, message: "Hello, I would like some help." });
      if (!sent.ok) throw new Error(sent.error);
      await reply.started;
      await runtime.waitFor(async () => {
        const history = await runtime.client.proc.history({ pid: ship.pid, format: 2 });
        return history.ok && history.format === 2 && history.records.some((record) =>
          record.kind === "event" && record.payload.kind === "responsibility.ready"
          && record.payload.payload.responsibilityIds.includes(onboarding.id));
      }, "onboarding responsibility batch to reach the active run");
      reply.release();
      await held.started;

      const messages = await runtime.client.conversation.history({ conversationId: conversation.id });
      expect(messages.messages.filter(({ author }) => author.kind === "process").map(({ text }) => text)).toEqual([text]);
      expect(await runtime.client.proc.history({ pid: ship.pid })).toMatchObject({ activeRunId: sent.runId });
      expect(runtime.signals).toContainEqual(expect.objectContaining({
        signal: "message.committed", payload: expect.objectContaining({ message: expect.objectContaining({ text }) }),
      }));
      expect(runtime.signals.some(({ signal }) => signal === "message.aborted")).toBe(false);
      const continuation = JSON.stringify(runtime.ai.requests.at(-1)?.messages);
      expect(continuation).toContain("Message committed; run remains active");
      expect(continuation).toContain(onboarding.id);

      held.release();
      await runtime.waitFor(async () => {
        const history = await runtime.client.proc.history({ pid: ship.pid });
        return history.ok && history.activeRunId === null;
      }, "Ship to yield after deferring onboarding");
      expect((await runtime.client.conversation.history({ conversationId: conversation.id })).messages).toEqual(messages.messages);
    } finally {
      for (const release of releases) release();
      await runtime.close();
    }
  });

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
      const scheduled = await runtime.client.r12y.update({ id: responsibilityId, patch: { nextCheckAtMs: checkAt } });
      await review.started;
      expect(Date.now()).toBeGreaterThanOrEqual(checkAt);
      expect((await runtime.client.r12y.get({ id: responsibilityId })).responsibility.revision).toBe(scheduled.responsibility.revision);
      const reviewContext = JSON.stringify(runtime.ai.requests.at(-1)?.messages);
      expect(reviewContext).toContain("Responsibility review requested at");
      expect(reviewContext).toContain(responsibilityId);
      expect(reviewContext).toContain("use Send to remind them of the specific question or decision");
      expect(reviewContext).toContain("not by itself a reason to silently move the check forward again");
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
