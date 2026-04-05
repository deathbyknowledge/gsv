import type { AppManifest } from "./apps";
import { renderDesktopIcon } from "./icons";
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
  setApps: (apps: readonly AppManifest[]) => void;
  destroy: () => void;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export function createLauncher(options: LauncherOptions): LauncherController {
  const { rootNode, windowManager, initialAppId } = options;
  const iconsNode = rootNode.querySelector<HTMLElement>("[data-desktop-icons]");

  if (!iconsNode) {
    throw new Error("Desktop icon layer is missing");
  }

  let apps: readonly AppManifest[] = [];
  let appById = new Map<string, AppManifest>();
  let selectedAppId: string | null = null;
  let latestSummaries: WindowSummary[] = [];

  const getIconNodes = (): HTMLButtonElement[] => {
    return Array.from(iconsNode.querySelectorAll<HTMLButtonElement>(".desktop-icon[data-app-id]"));
  };

  const renderIcons = (): void => {
    iconsNode.innerHTML = apps
      .map((appItem) => {
        return `
          <button type="button" class="desktop-icon" data-app-id="${escapeHtml(appItem.id)}">
            ${renderDesktopIcon(appItem.icon)}
            <span class="desktop-label">${escapeHtml(appItem.name)}</span>
          </button>
        `;
      })
      .join("");

    syncIconState();
  };

  const syncIconState = (summaries: WindowSummary[] = latestSummaries): void => {
    const activeSummary = summaries.find((summary) => summary.active && summary.mode !== "minimized");
    const activeAppId = activeSummary?.appId ?? null;

    for (const iconNode of getIconNodes()) {
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
    const app = appById.get(appId);
    if (!app) {
      return null;
    }

    selectedAppId = app.id;
    return windowManager.openApp(app);
  };

  const openApp = (appId: string): void => {
    void openWindowForApp(appId);
  };

  const getAppIdFromEvent = (event: Event): string | null => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return null;
    }

    const button = target.closest<HTMLButtonElement>(".desktop-icon[data-app-id]");
    if (!button || !iconsNode.contains(button)) {
      return null;
    }

    const appId = button.dataset.appId;
    return appId ?? null;
  };

  const onIconClick = (event: MouseEvent): void => {
    const appId = getAppIdFromEvent(event);
    if (!appId) {
      return;
    }

    setSelectedIcon(appId);
  };

  const onIconDoubleClick = (event: MouseEvent): void => {
    const appId = getAppIdFromEvent(event);
    if (!appId) {
      return;
    }

    openApp(appId);
  };

  const onIconKeyDown = (event: KeyboardEvent): void => {
    const appId = getAppIdFromEvent(event);
    if (!appId) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openApp(appId);
    }
  };

  const onIconFocus = (event: FocusEvent): void => {
    const appId = getAppIdFromEvent(event);
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

  iconsNode.addEventListener("click", onIconClick);
  iconsNode.addEventListener("dblclick", onIconDoubleClick);
  iconsNode.addEventListener("keydown", onIconKeyDown);
  iconsNode.addEventListener("focusin", onIconFocus as EventListener);

  window.addEventListener(OPEN_CHAT_PROCESS_EVENT, onOpenChatProcess as EventListener);
  window.addEventListener(OPEN_APP_EVENT, onOpenApp as EventListener);

  const unsubscribe = windowManager.subscribe((summaries) => {
    latestSummaries = summaries;
    syncIconState(summaries);
  });

  const setApps = (nextApps: readonly AppManifest[]): void => {
    apps = [...nextApps];
    appById = new Map(apps.map((app) => [app.id, app]));
    if (selectedAppId && !appById.has(selectedAppId)) {
      selectedAppId = null;
    }
    renderIcons();
  };

  if (initialAppId) {
    openApp(initialAppId);
  }

  return {
    openApp,
    setApps,
    destroy: () => {
      unsubscribe();
      iconsNode.removeEventListener("click", onIconClick);
      iconsNode.removeEventListener("dblclick", onIconDoubleClick);
      iconsNode.removeEventListener("keydown", onIconKeyDown);
      iconsNode.removeEventListener("focusin", onIconFocus as EventListener);
      window.removeEventListener(OPEN_CHAT_PROCESS_EVENT, onOpenChatProcess as EventListener);
      window.removeEventListener(OPEN_APP_EVENT, onOpenApp as EventListener);
    },
  };
}
