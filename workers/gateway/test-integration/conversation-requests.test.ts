import { describe, expect, it } from "vitest";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

describe("ordinary contextual requests over the authenticated protocol", () => {
  it("commits edited text, submits it to Ship once, and retains it in history", async () => {
    const runtime = await startProcessRuntimeHarness();
    try {
      const { conversation } = await runtime.client.conversation.ship({});
      if (!conversation.handlerPid) throw new Error("Ship must have a process");
      await runtime.configureAi(conversation.handlerPid);
      const text = "Help me create a routine, but only on Mondays.\n\nCheck my calendar at 9am.";
      runtime.ai.enqueue({ kind: "message", text: "What time would you like that update?" });
      const request = { conversationId: conversation.id, text, idempotencyKey: "plain-request" };
      const sent = await runtime.client.conversation.send(request);
      await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) =>
        signal === "proc.run.finished" && payload.runId === sent.runId), "Ship's reply to commit");
      expect(sent.message).toMatchObject({ text });
      expect(sent.message).not.toHaveProperty("action");
      const retried = await runtime.client.conversation.send(request);
      expect(retried.message).toEqual(sent.message);
      const history = await runtime.client.conversation.history({ conversationId: conversation.id });
      expect(history.messages.filter((message) => message.author.kind === "user")).toEqual([sent.message]);
      expect(history.messages.at(-1)?.text).toBe("What time would you like that update?");
      const process = await runtime.client.proc.history({ pid: conversation.handlerPid, format: 2, tail: true });
      expect(JSON.stringify(process)).toContain(JSON.stringify(text).slice(1, -1));
    } finally {
      await runtime.close();
    }
  });
});
