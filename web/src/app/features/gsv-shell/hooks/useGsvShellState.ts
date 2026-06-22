import type { JSX, RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  getDesktopObject,
  shellSurfaceLabel,
  shellTabForSurface,
  type DesktopObject,
  type DesktopGlyph,
  type DesktopObjectId,
  type ShellRailMode,
  type ShellSurfaceId,
  type ShellTab,
} from "../domain/shellModel";

export type PickerId = DesktopObjectId | "gsv" | "tabs";

export type PickerCard = {
  key: string;
  label: string;
  type: string;
  blurb: string;
  status: "online" | "error" | "idle" | "warn" | "live";
  glyph?: DesktopGlyph;
  icon?: string;
  onClick: () => void;
};

const MIN_CHAT_WIDTH = 380;
const DEFAULT_CHAT_WIDTH = 460;
const EXPANDED_RAIL_WIDTH = 262;
const COLLAPSED_RAIL_WIDTH = 64;
const MIN_CONSOLE_WIDTH = 360;
const MIN_DESKTOP_TREE_WIDTH = 700;
const MIN_DESKTOP_RAIL_CANVAS_WIDTH = 360;
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

function tabForSurface(surface: ShellSurfaceId): ShellTab | null {
  if (surface === "desktop") {
    return null;
  }
  return shellTabForSurface(surface);
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

function surfaceForDesktopObject(parentId: DesktopObjectId): ShellSurfaceId {
  if (parentId === "machines") {
    return "machines";
  }
  if (parentId === "messengers") {
    return "messengers";
  }
  if (parentId === "integrations") {
    return "integrations";
  }
  if (parentId === "applications") {
    return "applications";
  }
  return "settings";
}

function iconForSurface(surface: ShellSurfaceId): string {
  if (surface === "machines") {
    return "computer";
  }
  if (surface === "messengers") {
    return "chat";
  }
  if (surface === "integrations") {
    return "weblink";
  }
  if (surface === "applications") {
    return "stars";
  }
  if (surface === "files") {
    return "folder";
  }
  if (surface === "library") {
    return "pencil";
  }
  if (surface === "terminal") {
    return "terminal";
  }
  if (surface === "runtime") {
    return "list";
  }
  if (surface === "settings") {
    return "cog";
  }
  if (surface === "crew" || surface === "agent") {
    return "chat";
  }
  if (surface === "object") {
    return "tag";
  }
  return "stars";
}

export function useGsvShellState({
  rootRef,
  desktopObjects,
}: UseGsvShellStateArgs) {
  const [rootWidth, setRootWidth] = useState(1280);
  const [rootHeight, setRootHeight] = useState(760);
  const [tabs, setTabs] = useState<ShellTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null);
  const [railMode, setRailMode] = useState<ShellRailMode>("objects");
  const [manualRailCollapsed, setManualRailCollapsed] = useState(false);
  const [selectedObjectId, setSelectedObjectId] = useState<DesktopObjectId | null>(null);
  const [pickerId, setPickerId] = useState<PickerId | null>(null);
  const [gsvOpen, setGsvOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
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

  const activeTab = tabs.find((tab) => tab.key === activeTabKey) ?? null;
  const activeSurface: ShellSurfaceId = activeTab?.surface ?? "desktop";
  const inPageZone = activeTab !== null;
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

  const openSurface = (surface: ShellSurfaceId): void => {
    const tab = tabForSurface(surface);
    if (!tab) {
      setActiveTabKey(null);
      setSelectedObjectId(null);
      setPickerId(null);
      setGsvOpen(false);
      return;
    }

    setTabs((current) => current.some((item) => item.key === tab.key) ? current : [...current, tab]);
    setActiveTabKey(tab.key);
    setRailMode("gsv");
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
  };

  const backToDesktop = (): void => {
    setActiveTabKey(null);
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
    setRailMode("objects");
  };

  const revealDesktop = (): void => {
    setChatWidth(MIN_CHAT_WIDTH);
    setActiveTabKey(null);
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
    setRailMode("objects");
  };

  const openPicker = (id: DesktopObjectId): void => {
    setRailMode("objects");
    if (!inPageZone && !desktopCollapsed) {
      setSelectedObjectId(id);
      return;
    }
    setPickerId(id);
  };

  const openControlMenu = (): void => {
    setRailMode("gsv");
    setSelectedObjectId(null);
    setGsvOpen(false);
    setPickerId("gsv");
  };

  const activateTab = (key: string): void => {
    if (!tabs.some((tab) => tab.key === key)) {
      return;
    }
    setActiveTabKey(key);
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
  };

  const closeTab = (key: string): void => {
    const closedIndex = tabs.findIndex((tab) => tab.key === key);
    if (closedIndex < 0) {
      return;
    }

    const next = tabs.filter((tab) => tab.key !== key);
    setTabs(next);
    if (activeTabKey === key) {
      const fallback = next[Math.min(closedIndex, next.length - 1)] ?? null;
      setActiveTabKey(fallback?.key ?? null);
      if (!fallback) {
        setRailMode("objects");
        setPickerId(null);
        setGsvOpen(false);
      }
    }
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

  const pickerObject = pickerId && pickerId !== "tabs" && pickerId !== "gsv" ? getDesktopObject(desktopObjects, pickerId) : null;
  const pickerCards: PickerCard[] = pickerId === "tabs"
    ? tabs.map((tab) => ({
        key: tab.key,
        label: tab.title,
        type: "OPEN TAB",
        blurb: tab.key === activeTabKey ? "Currently active in the central panel." : "Open page. Select to bring it forward.",
        status: tab.key === activeTabKey ? "live" as const : "online" as const,
        icon: iconForSurface(tab.surface),
        onClick: () => {
          setActiveTabKey(tab.key);
          setPickerId(null);
        },
      }))
    : pickerObject?.children.map((child) => ({
        key: child.id,
        label: child.label,
        type: child.type,
        blurb: child.blurb,
        status: objectCardStatus(child.status),
        glyph: child.glyph,
        onClick: () => {
          openSurface(surfaceForDesktopObject(pickerObject.id));
        },
      })) ?? [];
  const pickerTitle = pickerId === "gsv"
    ? "GSV // CONTROL"
    : pickerId === "tabs"
      ? "OPEN TABS · SELECT TAB"
      : `${pickerObject?.label ?? "OBJECTS"} · SELECT AN OBJECT`;
  const pickerSubtitle = pickerId === "gsv"
    ? "System surfaces"
    : pickerId === "tabs"
      ? `${tabs.length} open ${tabs.length === 1 ? "tab" : "tabs"}`
      : pickerObject
        ? `${pickerObject.meta} · ${pickerObject.statusLabel}`
        : "No branch selected";
  const pickerEmptyLabel = pickerId === "tabs"
    ? "NO OPEN TABS"
    : pickerId === "gsv"
      ? ""
      : "NO OBJECTS";

  const statusContext = activeTab
    ? shellSurfaceLabel(activeTab.surface)
    : selectedObject
      ? selectedObject.label
      : "DESKTOP";

  return {
    activeSurface,
    activeTab,
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
    openPicker,
    openSurface,
    pickerCards,
    pickerEmptyLabel,
    pickerId,
    pickerObject,
    pickerSubtitle,
    pickerTitle,
    railCollapsed,
    railMode,
    revealDesktop,
    resolvedChatWidth,
    selectedObjectId,
    setChatOpen,
    setGsvOpen,
    setPickerId,
    setRailMode,
    setSelectedObjectId,
    showRail,
    startChatDrag,
    statusContext,
    tabs,
    toggleChatMax,
    toggleRailCollapsed: () => setManualRailCollapsed((value) => !value),
  };
}
