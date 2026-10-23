import * as z from "zod/mini";
import type { OperatorRun, OperatorRunStep } from "@humansandmachines/gsv/services/operator";
import type { ProcTraceSpanStatus } from "@humansandmachines/gsv/protocol";
import type { ProcessStore } from "./store";
import type { ProcessTraceSpanRow } from "./storage/records";

const MAX_STEPS_PER_RUN = 200;
const toolReferenceSchema = z.object({ callId: z.string() });

export type ProcessOperatorSummary = {
  pendingApprovals: number;
  lastCompactionAt: number | null;
  runs: OperatorRun[];
};

/**
 * Describes a Process's recent runs for operator inspection: timings, names
 * and outcomes, newest run first. It reads no message text, tool arguments or
 * output.
 */
export function processOperatorSummary(store: ProcessStore, runLimit: number): ProcessOperatorSummary {
  const spans = store.traces.listRecentRunSpans(runLimit);
  const byRun = new Map<string, ProcessTraceSpanRow[]>();
  for (const span of spans) {
    const runSpans = byRun.get(span.run_id) ?? [];
    runSpans.push(span);
    byRun.set(span.run_id, runSpans);
  }
  const described = store.messages.describeRuns([...byRun.keys()]);
  const runs: OperatorRun[] = [];
  for (const [runId, runSpans] of byRun) {
    const root = runSpans.find((span) => span.kind === "run");
    if (!root) continue;
    const facts = described.get(runId);
    const toolSpanIds = new Set(runSpans.filter((span) => span.kind === "tool").map((span) => span.span_id));
    const steps: OperatorRunStep[] = [];
    for (const span of runSpans) {
      // A tool span nested in another tool span (Shell → Execute) describes the same call.
      const step = span.kind === "inference" || span.kind === "delivery"
        || (span.kind === "tool" && !(span.parent_span_id && toolSpanIds.has(span.parent_span_id)));
      if (!step || steps.length >= MAX_STEPS_PER_RUN) continue;
      const entry: OperatorRunStep = {
        // SAFETY: `step` above admits only inference, tool and delivery spans.
        kind: span.kind as OperatorRunStep["kind"],
        name: span.name.slice(0, 256),
        startedAt: span.started_at,
        durationMs: span.ended_at === null ? null : Math.max(0, span.ended_at - span.started_at),
        status: stepStatus(span.status),
      };
      const target = span.kind === "tool" ? toolTarget(span, facts?.toolTargets) : undefined;
      if (target) entry.target = target.slice(0, 256);
      steps.push(entry);
    }
    runs.push({
      runId: runId.slice(0, 256),
      origin: runOrigin(runId, facts?.originKind ?? null, facts?.hasEvents ?? false),
      inputChars: facts?.inputChars ?? null,
      inputHasMedia: facts?.inputHasMedia ?? false,
      startedAt: root.started_at,
      durationMs: root.ended_at === null ? null : Math.max(0, root.ended_at - root.started_at),
      status: runStatus(root.status),
      steps,
    });
  }
  runs.sort((left, right) => right.startedAt - left.startedAt);
  return {
    pendingApprovals: store.tools.pendingHilCount(),
    lastCompactionAt: store.history.lastCompactionAt(),
    runs,
  };
}

function toolTarget(span: ProcessTraceSpanRow, targets: Map<string, string> | undefined): string | undefined {
  if (!span.reference_json || !targets) return undefined;
  let reference;
  try {
    reference = toolReferenceSchema.safeParse(JSON.parse(span.reference_json));
  } catch {
    return undefined; // A malformed reference only loses the target label.
  }
  return reference.success ? targets.get(reference.data.callId) : undefined;
}

function stepStatus(status: ProcTraceSpanStatus): OperatorRunStep["status"] {
  if (status === "ok" || status === "running" || status === "error") return status;
  return status === "denied" ? "error" : "cancelled";
}

function runStatus(status: ProcTraceSpanStatus): OperatorRun["status"] {
  if (status === "ok" || status === "running" || status === "error") return status;
  return status === "denied" ? "error" : "aborted";
}

function runOrigin(runId: string, originKind: string | null, hasEvents: boolean): OperatorRun["origin"] {
  switch (originKind) {
    case "adapter": return "adapter";
    case "client": case "web": case "desktop": return "client";
    case "scheduler": case "schedule": case "cron": return "schedule";
    case "ipc": return "ipc";
    case "event": return "event";
  }
  if (runId.startsWith("adapter-run:")) return "adapter";
  return originKind === null && hasEvents ? "event" : "other";
}
