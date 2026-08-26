import type {
  ProcTraceSpan,
  ProcTraceSpanReference,
} from "@humansandmachines/gsv/protocol";
import type {
  ChatTranscriptRow,
  ChatTranscriptValue,
} from "../../chat/domain/transcript";

export type RuntimeTraceRun = {
  id: string;
  startedAt: number;
  endedAt: number | null;
  status: ProcTraceSpan["status"];
};

export type RuntimeFlameSpan = ProcTraceSpan & {
  durationMs: number;
  lane: number;
  leftPercent: number;
  widthPercent: number;
};

export type RuntimeFlameChart = {
  durationMs: number;
  endedAt: number;
  laneCount: number;
  runId: string;
  spans: RuntimeFlameSpan[];
  startedAt: number;
};

export type RuntimeTraceInspectorSection = {
  label: string;
  value: string;
};

export function runtimeTraceRuns(
  spans: readonly ProcTraceSpan[],
): RuntimeTraceRun[] {
  const byRun = new Map<string, ProcTraceSpan[]>();
  for (const span of spans) {
    const existing = byRun.get(span.runId) ?? [];
    existing.push(span);
    byRun.set(span.runId, existing);
  }
  return Array.from(byRun, ([id, runSpans]) => {
    const root = runSpans.find((span) => span.kind === "run");
    const startedAt = root?.startedAt ?? Math.min(...runSpans.map((span) => span.startedAt));
    const endedValues = runSpans.flatMap((span) => span.endedAt === undefined ? [] : [span.endedAt]);
    return {
      id,
      startedAt,
      endedAt: root?.endedAt ?? (endedValues.length > 0 ? Math.max(...endedValues) : null),
      status: root?.status ?? (runSpans.some((span) => span.status === "running") ? "running" : "ok"),
    };
  }).sort((left, right) => right.startedAt - left.startedAt || right.id.localeCompare(left.id));
}

export function buildRuntimeFlameChart(
  spans: readonly ProcTraceSpan[],
  runId: string,
  now = Date.now(),
): RuntimeFlameChart | null {
  const runSpans = spans
    .filter((span) => span.runId === runId)
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  if (runSpans.length === 0) return null;

  const root = runSpans.find((span) => span.kind === "run");
  const startedAt = root?.startedAt ?? runSpans[0].startedAt;
  const endedAt = Math.max(
    startedAt + 1,
    root?.endedAt ?? 0,
    ...runSpans.map((span) => span.endedAt ?? now),
  );
  const durationMs = endedAt - startedAt;
  const byId = new Map(runSpans.map((span) => [span.id, span]));
  const depthCache = new Map<string, number>();
  const depthFor = (span: ProcTraceSpan, seen = new Set<string>()): number => {
    const cached = depthCache.get(span.id);
    if (cached !== undefined) return cached;
    if (!span.parentId || seen.has(span.id)) return 0;
    const parent = byId.get(span.parentId);
    if (!parent) return 0;
    seen.add(span.id);
    const depth = depthFor(parent, seen) + 1;
    depthCache.set(span.id, depth);
    return depth;
  };

  const byDepth = new Map<number, ProcTraceSpan[]>();
  for (const span of runSpans) {
    const depth = depthFor(span);
    const depthSpans = byDepth.get(depth) ?? [];
    depthSpans.push(span);
    byDepth.set(depth, depthSpans);
  }

  let laneOffset = 0;
  const laneById = new Map<string, number>();
  for (const depth of Array.from(byDepth.keys()).sort((left, right) => left - right)) {
    const laneEnds: number[] = [];
    const depthSpans = byDepth.get(depth) ?? [];
    for (const span of depthSpans) {
      const spanEnd = Math.max(span.startedAt, span.endedAt ?? now);
      let sublane = laneEnds.findIndex((end) => end <= span.startedAt);
      if (sublane === -1) {
        sublane = laneEnds.length;
        laneEnds.push(spanEnd);
      } else {
        laneEnds[sublane] = spanEnd;
      }
      laneById.set(span.id, laneOffset + sublane);
    }
    laneOffset += Math.max(1, laneEnds.length);
  }

  return {
    runId,
    startedAt,
    endedAt,
    durationMs,
    laneCount: laneOffset,
    spans: runSpans.map((span) => {
      const spanEnd = Math.max(span.startedAt, span.endedAt ?? now);
      const leftPercent = clampPercent(((span.startedAt - startedAt) / durationMs) * 100);
      const naturalWidth = ((spanEnd - span.startedAt) / durationMs) * 100;
      const widthPercent = Math.min(100 - leftPercent, Math.max(0.35, naturalWidth));
      return {
        ...span,
        durationMs: spanEnd - span.startedAt,
        lane: laneById.get(span.id) ?? 0,
        leftPercent,
        widthPercent,
      };
    }),
  };
}

