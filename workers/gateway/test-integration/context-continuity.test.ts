import { expect, it } from "vitest";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

it("continues one active run through successive Shell handovers", async () => {
  const runtime = await startProcessRuntimeHarness();
  try {
    const request = "Check the deadline and citations; keep the report in /report.md.";
    const firstHandover = "Initial evidence verified. Next check the deadline.";
    const secondHandover = "The deadline was corrected to Friday. Check the source citations next.";
    runtime.ai.enqueue(
      { kind: "tool-calls", calls: [{ id: "first-evidence", name: "Shell", arguments: { target: "gsv", input: "printf first-evidence-marker" } }] },
      { kind: "tool-calls", calls: [{ id: "first-handover", name: "Shell", arguments: { target: "gsv", input: `proc compact --summary '${firstHandover}'` } }] },
      { kind: "tool-calls", calls: [{ id: "second-evidence", name: "Shell", arguments: { target: "gsv", input: "printf second-evidence-marker" } }] },
      { kind: "tool-calls", calls: [{ id: "second-handover", name: "Shell", arguments: { target: "gsv", input: `proc compact --summary '${secondHandover}'` } }] },
      { kind: "message", text: "Both handovers complete." },
    );
    const process = await runtime.spawn("check deadline and citations", { runAs: "process-runtime-agent" });
    await runtime.configureAi(process.pid);
    const sent = await runtime.client.proc.send({ pid: process.pid, message: request });
    if (!sent.ok) throw new Error(sent.error);
    await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) =>
      signal === "proc.run.finished" && payload.runId === sent.runId), "the continued run to finish");

    expect(runtime.ai.requests).toHaveLength(5);
    const firstContinuation = JSON.stringify(runtime.ai.requests[2]!.messages);
    expect(firstContinuation).toContain(request);
    expect(firstContinuation).toContain(firstHandover);
    expect(firstContinuation).toContain("Handover saved. Compaction follows when the current tools finish.");
    expect(firstContinuation).not.toContain("first-evidence-marker");
    const secondContinuation = JSON.stringify(runtime.ai.requests[4]!.messages);
    expect(secondContinuation).toContain(request);
    expect(secondContinuation).toContain(secondHandover);
    expect(secondContinuation).not.toContain(firstHandover);
    expect(secondContinuation).not.toContain("second-evidence-marker");

    const history = await runtime.client.proc.history({ pid: process.pid, format: 2 });
    if (!history.ok || history.format !== 2) throw new Error("Typed history unavailable");
    expect(history).toMatchObject({ activeRunId: null, pendingHil: null });
    expect(history.records.filter((record) => record.kind === "event" && record.payload.kind === "history.compacted"))
      .toEqual([expect.objectContaining({ payload: expect.objectContaining({ payload: expect.objectContaining({ summary: secondHandover }) }) })]);
    const segments = await runtime.client.proc.history.segments({ pid: process.pid });
    if (!segments.ok) throw new Error(segments.error);
    expect(segments.segments.filter(({ kind }) => kind === "compaction")).toHaveLength(2);
  } finally {
    await runtime.close();
  }
});

it("lets Crew read the exact archived slice after its source process is killed", async () => {
  const runtime = await startProcessRuntimeHarness();
  try {
    const source = await runtime.spawn("remember personal preferences", { runAs: "process-runtime-agent" });
    await runtime.configureAi(source.pid);
    let afterMessageId = 0;
    for (const message of ["previous-slice-marker: use blue", "new-slice-marker: use green"]) {
      runtime.ai.enqueue({ kind: "message", text: "Noted." });
      const sent = await runtime.client.proc.send({ pid: source.pid, message });
      if (!sent.ok) throw new Error(sent.error);
      await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) =>
        signal === "proc.run.finished" && payload.runId === sent.runId), "the source run to finish");
      if (!afterMessageId) {
        const history = await runtime.client.proc.history({ pid: source.pid });
        if (!history.ok) throw new Error(history.error);
        afterMessageId = history.messages.at(-1)!.id!;
        expect(afterMessageId).toBeGreaterThan(0);
      }
    }
    const compacted = await runtime.client.proc.history.compact({ pid: source.pid, keepLast: 0, summary: "Green is preferred." });
    if (!compacted.ok) throw new Error(compacted.error);
    if ("pending" in compacted) throw new Error("Expected idle compaction to finish");
    expect(await runtime.client.proc.kill({ pid: source.pid, archive: false })).toMatchObject({ ok: true });
    await expect(runtime.client.proc.history.segment.read({ pid: source.pid, segmentId: compacted.segment.id }))
      .rejects.toThrow("Process not found");

    const { archivePath, generation, toMessageId } = compacted.segment;
    runtime.ai.enqueue(
      { kind: "tool-calls", calls: [{ id: "read-archive", name: "Shell", arguments: {
        target: "gsv",
        input: `set -o pipefail; gzip -dc '${archivePath}' | jq -c 'select(.generation == ${generation} and .id > ${afterMessageId} and .id <= ${toMessageId})'`,
      } }] },
      { kind: "message", text: "Review complete." },
    );
    const crew = await runtime.spawn("review the archived slice", { runAs: "crew" });
    await runtime.configureAi(crew.pid);
    const sent = await runtime.client.proc.send({ pid: crew.pid, message: "Read the assigned archive." });
    if (!sent.ok) throw new Error(sent.error);
    await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) =>
      signal === "proc.run.finished" && payload.runId === sent.runId), "Crew to finish reading the archive");
    const history = await runtime.client.proc.history({ pid: crew.pid });
    if (!history.ok) throw new Error(history.error);
    const read = history.messages.find(({ role, content }) => role === "toolResult" && JSON.stringify(content).includes("read-archive"));
    expect(read?.content).toMatchObject({ isError: false, output: expect.stringContaining("new-slice-marker") });
    expect(JSON.stringify(read?.content)).not.toContain("previous-slice-marker");
  } finally {
    await runtime.close();
  }
});
