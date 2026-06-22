import type { JSX, RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  getDesktopObject,
  shellSurfaceLabel,
  type DesktopObject,
  type DesktopObjectId,
  type ShellSurfaceId,
} from "../domain/shellModel";

export type PickerId = DesktopObjectId | "gsv";

export type PickerCard = {
  key: string;
  label: string;
  type: string;
  blurb: string;
  status: "online" | "error" | "idle" | "warn" | "live";
  glyph?: DesktopObject["children"][number]["glyph"];
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

export function useGsvShellState({
  rootRef,
  desktopObjects,
}: UseGsvShellStateArgs) {
  const [rootWidth, setRootWidth] = useState(1280);
  const [rootHeight, setRootHeight] = useState(760);
  const [activeSurface, setActiveSurface] = useState<ShellSurfaceId>("desktop");
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

  const openSurface = (surface: ShellSurfaceId): void => {
    if (surface === "desktop") {
      setActiveSurface("desktop");
      setSelectedObjectId(null);
      setPickerId(null);
      setGsvOpen(false);
      return;
    }

    setActiveSurface(surface);
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
  };

  const backToDesktop = (): void => {
    setActiveSurface("desktop");
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
  };

  const revealDesktop = (): void => {
    setChatWidth(MIN_CHAT_WIDTH);
    setActiveSurface("desktop");
    setSelectedObjectId(null);
    setPickerId(null);
    setGsvOpen(false);
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
    setPickerId("gsv");
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
          openSurface(surfaceForDesktopObject(pickerObject.id));
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
    ? shellSurfaceLabel(activeSurface)
    : selectedObject
      ? selectedObject.label
      : "DESKTOP";

  return {
    activeSurface,
    backToDesktop,
    chatDragging,
    chatOpen,
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
    toggleChatMax,
    toggleRailCollapsed: () => setManualRailCollapsed((value) => !value),
  };
}
