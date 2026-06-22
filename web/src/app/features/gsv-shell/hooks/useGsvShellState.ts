import type { JSX, RefObject } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  getDesktopObject,
  shellSurfaceLabel,
  shellTabForSurface,
  type DesktopObject,
  type DesktopObjectId,
  type ShellRailMode,
  type ShellSurfaceId,
  type ShellTab,
} from "../domain/shellModel";

export type PickerId = DesktopObjectId | "tabs";

export type PickerCard = {
  key: string;
  label: string;
  type: string;
  blurb: string;
  status: "online" | "error" | "idle" | "warn" | "live";
  onClick: () => void;
};

const MIN_CHAT_WIDTH = 380;
const DEFAULT_CHAT_WIDTH = 460;
const EXPANDED_RAIL_WIDTH = 262;
const COLLAPSED_RAIL_WIDTH = 64;
const MIN_CONSOLE_WIDTH = 360;

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
  if (parentId === "applications") {
    return "library";
  }
  return "settings";
}

export function useGsvShellState({
  rootRef,
  desktopObjects,
}: UseGsvShellStateArgs) {
  const [rootWidth, setRootWidth] = useState(1280);
  const [tabs, setTabs] = useState<ShellTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null);
  const [railMode, setRailMode] = useState<ShellRailMode>("gsv");
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

    const update = () => setRootWidth(node.getBoundingClientRect().width);
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
  const totalDesktopObjects = useMemo(
    () => desktopObjects.reduce((sum, object) => sum + object.children.length, 0),
    [desktopObjects],
  );
  const inPageZone = activeTab !== null;
  const maxChatWidth = Math.max(
    MIN_CHAT_WIDTH,
    rootWidth - (inPageZone ? COLLAPSED_RAIL_WIDTH + MIN_CONSOLE_WIDTH : COLLAPSED_RAIL_WIDTH),
  );
  const resolvedChatWidth = clamp(chatWidth, MIN_CHAT_WIDTH, maxChatWidth);
  const mainWidth = rootWidth - (chatOpen ? resolvedChatWidth : 0);
  const desktopCollapsed = !inPageZone && chatOpen && mainWidth < 600;
  const autoRailCollapsed = chatOpen && (
    inPageZone
      ? mainWidth - EXPANDED_RAIL_WIDTH < MIN_CONSOLE_WIDTH
      : mainWidth < EXPANDED_RAIL_WIDTH + 40
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
    setRailMode("tabs");
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
  };

  const backToDesktop = (): void => {
    setActiveTabKey(null);
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
    setRailMode("gsv");
  };

  const closeTab = (key: string): void => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.key !== key);
      if (activeTabKey === key) {
        setActiveTabKey(next.length > 0 ? next[next.length - 1].key : null);
      }
      if (next.length === 0) {
        setRailMode("gsv");
      }
      return next;
    });
  };

  const openPicker = (id: DesktopObjectId): void => {
    if (!inPageZone && !desktopCollapsed) {
      setSelectedObjectId(id);
      return;
    }
    setPickerId(id);
  };

  const activateTab = (key: string): void => {
    setActiveTabKey(key);
    setPickerId(null);
  };

  const startChatDrag = (event: JSX.TargetedMouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const reserve = inPageZone ? COLLAPSED_RAIL_WIDTH + MIN_CONSOLE_WIDTH : COLLAPSED_RAIL_WIDTH;
    const maxWidth = Math.max(MIN_CHAT_WIDTH, rect.width - reserve);
    setChatDragging(true);

    const onMove = (moveEvent: MouseEvent) => {
      const nextWidth = clamp(rect.right - moveEvent.clientX, MIN_CHAT_WIDTH, maxWidth);
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

  const pickerObject = pickerId && pickerId !== "tabs" ? getDesktopObject(desktopObjects, pickerId) : null;
  const pickerCards: PickerCard[] = pickerId === "tabs"
    ? tabs.map((tab) => ({
        key: tab.key,
        label: tab.title,
        type: "OPEN TAB",
        blurb: tab.key === activeTabKey ? "Currently active in the central panel." : "Open page. Select to bring it forward.",
        status: tab.key === activeTabKey ? "live" as const : "online" as const,
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
        onClick: () => {
          openSurface(surfaceForDesktopObject(pickerObject.id));
        },
      })) ?? [];

  const statusContext = activeTab
    ? shellSurfaceLabel(activeTab.surface)
    : selectedObject
      ? selectedObject.label
      : "DESKTOP";

  return {
    activeSurface,
    activeTab,
    activeTabKey,
    backToDesktop,
    chatDragging,
    chatOpen,
    closeTab,
    desktopCollapsed,
    gsvOpen,
    maxChatWidth,
    openPicker,
    openSurface,
    pickerCards,
    pickerId,
    pickerObject,
    railCollapsed,
    railMode,
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
    totalDesktopObjects,
    activateTab,
  };
}
