import type { ProcessEntry } from "./types";

export function processTitle(entry: ProcessEntry): string {
  const label = String(entry.label ?? "").trim();
  return label || String(entry.pid ?? "unknown");
}

export function processState(entry: ProcessEntry): string {
  return String(entry.state ?? "unknown").trim().toLowerCase() || "unknown";
}

export function processStateTone(entry: ProcessEntry): "good" | "warning" | "neutral" {
  const state = processState(entry);
  if (state === "running" || state === "waiting_tool") {
    return "good";
  }
  if (state === "queued" || state === "waiting_hil") {
    return "warning";
  }
  return "neutral";
}

export function filterProcesses(processes: ProcessEntry[], query: string): ProcessEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return processes;
  }
  return processes.filter((entry) => (
    String(entry.pid ?? "").toLowerCase().includes(normalizedQuery)
    || String(entry.label ?? "").toLowerCase().includes(normalizedQuery)
    || String(entry.profile ?? "").toLowerCase().includes(normalizedQuery)
    || String(entry.parentPid ?? "").toLowerCase().includes(normalizedQuery)
    || String(entry.cwd ?? "").toLowerCase().includes(normalizedQuery)
  ));
}

export function canOpenChat(entry: ProcessEntry): boolean {
  return String(entry.pid ?? "").trim().length > 0 && String(entry.cwd ?? "").trim().length > 0;
}
