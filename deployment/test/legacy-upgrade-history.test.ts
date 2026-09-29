import { describe, expect, it, vi } from "vitest";
import type { AiModelsResult } from "@humansandmachines/gsv/protocol/syscalls/ai";
import type { ConversationMessage, ConversationSummary } from "@humansandmachines/gsv/protocol/syscalls/conversation";
import type { ProcHistoryRecordsResult } from "@humansandmachines/gsv/protocol/syscalls/proc";
import type { ProcHistoryRecord } from "@humansandmachines/gsv/protocol/history";
import { captureLegacyUpgradeHistory, legacyHistoryProofSchema, seedLegacyUpgradeHistory, verifyLegacyUpgradeHistory } from "../acceptance/legacy-upgrade/history-proof.ts";
import { stableOpaqueId } from "../../workers/gateway/src/shared/stable-id.ts";

const intent = { pid: "proc:fixture", conversationId: "conversation:fixture", idempotencyKey: "persisted-fixture-key", sentinel: "private fixture history sentinel" };
const messageId = await stableOpaqueId("msg", [intent.conversationId, intent.idempotencyKey]);
const runId = `run:${messageId}`;
function fixture() {
  const summary: ConversationSummary = { id: intent.conversationId, kind: "ship", ownerUid: 1000, title: null,
    handlerPid: intent.pid, latestSequence: 1, createdAt: 1, updatedAt: 2 };
  const message: ConversationMessage = { id: messageId, conversationId: intent.conversationId, sequence: 1,
    author: { kind: "user", uid: 1000 }, text: intent.sentinel, origin: { kind: "client", clientId: "fixture" },
    processId: intent.pid, runId, createdAt: 2 };
  const records: ProcHistoryRecord[] = [
    { id: 1, messageId: 1, index: 0, generation: 0, runId, createdAt: 2, source: "typed", kind: "message",
      payload: { direction: "in", text: intent.sentinel, media: [], origin: { kind: "conversation.message" } } },
    { id: 2, messageId: 2, index: 0, generation: 0, runId, createdAt: 3, source: "typed", kind: "event",
      payload: { kind: "generation.failed", severity: "error", audience: "both",
        payload: { reason: "generation.error", error: "GSV inference is unavailable", provider: "gsv", model: "default" } } },
  ];
  const process: ProcHistoryRecordsResult = { ok: true, pid: intent.pid, format: 2, messages: [], messageCount: 2, records,
    historyRevision: 2, historyGeneration: 0, historyResetRevision: 0, reset: false, hasMore: false, activeRunId: null };
  const models: AiModelsResult = { models: [{ id: "gsv-included", name: "GSV Included", provider: "gsv", model: "default",
    source: "base", hasCredential: false }], preferredModelId: null };
  const client: Parameters<typeof seedLegacyUpgradeHistory>[0]["client"] = {
    ai: { models: vi.fn(async () => models) },
    conversation: {
      forProcess: vi.fn(async () => ({ conversation: summary })),
      send: vi.fn(async () => ({ message: structuredClone(message), handlerPid: intent.pid, runId })),
      history: vi.fn(async () => ({ conversation: summary, messages: [message], hasMore: false })),
    },
    proc: { history: vi.fn(async () => process) },
  };
  return { client, models, summary, message, process, records };
}
const seed = (client: ReturnType<typeof fixture>["client"]) => seedLegacyUpgradeHistory({ client, intent,
  phase: "seed-legacy", managedInferenceEnabled: false, timeoutMs: 0 });

