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
  "control-bg",
  "control-border",
  "control-border-focus",
  "control-focus-ring",
  "control-text",
  "control-placeholder",
  "control-disabled-bg",
  "control-disabled-text",
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
  "control-bg": "color-mix(in srgb, var(--surface-0) 72%, transparent)",
  "control-border": "var(--line-soft)",
  "control-border-focus": "color-mix(in srgb, var(--accent) 62%, var(--line-strong))",
  "control-focus-ring": "0 0 0 3px color-mix(in srgb, var(--accent) 24%, transparent)",
  "control-text": "var(--text-main)",
  "control-placeholder": "color-mix(in srgb, var(--text-muted) 92%, transparent)",
  "control-disabled-bg": "color-mix(in srgb, var(--surface-0) 52%, transparent)",
  "control-disabled-text": "color-mix(in srgb, var(--text-muted) 88%, transparent)",
} as const;

function defineThemeTokens(tokens: ThemeTokens): ThemeTokens {
  return tokens;
}

export const THEME_TOKENS: Record<ThemeId, ThemeTokens> = {
  "frutiger-aero": defineThemeTokens({
    ...SHARED_TOKENS,
    danger: "#f26d77",
    warn: "#f3ce74",
    ok: "#7fd45a",
    "bg-deep": "#62a7d6",
    "bg-mid": "#95d0ea",
    "bg-light": "#dbf8ff",
    "surface-0": "rgba(241, 250, 255, 0.78)",
    "surface-1": "rgba(231, 245, 252, 0.92)",
    "surface-2": "rgba(222, 239, 249, 0.95)",
    "line-soft": "rgba(90, 147, 182, 0.28)",
    "line-strong": "rgba(73, 133, 173, 0.48)",
    "text-main": "#16344c",
    "text-muted": "rgba(32, 70, 95, 0.74)",
    accent: "#32c8ff",
    "window-radius": "15px",
    "window-border-width": "1px",
    "window-border-color": "rgba(115, 170, 202, 0.52)",
    "window-shadow": "0 18px 34px rgba(63, 133, 182, 0.24), 0 28px 50px rgba(50, 109, 151, 0.22)",
    "window-shadow-drag": "0 24px 42px rgba(53, 118, 164, 0.28), 0 34px 56px rgba(48, 103, 145, 0.26)",
    "titlebar-bg":
      "linear-gradient(180deg, rgba(246, 255, 255, 0.96) 0%, rgba(220, 246, 255, 0.9) 56%, rgba(201, 234, 246, 0.9) 100%)",
    "topbar-shadow":
      "0 1px 0 rgba(255, 255, 255, 0.7) inset, 0 -1px 0 rgba(101, 157, 189, 0.34) inset, 0 8px 18px rgba(56, 120, 167, 0.22)",
    "icon-tile-size": "74px",
    "icon-radius": "12px",
    "icon-bg":
      "linear-gradient(180deg, rgba(248, 255, 255, 0.5) 0%, rgba(221, 247, 255, 0.38) 100%)",
    "icon-bg-hover":
      "linear-gradient(180deg, rgba(248, 255, 255, 0.74) 0%, rgba(196, 241, 255, 0.58) 100%)",
    "icon-shadow": "0 4px 10px rgba(69, 137, 178, 0.18)",
    "control-bg":
      "linear-gradient(180deg, rgba(255, 255, 255, 0.9) 0%, rgba(220, 245, 255, 0.86) 55%, rgba(206, 232, 245, 0.86) 100%)",
    "control-border": "rgba(92, 151, 186, 0.5)",
    "control-border-focus": "rgba(58, 167, 223, 0.88)",
    "control-focus-ring": "0 0 0 3px rgba(89, 205, 255, 0.34)",
    "control-text": "#16344c",
    "control-placeholder": "rgba(38, 88, 120, 0.56)",
    "control-disabled-bg":
      "linear-gradient(180deg, rgba(237, 246, 251, 0.86) 0%, rgba(223, 236, 244, 0.82) 100%)",
    "control-disabled-text": "rgba(49, 88, 112, 0.54)",
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
    danger: "#ea6d7e",
    warn: "#e9bb73",
    ok: "#7bbd98",
    "bg-deep": "#c6b9da",
    "bg-mid": "#dce2eb",
    "bg-light": "#f5f4f7",
    "surface-0": "rgba(255, 255, 255, 0.58)",
    "surface-1": "rgba(255, 255, 255, 0.74)",
    "surface-2": "rgba(248, 249, 253, 0.82)",
    "line-soft": "rgba(138, 146, 165, 0.22)",
    "line-strong": "rgba(130, 139, 161, 0.34)",
    "text-main": "#34363f",
    "text-muted": "rgba(81, 86, 102, 0.66)",
    accent: "#ff8f9d",
    "window-radius": "22px",
    "window-border-width": "1px",
    "window-border-color": "rgba(255, 255, 255, 0.8)",
    "window-shadow": "0 12px 28px rgba(124, 115, 148, 0.18), 0 2px 8px rgba(150, 153, 180, 0.14)",
    "window-shadow-drag": "0 16px 34px rgba(121, 113, 150, 0.24), 0 6px 14px rgba(145, 149, 176, 0.18)",
    "titlebar-bg":
      "linear-gradient(180deg, rgba(255, 255, 255, 0.88) 0%, rgba(247, 247, 251, 0.72) 100%)",
    "topbar-shadow":
      "0 1px 0 rgba(255, 255, 255, 0.84) inset, 0 8px 20px rgba(137, 131, 161, 0.16)",
    "panel-backdrop": "blur(20px) saturate(1.04)",
    "icon-radius": "20px",
    "icon-bg":
      "linear-gradient(180deg, rgba(255, 255, 255, 0.54) 0%, rgba(245, 246, 250, 0.34) 100%)",
    "icon-bg-hover":
      "linear-gradient(180deg, rgba(255, 255, 255, 0.72) 0%, rgba(243, 244, 249, 0.5) 100%)",
    "icon-shadow": "0 8px 16px rgba(150, 152, 172, 0.2)",
    "control-bg":
      "linear-gradient(180deg, rgba(255, 255, 255, 0.82) 0%, rgba(245, 246, 251, 0.62) 100%)",
    "control-border": "rgba(155, 160, 179, 0.32)",
    "control-border-focus": "rgba(255, 143, 157, 0.74)",
    "control-focus-ring": "0 0 0 3px rgba(255, 173, 184, 0.34)",
    "control-text": "#3a3e4b",
    "control-placeholder": "rgba(102, 106, 121, 0.5)",
    "control-disabled-bg":
      "linear-gradient(180deg, rgba(243, 244, 248, 0.78) 0%, rgba(235, 237, 244, 0.64) 100%)",
    "control-disabled-text": "rgba(112, 117, 133, 0.5)",
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
