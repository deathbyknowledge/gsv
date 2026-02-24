import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { TAB_GROUPS, TAB_ICONS, TAB_LABELS, type Tab } from "../../ui/types";
import { preloadTabView, TabView } from "../tabViews";

const WINDOW_MIN_WIDTH = 420;
const WINDOW_MIN_HEIGHT = 280;
const WINDOW_MARGIN = 12;
const SNAP_THRESHOLD = 28;
const CLOCK_REFRESH_MS = 15_000;

const TAB_ACCENTS: Record<Tab, string> = {
  chat: "hsl(191 95% 58%)",
  overview: "hsl(36 96% 60%)",
  sessions: "hsl(164 80% 52%)",
  channels: "hsl(9 88% 63%)",
  nodes: "hsl(214 90% 62%)",
  workspace: "hsl(152 70% 48%)",
  cron: "hsl(48 98% 59%)",
  logs: "hsl(2 88% 63%)",
  pairing: "hsl(24 92% 64%)",
  config: "hsl(205 68% 68%)",
  debug: "hsl(337 84% 62%)",
};

const CLOCK_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

type WindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type OsWindow = WindowRect & {
  id: number;
  tab: Tab;
  z: number;
  minimized: boolean;
  maximized: boolean;
  snapped: "left" | "right" | null;
  restoreRect?: WindowRect;
};

type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
type SnapZone = "left" | "right" | "top";

type InteractionState =
  | {
      type: "drag";
      windowId: number;
      startClientX: number;
      startClientY: number;
      startRect: WindowRect;
    }
  | {
      type: "resize";
      windowId: number;
      edge: ResizeEdge;
      startClientX: number;
      startClientY: number;
      startRect: WindowRect;
    };

type OpenWindowOptions = {
  syncTab?: boolean;
  newWindow?: boolean;
};

type SnapPreviewState = {
  zone: SnapZone;
  rect: WindowRect;
};

type CommandAction = {
  id: string;
  label: string;
  hint?: string;
  keywords?: string[];
  run: () => void;
};

type OsShellProps = {
  tab: Tab;
  onSwitchTab: (tab: Tab) => void;
  connectionState: "connected" | "connecting" | "disconnected";
  theme: "dark" | "light" | "system";
  onToggleTheme: () => void;
  onDisconnect: () => void;
  onExitOsMode: () => void;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  const tagName = element.tagName;
  return (
    element.isContentEditable ||
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT"
  );
}

function shouldOpenNewWindow(event: ReactMouseEvent<HTMLButtonElement>): boolean {
  return event.altKey || event.shiftKey || event.metaKey || event.ctrlKey;
}

function formatClock(date: Date): string {
  return CLOCK_FORMATTER.format(date);
}

function getDesktopBounds(node: HTMLDivElement | null): WindowRect {
  if (node) {
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return {
        x: 0,
        y: 0,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }
  }

  if (typeof window !== "undefined") {
    return {
      x: 0,
      y: 0,
      width: Math.max(720, Math.round(window.innerWidth - 320)),
      height: Math.max(420, Math.round(window.innerHeight - 140)),
    };
  }

  return { x: 0, y: 0, width: 960, height: 640 };
}

