import type { JSX, RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  getDesktopObject,
  shellRouteForTab,
  shellTabForAppRoute,
  shellSurfaceLabel,
  shellTabForDesktopChild,
  shellTabForRoute,
  shellTabForSettingsRoute,
  type DesktopChildObject,
  type DesktopObject,
  type DesktopObjectId,
  type ShellAppRoute,
  type ShellPageTab,
  type ShellRoute,
  type ShellSettingsRoute,
  type ShellSurfaceId,
} from "../domain/shellModel";
import {
  pushShellRoute,
  replaceShellRoute,
  shellRouteFromLocation,
} from "../routing/shellRoutes";

export type PickerId = "gsv" | "tabs";

const MIN_CHAT_WIDTH = 380;
const DEFAULT_CHAT_WIDTH = 460;
const EXPANDED_RAIL_WIDTH = 262;
const COLLAPSED_RAIL_WIDTH = 64;
const MIN_CONSOLE_WIDTH = 360;
const MIN_DESKTOP_TREE_WIDTH = 600;
const MIN_DESKTOP_RAIL_CANVAS_WIDTH = 40;
const STACKED_LAYOUT_WIDTH = 760;
const MIN_STACKED_CHAT_HEIGHT = 300;
const MIN_STACKED_WORLD_HEIGHT = 260;
const SHELL_TABS_STORAGE_KEY = "gsv.shell.tabs.v1";

