const TERMINAL_BACKGROUND_STORAGE_KEY = "gsv.terminal.runInBackground";

export function loadTerminalRunInBackgroundPreference(): boolean {
  try {
    return window.localStorage.getItem(TERMINAL_BACKGROUND_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveTerminalRunInBackgroundPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(TERMINAL_BACKGROUND_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Keep the in-memory form value when storage is unavailable.
  }
}
