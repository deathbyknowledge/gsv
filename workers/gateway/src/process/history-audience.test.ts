import { describe, expect, it } from "vitest";
import type { ProcHistoryRecordData } from "@humansandmachines/gsv/protocol";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";
import { buildProcContextState, estimateContextInputTokens } from "./context-pressure";
import { renderCompactionTranscriptWindow } from "./history/compaction-renderer";
import type { Process } from "./do";

const personNotice: ProcHistoryRecordData = { kind: "event", payload: {
  kind: "media.failed", severity: "warn", audience: "person",
  payload: { error: "Person-only fixture notice", reason: "media.error", messageId: 1 },
} };

function measuredContext(process: Process) {
  const stats = process.store.messages.messageStats();
  return buildProcContextState({
    revision: process.store.state.nextContextStateRevision(), runId: "measured-run",
    messageCount: stats.count, lastMessageId: stats.lastMessageId,
    provider: "workers-ai", model: "@cf/test/model", reasoning: "high",
    contextWindowTokens: 11_000, maxOutputTokens: 1_000,
    measurement: { estimatedInputTokens: 8_000, inputTokens: 8_000, confirmedInputTokens: 8_000,
      estimatedTrailingInputTokens: 0, source: "provider" },
    usageState: { inputTokens: 8_000, outputTokens: 123, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 8_123, cost: null },
    updatedAt: 777,
  });
}

describe("Process history audiences", () => {
  it.each([true, false])("allows idle pressure compaction after a notice only when the prior measurement was current: %s", async (fresh) => {
    const stub = await initProcess(`history-audience-pressure-${fresh}`, ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      process.store.messages.appendMessage("user", `Large old request ${"x".repeat(20_000)}`);
      for (let index = 0; index < 5; index += 1) {
        process.store.messages.appendMessage("user", `Small recent request ${index}`);
      }
      const measured = measuredContext(process);
      process.store.state.setContextState(measured);
      if (!fresh) process.store.messages.appendMessage("user", "Input after the last measurement");
      const providerContext = await process.history.buildContextMessages();
      const noticeId = process.store.messages.appendMessage("system", "Person-only fixture notice", { record: personNotice });
      expect(await process.history.buildContextMessages()).toEqual(providerContext);
      expect(process.runs.active).toBeNull();
      const carried = process.store.state.getContextState();
      const compacted = await process.history.handleHistoryCompact({ targetPressure: 0.4, summary: "Earlier work was archived." });
      if (fresh) {
        expect(compacted).toMatchObject({ ok: true, archivedMessages: 1 });
        expect(carried).toEqual({ ...measured, revision: measured.revision + 1, messageCount: measured.messageCount! + 1, lastMessageId: noticeId });
        expect(process.store.state.getContextStateRevision()).toBeGreaterThanOrEqual(carried!.revision);
      } else {
        expect(compacted).toEqual({ ok: false, error: expect.stringContaining("Context token usage is not current") });
        expect(carried).toEqual(measured);
      }
    });
  });

  it.each([false, true])("does not select notices as new compaction work beside a prior summary: %s", async (withSummary) => {
    const stub = await initProcess(`history-audience-empty-compact-${withSummary}`, ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      if (withSummary) process.store.messages.appendMessage("system", "Earlier summary", { record: {
        kind: "event", payload: { kind: "history.compacted", severity: "info", audience: "model",
          payload: { summary: "Earlier summary", segmentId: "earlier", archivePath: "/root/history/earlier.gz", archivedMessages: 2 } },
      } });
      process.store.messages.appendMessage("system", "Person-only fixture notice", { record: personNotice });
      process.store.messages.appendMessage("user", `Active request ${"x".repeat(20_000)}`, { runId: "current" });
      const context = { systemPrompt: "Fixture system prompt", messages: await process.history.buildContextMessages() };
      const state = measuredContext(process);
      const policy = { overflow: "auto-compact", compactAtPressure: 0.9, compactToPressure: 0.4, updatedAt: 100 } as const;
      for (const trigger of ["preflight", "provider-overflow"] as const) {
        expect(process.history.selectAutoCompactionPrefix("current", state, context, policy, trigger)).toEqual([]);
      }
    });
  });

  it("keeps person notices out of model context, origins, pressure, and compaction input", async () => {
    const capture = async (withNotices: boolean) => {
      const stub = await initProcess(`history-audience-${withNotices}`, ROOT_IDENTITY);
      return runInProcess(stub, async (process) => {
        const notice: ProcHistoryRecordData = { kind: "event", payload: {
          kind: "media.failed", severity: "warn", audience: "person",
          payload: { error: "PERSON ONLY " + "x".repeat(100_000), reason: "media.error", messageId: 1 },
        } };
        const appendNotice = () => process.store.messages.appendMessage("system", "PERSON ONLY", {
          record: notice, createdAt: 100, runId: "active",
          origin: JSON.stringify({ kind: "client", connectionId: "notice-source" }),
        });
        if (withNotices) appendNotice();
        process.store.messages.appendMessage("user", "Earlier request " + "x".repeat(30_000), {
          createdAt: 100, runId: "earlier",
          origin: JSON.stringify({ kind: "client", connectionId: "human-source" }),
        });
        if (withNotices) appendNotice();
        process.store.messages.appendMessage("assistant", "Earlier work " + "y".repeat(30_000), {
          createdAt: 100, runId: "earlier",
        });
        process.store.messages.appendMessage("user", "Current request", { createdAt: 100, runId: "current" });
        const context = { systemPrompt: "Test context", messages: await process.history.buildContextMessages() };
        const tokens = estimateContextInputTokens(context);
        const state = buildProcContextState({
          revision: 1, provider: "openai", model: "test", contextWindowTokens: 10_000, maxOutputTokens: 1000,
          measurement: { estimatedInputTokens: tokens, inputTokens: tokens, confirmedInputTokens: 0,
            estimatedTrailingInputTokens: tokens, source: "estimate" }, updatedAt: 100,
        });
        const selected = process.history.selectAutoCompactionPrefix("current", state, context, {
          overflow: "auto-compact", compactAtPressure: 0.9, compactToPressure: 0.4, updatedAt: 100,
        }, "preflight");
        const transcript = renderCompactionTranscriptWindow(process.store.messages.getMessages(), 250_000);
        expect(transcript).not.toContain("PERSON ONLY");
        expect(process.store.messages.getRecords().filter((record) => record.kind === "event")).toHaveLength(withNotices ? 2 : 0);
        return {
          context, tokens,
          compactedText: selected.filter((message) => message.records?.[0]?.kind !== "event").map((message) => message.content),
        };
      });
    };
    const baseline = await capture(false);
    const withNotices = await capture(true);
    expect(withNotices).toEqual(baseline);
    expect(baseline.compactedText).toHaveLength(2);
  });
});
