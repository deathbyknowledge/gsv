import { THEME_TOKEN_KEYS, type ThemeTokenKey } from "../themes";

export type AppThemeSnapshot = {
  themeId: string | null;
  tokens: Record<ThemeTokenKey, string>;
};

export type AppThemeClient = {
  snapshot: () => AppThemeSnapshot;
  subscribe: (listener: (snapshot: AppThemeSnapshot) => void) => () => void;
};

const THEME_EVENT = "gsv:theme-change";

function getShellNode(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".desktop-shell");
}

function readThemeSnapshot(): AppThemeSnapshot {
  const shellNode = getShellNode();
  const style = shellNode ? getComputedStyle(shellNode) : null;
  const themeId = shellNode?.dataset.theme ?? null;

  const tokens = {} as Record<ThemeTokenKey, string>;
  for (const tokenKey of THEME_TOKEN_KEYS) {
    const value = style?.getPropertyValue(`--gsv-${tokenKey}`) ?? "";
    tokens[tokenKey] = value.trim();
  }

  return {
    themeId,
    tokens,
  };
}

export function createThemeClient(): AppThemeClient {
  return {
    snapshot: () => readThemeSnapshot(),
    subscribe: (listener) => {
      const handler = (): void => {
        listener(readThemeSnapshot());
      };

      window.addEventListener(THEME_EVENT, handler);
      listener(readThemeSnapshot());

      return () => {
        window.removeEventListener(THEME_EVENT, handler);
      };
    },
  };
}

