import type { AiTranscriptionCreateResult } from "@humansandmachines/gsv/protocol";
import type { PresenceLogStatus, PresenceState } from "./types";

export function appendTranscript(current: string, addition: string): string {
  return `${current.trim()} ${addition.trim()}`.trim();
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function transcriptionNote(result: AiTranscriptionCreateResult): string {
  const parts: string[] = [];
  if (typeof result.language === "string" && result.language.trim()) {
    parts.push(result.language.trim());
  }
  if (typeof result.duration === "number" && Number.isFinite(result.duration) && result.duration > 0) {
    parts.push(`${Math.round(result.duration)}s`);
  }
  return parts.length > 0 ? `Transcribed ${parts.join(" / ")}` : "";
}

export function addPresenceLog(
  log: HTMLElement | null,
  status: PresenceLogStatus,
  text: string,
  timestamp: number,
): HTMLElement | null {
  if (!log) {
    return null;
  }
  log.hidden = false;
  const row = document.createElement("div");
  row.className = "presence-log-row";
  row.dataset.timestamp = String(timestamp);
  const meta = document.createElement("span");
  meta.className = "presence-log-meta";
  const body = document.createElement("p");
  body.textContent = text;
  row.append(meta, body);
  updatePresenceLog(row, status);
  log.prepend(row);
  while (log.children.length > 6) {
    log.lastElementChild?.remove();
  }
  return row;
}

export function updatePresenceLog(row: HTMLElement | null, status: PresenceLogStatus, text?: string): void {
  if (!row) {
    return;
  }
  const timestamp = Number(row.dataset.timestamp) || Date.now();
  row.dataset.status = statusKey(status);
  const meta = row.querySelector<HTMLElement>(".presence-log-meta");
  if (meta) {
    meta.textContent = `${formatClock(timestamp)} ${status}`;
  }
  if (typeof text === "string") {
    const body = row.querySelector<HTMLParagraphElement>("p");
    if (body) {
      body.textContent = text;
    }
  }
}

export function statusKey(status: PresenceLogStatus): string {
  return status.toLowerCase().replace(/\s+/g, "-");
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function truncateActivityText(text: string): string {
  return text.length > 420 ? `${text.slice(0, 419).trimEnd()}...` : text;
}

export function statusText(state: PresenceState, connected: boolean, activeRuns = 0): string {
  if (!connected) {
    return "Disconnected";
  }
  if (activeRuns > 0 && (state === "idle" || state === "listening")) {
    return activeRuns === 1 ? "Mind working" : `${activeRuns} Mind jobs`;
  }
  switch (state) {
    case "listening": return "Listening";
    case "capturing": return "Capturing speech";
    case "recording": return "Recording";
    case "transcribing": return "Transcribing";
    case "sending": return "Sending";
    case "unsupported": return "Mind unavailable; type instead";
    case "error": return "Needs attention";
    default: return "Paused";
  }
}

export function compactPresenceStatus(state: PresenceState, connected: boolean, activeRuns = 0): string {
  if (!connected) {
    return "Offline";
  }
  if (activeRuns > 0) {
    return activeRuns === 1 ? "Working" : `${activeRuns} jobs`;
  }
  switch (state) {
    case "listening": return "Listening";
    case "capturing": return "Heard";
    case "recording": return "Recording";
    case "transcribing": return "Transcribing";
    case "sending": return "Sending";
    case "unsupported": return "Text only";
    case "error": return "Attention";
    default: return "Paused";
  }
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
