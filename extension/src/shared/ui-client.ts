import type { ActivityEntry, ExtensionUiState, RuntimeMessage, RuntimeResponse } from "./ui-state";

export async function sendUiMessage(message: RuntimeMessage): Promise<RuntimeResponse> {
  return await chrome.runtime.sendMessage(message) as RuntimeResponse;
}

export function requireState(response: RuntimeResponse): ExtensionUiState {
  if (response.ok) {
    return response.state;
  }
  if (response.state) {
    return response.state;
  }
  throw new Error(response.error);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function timeAgo(iso: string | null): string {
  if (!iso) {
    return "-";
  }
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return iso;
  }
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 5) {
    return "now";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

export function formatDuration(ms?: number): string {
  if (typeof ms !== "number") {
    return "";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const keep = Math.max(1, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

export function renderActivityEntry(entry: ActivityEntry): string {
  const duration = formatDuration(entry.durationMs);
  const meta = [timeAgo(entry.at), duration].filter(Boolean).join(" / ");
  return `
    <li class="activity-row activity-row--${escapeHtml(entry.status)}">
      <span class="activity-kind">${escapeHtml(entry.kind)}</span>
      <span class="activity-main">
        <span class="activity-label">${escapeHtml(entry.label)}</span>
        <span class="activity-detail" title="${escapeHtml(entry.detail)}">${escapeHtml(entry.detail)}</span>
      </span>
      <span class="activity-meta" title="${escapeHtml(entry.at)}">${escapeHtml(meta)}</span>
    </li>
  `;
}

export function connectionText(state: ExtensionUiState): string {
  switch (state.connection.state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "disconnected":
      return "Disconnected";
  }
}
