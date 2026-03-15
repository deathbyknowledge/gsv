export type ThemeId =
  | "frutiger-aero"
  | "skeumorphism"
  | "flat-design"
  | "neumorphism"
  | "glassmorphism"
  | "neubrutalism";

export type DesktopTheme = {
  id: ThemeId;
  label: string;
};

export const DEFAULT_THEME_ID: ThemeId = "frutiger-aero";

export const DESKTOP_THEMES: readonly DesktopTheme[] = [
  { id: "frutiger-aero", label: "Frutiger Aero" },
  { id: "skeumorphism", label: "Skeumorphism" },
  { id: "flat-design", label: "Flat Design" },
  { id: "neumorphism", label: "Neumorphism" },
  { id: "glassmorphism", label: "Glassmorphism" },
  { id: "neubrutalism", label: "Neubrutalism" },
] as const;

const THEME_ID_SET = new Set<ThemeId>(DESKTOP_THEMES.map((theme) => theme.id));

export function isThemeId(value: string): value is ThemeId {
  return THEME_ID_SET.has(value as ThemeId);
}

export const THEME_TOKEN_KEYS = [
  "bg-deep",
  "bg-mid",
  "bg-light",
  "surface-0",
  "surface-1",
  "surface-2",
  "line-soft",
  "line-strong",
  "text-main",
  "text-muted",
  "accent",
  "danger",
  "warn",
  "ok",
  "window-radius",
  "window-border-width",
  "window-border-color",
  "window-shadow",
  "window-shadow-drag",
  "titlebar-bg",
  "topbar-height",
  "topbar-shadow",
  "panel-backdrop",
  "icon-tile-size",
  "icon-glyph-size",
  "icon-label-size",
  "icon-radius",
  "icon-bg",
  "icon-bg-hover",
  "icon-shadow",
] as const;

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];
export type ThemeTokens = Record<ThemeTokenKey, string>;

const SHARED_TOKENS = {
  danger: "#ff6f6f",
  warn: "#f0ca6f",
  ok: "#5cd2a8",
  "window-border-color": "var(--line-soft)",
  "topbar-height": "46px",
  "topbar-shadow": "none",
  "panel-backdrop": "none",
  "icon-tile-size": "72px",
  "icon-glyph-size": "22px",
  "icon-label-size": "0.74rem",
  "icon-shadow": "none",
} as const;

function defineThemeTokens(tokens: ThemeTokens): ThemeTokens {
  return tokens;
}

