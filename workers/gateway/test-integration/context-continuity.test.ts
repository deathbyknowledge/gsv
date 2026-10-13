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
