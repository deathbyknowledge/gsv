import { APP_REGISTRY, type AppManifest } from "./apps";
import type { WindowManager, WindowSummary } from "./window-manager";

type LauncherOptions = {
  rootNode: HTMLElement;
  windowManager: WindowManager;
  initialAppId?: string;
};

type LauncherController = {
  openApp: (appId: string) => void;
  destroy: () => void;
};

function byId(appId: string): AppManifest | undefined {
  return APP_REGISTRY.find((appItem) => appItem.id === appId);
}

export function createLauncher(options: LauncherOptions): LauncherController {
  const { rootNode, windowManager, initialAppId } = options;

  const iconNodes = Array.from(rootNode.querySelectorAll<HTMLButtonElement>(".desktop-icon[data-app-id]"));

  let selectedAppId: string | null = null;
  let latestSummaries: WindowSummary[] = [];

  const syncIconState = (summaries: WindowSummary[] = latestSummaries): void => {
    const activeSummary = summaries.find((summary) => summary.active && summary.mode !== "minimized");
    const activeAppId = activeSummary?.appId ?? null;

    for (const iconNode of iconNodes) {
      const appId = iconNode.dataset.appId;
      const isActive = appId !== undefined && appId === activeAppId;
      const isSelected = appId !== undefined && appId === selectedAppId;
      iconNode.classList.toggle("is-active", isActive);
      iconNode.classList.toggle("is-selected", isSelected);
    }
  };

  const setSelectedIcon = (appId: string | null): void => {
    selectedAppId = appId;
    syncIconState();
  };

  const openApp = (appId: string): void => {
    const app = byId(appId);
    if (!app) {
      return;
    }

    selectedAppId = app.id;
    windowManager.openApp(app);
  };

  const onIconClick = (event: MouseEvent): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLButtonElement)) {
      return;
    }

    const appId = target.dataset.appId;
    if (!appId) {
      return;
    }

    setSelectedIcon(appId);
  };

  const onIconDoubleClick = (event: MouseEvent): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLButtonElement)) {
      return;
    }

    const appId = target.dataset.appId;
    if (!appId) {
      return;
    }

    openApp(appId);
  };

  const onIconKeyDown = (event: KeyboardEvent): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLButtonElement)) {
      return;
    }

    const appId = target.dataset.appId;
    if (!appId) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openApp(appId);
    }
  };

  const onIconFocus = (event: FocusEvent): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLButtonElement)) {
      return;
    }

    const appId = target.dataset.appId;
    if (!appId) {
      return;
    }

    setSelectedIcon(appId);
  };

  for (const iconNode of iconNodes) {
    iconNode.addEventListener("click", onIconClick);
    iconNode.addEventListener("dblclick", onIconDoubleClick);
    iconNode.addEventListener("keydown", onIconKeyDown);
    iconNode.addEventListener("focus", onIconFocus);
  }

  const unsubscribe = windowManager.subscribe((summaries) => {
    latestSummaries = summaries;
    syncIconState(summaries);
  });

  if (initialAppId) {
    openApp(initialAppId);
  }

  return {
    openApp,
    destroy: () => {
      unsubscribe();
      for (const iconNode of iconNodes) {
        iconNode.removeEventListener("click", onIconClick);
        iconNode.removeEventListener("dblclick", onIconDoubleClick);
        iconNode.removeEventListener("keydown", onIconKeyDown);
        iconNode.removeEventListener("focus", onIconFocus);
      }
    },
  };
}
