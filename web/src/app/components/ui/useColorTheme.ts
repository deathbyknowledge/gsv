import { useCallback, useEffect, useState } from "preact/hooks";

export type ColorTheme = "light" | "dark";
/** "system" follows the operating system's appearance; light or dark pins this device. */
export type ColorThemePreference = ColorTheme | "system";
export type ColorThemeState = {
  theme: ColorTheme;
  preference: ColorThemePreference;
  setPreference: (next: ColorThemePreference) => void;
  toggleTheme: () => void;
};
const THEME_KEY = "gsv.instrument.theme";
const THEME_CHANGE = "gsv-color-theme-change";
let pagePreference: ColorThemePreference | null = null;

/** An absent or unrecognised stored value follows the system, as it always has. */
function storedPreference(): ColorThemePreference {
  if (pagePreference) return pagePreference;
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  return "system";
}

function effectiveTheme(preference: ColorThemePreference): ColorTheme {
  if (preference !== "system") return preference;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function writePreference(next: ColorThemePreference): void {
  try {
    if (next === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, next);
    pagePreference = null;
  } catch {
    // a private window or blocked storage: the choice lasts for this page only
    pagePreference = next;
  }
  window.dispatchEvent(new Event(THEME_CHANGE));
}

/** One device preference across the signed-out and signed-in surfaces; otherwise follow the system. */
export function useColorTheme(): ColorThemeState {
  const [preference, setPreferenceState] = useState<ColorThemePreference>(storedPreference);
  const [theme, setTheme] = useState<ColorTheme>(() => effectiveTheme(storedPreference()));
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    const refresh = () => {
      const next = storedPreference();
      setPreferenceState(next);
      setTheme(effectiveTheme(next));
    };
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
  const setPreference = useCallback((next: ColorThemePreference) => writePreference(next), []);
  /* the l key and the sign-in screens pin the opposite of what is showing now */
  const toggleTheme = useCallback(() => {
    writePreference(effectiveTheme(storedPreference()) === "light" ? "dark" : "light");
  }, []);
  return { theme, preference, setPreference, toggleTheme };
}
