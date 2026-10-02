import { GSVClient } from "@humansandmachines/gsv";
import { describe, expect, it } from "vitest";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

describe("concurrent UI sessions", () => {
  it("keeps two same-name clients live, synchronizes messages, and recovers history after reconnect", async () => {
    const runtime = await startProcessRuntimeHarness();
    const windows: GSVClient[] = [];
    try {
      const { token } = await runtime.client.sys.token.create({ kind: "human", label: "Remembered UI session", expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
      const status = runtime.client.getStatus();
      const received: unknown[][] = [[], []];
      for (const index of [0, 1]) {
        const client = new GSVClient({ url: status.url!, username: status.username!, token: token.token,
          peer: { id: "gsv-ui", version: "test", platform: index === 0 ? "browser" : "desktop" } });
        windows.push(client);
        client.onSignal((signal, payload) => { if (signal === "message.committed") received[index].push(payload); });
        await client.connect();
      }
      const [first, second] = windows;
      expect(first.getStatus().connectionId).not.toBe(second.getStatus().connectionId);
      const { conversation } = await first.conversation.ship({});
      if (!conversation.handlerPid) throw new Error("Ship must have a process");
      await runtime.configureAi(conversation.handlerPid);
      runtime.ai.enqueue({ kind: "message", text: "First reply." });
      await first.conversation.send({ conversationId: conversation.id, text: "First question." });
      await runtime.waitFor(() => received.every(messages => messages.length === 2), "both windows to receive the question and reply");
      expect(first.isConnected()).toBe(true);
      expect(second.isConnected()).toBe(true);
      const history = await first.conversation.history({ conversationId: conversation.id });
      expect((await second.conversation.history({ conversationId: conversation.id })).messages).toEqual(history.messages);
      expect(history.messages[0].origin).toEqual({ kind: "client", clientId: "gsv-ui", platform: "browser" });
      const lastSequence = history.messages.at(-1)!.sequence;

      second.disconnect();
      runtime.ai.enqueue({ kind: "message", text: "Second reply." });
      await first.conversation.send({ conversationId: conversation.id, text: "Second question." });
      await runtime.waitFor(() => received[0].length === 4, "the second reply to commit");
      await second.connect();
      const missed = await second.conversation.history({ conversationId: conversation.id, afterSequence: lastSequence });
      expect(missed.messages.map(message => message.text)).toEqual(["Second question.", "Second reply."]);
      expect(first.isConnected()).toBe(true);
    } finally {
      for (const client of windows) client.close();
      await runtime.close();
    }
  });
});
