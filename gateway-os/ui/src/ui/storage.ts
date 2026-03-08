/**
 * Local Storage for UI Settings
 */

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  sessionKey: string;
  theme: "dark" | "light" | "system";
};

const STORAGE_KEY = "gsv-ui-settings";

/**
 * Derive default WebSocket URL from current page location
 * - Same host as UI, but /ws path
 * - Switch protocol: https→wss, http→ws
 */
function deriveGatewayUrl(): string {
  const loc = window.location;
  const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${loc.host}/ws`;
}

const DEFAULT_SETTINGS: UiSettings = {
  gatewayUrl: "", // Empty means "use derived URL"
  token: "",
  sessionKey: "agent:main:web:dm:local",
  theme: "dark",
};

/**
 * Get effective gateway URL (derived if not explicitly set)
 */
export function getGatewayUrl(settings: UiSettings): string {
  return settings.gatewayUrl || deriveGatewayUrl();
}

export function loadSettings(): UiSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    }
  } catch {
    // Ignore
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: Partial<UiSettings>): void {
  try {
    const current = loadSettings();
    const next = { ...current, ...settings };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore
  }
}

export function applyTheme(theme: UiSettings["theme"]): void {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const effectiveTheme = theme === "system" ? (prefersDark ? "dark" : "light") : theme;
  document.documentElement.setAttribute("data-theme", effectiveTheme);
  document.documentElement.setAttribute("data-mode", effectiveTheme);
}
