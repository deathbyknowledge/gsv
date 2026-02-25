/**
 * Local Storage for UI Settings
 */

export type Wallpaper = "starfield" | "mesh" | "aurora" | "dark-grain" | "grid";

export const WALLPAPER_OPTIONS: { id: Wallpaper; label: string; description: string }[] = [
  { id: "starfield", label: "Starfield", description: "Drifting stars on deep space" },
  { id: "mesh", label: "Mesh Gradient", description: "Smooth shifting color gradient" },
  { id: "aurora", label: "Aurora", description: "Flowing bands of polar light" },
  { id: "dark-grain", label: "Dark Grain", description: "Near-black with subtle noise" },
  { id: "grid", label: "Grid", description: "Faint geometric dot matrix" },
];

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  sessionKey: string;
  theme: "dark" | "light" | "system";
  wallpaper: Wallpaper;
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
  wallpaper: "starfield",
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