describe("genuine legacy history proof", () => {
  it("sends only a guarded fixture-local plaintext message and retains content hashes without its text", async () => {
    const { client } = fixture();
    const proof = await seed(client);
    expect(client.conversation.send).toHaveBeenCalledExactlyOnceWith({ conversationId: intent.conversationId,
      text: intent.sentinel, idempotencyKey: intent.idempotencyKey });
    expect(proof.processInput.id).toBe(1);
    expect(proof.processError.id).toBe(2);
    expect(JSON.stringify(proof)).not.toContain(intent.sentinel);
    expect(JSON.stringify(proof)).not.toContain(intent.idempotencyKey);
    await verifyLegacyUpgradeHistory({ client, intent, proof: legacyHistoryProofSchema.parse(JSON.parse(JSON.stringify(proof))) });
    expect(client.conversation.send).toHaveBeenCalledTimes(1);
  });

  it("refuses every external or owner-added model before sending", async () => {
    for (const mutation of ["empty", "external", "personal"] as const) {
      const { client, models } = fixture();
      if (mutation === "empty") models.models = [];
      if (mutation === "external") models.models.push({ ...models.models[0], provider: "workers-ai" });
      if (mutation === "personal") models.models[0].source = "personal";
      await expect(seed(client)).rejects.toThrow("only the disabled");
      expect(client.conversation.send).not.toHaveBeenCalled();
    }
  });

  it("requires literal disabled inference and explicit seed phase at runtime", async () => {
    const { client } = fixture();
    for (const override of [{ managedInferenceEnabled: true }, { phase: "verify-current" }]) {
      // Exercise untyped JSON/CLI callers at this destructive boundary.
      const input = { client, intent, phase: "seed-legacy", managedInferenceEnabled: false, ...override };
      // @ts-expect-error Deliberately supply values rejected by the public signature.
      await expect(seedLegacyUpgradeHistory(input)).rejects.toThrow("Explicit legacy history authorization");
    }
    expect(client.conversation.send).not.toHaveBeenCalled();
  });

  it("rejects another conversation or handler before sending", async () => {
    const { client, summary } = fixture();
    summary.handlerPid = "another-process";
    await expect(seed(client)).rejects.toThrow("own Ship");
    expect(client.conversation.send).not.toHaveBeenCalled();
  });

  it("does not certify pending, missing, duplicated or unrelated failures", async () => {
    for (const mutation of ["active", "missing", "duplicate", "unexpected"] as const) {
      const { client, process, records } = fixture();
      if (mutation === "active") process.activeRunId = runId;
      if (mutation === "missing") records.pop();
      if (mutation === "duplicate") records.push(structuredClone(records[0]));
      if (mutation === "unexpected") {
        const record = records[1];
        if (record.kind === "event" && record.payload.kind === "generation.failed") record.payload.payload.error = "Network failure";
      }
      await expect(seed(client)).rejects.toThrow();
    }
  });

  it("waits for terminal state before capturing even when both records already exist", async () => {
    const { client, process } = fixture();
    vi.mocked(client.proc.history).mockResolvedValueOnce({ ...process, activeRunId: runId });
    const proof = await seedLegacyUpgradeHistory({ client, intent, phase: "seed-legacy", managedInferenceEnabled: false,
      timeoutMs: 1000, pollIntervalMs: 0 });
    expect(proof.runId).toBe(runId);
    expect(client.proc.history).toHaveBeenCalledTimes(2);
  });

  it("propagates an uncertain admission rather than inventing a receipt or retrying", async () => {
    const { client } = fixture();
    vi.mocked(client.conversation.send).mockRejectedValueOnce(new Error("Lost admission reply"));
    await expect(seed(client)).rejects.toThrow("Lost admission reply");
    expect(client.conversation.send).toHaveBeenCalledTimes(1);
    expect(client.proc.history).not.toHaveBeenCalled();
  });

  it("ignores mutable status/cursors but detects changed stored content and identity after migration", async () => {
    for (const mutation of ["mutable", "message", "input", "error-id", "missing"] as const) {
      const { client, process, message, records } = fixture();
      const proof = await seed(client);
      process.cursor = "new-current-cursor"; process.contextRevision = 20; process.historyRevision += 5;
      if (mutation === "message") message.text = "changed conversation text";
      if (mutation === "input" && records[0].kind === "message") records[0].payload.text = "changed Process text";
      if (mutation === "error-id") records[1].id = 9;
      if (mutation === "missing") records.pop();
      const verified = verifyLegacyUpgradeHistory({ client, intent, proof });
      if (mutation === "mutable") await expect(verified).resolves.toBeUndefined();
      else await expect(verified).rejects.toThrow(/content or identity changed/);
      expect(client.conversation.send).toHaveBeenCalledTimes(1);
    }
  });

  it("binds reloaded proof to the exact persisted intent before any history request", async () => {
    const { client } = fixture();
    const proof = await seed(client);
    vi.mocked(client.proc.history).mockClear();
    await expect(verifyLegacyUpgradeHistory({ client, intent: { ...intent, idempotencyKey: "different" }, proof })).rejects.toThrow("another persisted intent");
    expect(client.proc.history).not.toHaveBeenCalled();
  });

  it("preserves the entire existing prefix while allowing later machine events", async () => {
    const { client, records } = fixture();
    const earlier: ProcHistoryRecord = { id: 3, messageId: 3, index: 0, generation: 0, runId: null, createdAt: 1,
      source: "typed", kind: "note", payload: { text: "existing note", thinking: [] } };
    records.unshift(earlier);
    const proof = await seed(client);
    expect(proof.processPrefix).toHaveLength(3);
    records.push({ ...earlier, id: 4, messageId: 4, createdAt: 4, payload: { text: "new connection note", thinking: [] } });
    await expect(verifyLegacyUpgradeHistory({ client, intent, proof })).resolves.toBeUndefined();
    earlier.payload.text = "edited old note";
    await expect(verifyLegacyUpgradeHistory({ client, intent, proof })).rejects.toThrow("prefix content");
    earlier.payload.text = "existing note";
    [records[0], records[1]] = [records[1], records[0]];
    await expect(verifyLegacyUpgradeHistory({ client, intent, proof })).rejects.toThrow("prefix content");
  });

  it("rejects incomplete history windows instead of certifying a prefix from a truncated tail", async () => {
    const { client, process } = fixture();
    process.hasMoreBefore = true;
    await expect(seed(client)).rejects.toThrow("complete bounded evidence window");
  });

  it("recovers an already committed deterministic intent without sending or creating a second message", async () => {
    const { client } = fixture();
    const proof = await captureLegacyUpgradeHistory({ client, intent, phase: "capture-legacy", managedInferenceEnabled: false, timeoutMs: 0 });
    expect(proof.conversation.id).toBe(messageId);
    expect(proof.runId).toBe(runId);
    expect(proof.conversationPrefix).toHaveLength(1);
    expect(proof.processPrefix).toHaveLength(2);
    expect(client.conversation.send).not.toHaveBeenCalled();
    await verifyLegacyUpgradeHistory({ client, intent, proof });
    expect(client.conversation.send).not.toHaveBeenCalled();
  });

  it("never sends while capturing an absent, wrong-author, changed-text or wrong-run intent", async () => {
    for (const mutation of ["absent", "author", "text", "run"] as const) {
      const { client, message } = fixture();
      if (mutation === "absent") message.id = "different-message";
      if (mutation === "author") message.author = { kind: "user", uid: 1001 };
      if (mutation === "text") message.text = "different text";
      if (mutation === "run") message.runId = "different-run";
      await expect(captureLegacyUpgradeHistory({ client, intent, phase: "capture-legacy", managedInferenceEnabled: false, timeoutMs: 0 })).rejects.toThrow();
      expect(client.conversation.send).not.toHaveBeenCalled();
    }
  });

  it("accepts only the exact historical unavailable projection under the disabled-binding guards", async () => {
    for (const error of ["Managed inference is disabled", "Network failure", "GSV inference is unavailable: timeout"]) {
      const { client, records } = fixture();
      const record = records[1];
      if (record.kind === "event" && record.payload.kind === "generation.failed") record.payload.payload.error = error;
      await expect(captureLegacyUpgradeHistory({ client, intent, phase: "capture-legacy", managedInferenceEnabled: false, timeoutMs: 0 }))
        .rejects.toThrow("unexpected generation failure");
      expect(client.conversation.send).not.toHaveBeenCalled();
    }
    const { client } = fixture();
    // @ts-expect-error Reject untyped callers that have not proven the binding is false.
    await expect(captureLegacyUpgradeHistory({ client, intent, phase: "capture-legacy", managedInferenceEnabled: true })).rejects.toThrow("disabled inference");
    expect(client.conversation.send).not.toHaveBeenCalled();
  });
});
