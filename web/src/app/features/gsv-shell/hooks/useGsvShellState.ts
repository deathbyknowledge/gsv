import type { JSX, RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  getDesktopObject,
  shellRouteForTab,
  shellTabForAppRoute,
  shellSurfaceLabel,
  shellTabForDesktopChild,
  shellTabForLibraryRoute,
  shellTabForRoute,
  shellTabForSettingsRoute,
  type DesktopChildObject,
  type DesktopObject,
  type DesktopObjectId,
  type ShellAppRoute,
  type ShellLibraryRoute,
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

export type PickerId = "gsv";

const MIN_CHAT_WIDTH = 380;
const DEFAULT_CHAT_WIDTH = 460;
const EXPANDED_RAIL_WIDTH = 262;
const COLLAPSED_RAIL_WIDTH = 64;
const MIN_CONSOLE_WIDTH = 360;
// Smallest the center panel may be squeezed to while dragging the chat wider.
// At this width the page templates reflow to their single-column mobile layout
// (see the @container panel breakpoints), so the chat's effective max width is
// the collapsed rail plus this readable mobile floor.
const MIN_CONSOLE_DRAG_WIDTH = 320;
const MIN_DESKTOP_TREE_WIDTH = 600;
const MIN_DESKTOP_RAIL_CANVAS_WIDTH = 40;
// Below this panel width the shell switches to the mobile layout: the center
// panel is the home screen, and the menu (rail) and chat become full-height
// drawers revealed by swiping left/right (see GsvShell mobile pane handling).
const MOBILE_LAYOUT_WIDTH = 760;
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
  const [activeSurface, setActiveSurface] = useState<ShellSurfaceId>(() => surfaceForRoute(initialRoute));
  const [openTabs, setOpenTabs] = useState<ShellPageTab[]>(() => {
    const persistedTabs = readPersistedTabs();
    return initialTab ? upsertTab(persistedTabs, initialTab) : persistedTabs;
  });
  const [activeTabKey, setActiveTabKey] = useState<string | null>(() => initialTab?.key ?? null);
  const [manualRailCollapsed, setManualRailCollapsed] = useState(false);
  const [selectedObjectId, setSelectedObjectId] = useState<DesktopObjectId | null>(null);
  const [pickerId, setPickerId] = useState<PickerId | null>(null);
  const [gsvOpen, setGsvOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH);
  const [chatDragging, setChatDragging] = useState(false);
  // Mobile-only: the menu (rail) drawer. Chat reuses chatOpen; the two are kept
  // mutually exclusive below so only one full-height drawer shows at a time.
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Set while dragging the rail divider, so the trailing click doesn't also toggle.
  const railDraggedRef = useRef(false);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) {
      return;
    }

    const update = () => {
      const rect = node.getBoundingClientRect();
      setRootWidth(rect.width);
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
  const mobileLayout = rootWidth <= MOBILE_LAYOUT_WIDTH;
  // Desktop chat resize math. On mobile the chat is a full-height drawer that
  // overlays the center panel, so it no longer steals panel width and this is
  // unused (the resize handle is hidden — see the mobile rules in ChatDock.css).
  const maxChatWidth = Math.max(
    MIN_CHAT_WIDTH,
    rootWidth - (inPageZone ? COLLAPSED_RAIL_WIDTH + MIN_CONSOLE_DRAG_WIDTH : COLLAPSED_RAIL_WIDTH),
  );
  const resolvedChatWidth = clamp(chatWidth, MIN_CHAT_WIDTH, maxChatWidth);
  const mainWidth = rootWidth - (!mobileLayout && chatOpen ? resolvedChatWidth : 0);
  const desktopCollapsed = !mobileLayout && !inPageZone && chatOpen && mainWidth < MIN_DESKTOP_TREE_WIDTH;
  const autoRailCollapsed = !mobileLayout && chatOpen && (
    inPageZone
      ? mainWidth - EXPANDED_RAIL_WIDTH < MIN_CONSOLE_WIDTH
      : desktopCollapsed && mainWidth - EXPANDED_RAIL_WIDTH < MIN_DESKTOP_RAIL_CANVAS_WIDTH
  );
  // On mobile the rail is the full-height menu drawer, always shown expanded.
  const railCollapsed = !mobileLayout && (manualRailCollapsed || autoRailCollapsed);
  const showRail = inPageZone || desktopCollapsed;

  // Mobile drawers are mutually exclusive and only exist in the mobile layout:
  // leaving that layout, or opening the chat, closes the menu drawer.
  useEffect(() => {
    if (!mobileLayout || chatOpen) {
      setMobileMenuOpen(false);
    }
  }, [mobileLayout, chatOpen]);
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

  const syncActiveLibraryRoute = (route: ShellLibraryRoute): void => {
    if (activeSurface !== "library") {
      return;
    }

    pushShellRoute({ surface: "library", libraryRoute: route });
    const libraryTab = shellTabForLibraryRoute(route);
    setOpenTabs((current) => upsertTab(current, libraryTab));
    setActiveTabKey(libraryTab.key);
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

  /** Close the active screen: drop it from the (now-invisible) tab stack and
   *  return to the desktop. With the tab UI removed, a predictable "back to
   *  home" beats jumping to some other previously-opened screen. */
  const closeActiveScreen = (): void => {
    if (activeTabKey) {
      const key = activeTabKey;
      setOpenTabs((current) => current.filter((tab) => tab.key !== key));
    }
    activateRoute({ surface: "desktop" });
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

    const reserve = inPageZone ? COLLAPSED_RAIL_WIDTH + MIN_CONSOLE_DRAG_WIDTH : COLLAPSED_RAIL_WIDTH;
    const maxChatExtent = Math.max(MIN_CHAT_WIDTH, rect.width - reserve);
    setChatDragging(true);

    const onMove = (moveEvent: MouseEvent) => {
      const nextWidth = clamp(rect.right - moveEvent.clientX, MIN_CHAT_WIDTH, maxChatExtent);
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

  // Drag the rail divider: collapse to the icon rail when dragged left past the
  // midpoint between the collapsed and expanded widths, expand when dragged back.
  const startRailDrag = (event: JSX.TargetedMouseEvent<HTMLElement>): void => {
    event.preventDefault();
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const threshold = (COLLAPSED_RAIL_WIDTH + EXPANDED_RAIL_WIDTH) / 2;
    const startX = event.clientX;
    railDraggedRef.current = false;

    const onMove = (moveEvent: MouseEvent) => {
      if (!railDraggedRef.current && Math.abs(moveEvent.clientX - startX) > 4) {
        railDraggedRef.current = true;
      }
      if (railDraggedRef.current) {
        setManualRailCollapsed(moveEvent.clientX - rect.left < threshold);
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // Clear the drag flag after the trailing click would have fired (the click
      // dispatches before the next frame). This way an aborted drag whose click
      // is never delivered can't leave the flag stuck and swallow the next
      // activation (e.g. a keyboard Enter, which has no preceding mousedown).
      requestAnimationFrame(() => {
        railDraggedRef.current = false;
      });
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const toggleRailCollapsed = (): void => {
    // Ignore the click that follows a drag — the drag already set the state.
    if (railDraggedRef.current) {
      railDraggedRef.current = false;
      return;
    }
    setManualRailCollapsed((value) => !value);
  };

  const toggleChatMax = (): void => {
    if (resolvedChatWidth >= maxChatWidth - 1) {
      setChatWidth(DEFAULT_CHAT_WIDTH);
      return;
    }
    setChatWidth(maxChatWidth);
  };

  // Mobile pane controls. The menu and chat are full-height drawers over the
  // center panel; opening one closes the other (chatOpen also closes the menu
  // via the effect above, covering the non-mobile-menu open paths).
  const openMobileMenu = (): void => {
    setChatOpen(false);
    setMobileMenuOpen(true);
  };
  const closeMobilePanels = (): void => {
    setMobileMenuOpen(false);
    setChatOpen(false);
  };

  const pickerTitle = "GSV // CONTROL";
  const pickerSubtitle = "System surfaces";

  const statusContext = activeSurface !== "desktop"
    ? activePageTab?.title ?? shellSurfaceLabel(activeSurface)
    : selectedObject
      ? selectedObject.label
      : "DESKTOP";

  return {
    activeSurface,
    activePageTab,
    activeTabKey,
    backToDesktop,
    chatDragging,
    chatOpen,
    closeActiveScreen,
    closeMobilePanels,
    desktopCollapsed,
    gsvOpen,
    maxChatWidth,
    mobileLayout,
    mobileMenuOpen,
    openControlMenu,
    openMobileMenu,
    openObject,
    openAppRoute,
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
    startRailDrag,
    syncActiveSettingsRoute,
    syncActiveLibraryRoute,
    toggleChatMax,
    toggleRailCollapsed,
  };
}