export function runtimeTraceInspectorSections(
  selected: ProcTraceSpan,
  spans: readonly ProcTraceSpan[],
  rows: readonly ChatTranscriptRow[],
): RuntimeTraceInspectorSection[] {
  const sections: RuntimeTraceInspectorSection[] = [];
  const reference = inheritedReference(selected, spans);
  if (selected.kind === "run") {
    const input = rows.find((row) => (
      row.runId === selected.runId
      && (row.role === "user" || row.role === "system")
    ));
    if (input?.text) sections.push({ label: "INPUT", value: input.text });
  } else if (reference?.kind === "message") {
    const message = rows.find((row) => (
      row.role === "assistant" && row.messageId === reference.messageId
    ));
    if (message) sections.push(...assistantSections(selected.kind, message));
  } else if (reference?.kind === "tool" || reference?.kind === "approval") {
    sections.push(...toolSections(reference.callId, rows));
  } else if (reference?.kind === "delivery" && reference.callId) {
    sections.push(...toolSections(reference.callId, rows));
  }
  if (selected.attributes && Object.keys(selected.attributes).length > 0) {
    sections.push({ label: "METADATA", value: prettyValue(selected.attributes) });
  }
  return sections;
}

export function formatTraceDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function inheritedReference(
  selected: ProcTraceSpan,
  spans: readonly ProcTraceSpan[],
): ProcTraceSpanReference | undefined {
  if (selected.reference) return selected.reference;
  const byId = new Map(spans.map((span) => [span.id, span]));
  let parentId = selected.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return undefined;
    if (parent.reference) return parent.reference;
    parentId = parent.parentId;
  }
  return undefined;
}

function assistantSections(
  kind: ProcTraceSpan["kind"],
  row: ChatTranscriptRow,
): RuntimeTraceInspectorSection[] {
  const sections: RuntimeTraceInspectorSection[] = [];
  const thinking = row.thinking?.join("\n\n") ?? "";
  if ((kind === "reasoning" || kind === "inference") && thinking) {
    sections.push({ label: "REASONING", value: thinking });
  }
  if (kind !== "reasoning" && row.text) sections.push({ label: "OUTPUT", value: row.text });
  return sections;
}

function toolSections(
  callId: string,
  rows: readonly ChatTranscriptRow[],
): RuntimeTraceInspectorSection[] {
  const toolCall = rows.find((row) => row.role === "tool" && row.toolCallId === callId);
  const result = rows.find((row) => row.role === "toolResult" && row.toolCallId === callId);
  const sections: RuntimeTraceInspectorSection[] = [];
  if (toolCall) {
    sections.push({ label: "TOOL", value: toolCall.toolName ?? toolCall.text });
    if (toolCall.toolArgs !== undefined) {
      sections.push({ label: "ARGUMENTS", value: prettyValue(toolCall.toolArgs) });
    }
  }
  if (result?.text) sections.push({ label: "RESULT", value: result.text });
  return sections;
}

function prettyValue(value: ChatTranscriptValue): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
