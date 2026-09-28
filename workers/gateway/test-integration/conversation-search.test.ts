import { describe, expect, it } from "vitest";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

describe("conversation search over the authenticated protocol", () => {
  it("searches committed messages from a client and from Ship, and reads around a match", async () => {
    const runtime = await startProcessRuntimeHarness();
    try {
      const { conversation } = await runtime.client.conversation.ship({});
      await runtime.configureAi(conversation.handlerPid);
      runtime.ai.enqueue({ kind: "message", text: "Rotterdam cafés open at nine." });
      const sent = await runtime.client.conversation.send({ conversationId: conversation.id, text: "Find Rotterdam cafés." });
      await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) => (
        signal === "proc.run.finished" && payload.runId === sent.runId
      )), "the first reply to commit");

      const first = await runtime.client.conversation.search({ query: "rotter cafe", limit: 1 });
      expect(first.conversation.id).toBe(conversation.id);
      expect(first.indexing).toBe(false);
      expect(first.hits).toHaveLength(1);
      expect(first.hits[0].snippet).toBe("Rotterdam cafés open at nine.");
      expect(first.nextBeforeSequence).toBe(first.hits[0].sequence);
      const older = await runtime.client.conversation.search({ query: "rotter cafe", beforeSequence: first.nextBeforeSequence!, limit: 1 });
      expect(older.hits[0].id).toBe(sent.message.id);
      expect(older.nextBeforeSequence).toBeNull();
      const later = await runtime.client.conversation.history({ conversationId: conversation.id, afterSequence: sent.message.sequence, limit: 1 });
      expect(later.messages[0].id).toBe(first.hits[0].id);
      await expect(runtime.client.conversation.history({ conversationId: conversation.id, beforeSequence: 5, afterSequence: 1 }))
        .rejects.toThrow("cannot be combined");

      runtime.ai.enqueue(
        { kind: "tool-calls", calls: [{ id: "search-conversation", name: "Shell", arguments: { input: "message search 'rotter cafe' --json" } }] },
        { kind: "message", text: "Found our earlier discussion." },
      );
      const searched = await runtime.client.conversation.send({ conversationId: conversation.id, text: "Look up what we discussed." });
      await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) => (
        signal === "proc.run.finished" && payload.runId === searched.runId
      )), "Ship's search to finish");
      const history = await runtime.client.proc.history({ pid: conversation.handlerPid, format: 2, tail: true });
      if (!history.ok || history.format !== 2) throw new Error("Expected typed history");
      const result = history.records.find((record) => record.kind === "result" && record.payload.callId === "search-conversation");
      expect(result).toMatchObject({ kind: "result", payload: { outcome: "completed" } });
      expect(JSON.stringify(result)).toContain("Rotterdam cafés open at nine.");
      expect(JSON.stringify(result)).toContain(sent.message.id);
    } finally {
      await runtime.close();
    }
  });
});