type UseGsvShellStateArgs = {
  rootRef: RefObject<HTMLDivElement>;
  desktopObjects: readonly DesktopObject[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function upsertTab(tabs: readonly ShellPageTab[], tab: ShellPageTab): ShellPageTab[] {
  const index = tabs.findIndex((candidate) => candidate.key === tab.key);
  if (index === -1) {
    return [...tabs, tab];
  }
  return tabs.map((candidate, candidateIndex) => candidateIndex === index ? tab : candidate);
}

function isShellPageTab(value: unknown): value is ShellPageTab {
  if (!value || typeof value !== "object") {
    return false;
  }

  const tab = value as Record<string, unknown>;
  return typeof tab.key === "string"
    && typeof tab.surface === "string"
    && typeof tab.title === "string"
    && typeof tab.kind === "string"
    && typeof tab.icon === "string"
    && typeof tab.type === "string";
}

function readPersistedTabs(): ShellPageTab[] {
  try {
    const raw = window.localStorage.getItem(SHELL_TABS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as { version?: unknown; tabs?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.tabs)) {
      return [];
    }
    return parsed.tabs.filter(isShellPageTab);
  } catch {
    return [];
  }
}

function writePersistedTabs(tabs: readonly ShellPageTab[]): void {
  try {
    window.localStorage.setItem(SHELL_TABS_STORAGE_KEY, JSON.stringify({
      version: 1,
      tabs,
    }));
  } catch {
    // Ignore storage failures; tabs still work for the current session.
  }
}

function isListDetailRoute(route: ShellSettingsRoute): route is Extract<ShellSettingsRoute, { view: "list" }> & { detailId: string } {
  return route.view === "list" && typeof route.detailId === "string" && route.detailId.length > 0;
}

function readInitialRoute(): ShellRoute {
  return typeof window === "undefined"
    ? { surface: "desktop" }
    : shellRouteFromLocation(window.location);
}

function surfaceForRoute(route: ShellRoute): ShellSurfaceId {
  return route.surface;
}

export function useGsvShellState({
  rootRef,
  desktopObjects,
}: UseGsvShellStateArgs) {
  const [initialRoute] = useState<ShellRoute>(() => readInitialRoute());
  const initialTab = shellTabForRoute(initialRoute);
  const [rootWidth, setRootWidth] = useState(1280);
  const [rootHeight, setRootHeight] = useState(760);
  const [activeSurface, setActiveSurface] = useState<ShellSurfaceId>(() => surfaceForRoute(initialRoute));
  const [openTabs, setOpenTabs] = useState<ShellPageTab[]>(() => {
    const persistedTabs = readPersistedTabs();
    return initialTab ? upsertTab(persistedTabs, initialTab) : persistedTabs;
  });
  const [activeTabKey, setActiveTabKey] = useState<string | null>(() => initialTab?.key ?? null);
  const [manualRailCollapsed, setManualRailCollapsed] = useState(false);
  const [selectedObjectId, setSelectedObjectId] = useState<DesktopObjectId | null>(null);
  const [pickerId, setPickerId] = useState<PickerId | null>(null);
  const [tabsExpanded, setTabsExpanded] = useState(true);
  const [gsvOpen, setGsvOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH);
  const [chatDragging, setChatDragging] = useState(false);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) {
      return;
    }

    const update = () => {
      const rect = node.getBoundingClientRect();
      setRootWidth(rect.width);
      setRootHeight(rect.height);
    };
    update();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [rootRef]);

  useEffect(() => {
    writePersistedTabs(openTabs);
  }, [openTabs]);

  const inPageZone = activeSurface !== "desktop";
  const stackedLayout = rootWidth <= STACKED_LAYOUT_WIDTH;
  const maxChatWidth = Math.max(
    stackedLayout ? MIN_STACKED_CHAT_HEIGHT : MIN_CHAT_WIDTH,
    stackedLayout
      ? rootHeight - MIN_STACKED_WORLD_HEIGHT
      : rootWidth - (inPageZone ? COLLAPSED_RAIL_WIDTH + MIN_CONSOLE_WIDTH : COLLAPSED_RAIL_WIDTH),
  );
  const resolvedChatWidth = clamp(chatWidth, stackedLayout ? MIN_STACKED_CHAT_HEIGHT : MIN_CHAT_WIDTH, maxChatWidth);
  const mainWidth = rootWidth - (!stackedLayout && chatOpen ? resolvedChatWidth : 0);
  const desktopCollapsed = !stackedLayout && !inPageZone && chatOpen && mainWidth < MIN_DESKTOP_TREE_WIDTH;
  const autoRailCollapsed = !stackedLayout && chatOpen && (
    inPageZone
      ? mainWidth - EXPANDED_RAIL_WIDTH < MIN_CONSOLE_WIDTH
      : desktopCollapsed && mainWidth - EXPANDED_RAIL_WIDTH < MIN_DESKTOP_RAIL_CANVAS_WIDTH
  );
  const railCollapsed = manualRailCollapsed || autoRailCollapsed;
  const showRail = inPageZone || desktopCollapsed;
  const selectedObject = getDesktopObject(desktopObjects, selectedObjectId);
  const activePageTab = activeTabKey ? openTabs.find((tab) => tab.key === activeTabKey) ?? null : null;

  const activateRoute = (route: ShellRoute, history: "none" | "push" | "replace" = "push"): void => {
    if (history === "push") {
      pushShellRoute(route);
    } else if (history === "replace") {
      replaceShellRoute(route);
    }

    if (route.surface === "desktop") {
      setActiveSurface("desktop");
      setActiveTabKey(null);
      setSelectedObjectId(null);
      setPickerId(null);
      setGsvOpen(false);
      return;
    }

    const tab = shellTabForRoute(route);
    if (!tab) {
      return;
    }

    setOpenTabs((current) => upsertTab(current, tab));
    setActiveTabKey(tab.key);
    setActiveSurface(route.surface);
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
  };

  useEffect(() => {
    const onPopState = () => {
      activateRoute(shellRouteFromLocation(window.location), "none");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const openSurface = (surface: ShellSurfaceId): void => {
    if (surface === "desktop") {
      activateRoute({ surface: "desktop" });
      return;
    }

    if (surface === "settings") {
      activateRoute({ surface: "settings", settingsRoute: { view: "overview" } });
      return;
    }

    if (surface === "app") {
      return;
    }

    activateRoute({ surface });
  };

  const openSettingsRoute = (route: ShellSettingsRoute): void => {
    activateRoute({ surface: "settings", settingsRoute: route });
  };

  const openAppRoute = (route: ShellAppRoute, title?: string): string => {
    const tab = shellTabForAppRoute(route, title);
    const shellRoute: ShellRoute = { surface: "app", appRoute: tab.appRoute ?? route };
    pushShellRoute(shellRoute);
    setOpenTabs((current) => upsertTab(current, tab));
    setActiveTabKey(tab.key);
    setActiveSurface("app");
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
    return tab.key;
  };

  const syncActiveSettingsRoute = (route: ShellSettingsRoute): void => {
    if (activeSurface !== "settings") {
      return;
    }

    pushShellRoute({ surface: "settings", settingsRoute: route });

    const activeKey = activeTabKey;
    const shouldKeepObjectTab = activePageTab?.kind === "object" && isListDetailRoute(route);
    const settingsTab = shellTabForSettingsRoute(route);

    setOpenTabs((current) => {
      const activeTab = activeKey ? current.find((tab) => tab.key === activeKey) ?? null : null;
      if (activeTab?.kind === "object" && shouldKeepObjectTab) {
        return current.map((tab) => tab.key === activeTab.key
          ? {
              ...tab,
              title: route.detailLabel ?? tab.title,
              settingsRoute: route,
            }
          : tab);
      }

      const tabs = activeTab?.kind === "object"
        ? current.filter((tab) => tab.key !== activeTab.key)
        : current;
      return upsertTab(tabs, settingsTab);
    });

    if (!shouldKeepObjectTab) {
      setActiveTabKey(settingsTab.key);
    }
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
  };

  const openObject = (child: DesktopChildObject): void => {
    if (child.appRoute) {
      openAppRoute(child.appRoute, child.label);
      return;
    }

    const tab = shellTabForDesktopChild(child);
    pushShellRoute(shellRouteForTab(tab));
    setOpenTabs((current) => upsertTab(current, tab));
    setActiveTabKey(tab.key);
    setActiveSurface(tab.surface);
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
  };

  const backToDesktop = (): void => {
    activateRoute({ surface: "desktop" });
  };

  const revealDesktop = (): void => {
    setChatWidth(MIN_CHAT_WIDTH);
    activateRoute({ surface: "desktop" });
  };

  const activateTab = (key: string): void => {
    const tab = openTabs.find((candidate) => candidate.key === key);
    if (!tab) {
      return;
    }
    pushShellRoute(shellRouteForTab(tab));
    setActiveSurface(tab.surface);
    setActiveTabKey(tab.key);
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
  };

  const closeTab = (key: string): void => {
    const nextTabs = openTabs.filter((tab) => tab.key !== key);

    setOpenTabs(nextTabs);
    if (activeTabKey === key) {
      const nextActiveTab = nextTabs[nextTabs.length - 1] ?? null;
      setActiveTabKey(nextActiveTab?.key ?? null);
      setActiveSurface(nextActiveTab?.surface ?? "desktop");
      if (nextActiveTab) {
        pushShellRoute(shellRouteForTab(nextActiveTab));
      } else {
        pushShellRoute({ surface: "desktop" });
      }
    }
  };

  const openControlMenu = (): void => {
    setSelectedObjectId(null);
    setGsvOpen(false);
    if (railCollapsed && autoRailCollapsed) {
      setPickerId("gsv");
      return;
    }
    setManualRailCollapsed(false);
    setPickerId(null);
  };

  const startChatDrag = (event: JSX.TargetedMouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const reserve = inPageZone ? COLLAPSED_RAIL_WIDTH + MIN_CONSOLE_WIDTH : COLLAPSED_RAIL_WIDTH;
    const stackedDrag = rect.width <= STACKED_LAYOUT_WIDTH;
    const minChatExtent = stackedDrag ? MIN_STACKED_CHAT_HEIGHT : MIN_CHAT_WIDTH;
    const maxChatExtent = Math.max(
      minChatExtent,
      stackedDrag ? rect.height - MIN_STACKED_WORLD_HEIGHT : rect.width - reserve,
    );
    setChatDragging(true);

    const onMove = (moveEvent: MouseEvent) => {
      const nextWidth = clamp(
        stackedDrag ? rect.bottom - moveEvent.clientY : rect.right - moveEvent.clientX,
        minChatExtent,
        maxChatExtent,
      );
      setChatWidth(nextWidth);
    };
    const onUp = () => {
      setChatDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const toggleChatMax = (): void => {
    if (resolvedChatWidth >= maxChatWidth - 1) {
      setChatWidth(DEFAULT_CHAT_WIDTH);
      return;
    }
    setChatWidth(maxChatWidth);
  };

  const openTabsPicker = (): void => {
    setPickerId("tabs");
    setSelectedObjectId(null);
    setGsvOpen(false);
  };

  const pickerTitle = pickerId === "gsv"
    ? "GSV // CONTROL"
    : "OPEN TABS";
  const pickerSubtitle = pickerId === "gsv"
    ? "System surfaces"
    : `${openTabs.length} open ${openTabs.length === 1 ? "page" : "pages"}`;

  const statusContext = activeSurface !== "desktop"
    ? activePageTab?.title ?? shellSurfaceLabel(activeSurface)
    : selectedObject
      ? selectedObject.label
      : "DESKTOP";

  return {
    activeSurface,
    activePageTab,
    activeTabKey,
    activateTab,
    backToDesktop,
    chatDragging,
    chatOpen,
    closeTab,
    desktopCollapsed,
    gsvOpen,
    maxChatWidth,
    openControlMenu,
    openObject,
    openAppRoute,
    openTabsPicker,
    openSettingsRoute,
    openSurface,
    openTabs,
    pickerId,
    pickerSubtitle,
    pickerTitle,
    railCollapsed,
    revealDesktop,
    resolvedChatWidth,
    selectedObjectId,
    setChatOpen,
    setGsvOpen,
    setPickerId,
    setSelectedObjectId,
    showRail,
    startChatDrag,
    statusContext,
    syncActiveSettingsRoute,
    tabsExpanded,
    toggleChatMax,
    toggleTabsExpanded: () => {
      setTabsExpanded((value) => !value);
    },
    toggleRailCollapsed: () => {
      setManualRailCollapsed((value) => !value);
    },
  };
}
