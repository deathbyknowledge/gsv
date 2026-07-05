import type { ExtensionUiState } from "./ui-state";

export function browserTargetHeadline(state: ExtensionUiState): string {
  if (liveAccessCount(state) > 0) {
    return "Agent using this browser";
  }
  if (state.connection.state === "connected") {
    return "Ready";
  }
  if (state.connection.state === "connecting") {
    return "Connecting";
  }
  return "Offline";
}

export function browserTargetTone(state: ExtensionUiState): string {
  if (liveAccessCount(state) > 0) {
    return "active";
  }
  return state.connection.state;
}

export function liveAccessCount(state: ExtensionUiState): number {
  return state.sensitive.networkCaptures
    + state.sensitive.mediaRecordings
    + state.sensitive.debuggerTabs.length;
}

export function liveAccessText(state: ExtensionUiState): string {
  const parts: string[] = [];
  if (state.sensitive.networkCaptures > 0) {
    parts.push(`${state.sensitive.networkCaptures} network capture${state.sensitive.networkCaptures === 1 ? "" : "s"}`);
  }
  if (state.sensitive.mediaRecordings > 0) {
    parts.push(`${state.sensitive.mediaRecordings} media recording${state.sensitive.mediaRecordings === 1 ? "" : "s"}`);
  }
  if (state.sensitive.debuggerTabs.length > 0) {
    parts.push(`${state.sensitive.debuggerTabs.length} debugger tab${state.sensitive.debuggerTabs.length === 1 ? "" : "s"}`);
  }
  return parts.join(" / ");
}

export function recordingGrantText(state: ExtensionUiState): string {
  const grant = state.media.captureGrant;
  if (!grant) {
    return "";
  }
  const label = grant.title || grant.url || `tab ${grant.tabId}`;
  return `${label} / ${timeUntil(grant.expiresAt)}`;
}

export function timeUntil(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return "expires soon";
  }
  const seconds = Math.max(0, Math.ceil((then - Date.now()) / 1000));
  if (seconds <= 0) {
    return "expired";
  }
  if (seconds < 60) {
    return `${seconds}s left`;
  }
  return `${Math.ceil(seconds / 60)}m left`;
}