function getDesktopClientBounds(node: HTMLDivElement | null): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  if (node) {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  if (typeof window !== "undefined") {
    return {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  return { left: 0, top: 0, width: 960, height: 640 };
}

function clampRectToBounds(rect: WindowRect, bounds: WindowRect): WindowRect {
  const maxWidth = Math.max(WINDOW_MIN_WIDTH, bounds.width - WINDOW_MARGIN * 2);
  const maxHeight = Math.max(WINDOW_MIN_HEIGHT, bounds.height - WINDOW_MARGIN * 2);
  const width = clamp(rect.width, WINDOW_MIN_WIDTH, maxWidth);
  const height = clamp(rect.height, WINDOW_MIN_HEIGHT, maxHeight);
  const maxX = Math.max(WINDOW_MARGIN, bounds.width - width - WINDOW_MARGIN);
  const maxY = Math.max(WINDOW_MARGIN, bounds.height - height - WINDOW_MARGIN);
  return {
    x: clamp(rect.x, WINDOW_MARGIN, maxX),
    y: clamp(rect.y, WINDOW_MARGIN, maxY),
    width,
    height,
  };
}

function createWindow(
  tab: Tab,
  id: number,
  z: number,
  index: number,
  bounds: WindowRect,
): OsWindow {
  const baseRect: WindowRect = {
    x: 36 + (index % 7) * 24,
    y: 34 + (index % 7) * 18,
    width: Math.round(bounds.width * 0.68),
    height: Math.round(bounds.height * 0.74),
  };
  const rect = clampRectToBounds(baseRect, bounds);
  return {
    id,
    tab,
    z,
    minimized: false,
    maximized: false,
    snapped: null,
    ...rect,
  };
}

function resizeRect(
  startRect: WindowRect,
  edge: ResizeEdge,
  deltaX: number,
  deltaY: number,
  bounds: WindowRect,
): WindowRect {
  let nextX = startRect.x;
  let nextY = startRect.y;
  let nextWidth = startRect.width;
  let nextHeight = startRect.height;

  if (edge.includes("e")) {
    const maxWidth = bounds.width - startRect.x - WINDOW_MARGIN;
    nextWidth = clamp(startRect.width + deltaX, WINDOW_MIN_WIDTH, maxWidth);
  }

  if (edge.includes("s")) {
    const maxHeight = bounds.height - startRect.y - WINDOW_MARGIN;
    nextHeight = clamp(startRect.height + deltaY, WINDOW_MIN_HEIGHT, maxHeight);
  }

  if (edge.includes("w")) {
    const maxX = startRect.x + startRect.width - WINDOW_MIN_WIDTH;
    nextX = clamp(startRect.x + deltaX, WINDOW_MARGIN, maxX);
    nextWidth = startRect.width - (nextX - startRect.x);
  }

  if (edge.includes("n")) {
    const maxY = startRect.y + startRect.height - WINDOW_MIN_HEIGHT;
    nextY = clamp(startRect.y + deltaY, WINDOW_MARGIN, maxY);
    nextHeight = startRect.height - (nextY - startRect.y);
  }

  return clampRectToBounds(
    {
      x: nextX,
      y: nextY,
      width: nextWidth,
      height: nextHeight,
    },
    bounds,
  );
}

function detectSnapZone(
  clientX: number,
  clientY: number,
  desktopClientBounds: { left: number; top: number; width: number; height: number },
): SnapZone | null {
  const localX = clientX - desktopClientBounds.left;
  const localY = clientY - desktopClientBounds.top;

  if (
    localX < 0 ||
    localY < 0 ||
    localX > desktopClientBounds.width ||
    localY > desktopClientBounds.height
  ) {
    return null;
  }

  if (localY <= SNAP_THRESHOLD) {
    return "top";
  }
  if (localX <= SNAP_THRESHOLD) {
    return "left";
  }
  if (localX >= desktopClientBounds.width - SNAP_THRESHOLD) {
    return "right";
  }
  return null;
}

function getSnapRect(zone: SnapZone, bounds: WindowRect): WindowRect {
  if (zone === "top") {
    return {
      x: 0,
      y: 0,
      width: bounds.width,
      height: bounds.height,
    };
  }

  const halfWidth = Math.max(WINDOW_MIN_WIDTH, Math.floor(bounds.width / 2));
  if (zone === "left") {
    return {
      x: 0,
      y: 0,
      width: halfWidth,
      height: bounds.height,
    };
  }

  return {
    x: bounds.width - halfWidth,
    y: 0,
    width: halfWidth,
    height: bounds.height,
  };
}

const RESIZE_HANDLES: { edge: ResizeEdge; className: string }[] = [
  { edge: "n", className: "os-resize-handle n" },
  { edge: "s", className: "os-resize-handle s" },
  { edge: "e", className: "os-resize-handle e" },
  { edge: "w", className: "os-resize-handle w" },
  { edge: "ne", className: "os-resize-handle ne" },
  { edge: "nw", className: "os-resize-handle nw" },
  { edge: "se", className: "os-resize-handle se" },
  { edge: "sw", className: "os-resize-handle sw" },
];

export function OsShell({
  tab,
  onSwitchTab,
  connectionState,
  theme,
  onToggleTheme,
  onDisconnect,
  onExitOsMode,
}: OsShellProps) {
  const desktopRef = useRef<HTMLDivElement | null>(null);
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const interactionRef = useRef<InteractionState | null>(null);
  const windowsRef = useRef<OsWindow[]>([]);
  const snapPreviewRef = useRef<SnapPreviewState | null>(null);
  const focusedWindowIdRef = useRef<number | null>(1);
  const nextWindowIdRef = useRef(2);
  const nextZRef = useRef(2);

  const [windows, setWindows] = useState<OsWindow[]>(() => {
    const bounds = getDesktopBounds(null);
    return [createWindow(tab, 1, 1, 0, bounds)];
  });
  const [focusedWindowId, setFocusedWindowId] = useState<number | null>(1);
  const [snapPreview, setSnapPreview] = useState<SnapPreviewState | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [clockLabel, setClockLabel] = useState(() => formatClock(new Date()));

  const launchTabs = useMemo(() => TAB_GROUPS.flatMap((group) => group.tabs), []);
  const openTabs = useMemo(
    () => new Set(windows.map((windowState) => windowState.tab)),
    [windows],
  );
  const visibleWindows = useMemo(
    () =>
      windows
        .filter((windowState) => !windowState.minimized)
        .sort((left, right) => left.z - right.z),
    [windows],
  );
  const focusedWindow = useMemo(
    () =>
      focusedWindowId === null
        ? null
        : windows.find((windowState) => windowState.id === focusedWindowId) ?? null,
    [focusedWindowId, windows],
  );
  const focusedTab = focusedWindow?.tab ?? null;
  const focusedTabLabel = focusedTab ? TAB_LABELS[focusedTab] : "No focus";
  const totalWindowCount = windows.length;
  const visibleWindowCount = visibleWindows.length;
  const shellFocusAccent = focusedTab
    ? TAB_ACCENTS[focusedTab]
    : "var(--accent-primary)";
  const shellStyle = useMemo(
    () =>
      ({
        "--os-focus-accent": shellFocusAccent,
      }) as CSSProperties,
    [shellFocusAccent],
  );
  const connectionStateLabel = useMemo(() => {
    if (connectionState === "connected") {
      return "online";
    }
    if (connectionState === "connecting") {
      return "linking";
    }
    return "offline";
  }, [connectionState]);
  const windowCountByTab = useMemo(() => {
    const counts: Partial<Record<Tab, number>> = {};
    for (const windowState of windows) {
      counts[windowState.tab] = (counts[windowState.tab] ?? 0) + 1;
    }
    return counts;
  }, [windows]);

  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  useEffect(() => {
    focusedWindowIdRef.current = focusedWindowId;
  }, [focusedWindowId]);

  useEffect(() => {
    const updateClock = () => {
      setClockLabel(formatClock(new Date()));
    };
    updateClock();
    const interval = window.setInterval(updateClock, CLOCK_REFRESH_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  const connectionBadgeVariant = useMemo(() => {
    if (connectionState === "connected") {
      return "primary";
    }
    if (connectionState === "connecting") {
      return "outline";
    }
    return "destructive";
  }, [connectionState]);

  const focusWindow = useCallback(
    (windowId: number, syncTab = true) => {
      const target = windowsRef.current.find((windowState) => windowState.id === windowId);
      if (!target) {
        return;
      }
      const nextZ = nextZRef.current++;
      setWindows((previous) =>
        previous.map((windowState) =>
          windowState.id === windowId
            ? {
                ...windowState,
                minimized: false,
                z: nextZ,
              }
            : windowState,
        ),
      );
      setFocusedWindowId(windowId);
      if (syncTab) {
        onSwitchTab(target.tab);
      }
    },
    [onSwitchTab],
  );

  const openWindow = useCallback(
    (windowTab: Tab, options: OpenWindowOptions = {}) => {
      const { newWindow = false, syncTab = true } = options;
      preloadTabView(windowTab);

      const existingTopWindow = windowsRef.current
        .filter((windowState) => windowState.tab === windowTab)
        .sort((left, right) => right.z - left.z)[0];

      if (existingTopWindow && !newWindow) {
        focusWindow(existingTopWindow.id, syncTab);
        return existingTopWindow.id;
      }

      const bounds = getDesktopBounds(desktopRef.current);
      const windowId = nextWindowIdRef.current++;
      const nextZ = nextZRef.current++;
      const windowState = createWindow(
        windowTab,
        windowId,
        nextZ,
        windowsRef.current.length,
        bounds,
      );

      setWindows((previous) => [...previous, windowState]);
      setFocusedWindowId(windowId);
      if (syncTab) {
        onSwitchTab(windowTab);
      }
      return windowId;
    },
    [focusWindow, onSwitchTab],
  );

  const closeWindow = useCallback(
    (windowId: number) => {
      const currentWindows = windowsRef.current;
      const target = currentWindows.find((windowState) => windowState.id === windowId);
      if (!target) {
        return;
      }

      const remaining = currentWindows.filter((windowState) => windowState.id !== windowId);
      if (!remaining.length) {
        setWindows([]);
        setFocusedWindowId(null);
        return;
      }

      if (focusedWindowIdRef.current !== windowId) {
        setWindows(remaining);
        return;
      }

      const nextFocusTarget =
        remaining
          .filter((windowState) => !windowState.minimized)
          .sort((left, right) => right.z - left.z)[0] ??
        [...remaining].sort((left, right) => right.z - left.z)[0];
      const nextZ = nextZRef.current++;

      setWindows(
        remaining.map((windowState) =>
          windowState.id === nextFocusTarget.id
            ? {
                ...windowState,
                minimized: false,
                z: nextZ,
              }
            : windowState,
        ),
      );
      setFocusedWindowId(nextFocusTarget.id);
      onSwitchTab(nextFocusTarget.tab);
    },
    [onSwitchTab],
  );

  const minimizeWindow = useCallback(
    (windowId: number) => {
      const currentWindows = windowsRef.current;
      const target = currentWindows.find((windowState) => windowState.id === windowId);
      if (!target) {
        return;
      }

      setWindows((previous) =>
        previous.map((windowState) =>
          windowState.id === windowId
            ? {
                ...windowState,
                minimized: true,
              }
            : windowState,
        ),
      );

      if (focusedWindowIdRef.current !== windowId) {
        return;
      }

      const nextVisible = currentWindows
        .filter((windowState) => windowState.id !== windowId && !windowState.minimized)
        .sort((left, right) => right.z - left.z);
      if (!nextVisible.length) {
        setFocusedWindowId(null);
        return;
      }
      focusWindow(nextVisible[0].id);
    },
    [focusWindow],
  );

  const restoreWindow = useCallback(
    (windowId: number) => {
      const target = windowsRef.current.find((windowState) => windowState.id === windowId);
      if (!target || !target.restoreRect) {
        return;
      }
      const bounds = getDesktopBounds(desktopRef.current);
      const restored = clampRectToBounds(target.restoreRect, bounds);
      const nextZ = nextZRef.current++;

      setWindows((previous) =>
        previous.map((windowState) =>
          windowState.id === windowId
            ? {
                ...windowState,
                ...restored,
                z: nextZ,
                maximized: false,
                snapped: null,
                restoreRect: undefined,
              }
            : windowState,
        ),
      );
      setFocusedWindowId(windowId);
      onSwitchTab(target.tab);
    },
    [onSwitchTab],
  );

  const toggleWindowMaximized = useCallback(
    (windowId: number) => {
      const current = windowsRef.current.find((windowState) => windowState.id === windowId);
      if (!current) {
        return;
      }
      if (current.maximized) {
        restoreWindow(windowId);
        return;
      }

      const bounds = getDesktopBounds(desktopRef.current);
      const nextZ = nextZRef.current++;

      setWindows((previous) =>
        previous.map((windowState) => {
          if (windowState.id !== windowId) {
            return windowState;
          }
          return {
            ...windowState,
            x: 0,
            y: 0,
            width: bounds.width,
            height: bounds.height,
            maximized: true,
            snapped: null,
            restoreRect: {
              x: windowState.x,
              y: windowState.y,
              width: windowState.width,
              height: windowState.height,
            },
            z: nextZ,
          };
        }),
      );
      setFocusedWindowId(windowId);
      onSwitchTab(current.tab);
    },
    [onSwitchTab, restoreWindow],
  );

  const snapWindow = useCallback(
    (windowId: number, zone: SnapZone) => {
      const target = windowsRef.current.find((windowState) => windowState.id === windowId);
      if (!target) {
        return;
      }
      const bounds = getDesktopBounds(desktopRef.current);
      const snappedRect = clampRectToBounds(getSnapRect(zone, bounds), bounds);
      const nextZ = nextZRef.current++;

      setWindows((previous) =>
        previous.map((windowState) => {
          if (windowState.id !== windowId) {
            return windowState;
          }

          const preserveRestoreRect =
            windowState.restoreRect ??
            ({
              x: windowState.x,
              y: windowState.y,
              width: windowState.width,
              height: windowState.height,
            } satisfies WindowRect);

          return {
            ...windowState,
            ...snappedRect,
            z: nextZ,
            maximized: zone === "top",
            snapped: zone === "top" ? null : zone,
            restoreRect: preserveRestoreRect,
          };
        }),
      );

      setFocusedWindowId(windowId);
      onSwitchTab(target.tab);
    },
    [onSwitchTab],
  );

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, windowId: number) => {
      if (event.button !== 0) {
        return;
      }
      const target = windowsRef.current.find((windowState) => windowState.id === windowId);
      if (!target || target.minimized || target.maximized) {
        return;
      }
      if ((event.target as HTMLElement).closest("[data-window-action]")) {
        return;
      }

      const bounds = getDesktopBounds(desktopRef.current);
      let startRect: WindowRect = {
        x: target.x,
        y: target.y,
        width: target.width,
        height: target.height,
      };

      if (target.snapped && target.restoreRect) {
        startRect = clampRectToBounds(target.restoreRect, bounds);
        setWindows((previous) =>
          previous.map((windowState) =>
            windowState.id === windowId
              ? {
                  ...windowState,
                  ...startRect,
                  snapped: null,
                  restoreRect: undefined,
                }
              : windowState,
          ),
        );
      }

      focusWindow(windowId);
      interactionRef.current = {
        type: "drag",
        windowId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startRect,
      };
      snapPreviewRef.current = null;
      setSnapPreview(null);
      document.body.classList.add("os-dragging");
      event.preventDefault();
    },
    [focusWindow],
  );

  const beginResize = useCallback(
    (
      event: ReactPointerEvent<HTMLDivElement>,
      windowId: number,
      edge: ResizeEdge,
    ) => {
      if (event.button !== 0) {
        return;
      }
      const target = windowsRef.current.find((windowState) => windowState.id === windowId);
      if (!target || target.minimized || target.maximized) {
        return;
      }

      focusWindow(windowId);
      interactionRef.current = {
        type: "resize",
        windowId,
        edge,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startRect: {
          x: target.x,
          y: target.y,
          width: target.width,
          height: target.height,
        },
      };
      snapPreviewRef.current = null;
      setSnapPreview(null);
      document.body.classList.add("os-dragging");
      event.preventDefault();
      event.stopPropagation();
    },
    [focusWindow],
  );

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction) {
        return;
      }

      const bounds = getDesktopBounds(desktopRef.current);
      const deltaX = event.clientX - interaction.startClientX;
      const deltaY = event.clientY - interaction.startClientY;

      if (interaction.type === "drag") {
        setWindows((previous) =>
          previous.map((windowState) => {
            if (windowState.id !== interaction.windowId) {
              return windowState;
            }

            const nextRect = clampRectToBounds(
              {
                ...interaction.startRect,
                x: interaction.startRect.x + deltaX,
                y: interaction.startRect.y + deltaY,
              },
              bounds,
            );

            return {
              ...windowState,
              x: nextRect.x,
              y: nextRect.y,
            };
          }),
        );

        const desktopClientBounds = getDesktopClientBounds(desktopRef.current);
        const snapZone = detectSnapZone(
          event.clientX,
          event.clientY,
          desktopClientBounds,
        );
        const nextPreview = snapZone
          ? {
              zone: snapZone,
              rect: clampRectToBounds(getSnapRect(snapZone, bounds), bounds),
            }
          : null;
        if (snapPreviewRef.current?.zone !== nextPreview?.zone) {
          snapPreviewRef.current = nextPreview;
          setSnapPreview(nextPreview);
        }
      } else {
        setWindows((previous) =>
          previous.map((windowState) => {
            if (windowState.id !== interaction.windowId) {
              return windowState;
            }

            const nextRect = resizeRect(
              interaction.startRect,
              interaction.edge,
              deltaX,
              deltaY,
              bounds,
            );
            return { ...windowState, ...nextRect };
          }),
        );
      }
    };

    const stopInteraction = () => {
      const interaction = interactionRef.current;
      if (!interaction) {
        return;
      }

      interactionRef.current = null;
      document.body.classList.remove("os-dragging");

      const preview = snapPreviewRef.current;
      snapPreviewRef.current = null;
      setSnapPreview(null);

      if (interaction.type === "drag" && preview) {
        snapWindow(interaction.windowId, preview.zone);
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopInteraction);
    window.addEventListener("pointercancel", stopInteraction);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopInteraction);
      window.removeEventListener("pointercancel", stopInteraction);
      document.body.classList.remove("os-dragging");
    };
  }, [snapWindow]);

  useEffect(() => {
    const onResize = () => {
      const bounds = getDesktopBounds(desktopRef.current);
      setWindows((previous) =>
        previous.map((windowState) => {
          if (windowState.maximized) {
            return {
              ...windowState,
              x: 0,
              y: 0,
              width: bounds.width,
              height: bounds.height,
            };
          }

          const nextRect = clampRectToBounds(windowState, bounds);
          return { ...windowState, ...nextRect };
        }),
      );
    };

    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    preloadTabView(tab);
    const existing = windowsRef.current
      .filter((windowState) => windowState.tab === tab)
      .sort((left, right) => right.z - left.z)[0];
    if (existing) {
      if (focusedWindowIdRef.current !== existing.id || existing.minimized) {
        focusWindow(existing.id, false);
      }
      return;
    }
    openWindow(tab, { syncTab: false });
  }, [focusWindow, openWindow, tab]);

  const commandActions = useMemo<CommandAction[]>(() => {
    const actions: CommandAction[] = [];

    for (const windowTab of launchTabs) {
      const tabLabel = TAB_LABELS[windowTab];
      const count = windowCountByTab[windowTab] ?? 0;
      actions.push({
        id: `focus-${windowTab}`,
        label: count ? `Focus ${tabLabel}` : `Open ${tabLabel}`,
        hint: count ? `${count} window${count > 1 ? "s" : ""} running` : "launch app",
        keywords: [windowTab, tabLabel, "focus", "open"],
        run: () => {
          openWindow(windowTab, { newWindow: false });
        },
      });
      actions.push({
        id: `new-${windowTab}`,
        label: `Open new ${tabLabel} window`,
        hint: "spawn parallel workspace",
        keywords: [windowTab, tabLabel, "new", "window", "duplicate"],
        run: () => {
          openWindow(windowTab, { newWindow: true });
        },
      });
    }

    if (focusedWindow) {
      actions.push({
        id: "close-focused",
        label: "Close focused window",
        hint: "Cmd/Ctrl + W",
        keywords: ["close", "window"],
        run: () => closeWindow(focusedWindow.id),
      });
      actions.push({
        id: "minimize-focused",
        label: "Minimize focused window",
        hint: "hide to dock",
        keywords: ["minimize", "hide", "window"],
        run: () => minimizeWindow(focusedWindow.id),
      });
      actions.push({
        id: focusedWindow.maximized ? "restore-focused" : "maximize-focused",
        label: focusedWindow.maximized
          ? "Restore focused window"
          : "Maximize focused window",
        hint: focusedWindow.maximized ? "return to previous size" : "fill desktop",
        keywords: ["maximize", "restore", "window"],
        run: () => {
          if (focusedWindow.maximized) {
            restoreWindow(focusedWindow.id);
            return;
          }
          toggleWindowMaximized(focusedWindow.id);
        },
      });
      actions.push({
        id: "snap-left-focused",
        label: "Snap focused window left",
        hint: "Shift + Left Arrow",
        keywords: ["snap", "left", "window"],
        run: () => snapWindow(focusedWindow.id, "left"),
      });
      actions.push({
        id: "snap-right-focused",
        label: "Snap focused window right",
        hint: "Shift + Right Arrow",
        keywords: ["snap", "right", "window"],
        run: () => snapWindow(focusedWindow.id, "right"),
      });
      actions.push({
        id: "snap-top-focused",
        label: "Snap focused window full screen",
        hint: "Shift + Up Arrow",
        keywords: ["snap", "maximize", "top", "window"],
        run: () => snapWindow(focusedWindow.id, "top"),
      });
    }

    actions.push({
      id: "toggle-theme",
      label: "Toggle theme",
      hint: "switch light/dark",
      keywords: ["theme", "dark", "light"],
      run: () => onToggleTheme(),
    });
    actions.push({
      id: "exit-os-mode",
      label: "Switch to classic view",
      hint: "disable OS shell",
      keywords: ["classic", "mode", "layout"],
      run: () => onExitOsMode(),
    });
    actions.push({
      id: "disconnect",
      label: "Disconnect gateway",
      hint: "close websocket session",
      keywords: ["disconnect", "gateway", "logout"],
      run: () => onDisconnect(),
    });

    return actions;
  }, [
    closeWindow,
    focusedWindow,
    launchTabs,
    minimizeWindow,
    onDisconnect,
    onExitOsMode,
    onToggleTheme,
    openWindow,
    restoreWindow,
    snapWindow,
    toggleWindowMaximized,
    windowCountByTab,
  ]);

  const filteredCommandActions = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (!query) {
      return commandActions;
    }
    return commandActions.filter((action) => {
      const corpus = [
        action.label,
        action.hint ?? "",
        ...(action.keywords ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return corpus.includes(query);
    });
  }, [commandActions, commandQuery]);

  const executeCommand = useCallback((action: CommandAction) => {
    action.run();
    setCommandOpen(false);
    setCommandQuery("");
    setSelectedCommandIndex(0);
  }, []);

  useEffect(() => {
    setSelectedCommandIndex(0);
  }, [commandQuery, commandOpen]);

  useEffect(() => {
    if (selectedCommandIndex < filteredCommandActions.length) {
      return;
    }
    setSelectedCommandIndex(Math.max(0, filteredCommandActions.length - 1));
  }, [filteredCommandActions.length, selectedCommandIndex]);

  useEffect(() => {
    if (!commandOpen) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      commandInputRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [commandOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const metaOrCtrl = event.metaKey || event.ctrlKey;
      const lowerKey = event.key.toLowerCase();

      if (metaOrCtrl && lowerKey === "k") {
        event.preventDefault();
        setCommandOpen(true);
        return;
      }

      if (commandOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setCommandOpen(false);
          setCommandQuery("");
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelectedCommandIndex((current) => {
            if (!filteredCommandActions.length) {
              return 0;
            }
            return (current + 1) % filteredCommandActions.length;
          });
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedCommandIndex((current) => {
            if (!filteredCommandActions.length) {
              return 0;
            }
            return (current - 1 + filteredCommandActions.length) % filteredCommandActions.length;
          });
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          if (!filteredCommandActions.length) {
            return;
          }
          executeCommand(
            filteredCommandActions[selectedCommandIndex] ?? filteredCommandActions[0],
          );
        }
        return;
      }

      if (metaOrCtrl && lowerKey === "w") {
        if (focusedWindowIdRef.current === null) {
          return;
        }
        event.preventDefault();
        closeWindow(focusedWindowIdRef.current);
        return;
      }

      if (isTypingTarget(event.target)) {
        return;
      }

      if (event.shiftKey && !metaOrCtrl && focusedWindowIdRef.current !== null) {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          snapWindow(focusedWindowIdRef.current, "left");
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          snapWindow(focusedWindowIdRef.current, "right");
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          snapWindow(focusedWindowIdRef.current, "top");
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    closeWindow,
    commandOpen,
    executeCommand,
    filteredCommandActions,
    selectedCommandIndex,
    snapWindow,
  ]);

  const onAppClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, windowTab: Tab) => {
      openWindow(windowTab, {
        newWindow: shouldOpenNewWindow(event),
      });
    },
    [openWindow],
  );

  return (
    <div className="os-shell" style={shellStyle}>
      <header className="os-menubar">
        <div className="os-menubar-brand">
          <span className="os-menubar-logo">⚡</span>
          <span className="os-menubar-title">GSV Control OS</span>
        </div>
        <div className="os-menubar-status">
          <Badge className="ui-badge-fix" variant={connectionBadgeVariant}>
            {connectionState}
          </Badge>
          <div className="os-menubar-telemetry">
            <span className="os-menubar-chip">
              {totalWindowCount} window{totalWindowCount === 1 ? "" : "s"}
            </span>
            <span className="os-menubar-chip">{focusedTabLabel}</span>
            <span className="os-menubar-chip mono">{clockLabel}</span>
          </div>
          <Button
            variant="secondary"
            className="ui-button-fix"
            size="sm"
            onClick={() => setCommandOpen(true)}
          >
            ⌘K
          </Button>
          <Button
            variant="secondary"
            className="ui-button-fix"
            size="sm"
            onClick={onExitOsMode}
          >
            Classic
          </Button>
          <Button
            variant="ghost"
            shape="square"
            aria-label="Toggle theme"
            title="Toggle theme"
            onClick={onToggleTheme}
          >
            {theme === "dark" ? "🌙" : "☀️"}
          </Button>
          <Button
            variant="secondary"
            className="ui-button-fix"
            size="sm"
            onClick={onDisconnect}
          >
            Disconnect
          </Button>
        </div>
      </header>

      <div className="os-workspace">
        <aside className="os-launchpad">
          {TAB_GROUPS.map((group) => (
            <section className="os-launch-group" key={group.label}>
              <h2 className="os-launch-group-label">{group.label}</h2>
              <div className="os-launch-grid">
                {group.tabs.map((windowTab) => {
                  const isOpen = openTabs.has(windowTab);
                  const isFocused = focusedTab === windowTab;
                  const count = windowCountByTab[windowTab] ?? 0;
                  return (
                    <button
                      key={windowTab}
                      type="button"
                      className={`os-launch-item ${isOpen ? "open" : ""} ${
                        isFocused ? "focused" : ""
                      }`}
                      style={
                        {
                          "--os-item-accent": TAB_ACCENTS[windowTab],
                        } as CSSProperties
                      }
                      onClick={(event) => onAppClick(event, windowTab)}
                      onMouseEnter={() => preloadTabView(windowTab)}
                      onFocus={() => preloadTabView(windowTab)}
                    >
                      <span className="os-launch-icon">{TAB_ICONS[windowTab]}</span>
                      <span className="os-launch-label">{TAB_LABELS[windowTab]}</span>
                      {count > 1 ? <span className="os-launch-count">{count}</span> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          <p className="os-launch-hint">
            Tip: hold <kbd>Shift</kbd>/<kbd>Alt</kbd>/<kbd>Cmd</kbd> while opening an app to spawn another window.
          </p>
        </aside>

        <main className="os-desktop" ref={desktopRef}>
          {snapPreview ? (
            <div
              className={`os-snap-preview ${snapPreview.zone}`}
              style={{
                transform: `translate(${snapPreview.rect.x}px, ${snapPreview.rect.y}px)`,
                width: `${snapPreview.rect.width}px`,
                height: `${snapPreview.rect.height}px`,
              }}
            />
          ) : null}

          <aside className="os-status-rail">
            <section className="os-status-card">
              <p className="os-status-title">System Pulse</p>
              <div className="os-status-grid">
                <span>Link</span>
                <strong>{connectionStateLabel}</strong>
                <span>Active</span>
                <strong>{focusedTabLabel}</strong>
                <span>Visible</span>
                <strong>{visibleWindowCount}</strong>
                <span>Theme</span>
                <strong>{theme}</strong>
              </div>
            </section>
            <section className="os-status-card">
              <p className="os-status-title">Quick Keys</p>
              <p className="os-status-shortcut">
                <kbd>⌘K</kbd> palette
              </p>
              <p className="os-status-shortcut">
                <kbd>⇧</kbd> + <kbd>←</kbd>/<kbd>→</kbd>/<kbd>↑</kbd> snap
              </p>
            </section>
          </aside>

          {visibleWindows.map((windowState) => (
            <section
              key={windowState.id}
              className={`os-window ${
                focusedWindowId === windowState.id ? "focused" : ""
              } ${windowState.maximized ? "maximized" : ""}`}
              style={
                {
                  "--os-tab-accent": TAB_ACCENTS[windowState.tab],
                  transform: `translate(${windowState.x}px, ${windowState.y}px)`,
                  width: `${windowState.width}px`,
                  height: `${windowState.height}px`,
                  zIndex: windowState.z,
                } as CSSProperties
              }
              onMouseDown={() => focusWindow(windowState.id)}
            >
              <div
                className="os-window-titlebar"
                onPointerDown={(event) => beginDrag(event, windowState.id)}
              >
                <div className="os-window-actions">
                  <button
                    type="button"
                    className="os-window-action close"
                    data-window-action
                    aria-label={`Close ${TAB_LABELS[windowState.tab]}`}
                    onClick={() => closeWindow(windowState.id)}
                  />
                  <button
                    type="button"
                    className="os-window-action minimize"
                    data-window-action
                    aria-label={`Minimize ${TAB_LABELS[windowState.tab]}`}
                    onClick={() => minimizeWindow(windowState.id)}
                  />
                  <button
                    type="button"
                    className="os-window-action maximize"
                    data-window-action
                    aria-label={`Toggle maximize ${TAB_LABELS[windowState.tab]}`}
                    onClick={() => toggleWindowMaximized(windowState.id)}
                  />
                </div>
                <div className="os-window-title">
                  <span className="os-window-title-icon">{TAB_ICONS[windowState.tab]}</span>
                  <span className="os-window-title-label">{TAB_LABELS[windowState.tab]}</span>
                </div>
                <button
                  type="button"
                  className="os-window-clone"
                  data-window-action
                  onClick={() => openWindow(windowState.tab, { newWindow: true })}
                >
                  + window
                </button>
              </div>

              <div className="os-window-content">
                <TabView tab={windowState.tab} />
              </div>

              {!windowState.maximized
                ? RESIZE_HANDLES.map((handle) => (
                    <div
                      key={handle.edge}
                      className={handle.className}
                      onPointerDown={(event) =>
                        beginResize(event, windowState.id, handle.edge)
                      }
                    />
                  ))
                : null}
            </section>
          ))}

          {!visibleWindows.length ? (
            <div className="os-desktop-empty">
              <p>All windows minimized</p>
              <span>Select an app from the dock to continue.</span>
            </div>
          ) : null}
        </main>
      </div>

      <footer className="os-dock">
        {launchTabs.map((windowTab) => {
          const isOpen = openTabs.has(windowTab);
          const isFocused = focusedTab === windowTab;
          const count = windowCountByTab[windowTab] ?? 0;
          return (
            <button
              key={windowTab}
              type="button"
              className={`os-dock-item ${isOpen ? "open" : ""} ${
                isFocused ? "focused" : ""
              }`}
              style={
                {
                  "--os-item-accent": TAB_ACCENTS[windowTab],
                } as CSSProperties
              }
              onClick={(event) => onAppClick(event, windowTab)}
              onMouseEnter={() => preloadTabView(windowTab)}
              onFocus={() => preloadTabView(windowTab)}
            >
              <span className="os-dock-item-icon">{TAB_ICONS[windowTab]}</span>
              <span className="os-dock-item-label">{TAB_LABELS[windowTab]}</span>
              {count > 1 ? <span className="os-dock-item-count">{count}</span> : null}
              <span className="os-dock-indicator" />
            </button>
          );
        })}
      </footer>

      {commandOpen ? (
        <div
          className="os-command-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setCommandOpen(false);
              setCommandQuery("");
            }
          }}
        >
          <div className="os-command-palette" role="dialog" aria-modal="true">
            <div className="os-command-header">
              <p>Command Palette</p>
              <span>
                {filteredCommandActions.length} action
                {filteredCommandActions.length === 1 ? "" : "s"} · ⌘K
              </span>
            </div>
            <input
              ref={commandInputRef}
              className="os-command-input"
              value={commandQuery}
              onChange={(event) => setCommandQuery(event.target.value)}
              placeholder="Open app, snap window, switch mode..."
            />
            <div className="os-command-results">
              {filteredCommandActions.length ? (
                filteredCommandActions.map((action, index) => (
                  <button
                    key={action.id}
                    type="button"
                    className={`os-command-item ${
                      index === selectedCommandIndex ? "active" : ""
                    }`}
                    onMouseEnter={() => setSelectedCommandIndex(index)}
                    onClick={() => executeCommand(action)}
                  >
                    <span className="os-command-item-label">{action.label}</span>
                    {action.hint ? (
                      <span className="os-command-item-hint">{action.hint}</span>
                    ) : null}
                  </button>
                ))
              ) : (
                <div className="os-command-empty">No command matches “{commandQuery}”.</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