export const THEME_TOKENS: Record<ThemeId, ThemeTokens> = {
  "frutiger-aero": defineThemeTokens({
    ...SHARED_TOKENS,
    "bg-deep": "#070f22",
    "bg-mid": "#11274d",
    "bg-light": "#2f5f93",
    "surface-0": "rgba(8, 16, 35, 0.84)",
    "surface-1": "rgba(10, 19, 41, 0.9)",
    "surface-2": "rgba(7, 14, 30, 0.94)",
    "line-soft": "rgba(170, 207, 241, 0.22)",
    "line-strong": "rgba(196, 224, 249, 0.42)",
    "text-main": "#edf5ff",
    "text-muted": "rgba(219, 236, 251, 0.76)",
    accent: "#8ccdf8",
    "window-radius": "12px",
    "window-border-width": "1px",
    "window-shadow": "0 28px 60px rgba(4, 10, 24, 0.52)",
    "window-shadow-drag": "0 34px 74px rgba(2, 8, 21, 0.62)",
    "titlebar-bg": "rgba(130, 169, 204, 0.15)",
    "icon-radius": "8px",
    "icon-bg": "rgba(150, 196, 226, 0.08)",
    "icon-bg-hover": "rgba(150, 196, 226, 0.16)",
  }),

  skeumorphism: defineThemeTokens({
    ...SHARED_TOKENS,
    "bg-deep": "#15110d",
    "bg-mid": "#3c2f24",
    "bg-light": "#75624a",
    "surface-0": "rgba(38, 28, 20, 0.9)",
    "surface-1": "rgba(59, 44, 32, 0.9)",
    "surface-2": "rgba(50, 36, 24, 0.92)",
    "line-soft": "rgba(238, 210, 172, 0.26)",
    "line-strong": "rgba(249, 227, 198, 0.44)",
    "text-main": "#fbf2e4",
    "text-muted": "rgba(250, 234, 207, 0.74)",
    accent: "#e6bf83",
    "window-radius": "6px",
    "window-border-width": "1px",
    "window-shadow": "0 18px 32px rgba(14, 9, 6, 0.52), inset 0 1px 0 rgba(255, 232, 199, 0.26)",
    "window-shadow-drag": "0 22px 40px rgba(14, 9, 6, 0.62), inset 0 1px 0 rgba(255, 232, 199, 0.26)",
    "titlebar-bg": "linear-gradient(180deg, rgba(184, 139, 98, 0.2), rgba(108, 79, 54, 0.24))",
    "icon-radius": "6px",
    "icon-bg": "rgba(147, 113, 78, 0.2)",
    "icon-bg-hover": "rgba(171, 132, 92, 0.3)",
  }),

  "flat-design": defineThemeTokens({
    ...SHARED_TOKENS,
    "bg-deep": "#10253f",
    "bg-mid": "#1e466f",
    "bg-light": "#3698d5",
    "surface-0": "rgba(18, 57, 89, 0.98)",
    "surface-1": "rgba(24, 65, 101, 0.96)",
    "surface-2": "rgba(17, 52, 83, 0.98)",
    "line-soft": "rgba(162, 219, 255, 0.22)",
    "line-strong": "rgba(194, 234, 255, 0.44)",
    "text-main": "#f6fbff",
    "text-muted": "rgba(220, 241, 255, 0.78)",
    accent: "#6de0ff",
    "window-radius": "4px",
    "window-border-width": "1px",
    "window-shadow": "none",
    "window-shadow-drag": "0 0 0 2px rgba(109, 224, 255, 0.32)",
    "titlebar-bg": "rgba(111, 203, 255, 0.18)",
    "icon-radius": "4px",
    "icon-bg": "rgba(115, 202, 250, 0.2)",
    "icon-bg-hover": "rgba(115, 202, 250, 0.34)",
  }),

  neumorphism: defineThemeTokens({
    ...SHARED_TOKENS,
    "bg-deep": "#7a8797",
    "bg-mid": "#95a2b1",
    "bg-light": "#b9c4d0",
    "surface-0": "rgba(167, 179, 194, 0.92)",
    "surface-1": "rgba(175, 188, 203, 0.96)",
    "surface-2": "rgba(168, 180, 197, 0.94)",
    "line-soft": "rgba(255, 255, 255, 0.35)",
    "line-strong": "rgba(111, 126, 145, 0.36)",
    "text-main": "#203042",
    "text-muted": "rgba(42, 57, 74, 0.72)",
    accent: "#3e6ea0",
    "window-radius": "18px",
    "window-border-width": "0",
    "window-shadow": "14px 14px 30px rgba(116, 127, 140, 0.44), -10px -10px 20px rgba(226, 234, 242, 0.6)",
    "window-shadow-drag": "16px 16px 34px rgba(116, 127, 140, 0.5), -12px -12px 24px rgba(226, 234, 242, 0.62)",
    "titlebar-bg": "rgba(255, 255, 255, 0.24)",
    "icon-radius": "16px",
    "icon-bg": "rgba(172, 185, 199, 0.94)",
    "icon-bg-hover": "rgba(180, 193, 205, 1)",
    "icon-shadow": "6px 6px 14px rgba(119, 130, 143, 0.36), -5px -5px 10px rgba(228, 236, 244, 0.62)",
  }),

  glassmorphism: defineThemeTokens({
    ...SHARED_TOKENS,
    "bg-deep": "#071429",
    "bg-mid": "#143660",
    "bg-light": "#4f91c8",
    "surface-0": "rgba(18, 39, 70, 0.46)",
    "surface-1": "rgba(18, 41, 76, 0.44)",
    "surface-2": "rgba(14, 33, 63, 0.5)",
    "line-soft": "rgba(216, 239, 255, 0.3)",
    "line-strong": "rgba(228, 246, 255, 0.46)",
    "text-main": "#f3fbff",
    "text-muted": "rgba(230, 245, 255, 0.8)",
    accent: "#93e5ff",
    "window-radius": "14px",
    "window-border-width": "1px",
    "window-shadow": "0 18px 48px rgba(4, 11, 25, 0.5)",
    "window-shadow-drag": "0 24px 60px rgba(3, 9, 21, 0.58)",
    "titlebar-bg": "rgba(136, 189, 228, 0.2)",
    "panel-backdrop": "blur(16px) saturate(1.2)",
    "icon-radius": "12px",
    "icon-bg": "rgba(143, 195, 231, 0.2)",
    "icon-bg-hover": "rgba(143, 195, 231, 0.3)",
  }),

  neubrutalism: defineThemeTokens({
    ...SHARED_TOKENS,
    "bg-deep": "#202020",
    "bg-mid": "#2f2f2f",
    "bg-light": "#ffd532",
    "surface-0": "#111111",
    "surface-1": "#f9f6eb",
    "surface-2": "#fffcee",
    "line-soft": "#000000",
    "line-strong": "#000000",
    "text-main": "#111111",
    "text-muted": "rgba(24, 24, 24, 0.8)",
    accent: "#ff3ebf",
    "window-radius": "0",
    "window-border-width": "3px",
    "window-border-color": "#000000",
    "window-shadow": "8px 8px 0 #000000",
    "window-shadow-drag": "12px 12px 0 #000000",
    "titlebar-bg": "#f7e95a",
    "icon-radius": "0",
    "icon-bg": "#ffffff",
    "icon-bg-hover": "#ff93eb",
    "icon-shadow": "4px 4px 0 #000000",
  }),
};
