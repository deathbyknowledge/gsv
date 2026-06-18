import {
  OPEN_APP_EVENT,
  resolveOpenAppDetail,
  type OpenAppEventDetail,
} from "@humansandmachines/gsv/sdk/host";
import { render as renderPreact } from "preact";
import {
  TARGET_CHAT_PROCESS_EVENT,
  queuePendingChatProcess,
  type TargetChatProcessEventDetail,
} from "./host/chatTarget";
import type { DesktopApp, DesktopAppIcon } from "../domain/desktopApp";
import {
  DesktopAppIcons,
  MobileAppGrid,
  MobileWindowStack,
  TaskbarWindows,
  type MobileAppActivationInput,
} from "../components/DesktopLauncherViews";
import {
  centeredMobileRotorIndex,
  mobileRotorMetrics as calculateMobileRotorMetrics,
  normalizeMobileRotorPosition as normalizeRotorPosition,
  orderMobileWindowStack,
  shortestMobileRotorDelta as shortestRotorDelta,
  type MobileRotorMetrics,
} from "../domain/launcherState";
import { createCommandPalette, type CommandPaletteActionItem } from "./commandPalette";
import type { WindowManager, WindowSummary } from "./windowManager";

type LauncherOptions = {
  rootNode: HTMLElement;
  windowManager: WindowManager;
  initialAppId?: string;
};

type LauncherController = {
  openApp: (appId: string, route?: string) => void;
  openCommandPalette: () => void;
  revealDock: (options?: { temporary?: boolean }) => void;
  hideDockSoon: () => void;
  setApps: (apps: readonly DesktopApp[]) => void;
  destroy: () => void;
};

type MobileShellState = "home" | "app" | "search";

