import { expect, it } from "vitest";
import { initProcess, ROOT_IDENTITY, runInProcess, generationRun, processTestConfig, setHistoryPolicy, mockGeneration, terminalTestResponse, messageAction } from "./do-test-harness";

it("compacts history containing retained multi-megabyte fallback metadata", async () => {
  const pid = "large-fallback-metadata-compaction";
  const runId = "large-fallback-metadata-run";
  const stub = await initProcess(pid, ROOT_IDENTITY);
  const result = await runInProcess(stub, async (process) => {
    let summaries = 0;
    process.sendSignal = async () => {};
    mockGeneration(process, async () => terminalTestResponse([messageAction("done", "large-metadata-done")]), async () => {
      summaries += 1;
      return "Synthetic compacted summary.";
    });
    for (let index = 0; index < 438; index += 1) {
      const metadata = index % 16 === 0 && index < 432 ? {
        fallback: {
          used: true,
          from: { provider: "openai-codex", model: "gpt-6-astra" },
          to: { provider: "gsv", model: "default" },
          reason: `synthetic ${index}\n` + "x".repeat(734420),
        },
      } : undefined;
      process.store.messages.appendMessage(index % 2 === 0 ? "assistant" : "user", `Synthetic message ${index} ` + "c".repeat(1730), { metadata });
    }
    process.store.messages.appendMessage("user", "Current synthetic input", { runId });
    setHistoryPolicy(process);
    process.runs.active = generationRun(runId, processTestConfig(pid, {
      provider: "openai-codex", model: "gpt-6-astra", maxTokens: 8192, contextWindowTokens: 247424,
    }));
    await process.run.runTick(runId);
    const epoch = process.store.epochs.listContextEpochs().find((entry: { state: string }) => entry.state === "closed");
    if (!epoch?.archivePath) throw new Error("Compaction did not retain its context epoch archive");
    const archived = await process.storage.head(epoch.archivePath.replace(/^\/+/, ""));
    return { summaries, segments: process.store.history.listHistorySegments(), active: process.runs.active !== null, epochArchived: archived !== null };
  });
  expect(result.summaries).toBe(1);
  expect(result.segments).toHaveLength(1);
  expect(result.segments[0].toMessageId).toBeGreaterThan(200);
  expect(result.active).toBe(false);
  expect(result.epochArchived).toBe(true);
});
