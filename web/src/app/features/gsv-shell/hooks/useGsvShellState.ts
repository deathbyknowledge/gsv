import type { JSX, RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  getDesktopObject,
  shellSurfaceLabel,
  shellTabForDesktopChild,
  shellTabForSettingsRoute,
  shellTabForSurface,
  type DesktopChildObject,
  type DesktopObject,
  type DesktopObjectId,
  type ShellPageTab,
  type ShellSettingsRoute,
  type ShellSurfaceId,
} from "../domain/shellModel";

export type PickerId = DesktopObjectId | "gsv";
export type RailMode = "gsv" | "tabs";

export type PickerCard = {
  key: string;
  label: string;
  type: string;
  blurb: string;
  status: "online" | "error" | "idle" | "warn" | "live";
  glyph?: DesktopObject["children"][number]["glyph"];
  icon?: string;
  onClick: () => void;
};

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

type UseGsvShellStateArgs = {
  rootRef: RefObject<HTMLDivElement>;
  desktopObjects: readonly DesktopObject[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function objectCardStatus(status: string): "online" | "error" | "idle" | "warn" | "live" {
  if (status === "update") {
    return "warn";
  }
  if (status === "online" || status === "error" || status === "idle" || status === "warn" || status === "live") {
    return status;
  }
  return "online";
}

function upsertTab(tabs: readonly ShellPageTab[], tab: ShellPageTab): ShellPageTab[] {
  const index = tabs.findIndex((candidate) => candidate.key === tab.key);
  if (index === -1) {
    return [...tabs, tab];
  }
  return tabs.map((candidate, candidateIndex) => candidateIndex === index ? tab : candidate);
}

function isListDetailRoute(route: ShellSettingsRoute): route is Extract<ShellSettingsRoute, { view: "list" }> & { detailId: string } {
  return route.view === "list" && typeof route.detailId === "string" && route.detailId.length > 0;
}

export function useGsvShellState({
  rootRef,
  desktopObjects,
}: UseGsvShellStateArgs) {
  const [rootWidth, setRootWidth] = useState(1280);
  const [rootHeight, setRootHeight] = useState(760);
  const [activeSurface, setActiveSurface] = useState<ShellSurfaceId>("desktop");
  const [openTabs, setOpenTabs] = useState<ShellPageTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null);
  const [railMode, setRailMode] = useState<RailMode>("gsv");
  const [manualRailCollapsed, setManualRailCollapsed] = useState(false);
  const [selectedObjectId, setSelectedObjectId] = useState<DesktopObjectId | null>(null);
  const [pickerId, setPickerId] = useState<PickerId | null>(null);
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

  const openSurface = (surface: ShellSurfaceId): void => {
    if (surface === "desktop") {
      setActiveSurface("desktop");
      setActiveTabKey(null);
      setSelectedObjectId(null);
      setPickerId(null);
      setGsvOpen(false);
      return;
    }

    const tab = shellTabForSurface(surface);
    setOpenTabs((current) => upsertTab(current, tab));
    setActiveTabKey(tab.key);
    setActiveSurface(surface);
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
  };

  const openSettingsRoute = (route: ShellSettingsRoute): void => {
    const tab = shellTabForSettingsRoute(route);
    setOpenTabs((current) => upsertTab(current, tab));
    setActiveTabKey(tab.key);
    setActiveSurface("settings");
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
  };

  const syncActiveSettingsRoute = (route: ShellSettingsRoute): void => {
    if (activeSurface !== "settings") {
      return;
    }

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
    const tab = shellTabForDesktopChild(child);
    setOpenTabs((current) => upsertTab(current, tab));
    setActiveTabKey(tab.key);
    setActiveSurface(tab.surface);
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
  };

  const backToDesktop = (): void => {
    setActiveSurface("desktop");
    setActiveTabKey(null);
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
  };

  const revealDesktop = (): void => {
    setChatWidth(MIN_CHAT_WIDTH);
    setActiveSurface("desktop");
    setActiveTabKey(null);
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
  };

  const activateTab = (key: string): void => {
    const tab = openTabs.find((candidate) => candidate.key === key);
    if (!tab) {
      return;
    }
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
    }
    if (nextTabs.length === 0) {
      setRailMode("gsv");
    }
  };

  const openPicker = (id: DesktopObjectId): void => {
    if (!inPageZone && !desktopCollapsed) {
      setSelectedObjectId(id);
      return;
    }
    setPickerId(id);
  };

  const openControlMenu = (): void => {
    setSelectedObjectId(null);
    setGsvOpen(false);
    if (railCollapsed && autoRailCollapsed) {
      setPickerId("gsv");
      return;
    }
    setManualRailCollapsed(false);
    setRailMode("gsv");
    setPickerId(null);
  };

  const openTabsPicker = (): void => {
    setSelectedObjectId(null);
    setGsvOpen(false);
    if (railCollapsed) {
      return;
    }
    setRailMode("tabs");
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

  const pickerObject = pickerId && pickerId !== "gsv" ? getDesktopObject(desktopObjects, pickerId) : null;
  const pickerCards: PickerCard[] = pickerObject?.children.map((child) => ({
    key: child.id,
    label: child.label,
    type: child.type,
    blurb: child.blurb,
    status: objectCardStatus(child.status),
    glyph: child.glyph,
    onClick: () => {
      openObject(child);
    },
  })) ?? [];
  const pickerTitle = pickerId === "gsv"
    ? "GSV // CONTROL"
    : `${pickerObject?.label ?? "OBJECTS"} · SELECT AN OBJECT`;
  const pickerSubtitle = pickerId === "gsv"
    ? "System surfaces"
    : pickerObject
      ? `${pickerObject.meta} · ${pickerObject.statusLabel}`
      : "No branch selected";
  const pickerEmptyLabel = pickerId === "gsv"
    ? ""
    : "NO OBJECTS";

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
    openPicker,
    openSettingsRoute,
    openSurface,
    openTabs,
    openTabsPicker,
    pickerCards,
    pickerEmptyLabel,
    pickerId,
    pickerObject,
    pickerSubtitle,
    pickerTitle,
    railMode,
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
    toggleChatMax,
    toggleRailCollapsed: () => {
      setManualRailCollapsed((value) => !value);
    },
  };
}
