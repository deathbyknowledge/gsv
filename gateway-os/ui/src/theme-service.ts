import { DEFAULT_THEME_ID, isThemeId, THEME_TOKEN_KEYS, THEME_TOKENS, type ThemeId } from "./themes";

const THEME_STORAGE_KEY = "gsv.desktop.theme";
const THEME_CHANGE_EVENT = "gsv:theme-change";
const THEME_SET_EVENT = "gsv:theme-set";

type ThemeBindingOptions = {
  shellNode: HTMLElement;
};

type ThemeBinding = {
  applyTheme: (themeId: ThemeId) => void;
  destroy: () => void;
};

export type ThemeService = {
  initialTheme: ThemeId;
  bind: (options: ThemeBindingOptions) => ThemeBinding;
};

function readThemePreference(): ThemeId {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (value && isThemeId(value)) {
      return value;
    }
  } catch {
    // Ignore storage errors and fall back to default theme.
  }

  return DEFAULT_THEME_ID;
}

function persistThemePreference(themeId: ThemeId): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, themeId);
  } catch {
    // Ignore storage errors and keep runtime-only selection.
  }
}

function applyThemeTokens(shellNode: HTMLElement, themeId: ThemeId): void {
  const tokens = THEME_TOKENS[themeId];
  for (const tokenName of THEME_TOKEN_KEYS) {
    shellNode.style.setProperty(`--${tokenName}`, tokens[tokenName]);
    shellNode.style.setProperty(`--gsv-${tokenName}`, tokens[tokenName]);
  }
}

export function createThemeService(): ThemeService {
  const initialTheme = readThemePreference();

  return {
    initialTheme,
    bind: ({ shellNode }: ThemeBindingOptions): ThemeBinding => {
      const applyTheme = (themeId: ThemeId): void => {
        shellNode.dataset.theme = themeId;
        applyThemeTokens(shellNode, themeId);
        persistThemePreference(themeId);
        window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { themeId } }));
      };

      const onThemeSet = (event: Event): void => {
        if (!(event instanceof CustomEvent)) {
          return;
        }

        const requestedTheme = event.detail?.themeId;
        if (typeof requestedTheme !== "string" || !isThemeId(requestedTheme)) {
          return;
        }

        applyTheme(requestedTheme);
      };

      window.addEventListener(THEME_SET_EVENT, onThemeSet);
      applyTheme(initialTheme);

      return {
        applyTheme,
        destroy: () => {
          window.removeEventListener(THEME_SET_EVENT, onThemeSet);
        },
      };
    },
  };
}
