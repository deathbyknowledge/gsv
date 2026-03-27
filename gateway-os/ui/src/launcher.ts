import { APP_REGISTRY, type AppManifest } from "./apps";
import { OPEN_APP_EVENT, type OpenAppEventDetail } from "./app-link";
import {
  OPEN_CHAT_PROCESS_EVENT,
  TARGET_CHAT_PROCESS_EVENT,
  normalizeProcessId,
  queuePendingChatProcess,
  type TargetChatProcessEventDetail,
} from "./chat-process-link";
import { normalizeThreadContext, setActiveThreadContext } from "./thread-context";
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

  const openWindowForApp = (appId: string): string | null => {
    const app = byId(appId);
    if (!app) {
      return null;
    }

    selectedAppId = app.id;
    return windowManager.openApp(app);
  };

  const openApp = (appId: string): void => {
    void openWindowForApp(appId);
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

  const onOpenChatProcess = (event: Event): void => {
    if (!(event instanceof CustomEvent)) {
      return;
    }

    const rawDetail = event.detail as { pid?: unknown; workspaceId?: unknown; cwd?: unknown } | null;
    const pid = normalizeProcessId(rawDetail?.pid);
    const normalized = normalizeThreadContext({
      pid,
      workspaceId: rawDetail?.workspaceId ?? null,
      cwd: rawDetail?.cwd,
    });
    if (!normalized) {
      return;
    }

    const chatWindowId = openWindowForApp("chat");
    if (!chatWindowId) {
      return;
    }

    setActiveThreadContext(normalized);
    queuePendingChatProcess(chatWindowId, normalized);
    const targetDetail: TargetChatProcessEventDetail = { ...normalized, windowId: chatWindowId };
    window.dispatchEvent(new CustomEvent<TargetChatProcessEventDetail>(TARGET_CHAT_PROCESS_EVENT, { detail: targetDetail }));
  };

  const onOpenApp = (event: Event): void => {
    if (!(event instanceof CustomEvent)) {
      return;
    }

    const detail = event.detail as OpenAppEventDetail | null;
    const appId = typeof detail?.appId === "string" ? detail.appId.trim() : "";
    if (!appId) {
      return;
    }

    const normalizedThread = normalizeThreadContext(detail?.threadContext);
    if (normalizedThread) {
      setActiveThreadContext(normalizedThread);
    }

    openApp(appId);
  };

  for (const iconNode of iconNodes) {
    iconNode.addEventListener("click", onIconClick);
    iconNode.addEventListener("dblclick", onIconDoubleClick);
    iconNode.addEventListener("keydown", onIconKeyDown);
    iconNode.addEventListener("focus", onIconFocus);
  }

  window.addEventListener(OPEN_CHAT_PROCESS_EVENT, onOpenChatProcess as EventListener);
  window.addEventListener(OPEN_APP_EVENT, onOpenApp as EventListener);

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
      window.removeEventListener(OPEN_CHAT_PROCESS_EVENT, onOpenChatProcess as EventListener);
      window.removeEventListener(OPEN_APP_EVENT, onOpenApp as EventListener);
    },
  };
}