export function createLauncher(options: LauncherOptions): LauncherController {
  const { rootNode, windowManager, initialAppId } = options;
  const iconsNode = rootNode.querySelector<HTMLElement>("[data-desktop-icons]");
  const taskbarWindowsNode = rootNode.querySelector<HTMLElement>("[data-taskbar-windows]");
  const mobileAppsNode = rootNode.querySelector<HTMLElement>("[data-mobile-apps]");
  const mobileHomeNode = rootNode.querySelector<HTMLElement>("[data-mobile-home]");
  const mobileHomeButtonNode = rootNode.querySelector<HTMLButtonElement>("[data-mobile-home-button]");
  const commandPaletteRootNode = rootNode.querySelector<HTMLElement>("[data-command-palette-root]");

  if (!iconsNode) {
    throw new Error("Desktop icon layer is missing");
  }
  if (!commandPaletteRootNode) {
    throw new Error("Command palette root is missing");
  }

  let apps: readonly DesktopApp[] = [];
  let appById = new Map<string, DesktopApp>();
  let selectedAppId: string | null = null;
  let latestSummaries: WindowSummary[] = [];
  let openedInitialApp = false;
  let dockRevealTimer: number | null = null;
  let mobileLaunchTimer: number | null = null;
  let mobileReturnTimer: number | null = null;
  let mobileShellState: MobileShellState = "home";
  let mobileHomeDepthRaf: number | null = null;
  let mobileRotorPosition = 0;
  let mobileRotorSnapTimer: number | null = null;
  let mobileRotorPointerId: number | null = null;
  let mobileRotorDragStartY = 0;
  let mobileRotorDragStartPosition = 0;
  let mobileRotorLastDragY = 0;
  let mobileRotorLastDragTime = 0;
  let mobileRotorDidDrag = false;
  let mobileRotorVelocity = 0;
  let mobileRotorMomentumRaf: number | null = null;
  let mobileRotorMomentumTime = 0;
  let mobileAppNodes: HTMLButtonElement[] = [];
  let mobileAppIndexById = new Map<string, number>();
  let mobileRotorMetrics: MobileRotorMetrics | null = null;
  let mobileCenteredAppId: string | null = null;
  const mobileStackSelections = new Map<string, string>();
  let mobileHomeGesturePointerId: number | null = null;
  let mobileHomeGestureStartY = 0;
  let mobileHomeGestureProgress = 0;
  let mobileHomeGestureSuppressClick = false;

  const summariesForApp = (appId: string): WindowSummary[] => {
    return latestSummaries
      .filter((summary) => summary.appId === appId)
      .sort((left, right) => right.zIndex - left.zIndex);
  };

  const activateWindowSummary = (summary: WindowSummary): void => {
    if (summary.mode === "minimized") {
      windowManager.restoreWindow(summary.windowId);
      return;
    }
    windowManager.focusWindow(summary.windowId);
  };

  const activateApp = (appId: string, options?: { forceNew?: boolean; route?: string }): string | null => {
    if (!options?.forceNew) {
      const existing = summariesForApp(appId)[0];
      if (existing) {
        activateWindowSummary(existing);
        setSelectedIcon(appId);
        return existing.windowId;
      }
    }

    return openWindowForApp(appId, options?.route, { forceNew: options?.forceNew });
  };

  const activateMobileApp = (appId: string): string | null => {
    const selectedWindowId = mobileStackSelections.get(appId) ?? null;
    if (selectedWindowId) {
      const selectedSummary = summariesForApp(appId).find((summary) => summary.windowId === selectedWindowId) ?? null;
      if (selectedSummary) {
        activateWindowSummary(selectedSummary);
        setSelectedIcon(appId);
        return selectedSummary.windowId;
      }
      mobileStackSelections.delete(appId);
    }

    return activateApp(appId);
  };

  const renderDesktopIcons = (summaries: WindowSummary[] = latestSummaries): void => {
    const activeSummary = summaries.find((summary) => summary.active && summary.mode !== "minimized");
    const activeAppId = activeSummary?.appId ?? null;

    renderPreact(
      <DesktopAppIcons
        apps={apps}
        activeAppId={activeAppId}
        selectedAppId={selectedAppId}
        onSelectApp={setSelectedIcon}
        onOpenApp={(appId, openOptions) => {
          activateApp(appId, openOptions);
        }}
      />,
      iconsNode,
    );
  };

  const renderTaskbarWindows = (summaries: readonly WindowSummary[] = latestSummaries): void => {
    if (!taskbarWindowsNode) {
      return;
    }

    renderPreact(
      <TaskbarWindows
        summaries={summaries}
        onActivateWindow={(windowId) => {
          const summary = latestSummaries.find((item) => item.windowId === windowId);
          if (summary) {
            activateWindowSummary(summary);
          }
        }}
        onCloseWindow={(windowId) => windowManager.closeWindow(windowId)}
      />,
      taskbarWindowsNode,
    );
  };

  const renderMobileApps = (): void => {
    if (!mobileAppsNode) {
      return;
    }

    renderPreact(
      <MobileAppGrid
        apps={apps}
        onActivateApp={(input) => activateMobileAppFromGrid(input)}
        onNavigate={(direction) => navigateMobileRotor(direction)}
      />,
      mobileAppsNode,
    );
    mobileAppNodes = Array.from(mobileAppsNode.querySelectorAll<HTMLButtonElement>(".mobile-app-icon[data-app-id]"));
    mobileAppIndexById = new Map(apps.map((appItem, index) => [appItem.id, index]));
    mobileRotorMetrics = null;
    mobileCenteredAppId = apps[getCenteredMobileRotorIndex()]?.id ?? null;
    syncMobileAppState();
    scheduleMobileHomeDepth();
  };

  const getMobileAppNodes = (): HTMLButtonElement[] => {
    return mobileAppNodes;
  };

  const normalizeMobileRotorPosition = (position: number): number => {
    return normalizeRotorPosition(position, apps.length);
  };

  const shortestMobileRotorDelta = (index: number, position: number): number => {
    return shortestRotorDelta(index, position, apps.length);
  };

  const setMobileRotorPosition = (position: number): void => {
    mobileRotorPosition = normalizeMobileRotorPosition(position);
    scheduleMobileHomeDepth();
  };

  const setMobileRotorIndex = (index: number): void => {
    if (apps.length === 0) {
      return;
    }
    setMobileRotorPosition(mobileRotorPosition + shortestMobileRotorDelta(index, mobileRotorPosition));
  };

  const getCenteredMobileRotorIndex = (): number => {
    return centeredMobileRotorIndex(mobileRotorPosition, apps.length);
  };

  const getMobileRotorIndexForButton = (button: HTMLButtonElement): number => {
    const appId = button.dataset.appId;
    if (!appId) {
      return -1;
    }
    return mobileAppIndexById.get(appId) ?? -1;
  };

  const focusMobileRotorIndex = (index: number): void => {
    getMobileAppNodes()[index]?.focus();
  };

  const clearMobileRotorSnapTimer = (): void => {
    if (mobileRotorSnapTimer === null) {
      return;
    }
    window.clearTimeout(mobileRotorSnapTimer);
    mobileRotorSnapTimer = null;
  };

  const clearMobileRotorMomentum = (): void => {
    if (mobileRotorMomentumRaf !== null) {
      window.cancelAnimationFrame(mobileRotorMomentumRaf);
      mobileRotorMomentumRaf = null;
    }
    mobileRotorVelocity = 0;
    mobileAppsNode?.classList.remove("is-gliding");
  };

  const prefersReducedMotion = (): boolean => {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  };

  const snapMobileRotor = (): void => {
    clearMobileRotorSnapTimer();
    clearMobileRotorMomentum();
    const centeredIndex = getCenteredMobileRotorIndex();
    if (centeredIndex >= 0) {
      setMobileRotorIndex(centeredIndex);
    }
  };

  const scheduleMobileRotorSnap = (): void => {
    clearMobileRotorSnapTimer();
    mobileRotorSnapTimer = window.setTimeout(() => {
      mobileRotorSnapTimer = null;
      snapMobileRotor();
    }, 140);
  };

  const stepMobileRotorMomentum = (timestamp: number): void => {
    if (mobileRotorMomentumRaf === null) {
      return;
    }

    const elapsed = Math.min(Math.max(timestamp - mobileRotorMomentumTime, 0), 48);
    mobileRotorMomentumTime = timestamp;
    setMobileRotorPosition(mobileRotorPosition + mobileRotorVelocity * (elapsed / 1000));
    mobileRotorVelocity *= Math.pow(0.045, elapsed / 1000);

    if (Math.abs(mobileRotorVelocity) < 0.18) {
      mobileRotorMomentumRaf = null;
      mobileAppsNode?.classList.remove("is-gliding");
      snapMobileRotor();
      return;
    }

    mobileRotorMomentumRaf = window.requestAnimationFrame(stepMobileRotorMomentum);
  };

  const startMobileRotorMomentum = (velocity: number): void => {
    clearMobileRotorSnapTimer();
    clearMobileRotorMomentum();
    if (apps.length <= 1 || prefersReducedMotion() || Math.abs(velocity) < 0.16) {
      snapMobileRotor();
      return;
    }

    mobileRotorVelocity = Math.max(-8.5, Math.min(8.5, velocity));
    mobileRotorMomentumTime = performance.now();
    mobileAppsNode?.classList.add("is-gliding");
    mobileRotorMomentumRaf = window.requestAnimationFrame(stepMobileRotorMomentum);
  };

  const orderedMobileWindowStack = (appId: string, appSummaries: WindowSummary[], options?: { useSelection?: boolean }): WindowSummary[] => {
    const selectedWindowId = options?.useSelection === false ? null : mobileStackSelections.get(appId) ?? null;
    return orderMobileWindowStack(appSummaries, selectedWindowId);
  };

  const syncMobileAppState = (summaries: WindowSummary[] = latestSummaries): void => {
    if (!mobileAppsNode) {
      return;
    }

    const activeSummary = summaries.find((summary) => summary.active && summary.mode !== "minimized") ?? null;
    const summariesByApp = new Map<string, WindowSummary[]>();
    for (const summary of summaries) {
      const appSummaries = summariesByApp.get(summary.appId) ?? [];
      appSummaries.push(summary);
      summariesByApp.set(summary.appId, appSummaries);
    }

    for (const appNode of mobileAppNodes) {
      const appId = appNode.dataset.appId;
      if (!appId) {
        continue;
      }

      const appSummaries = summariesByApp.get(appId) ?? [];
      const selectedWindowId = mobileStackSelections.get(appId) ?? null;
      if (selectedWindowId && !appSummaries.some((summary) => summary.windowId === selectedWindowId)) {
        mobileStackSelections.delete(appId);
      }
      const visibleCount = appSummaries.filter((summary) => summary.mode !== "minimized").length;
      const isActive = activeSummary?.appId === appId;
      const isOpen = appSummaries.length > 0;
      const isPaused = isOpen && visibleCount === 0;
      const stackNode = appNode.querySelector<HTMLElement>("[data-mobile-window-stack]");
      let stateLabel = "ready";

      if (isActive) {
        stateLabel = "active";
      } else if (visibleCount > 0) {
        stateLabel = visibleCount > 1 ? `${visibleCount} open` : "running";
      } else if (isPaused) {
        stateLabel = appSummaries.length > 1 ? `${appSummaries.length} paused` : "paused";
      }

      appNode.classList.toggle("is-active-app", isActive);
      appNode.classList.toggle("is-open", isOpen);
      appNode.classList.toggle("is-paused", isPaused);
      appNode.classList.toggle("is-running", visibleCount > 0);
      appNode.setAttribute("aria-label", `${appById.get(appId)?.name ?? appId}, ${stateLabel}`);

      if (stackNode) {
        const shouldRenderStack = appSummaries.length > 0 && appId === mobileCenteredAppId;
        stackNode.hidden = !shouldRenderStack;

        if (!shouldRenderStack) {
          stackNode.dataset.stackKey = "";
          renderPreact(null, stackNode);
          continue;
        }

        const orderedSummaries = orderedMobileWindowStack(appId, appSummaries).slice(0, 5);
        const stackKey = orderedSummaries
          .map((summary) => `${summary.windowId}:${summary.mode}:${summary.active ? "1" : "0"}:${summary.title}`)
          .join("|");

        if (stackNode.dataset.stackKey === stackKey) {
          continue;
        }

        stackNode.dataset.stackKey = stackKey;
        renderPreact(<MobileWindowStack summaries={orderedSummaries} />, stackNode);
      }
    }
  };

  const updateMobileHomeDepth = (): void => {
    if (!mobileAppsNode || mobileShellState !== "home") {
      return;
    }

    const items = mobileAppNodes;
    if (items.length === 0) {
      return;
    }

    if (!mobileRotorMetrics) {
      const listHeight = mobileAppsNode.clientHeight || mobileAppsNode.getBoundingClientRect().height;
      const nextMetrics = calculateMobileRotorMetrics(listHeight, items.length);
      if (!nextMetrics) {
        return;
      }
      mobileRotorMetrics = nextMetrics;
    }

    const centeredIndex = getCenteredMobileRotorIndex();
    const nextCenteredAppId = apps[centeredIndex]?.id ?? null;
    if (mobileCenteredAppId !== nextCenteredAppId) {
      mobileCenteredAppId = nextCenteredAppId;
      syncMobileAppState();
    }

    for (const [index, item] of items.entries()) {
      const distance = shortestMobileRotorDelta(index, mobileRotorPosition);
      const isVirtualHidden = Math.abs(distance) > mobileRotorMetrics.activeRadius;
      const nextVirtualState = isVirtualHidden ? "0" : "1";
      const nextCenteredState = index === centeredIndex ? "1" : "0";

      if (isVirtualHidden) {
        if (item.dataset.mobileVisible !== nextVirtualState || item.dataset.mobileCentered !== nextCenteredState) {
          item.dataset.mobileVisible = nextVirtualState;
          item.dataset.mobileBehind = "1";
          item.dataset.mobileCentered = nextCenteredState;
          item.tabIndex = -1;
          item.setAttribute("aria-hidden", "true");
          item.classList.add("is-behind", "is-virtual-hidden");
          item.classList.toggle("is-centered", index === centeredIndex);
        }
        continue;
      }

      const angle = distance * mobileRotorMetrics.angleStep;
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      const frontness = (cos + 1) / 2;
      const sideFalloff = 1 - Math.min(Math.abs(sin) * 0.22, 0.22);
      const isBehind = cos < -0.18;
      const opacity = isBehind ? 0 : Math.max(0.12, frontness * sideFalloff);
      const scale = 0.56 + frontness * 0.44;
      const depth = (cos - 1) * mobileRotorMetrics.depthRadius;
      const offsetY = sin * mobileRotorMetrics.radius;
      const rotate = Math.max(-64, Math.min(64, angle * -32));
      const blur = isBehind ? 7 : Math.max(0, (1 - frontness) * 2.4);
      const zIndex = String(Math.round(frontness * 1000));
      const nextBehindState = isBehind ? "1" : "0";
      const wasBehind = item.dataset.mobileBehind === "1";

      if (isBehind && wasBehind && item.dataset.mobileCentered === nextCenteredState && item.dataset.mobileVisible === nextVirtualState) {
        continue;
      }

      if (item.dataset.mobileVisible !== nextVirtualState) {
        item.dataset.mobileVisible = nextVirtualState;
        item.removeAttribute("aria-hidden");
        item.classList.remove("is-virtual-hidden");
      }
      item.style.setProperty("--home-app-depth", `${depth.toFixed(1)}px`);
      item.style.setProperty("--home-app-rotate", `${rotate.toFixed(2)}deg`);
      item.style.setProperty("--home-app-scale", scale.toFixed(3));
      item.style.setProperty("--home-app-opacity", opacity.toFixed(3));
      item.style.setProperty("--home-app-y", `${offsetY.toFixed(1)}px`);
      item.style.setProperty("--home-app-blur", `${blur.toFixed(2)}px`);
      if (item.style.zIndex !== zIndex) {
        item.style.zIndex = zIndex;
      }
      if (item.dataset.mobileBehind !== nextBehindState) {
        item.dataset.mobileBehind = nextBehindState;
        item.tabIndex = isBehind ? -1 : 0;
        item.classList.toggle("is-behind", isBehind);
      }
      if (item.dataset.mobileCentered !== nextCenteredState) {
        item.dataset.mobileCentered = nextCenteredState;
        item.classList.toggle("is-centered", index === centeredIndex);
      }
    }
  };

  const scheduleMobileHomeDepth = (): void => {
    if (mobileHomeDepthRaf !== null) {
      return;
    }

    mobileHomeDepthRaf = window.requestAnimationFrame(() => {
      mobileHomeDepthRaf = null;
      updateMobileHomeDepth();
    });
  };

  const onMobileHomeResize = (): void => {
    mobileRotorMetrics = null;
    scheduleMobileHomeDepth();
  };

  const clearDockRevealTimer = (): void => {
    if (dockRevealTimer === null) {
      return;
    }
    window.clearTimeout(dockRevealTimer);
    dockRevealTimer = null;
  };

  const clearMobileLaunchTimer = (): void => {
    if (mobileLaunchTimer === null) {
      return;
    }
    window.clearTimeout(mobileLaunchTimer);
    mobileLaunchTimer = null;
  };

  const clearMobileReturnTimer = (): void => {
    if (mobileReturnTimer === null) {
      return;
    }
    window.clearTimeout(mobileReturnTimer);
    mobileReturnTimer = null;
  };

  const startMobileLaunchTransition = (): void => {
    clearMobileLaunchTimer();
    rootNode.classList.add("mobile-launching");
    mobileLaunchTimer = window.setTimeout(() => {
      rootNode.classList.remove("mobile-launching");
      mobileLaunchTimer = null;
    }, 260);
  };

  const startMobileReturnTransition = (): void => {
    clearMobileReturnTimer();
    rootNode.classList.add("mobile-returning-home");
    mobileReturnTimer = window.setTimeout(() => {
      rootNode.classList.remove("mobile-returning-home");
      mobileReturnTimer = null;
    }, 260);
  };

  const resetMobileHomeGesture = (): void => {
    mobileHomeGesturePointerId = null;
    mobileHomeGestureStartY = 0;
    mobileHomeGestureProgress = 0;
    rootNode.classList.remove("mobile-home-gesture-active");
    rootNode.style.removeProperty("--mobile-home-peek-opacity");
    rootNode.style.removeProperty("--mobile-home-peek-y");
    rootNode.style.removeProperty("--mobile-home-peek-scale");
    rootNode.style.removeProperty("--mobile-app-peek-y");
    rootNode.style.removeProperty("--mobile-app-peek-scale");
    rootNode.style.removeProperty("--mobile-app-peek-radius");
    rootNode.style.removeProperty("--mobile-handle-y");
  };

  const setMobileHomeGestureProgress = (progress: number): void => {
    const eased = 1 - Math.pow(1 - Math.max(0, Math.min(progress, 1)), 2.4);
    mobileHomeGestureProgress = eased;
    rootNode.classList.toggle("mobile-home-gesture-active", eased > 0);
    rootNode.style.setProperty("--mobile-home-peek-opacity", (0.08 + eased * 0.88).toFixed(3));
    rootNode.style.setProperty("--mobile-home-peek-y", `${((1 - eased) * 18).toFixed(1)}px`);
    rootNode.style.setProperty("--mobile-home-peek-scale", (0.978 + eased * 0.022).toFixed(3));
    rootNode.style.setProperty("--mobile-app-peek-y", `${(-eased * 22).toFixed(1)}px`);
    rootNode.style.setProperty("--mobile-app-peek-scale", (1 - eased * 0.048).toFixed(3));
    rootNode.style.setProperty("--mobile-app-peek-radius", `${(eased * 24).toFixed(1)}px`);
    rootNode.style.setProperty("--mobile-handle-y", `${(-eased * 18).toFixed(1)}px`);
  };

  const returnToMobileHome = (): void => {
    startMobileReturnTransition();
    resetMobileHomeGesture();
    showMobileHome();
  };

  const setDockRevealed = (revealed: boolean, options?: { temporary?: boolean }): void => {
    clearDockRevealTimer();
    rootNode.classList.toggle("dock-revealed", revealed);
    if (revealed && options?.temporary) {
      dockRevealTimer = window.setTimeout(() => {
        rootNode.classList.remove("dock-revealed");
        dockRevealTimer = null;
      }, 1600);
    }
  };

  const scheduleDockHide = (): void => {
    clearDockRevealTimer();
    dockRevealTimer = window.setTimeout(() => {
      rootNode.classList.remove("dock-revealed");
      dockRevealTimer = null;
    }, 360);
  };

  const syncDockAutoHide = (summaries: WindowSummary[]): void => {
    const hasVisibleWindow = summaries.some((summary) => summary.mode !== "minimized");
    const hasActiveMaximizedWindow = summaries.some((summary) => summary.active && summary.mode === "maximized");
    rootNode.classList.toggle("dock-auto-hide", hasVisibleWindow);
    rootNode.classList.toggle("dock-auto-hide-strong", hasActiveMaximizedWindow);
    if (!hasVisibleWindow) {
      setDockRevealed(false);
    }
  };

  const getBaseMobileShellState = (summaries: WindowSummary[] = latestSummaries): MobileShellState => {
    const hasVisibleWindow = summaries.some((summary) => summary.mode !== "minimized");
    return hasVisibleWindow ? "app" : "home";
  };

  const setMobileShellState = (state: MobileShellState): void => {
    mobileShellState = state;
    rootNode.dataset.mobileState = state;
    rootNode.classList.toggle("mobile-home-active", state === "home");
    rootNode.classList.toggle("mobile-app-active", state !== "home");
    rootNode.classList.toggle("mobile-search-open", state === "search");
    if (state !== "app" && mobileHomeGesturePointerId === null) {
      resetMobileHomeGesture();
    }
    if (state === "home") {
      scheduleMobileHomeDepth();
    }
  };

  const showMobileHome = (): void => {
    setMobileShellState("home");
    for (const summary of latestSummaries) {
      if (summary.mode !== "minimized") {
        windowManager.minimizeWindow(summary.windowId);
      }
    }
  };

  const syncMobileState = (summaries: WindowSummary[] = latestSummaries): void => {
    if (mobileShellState === "home" || mobileShellState === "app") {
      setMobileShellState(getBaseMobileShellState(summaries));
    }
    syncMobileAppState(summaries);
    if (mobileHomeNode) {
      mobileHomeNode.hidden = false;
    }
    scheduleMobileHomeDepth();
  };

  const syncIconState = (summaries: WindowSummary[] = latestSummaries): void => {
    renderDesktopIcons(summaries);
    renderTaskbarWindows(summaries);
    syncDockAutoHide(summaries);
    syncMobileState(summaries);
  };

  const setSelectedIcon = (appId: string | null): void => {
    selectedAppId = appId;
    syncIconState();
  };

  const openWindowForApp = (appId: string, route?: string, options?: { forceRestart?: boolean; forceNew?: boolean }): string | null => {
    const app = appById.get(appId);
    if (!app) {
      return null;
    }

    selectedAppId = app.id;
    return windowManager.openApp(app, route, options);
  };

  const openApp = (appId: string, route?: string): void => {
    void openWindowForApp(appId, route);
  };

  const handleMobileStackClick = (input: MobileAppActivationInput): boolean => {
    const { appId, button: appButton, target } = input;
    const stackNode = target.closest<HTMLElement>(".mobile-window-stack");
    if (!stackNode || !appButton.contains(stackNode) || !appButton.classList.contains("is-centered")) {
      return false;
    }

    const appSummaries = summariesForApp(appId);
    if (appSummaries.length === 0) {
      return false;
    }

    input.preventDefault();
    input.stopPropagation();
    clearMobileRotorMomentum();
    clearMobileRotorSnapTimer();

    const orderedSummaries = orderedMobileWindowStack(appId, appSummaries);
    const clickedLayer = target.closest<HTMLElement>(".mobile-window-layer[data-window-id]");
    const frontSummary = orderedSummaries[0] ?? null;
    const clickedSummary = orderedSummaries.find((summary) => summary.windowId === clickedLayer?.dataset.windowId) ?? null;

    if (clickedSummary && frontSummary && clickedSummary.windowId !== frontSummary.windowId) {
      mobileStackSelections.set(appId, clickedSummary.windowId);
      syncMobileAppState();
      return true;
    }

    if (!clickedSummary && orderedSummaries.length > 1) {
      const baseSummaries = orderedMobileWindowStack(appId, appSummaries, { useSelection: false });
      const selectedWindowId = mobileStackSelections.get(appId) ?? frontSummary?.windowId ?? null;
      const selectedIndex = selectedWindowId
        ? baseSummaries.findIndex((summary) => summary.windowId === selectedWindowId)
        : 0;
      const nextSummary = baseSummaries[((selectedIndex >= 0 ? selectedIndex : 0) + 1) % baseSummaries.length] ?? baseSummaries[0];
      if (nextSummary) {
        mobileStackSelections.set(appId, nextSummary.windowId);
        syncMobileAppState();
      }
      return true;
    }

    if (frontSummary) {
      mobileStackSelections.set(appId, frontSummary.windowId);
      startMobileLaunchTransition();
      activateWindowSummary(frontSummary);
      setSelectedIcon(appId);
    }
    return true;
  };

  const activateMobileAppFromGrid = (input: MobileAppActivationInput): void => {
    if (mobileRotorDidDrag) {
      input.preventDefault();
      mobileRotorDidDrag = false;
      return;
    }

    if (handleMobileStackClick(input)) {
      return;
    }

    const index = getMobileRotorIndexForButton(input.button);
    if (index >= 0 && index !== getCenteredMobileRotorIndex()) {
      input.preventDefault();
      clearMobileRotorMomentum();
      clearMobileRotorSnapTimer();
      setMobileRotorIndex(index);
      input.button.focus();
      return;
    }

    clearMobileRotorMomentum();
    clearMobileRotorSnapTimer();
    startMobileLaunchTransition();
    activateMobileApp(input.appId);
  };

  const navigateMobileRotor = (direction: "next" | "previous"): void => {
    if (mobileShellState !== "home" || apps.length <= 1) {
      return;
    }
    clearMobileRotorMomentum();
    clearMobileRotorSnapTimer();
    const offset = direction === "next" ? 1 : -1;
    setMobileRotorIndex((getCenteredMobileRotorIndex() + offset + apps.length) % apps.length);
    focusMobileRotorIndex(getCenteredMobileRotorIndex());
  };

  const onMobileAppsWheel = (event: WheelEvent): void => {
    if (mobileShellState !== "home" || apps.length <= 1) {
      return;
    }

    event.preventDefault();
    clearMobileRotorMomentum();
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    setMobileRotorPosition(mobileRotorPosition + delta / 220);
    scheduleMobileRotorSnap();
  };

  const onMobileAppsPointerDown = (event: PointerEvent): void => {
    if (mobileShellState !== "home" || apps.length <= 1 || event.button !== 0) {
      return;
    }

    const target = event.target;
    if (target instanceof HTMLElement && target.closest(".mobile-window-stack")) {
      return;
    }

    clearMobileRotorSnapTimer();
    clearMobileRotorMomentum();
    mobileRotorPointerId = event.pointerId;
    mobileRotorDragStartY = event.clientY;
    mobileRotorDragStartPosition = mobileRotorPosition;
    mobileRotorLastDragY = event.clientY;
    mobileRotorLastDragTime = performance.now();
    mobileRotorDidDrag = false;
    mobileAppsNode?.classList.add("is-dragging");
    mobileAppsNode?.setPointerCapture(event.pointerId);
  };

  const onMobileAppsPointerMove = (event: PointerEvent): void => {
    if (mobileRotorPointerId !== event.pointerId || apps.length <= 1) {
      return;
    }

    event.preventDefault();
    const dragDelta = event.clientY - mobileRotorDragStartY;
    const dragUnits = dragDelta / 132;
    const easedDragUnits = Math.sign(dragUnits) * Math.pow(Math.abs(dragUnits), 0.96);
    const timestamp = performance.now();
    const elapsed = Math.max(timestamp - mobileRotorLastDragTime, 12);
    mobileRotorVelocity = -((event.clientY - mobileRotorLastDragY) / 132) / (elapsed / 1000);
    mobileRotorLastDragY = event.clientY;
    mobileRotorLastDragTime = timestamp;
    mobileRotorDidDrag = mobileRotorDidDrag || Math.abs(dragDelta) > 8;
    setMobileRotorPosition(mobileRotorDragStartPosition - easedDragUnits);
  };

  const finishMobileRotorDrag = (event: PointerEvent): void => {
    if (mobileRotorPointerId !== event.pointerId) {
      return;
    }

    mobileAppsNode?.classList.remove("is-dragging");
    if (mobileAppsNode?.hasPointerCapture(event.pointerId)) {
      mobileAppsNode.releasePointerCapture(event.pointerId);
    }
    mobileRotorPointerId = null;
    startMobileRotorMomentum(mobileRotorVelocity);
    if (mobileRotorDidDrag) {
      window.setTimeout(() => {
        mobileRotorDidDrag = false;
      }, 0);
    }
  };

  const onMobileHomeButtonClick = (event: MouseEvent): void => {
    if (mobileHomeGestureSuppressClick) {
      event.preventDefault();
      mobileHomeGestureSuppressClick = false;
      return;
    }

    if (event.detail > 0) {
      event.preventDefault();
      return;
    }

    if (mobileShellState !== "app") {
      return;
    }

    event.preventDefault();
    returnToMobileHome();
  };

  const onMobileHomeGesturePointerDown = (event: PointerEvent): void => {
    if (mobileShellState !== "app" || event.button !== 0) {
      return;
    }

    event.preventDefault();
    clearMobileReturnTimer();
    mobileHomeGesturePointerId = event.pointerId;
    mobileHomeGestureStartY = event.clientY;
    mobileHomeGestureProgress = 0;
    mobileHomeGestureSuppressClick = false;
    mobileHomeButtonNode?.setPointerCapture(event.pointerId);
  };

  const onMobileHomeGesturePointerMove = (event: PointerEvent): void => {
    if (mobileHomeGesturePointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    const upwardDelta = Math.max(0, mobileHomeGestureStartY - event.clientY);
    if (upwardDelta > 7) {
      mobileHomeGestureSuppressClick = true;
    }
    setMobileHomeGestureProgress(upwardDelta / 118);
  };

  const finishMobileHomeGesture = (event: PointerEvent): void => {
    if (mobileHomeGesturePointerId !== event.pointerId) {
      return;
    }

    if (mobileHomeButtonNode?.hasPointerCapture(event.pointerId)) {
      mobileHomeButtonNode.releasePointerCapture(event.pointerId);
    }

    if (mobileHomeGestureProgress > 0.42) {
      returnToMobileHome();
      return;
    }

    resetMobileHomeGesture();
  };

  const cancelMobileHomeGesture = (event: PointerEvent): void => {
    if (mobileHomeGesturePointerId !== event.pointerId) {
      return;
    }

    if (mobileHomeButtonNode?.hasPointerCapture(event.pointerId)) {
      mobileHomeButtonNode.releasePointerCapture(event.pointerId);
    }
    resetMobileHomeGesture();
  };

  const openChatProcessContext = (normalized: { pid: string; cwd: string }): void => {
    const chatWindowId = openWindowForApp("chat");
    if (!chatWindowId) {
      return;
    }

    queuePendingChatProcess(chatWindowId, normalized);
    const targetDetail: TargetChatProcessEventDetail = { ...normalized, windowId: chatWindowId };
    window.dispatchEvent(new CustomEvent<TargetChatProcessEventDetail>(TARGET_CHAT_PROCESS_EVENT, { detail: targetDetail }));
  };

  const onOpenApp = (event: Event): void => {
    const detail = ((event as Event & { detail?: OpenAppEventDetail | null }).detail) ?? null;
    console.debug("[gsv-open] launcher received open request", detail);
    const resolved = resolveOpenAppDetail(detail, window.location.href);
    if (!resolved) {
      console.debug("[gsv-open] launcher dropped unresolved request", detail);
      return;
    }
    console.debug("[gsv-open] launcher resolved request", resolved);

    if (resolved.type === "chat-process") {
      openChatProcessContext(resolved.threadContext);
      return;
    }

    const windowId = openWindowForApp(resolved.appId, resolved.route, {
      forceRestart: !!detail?.request,
    });
    console.debug("[gsv-open] launcher opened window", {
      appId: resolved.appId,
      route: resolved.route,
      windowId,
    });
    if (!windowId) {
      return;
    }

  };

  const onWindowMessage = (event: MessageEvent): void => {
    if (event.origin !== window.location.origin) {
      return;
    }

    const data = event.data as { type?: unknown; detail?: unknown } | null;
    if (!data || typeof data !== "object" || typeof data.type !== "string") {
      return;
    }

    if (data.type === OPEN_APP_EVENT) {
      onOpenApp({
        detail: data.detail as OpenAppEventDetail | null,
      } as Event & { detail?: OpenAppEventDetail | null });
    }
  };

  const onCommandPaletteOpen = (): void => {
    resetMobileHomeGesture();
    clearMobileRotorMomentum();
    clearMobileRotorSnapTimer();
    setMobileShellState("search");
    setDockRevealed(true, { temporary: true });
  };

  const onCommandPaletteClose = (): void => {
    if (mobileShellState === "search") {
      setMobileShellState(getBaseMobileShellState());
    }
  };

  const buildPaletteItems = (): CommandPaletteActionItem[] => {
    const appItems = apps.map((appItem): CommandPaletteActionItem => ({
      id: `app:${appItem.id}`,
      label: appItem.name,
      meta: "Open app",
      search: `${appItem.name} ${appItem.description} app`,
      icon: appItem.icon,
      run: () => {
        activateApp(appItem.id);
      },
    }));

    const windowItems = latestSummaries
      .slice()
      .sort((left, right) => right.zIndex - left.zIndex)
      .map((summary): CommandPaletteActionItem => ({
        id: `window:${summary.windowId}`,
        label: summary.title,
        meta: summary.mode === "minimized" ? "Restore window" : `Focus ${summary.appName}`,
        search: `${summary.title} ${summary.appName} ${summary.route} window`,
        icon: appById.get(summary.appId)?.icon ?? { kind: "fallback", label: "AP" },
        run: () => {
          activateWindowSummary(summary);
        },
      }));

    return [...windowItems, ...appItems];
  };

  const commandPalette = createCommandPalette({
    rootNode: commandPaletteRootNode,
    getItems: buildPaletteItems,
    onOpen: onCommandPaletteOpen,
    onClose: onCommandPaletteClose,
  });

  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.altKey && event.key === "Tab") {
      setDockRevealed(true, { temporary: true });
    }

    if ((event.metaKey || event.ctrlKey) && event.key === "`") {
      setDockRevealed(true, { temporary: true });
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      commandPalette.toggle();
    }
  };

  mobileAppsNode?.addEventListener("wheel", onMobileAppsWheel, { passive: false });
  mobileAppsNode?.addEventListener("pointerdown", onMobileAppsPointerDown);
  mobileAppsNode?.addEventListener("pointermove", onMobileAppsPointerMove);
  mobileAppsNode?.addEventListener("pointerup", finishMobileRotorDrag);
  mobileAppsNode?.addEventListener("pointercancel", finishMobileRotorDrag);
  mobileHomeButtonNode?.addEventListener("click", onMobileHomeButtonClick);
  mobileHomeButtonNode?.addEventListener("pointerdown", onMobileHomeGesturePointerDown);
  mobileHomeButtonNode?.addEventListener("pointermove", onMobileHomeGesturePointerMove);
  mobileHomeButtonNode?.addEventListener("pointerup", finishMobileHomeGesture);
  mobileHomeButtonNode?.addEventListener("pointercancel", cancelMobileHomeGesture);
  document.addEventListener("keydown", onDocumentKeyDown);
  window.addEventListener("resize", onMobileHomeResize);

  window.addEventListener(OPEN_APP_EVENT, onOpenApp as EventListener);
  window.addEventListener("message", onWindowMessage);

  const unsubscribe = windowManager.subscribe((summaries) => {
    latestSummaries = summaries;
    syncIconState(summaries);
    commandPalette.refresh();
  });

  const setApps = (nextApps: readonly DesktopApp[]): void => {
    apps = [...nextApps];
    appById = new Map(apps.map((app) => [app.id, app]));
    mobileRotorPosition = normalizeMobileRotorPosition(mobileRotorPosition);
    if (selectedAppId && !appById.has(selectedAppId)) {
      selectedAppId = null;
    }
    renderMobileApps();
    syncIconState();
    commandPalette.refresh();
    if (initialAppId && !openedInitialApp && appById.has(initialAppId)) {
      openedInitialApp = true;
      openApp(initialAppId);
    }
  };

  return {
    openApp,
    openCommandPalette: () => {
      commandPalette.open();
    },
    revealDock: (options?: { temporary?: boolean }) => {
      setDockRevealed(true, options);
    },
    hideDockSoon: scheduleDockHide,
    setApps,
    destroy: () => {
      unsubscribe();
      mobileAppsNode?.removeEventListener("wheel", onMobileAppsWheel);
      mobileAppsNode?.removeEventListener("pointerdown", onMobileAppsPointerDown);
      mobileAppsNode?.removeEventListener("pointermove", onMobileAppsPointerMove);
      mobileAppsNode?.removeEventListener("pointerup", finishMobileRotorDrag);
      mobileAppsNode?.removeEventListener("pointercancel", finishMobileRotorDrag);
      mobileHomeButtonNode?.removeEventListener("click", onMobileHomeButtonClick);
      mobileHomeButtonNode?.removeEventListener("pointerdown", onMobileHomeGesturePointerDown);
      mobileHomeButtonNode?.removeEventListener("pointermove", onMobileHomeGesturePointerMove);
      mobileHomeButtonNode?.removeEventListener("pointerup", finishMobileHomeGesture);
      mobileHomeButtonNode?.removeEventListener("pointercancel", cancelMobileHomeGesture);
      document.removeEventListener("keydown", onDocumentKeyDown);
      commandPalette.destroy();
      renderPreact(null, iconsNode);
      if (taskbarWindowsNode) {
        renderPreact(null, taskbarWindowsNode);
      }
      if (mobileAppsNode) {
        renderPreact(null, mobileAppsNode);
      }
      clearDockRevealTimer();
      clearMobileLaunchTimer();
      clearMobileReturnTimer();
      clearMobileRotorSnapTimer();
      clearMobileRotorMomentum();
      resetMobileHomeGesture();
      if (mobileHomeDepthRaf !== null) {
        window.cancelAnimationFrame(mobileHomeDepthRaf);
        mobileHomeDepthRaf = null;
      }
      window.removeEventListener("resize", onMobileHomeResize);
      window.removeEventListener(OPEN_APP_EVENT, onOpenApp as EventListener);
      window.removeEventListener("message", onWindowMessage);
    },
  };
}
