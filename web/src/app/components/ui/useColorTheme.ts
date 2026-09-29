import { useCallback, useEffect, useState } from "preact/hooks";

export type ColorTheme = "light" | "dark";
export type ColorThemeState = { theme: ColorTheme; toggleTheme: () => void };
const THEME_KEY = "gsv.instrument.theme";
const THEME_CHANGE = "gsv-color-theme-change";
let pagePreference: ColorTheme | null = null;

function effectiveTheme(): ColorTheme {
  if (pagePreference) return pagePreference;
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** One device preference across the signed-out and signed-in surfaces; otherwise follow the system. */
export function useColorTheme(): ColorThemeState {
  const [theme, setTheme] = useState<ColorTheme>(effectiveTheme);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    const refresh = () => setTheme(effectiveTheme());
    const storage = (event: StorageEvent) => {
      if (event.key === THEME_KEY || event.key === null) {
        pagePreference = null;
        refresh();
      }
    };
    query?.addEventListener("change", refresh);
    window.addEventListener("storage", storage);
    window.addEventListener(THEME_CHANGE, refresh);
    refresh();
    return () => {
      query?.removeEventListener("change", refresh);
      window.removeEventListener("storage", storage);
      window.removeEventListener(THEME_CHANGE, refresh);
    };
  }, []);
  const toggleTheme = useCallback(() => {
    const next = effectiveTheme() === "light" ? "dark" : "light";
    try {
      window.localStorage.setItem(THEME_KEY, next);
      pagePreference = null;
    } catch {
      // a private window or blocked storage: the choice lasts for this page only
      pagePreference = next;
    }
    setTheme(next);
    window.dispatchEvent(new Event(THEME_CHANGE));
  }, []);
  return { theme, toggleTheme };
}
