import { canUseAmbientMode } from "./audio";
import type { PresenceMode } from "./types";

const PRESENCE_MODE_STORAGE_KEY = "gsv.presence.mode";
const SPEAK_REPLIES_STORAGE_KEY = "gsv.presence.speakReplies";

export function loadPresenceModePreference(): PresenceMode {
  try {
    const mode = normalizePresenceMode(window.localStorage.getItem(PRESENCE_MODE_STORAGE_KEY));
    if (mode === "ambient" && !canUseAmbientMode()) {
      return "push";
    }
    return mode ?? defaultPresenceMode();
  } catch {
    return defaultPresenceMode();
  }
}

export function savePresenceModePreference(mode: PresenceMode): void {
  try {
    window.localStorage.setItem(PRESENCE_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore unavailable storage; the in-memory state still applies for this session.
  }
}

export function loadSpeakRepliesPreference(): boolean {
  try {
    return window.localStorage.getItem(SPEAK_REPLIES_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveSpeakRepliesPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(SPEAK_REPLIES_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore unavailable storage; the in-memory state still applies for this session.
  }
}

export function normalizePresenceMode(value: unknown): PresenceMode | null {
  return value === "ambient" || value === "push" ? value : null;
}

function defaultPresenceMode(): PresenceMode {
  return canUseAmbientMode() ? "ambient" : "push";
}
