import type { ProcHistoryRecord, ProcTraceSpan } from "@humansandmachines/gsv/protocol";
import type { LedgerLine } from "./fleetModel";

export type LedgerWindow = { since: number; until: number };
export type AnalysisLine = LedgerLine & { durationMs: number | null };
export type ProcessTrace = { pid: string; spans: ProcTraceSpan[]; truncated: boolean };
export type GenerationUsage = {
  id: string;
  pid: string;
  runId: string | null;
  timestamp: number;
  model: string | null;
  provider: string | null;
  tokens: number | null;
  cost: number | null;
  costIncomplete: boolean;
  fallback: boolean;
};

/** A logical assistant message may contain a note and several calls with the same usage. */
export function generationUsage(pid: string, records: readonly ProcHistoryRecord[], window: LedgerWindow): GenerationUsage[] {
  const seen = new Set<string>();
  const generations: GenerationUsage[] = [];
  for (const record of records) {
    const metadata = record.metadata;
    if (!metadata || (!metadata.provider && !metadata.usage)) continue;
    if (record.createdAt < window.since || record.createdAt > window.until) continue;
    const id = `${pid}:${record.generation}:${record.messageId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    generations.push({
      id, pid, runId: record.runId, timestamp: record.createdAt,
      model: metadata.provider?.responseModel ?? metadata.provider?.model ?? metadata.fallback?.to?.model ?? null,
      provider: metadata.provider?.provider ?? metadata.fallback?.to?.provider ?? null,
      tokens: metadata.usage?.totalTokens ?? null,
      cost: metadata.usage?.cost?.total ?? null,
      costIncomplete: metadata.usage?.costIncomplete === true,
      fallback: metadata.fallback?.used === true,
    });
  }
  return generations;
}

export type UsageGroup = {
  id: string;
  generations: GenerationUsage[];
  tokens: number;
  cost: number;
  costReports: number;
  missingTokens: number;
  missingCost: number;
  fallbacks: number;
};
export type UsageAxis = "process" | "model" | "day";

export function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function groupUsage(generations: readonly GenerationUsage[], by: UsageAxis): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const generation of generations) {
    const id = by === "process" ? generation.pid : by === "day" ? localDay(generation.timestamp)
      : generation.model ? `${generation.provider ?? "unknown provider"} · ${generation.model}` : "Unattributed model";
    let group = groups.get(id);
    if (!group) {
      group = { id, generations: [], tokens: 0, cost: 0, costReports: 0, missingTokens: 0, missingCost: 0, fallbacks: 0 };
      groups.set(id, group);
    }
    group.generations.push(generation);
    group.tokens += generation.tokens ?? 0;
    group.cost += generation.cost ?? 0;
    if (generation.cost !== null) group.costReports += 1;
    if (generation.tokens === null) group.missingTokens += 1;
    if (generation.cost === null || generation.costIncomplete) group.missingCost += 1;
    if (generation.fallback) group.fallbacks += 1;
  }
  return [...groups.values()].sort((a, b) => by === "day" ? a.id.localeCompare(b.id)
    : b.tokens - a.tokens || b.cost - a.cost || a.id.localeCompare(b.id));
}

export type FailureGroup = { id: string; syscall: string; place: string; outcome: string; lines: AnalysisLine[] };
export function groupFailures(lines: readonly AnalysisLine[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  const seen = new Set<string>();
  for (const line of lines) {
    if (!["failed", "denied", "cancelled"].includes(line.outcome) || seen.has(line.id)) continue;
    seen.add(line.id);
    const id = JSON.stringify([line.syscall, line.place, line.outcome]);
    const group = groups.get(id) ?? { id, syscall: line.syscall, place: line.place, outcome: line.outcome, lines: [] };
    group.lines.push(line);
    groups.set(id, group);
  }
  return [...groups.values()].map((group) => ({ ...group, lines: group.lines.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)) }))
    .sort((a, b) => b.lines.length - a.lines.length || (b.lines[0].timestamp ?? 0) - (a.lines[0].timestamp ?? 0));
}

export type TimelineRun = {
  pid: string; id: string; start: number; end: number; status: ProcTraceSpan["status"]; partial: boolean; spans: ProcTraceSpan[];
};
export function timelineRuns(traces: readonly ProcessTrace[], window: LedgerWindow): TimelineRun[] {
  const runs: TimelineRun[] = [];
  for (const trace of traces) {
    const groups = new Map<string, ProcTraceSpan[]>();
    for (const span of trace.spans) {
      const group = groups.get(span.runId) ?? [];
      group.push(span);
      groups.set(span.runId, group);
    }
    for (const [id, spans] of groups) {
      const root = spans.find((span) => span.kind === "run");
      const start = root?.startedAt ?? Math.min(...spans.map((span) => span.startedAt));
      const status = root?.status ?? (spans.some((span) => span.status === "running") ? "running"
        : spans.some((span) => span.status === "error") ? "error"
        : spans.some((span) => span.status === "denied") ? "denied"
        : spans.some((span) => span.status === "aborted") ? "aborted" : "ok");
      const end = root?.endedAt ?? (status === "running" ? window.until : Math.max(...spans.map((span) => span.endedAt ?? span.startedAt)));
      if (start > window.until || end < window.since) continue;
      runs.push({ pid: trace.pid, id, start, end: Math.max(start, end), status, partial: !root || trace.truncated, spans });
    }
  }
  return runs.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export function timelineBounds(runs: readonly TimelineRun[], window: LedgerWindow, fit: boolean): LedgerWindow {
  if (!fit || runs.length === 0) return window;
  const since = Math.max(window.since, Math.min(...runs.map((run) => run.start)));
  const until = Math.min(window.until, Math.max(...runs.map((run) => run.end)));
  return { since, until: Math.max(since + 1, until) };
}

/** Clip at the selected window; nested spans are not added to wall-clock duration. */
export function timelinePosition(start: number, end: number, window: LedgerWindow): { left: number; width: number } {
  const duration = Math.max(1, window.until - window.since);
  const left = Math.max(0, Math.min(100, (start - window.since) / duration * 100));
  const right = Math.max(left, Math.min(100, (end - window.since) / duration * 100));
  return { left, width: right - left };
}

export function reportedCost(cost: number, reported: boolean): string {
  if (!reported) return "—";
  if (cost === 0) return "$0.00";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}
