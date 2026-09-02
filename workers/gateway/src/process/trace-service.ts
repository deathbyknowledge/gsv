import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type {
  JsonObject, ProcTraceArgs, ProcTraceResult, ProcTraceSpanKind, ProcTraceSpanReference, ProcTraceSpanStatus,
} from "@humansandmachines/gsv/protocol";
import type { Process } from "./do";

const MAX_PROCESS_TRACE_READ_LIMIT = 2_000;

type GenerationTracePhase = {
  runId: string;
  kind: Extract<ProcTraceSpanKind, "reasoning" | "output">;
  spanId: string;
};

/** Owns Process trace persistence and live generation-phase projection. */
export class ProcessTraceService {
  private readonly generationPhases = new Map<string, GenerationTracePhase>();

  constructor(private readonly host: Process) {}

  list(args: ProcTraceArgs): ProcTraceResult {
    const limit = args.limit ?? 1_000;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PROCESS_TRACE_READ_LIMIT) {
      return {
        ok: false,
        error: `proc.trace limit must be between 1 and ${MAX_PROCESS_TRACE_READ_LIMIT}`,
      };
    }
    const runId = optionalString(args.runId);
    const trace = this.host.store.traces.listTraceSpans({
      ...(runId ? { runId } : undefined),
      limit,
    });
    return {
      ok: true,
      pid: this.host.pid,
      spans: trace.spans,
      spanCount: trace.count,
      truncated: trace.spans.length < trace.count,
      activeRunId: this.host.runs.active?.runId ?? null,
    };
  }

  start(input: {
    runId: string;
    parentId?: string;
    kind: ProcTraceSpanKind;
    name: string;
    reference?: ProcTraceSpanReference;
    attributes?: JsonObject;
    id?: string;
    startedAt?: number;
  }): string | null {
    if (this.host.killed) return null;
    const id = input.id ?? `trace:${crypto.randomUUID()}`;
    return this.host.store.traces.startTraceSpan({
      id,
      runId: input.runId,
      parentId: input.parentId ?? `run:${input.runId}`,
      kind: input.kind,
      name: input.name,
      startedAt: input.startedAt ?? Date.now(),
      ...(input.reference ? { reference: input.reference } : undefined),
      ...(input.attributes ? { attributes: input.attributes } : undefined),
    })
      ? id
      : null;
  }

  finish(
    id: string | null,
    status: Exclude<ProcTraceSpanStatus, "running">,
    options: {
      reference?: ProcTraceSpanReference;
      attributes?: JsonObject;
      endedAt?: number;
    } = {},
  ): void {
    if (!id || this.host.killed) return;
    this.host.store.traces.finishTraceSpan(id, status, options.endedAt ?? Date.now(), options);
  }

  runStartedAt(runId: string): number | null {
    return this.host.store.traces.getRunTraceStartedAt(runId);
  }

  finishRunPersistence(
    runId: string,
    status: Exclude<ProcTraceSpanStatus, "running" | "denied">,
    endedAt: number,
  ): void {
    this.host.store.traces.finishRunTrace(runId, status, endedAt);
  }

  releaseRun(runId: string): void {
    for (const [inferenceId, phase] of this.generationPhases) {
      if (phase.runId === runId) this.generationPhases.delete(inferenceId);
    }
  }

  recordGenerationEvent(
    runId: string,
    inferenceSpanId: string | undefined,
    event: AssistantMessageEvent,
  ): void {
    if (!inferenceSpanId) return;
    if (event.type === "done" || event.type === "error") {
      this.finishGenerationPhase(inferenceSpanId, event.type === "error" ? "error" : "ok");
      return;
    }
    const kind =
      event.type === "thinking_delta"
        ? "reasoning"
        : event.type === "text_delta" ||
            event.type === "toolcall_start" ||
            event.type === "toolcall_delta" ||
            event.type === "toolcall_end"
          ? "output"
          : null;
    if (!kind) return;

    const current = this.generationPhases.get(inferenceSpanId);
    if (current?.kind === kind) return;
    const now = Date.now();
    if (current) this.finish(current.spanId, "ok", { endedAt: now });
    const spanId = this.start({
      runId,
      parentId: inferenceSpanId,
      kind,
      name: kind === "reasoning" ? "Reasoning" : "Model output",
      startedAt: now,
    });
    if (spanId) {
      this.generationPhases.set(inferenceSpanId, { runId, kind, spanId });
    }
  }

  finishGenerationPhase(
    inferenceSpanId: string | null,
    status: Exclude<ProcTraceSpanStatus, "running"> = "ok",
  ): void {
    if (!inferenceSpanId) return;
    const phase = this.generationPhases.get(inferenceSpanId);
    if (!phase) return;
    this.generationPhases.delete(inferenceSpanId);
    this.finish(phase.spanId, status);
  }
}

function optionalString(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
