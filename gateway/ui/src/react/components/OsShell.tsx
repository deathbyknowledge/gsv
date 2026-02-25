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
import { TAB_ICONS, TAB_LABELS, OS_DOCK_TABS, TAB_GROUPS, type Tab, type Surface } from "../../ui/types";
import type { Wallpaper } from "../../ui/storage";
import { preloadTabView, TabView } from "../tabViews";
import { WallpaperBg } from "./Wallpaper";
import { useReactUiStore } from "../state/store";

const WINDOW_MIN_WIDTH = 420;
const WINDOW_MIN_HEIGHT = 280;
const WINDOW_MARGIN = 12;
const SNAP_THRESHOLD = 28;
const CLOCK_REFRESH_MS = 15_000;

/**
 * Normalize a URL to its embeddable form for known services.
 * Returns the embed URL if a transformation applies, or the original URL otherwise.
 */
function toEmbedUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "");

    // YouTube: watch?v=ID → /embed/ID, youtu.be/ID → /embed/ID, shorts/ID → /embed/ID
    if (host === "youtube.com" || host === "m.youtube.com") {
      const videoId = u.searchParams.get("v");
      if (videoId) return `https://www.youtube.com/embed/${videoId}?autoplay=1`;
      const shortsMatch = u.pathname.match(/^\/shorts\/([^/?]+)/);
      if (shortsMatch) return `https://www.youtube.com/embed/${shortsMatch[1]}?autoplay=1`;
      if (u.pathname.startsWith("/embed/")) {
        u.searchParams.set("autoplay", "1");
        return u.toString();
      }
    }
    if (host === "youtu.be") {
      const videoId = u.pathname.slice(1).split("/")[0];
      if (videoId) return `https://www.youtube.com/embed/${videoId}?autoplay=1`;
    }

    // Vimeo: vimeo.com/ID → player.vimeo.com/video/ID
    if (host === "vimeo.com") {
      const videoId = u.pathname.match(/^\/(\d+)/)?.[1];
      if (videoId) return `https://player.vimeo.com/video/${videoId}?autoplay=1`;
    }
    if (host === "player.vimeo.com") {
      u.searchParams.set("autoplay", "1");
      return u.toString();
    }

    // Spotify: open.spotify.com/track/ID → open.spotify.com/embed/track/ID (etc.)
    if (host === "open.spotify.com" && !u.pathname.startsWith("/embed/")) {
      return `https://open.spotify.com/embed${u.pathname}`;
    }

    // Google Maps: /maps/... → /maps/embed/...
    if (host === "google.com" && u.pathname.startsWith("/maps") && !u.pathname.includes("/embed")) {
      return `https://www.google.com/maps/embed/v1/place?key=&q=${encodeURIComponent(raw)}`;
    }

    // Figma: figma.com/file/... or figma.com/design/... → embed
    if (host === "figma.com" && (u.pathname.startsWith("/file/") || u.pathname.startsWith("/design/"))) {
      return `https://www.figma.com/embed?embed_host=gsv&url=${encodeURIComponent(raw)}`;
    }

    // Loom: loom.com/share/ID → loom.com/embed/ID
    if (host === "loom.com" || host === "www.loom.com") {
      const shareMatch = u.pathname.match(/^\/share\/([^/?]+)/);
      if (shareMatch) return `https://www.loom.com/embed/${shareMatch[1]}?autoplay=1`;
    }

    return raw;
  } catch {
    return raw;
  }
}

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
  settings: "hsl(220 60% 65%)",
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
  surfaceId?: string;
  /** URL for webview/media surfaces (renders as iframe instead of TabView). */
  url?: string;
  /** Custom title label for webview/media windows. */
  surfaceLabel?: string;
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
  wallpaper: Wallpaper;
  onToggleTheme: () => void;
  onChangeWallpaper: (wallpaper: Wallpaper) => void;
  onDisconnect: () => void;
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
  wallpaper,
  onToggleTheme,
  onChangeWallpaper,
  onDisconnect,
}: OsShellProps) {
  // ── Surface protocol integration ──
  const storeSurfaces = useReactUiStore((s) => s.surfaces);
  const storeSurfaceOpen = useReactUiStore((s) => s.surfaceOpen);
  const storeSurfaceClose = useReactUiStore((s) => s.surfaceClose);
  const storeSurfaceUpdate = useReactUiStore((s) => s.surfaceUpdate);
  const storeSurfaceFocus = useReactUiStore((s) => s.surfaceFocus);

  const desktopRef = useRef<HTMLDivElement | null>(null);
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const interactionRef = useRef<InteractionState | null>(null);
  const windowsRef = useRef<OsWindow[]>([]);
  const snapPreviewRef = useRef<SnapPreviewState | null>(null);
  const focusedWindowIdRef = useRef<number | null>(1);
  const nextWindowIdRef = useRef(2);
  const nextZRef = useRef(2);
  // Track which surfaceIds this client owns (locally opened), to avoid echo loops.
  const ownedSurfaceIdsRef = useRef<Set<string>>(new Set());
  // Track window IDs that have a surfaceOpen RPC in flight (surfaceId not yet known).
  // Maps windowId → contentRef (tab name) so reconciliation can match pending opens.
  const pendingSurfaceOpensRef = useRef<Map<number, string>>(new Map());
  // Stable refs for surface actions (avoid callback dependency churn).
  const surfaceOpenRef = useRef(storeSurfaceOpen);
  surfaceOpenRef.current = storeSurfaceOpen;
  const surfaceCloseRef = useRef(storeSurfaceClose);
  surfaceCloseRef.current = storeSurfaceClose;
  const surfaceUpdateRef = useRef(storeSurfaceUpdate);
  surfaceUpdateRef.current = storeSurfaceUpdate;
  const surfaceFocusRef = useRef(storeSurfaceFocus);
  surfaceFocusRef.current = storeSurfaceFocus;

  const [windows, setWindows] = useState<OsWindow[]>(() => {
    const bounds = getDesktopBounds(null);
    // Mark the initial window as pending so reconciliation doesn't duplicate it.
    pendingSurfaceOpensRef.current.set(1, tab);
    return [createWindow(tab, 1, 1, 0, bounds)];
  });
  const [focusedWindowId, setFocusedWindowId] = useState<number | null>(1);
  const [snapPreview, setSnapPreview] = useState<SnapPreviewState | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [clockLabel, setClockLabel] = useState(() => formatClock(new Date()));

  const launchTabs = OS_DOCK_TABS;
  const allTabs = useMemo(() => TAB_GROUPS.flatMap((group) => group.tabs), []);
  /** Windows backed by a gateway surface URL (webview/media) — not tied to a Tab. */
  const surfaceWindows = useMemo(
    () => windows.filter((windowState) => windowState.url),
    [windows],
  );
  const openTabs = useMemo(
    () => new Set(windows.filter((w) => !w.url).map((w) => w.tab)),
    [windows],
  );
  // Do NOT sort by z-index here — sorting reorders the array on every focus
  // change, causing React to physically move DOM nodes (reloads iframes,
  // resets scroll). CSS z-index (set via inline style) handles stacking.
  const visibleWindows = useMemo(
    () => windows.filter((windowState) => !windowState.minimized),
    [windows],
  );
  const focusedWindow = useMemo(
    () =>
      focusedWindowId === null
        ? null
        : windows.find((windowState) => windowState.id === focusedWindowId) ?? null,
    [focusedWindowId, windows],
  );
  const focusedIsUrl = focusedWindow?.url != null;
  const focusedTab = focusedIsUrl ? null : (focusedWindow?.tab ?? null);
  const focusedTabLabel = focusedIsUrl
    ? (focusedWindow?.surfaceLabel ?? "Webview")
    : focusedTab
      ? TAB_LABELS[focusedTab]
      : "No focus";
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
      if (!windowState.url) {
        counts[windowState.tab] = (counts[windowState.tab] ?? 0) + 1;
      }
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

  // Register the initial window (id=1) with the gateway surface registry.
  // This runs once on mount. The pending marker was set synchronously in useState.
  useEffect(() => {
    const initialWindow = windowsRef.current.find((w) => w.id === 1);
    if (!initialWindow) return;
    void surfaceOpenRef.current({
      kind: "app",
      contentRef: initialWindow.tab,
      label: TAB_LABELS[initialWindow.tab],
      rect: { x: initialWindow.x, y: initialWindow.y, width: initialWindow.width, height: initialWindow.height },
    }).then((surface) => {
      pendingSurfaceOpensRef.current.delete(1);
      if (surface) {
        ownedSurfaceIdsRef.current.add(surface.surfaceId);
        setWindows((prev) =>
          prev.map((w) =>
            w.id === 1 ? { ...w, surfaceId: surface.surfaceId } : w,
          ),
        );
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /** Fire-and-forget: sync a window's state to the gateway surface registry. */
  const syncSurfaceState = useCallback(
    (win: OsWindow) => {
      if (!win.surfaceId) return;
      void surfaceUpdateRef.current({
        surfaceId: win.surfaceId,
        state: win.minimized ? "minimized" : "open",
        rect: { x: win.x, y: win.y, width: win.width, height: win.height },
        zIndex: win.z,
      });
    },
    [],
  );

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
      // Surface sync: focus
      if (target.surfaceId) {
        void surfaceFocusRef.current(target.surfaceId);
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

      // Surface sync: register this window with the gateway.
      // Mark as pending SYNCHRONOUSLY so reconciliation skips duplicates
      // even if the surfaceOpen RPC resolves before the .then() patches the window.
      pendingSurfaceOpensRef.current.set(windowId, windowTab);
      void surfaceOpenRef.current({
        kind: "app",
        contentRef: windowTab,
        label: TAB_LABELS[windowTab],
        rect: { x: windowState.x, y: windowState.y, width: windowState.width, height: windowState.height },
      }).then((surface) => {
        pendingSurfaceOpensRef.current.delete(windowId);
        if (surface) {
          ownedSurfaceIdsRef.current.add(surface.surfaceId);
          // Patch the window with its surfaceId
          setWindows((prev) =>
            prev.map((w) =>
              w.id === windowId ? { ...w, surfaceId: surface.surfaceId } : w,
            ),
          );
        }
      });

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

      // Surface sync: close
      if (target.surfaceId) {
        ownedSurfaceIdsRef.current.delete(target.surfaceId);
        void surfaceCloseRef.current(target.surfaceId);
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

      // Surface sync: minimized
      if (target.surfaceId) {
        void surfaceUpdateRef.current({
          surfaceId: target.surfaceId,
          state: "minimized",
        });
      }

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

      // Surface sync: restored rect
      if (target.surfaceId) {
        void surfaceUpdateRef.current({
          surfaceId: target.surfaceId,
          state: "open",
          rect: restored,
          zIndex: nextZ,
        });
      }
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

      // Surface sync: maximized rect
      if (current.surfaceId) {
        void surfaceUpdateRef.current({
          surfaceId: current.surfaceId,
          state: "open",
          rect: { x: 0, y: 0, width: bounds.width, height: bounds.height },
          zIndex: nextZ,
        });
      }
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

      // Surface sync: snapped rect
      if (target.surfaceId) {
        void surfaceUpdateRef.current({
          surfaceId: target.surfaceId,
          state: "open",
          rect: snappedRect,
          zIndex: nextZ,
        });
      }
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
        // snapWindow handles its own surface sync
      } else {
        // Drag without snap, or resize: sync the settled rect
        const settled = windowsRef.current.find(
          (w) => w.id === interaction.windowId,
        );
        if (settled?.surfaceId) {
          void surfaceUpdateRef.current({
            surfaceId: settled.surfaceId,
            rect: { x: settled.x, y: settled.y, width: settled.width, height: settled.height },
            zIndex: settled.z,
          });
        }
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

  // ── A3: Inbound surface reconciliation ──
  // When surfaces arrive from other clients or agents, create/destroy local windows.
  useEffect(() => {
    const currentWindows = windowsRef.current;
    const localSurfaceIds = new Set(
      currentWindows
        .filter((w) => w.surfaceId)
        .map((w) => w.surfaceId as string),
    );
    const remoteSurfaceIds = new Set(Object.keys(storeSurfaces));

    // 1. Surfaces that were removed externally → close matching local windows
    for (const win of currentWindows) {
      if (win.surfaceId && !remoteSurfaceIds.has(win.surfaceId)) {
        // Only auto-close if we didn't locally initiate the close (owned check)
        if (!ownedSurfaceIdsRef.current.has(win.surfaceId)) {
          setWindows((prev) => prev.filter((w) => w.id !== win.id));
        }
      }
    }

    // 2. New surfaces that we don't have a local window for → create one
    const pendingContentRefs = new Set(pendingSurfaceOpensRef.current.values());
    for (const [surfaceId, surface] of Object.entries(storeSurfaces)) {
      if (localSurfaceIds.has(surfaceId)) continue;
      if (ownedSurfaceIdsRef.current.has(surfaceId)) continue; // we opened it, patch is in flight
      if (surface.state === "closed") continue;
      // Skip app surfaces that match a window with a pending surfaceOpen RPC.
      // This prevents the race where the store gets the surface before the
      // .then() callback patches the window's surfaceId.
      if (surface.kind === "app" && pendingContentRefs.has(surface.contentRef)) continue;

      const bounds = getDesktopBounds(desktopRef.current);
      const windowId = nextWindowIdRef.current++;
      const nextZ = nextZRef.current++;

      const rect: WindowRect = surface.rect
        ? clampRectToBounds(surface.rect, bounds)
        : clampRectToBounds(
            {
              x: 36 + (windowId % 7) * 24,
              y: 34 + (windowId % 7) * 18,
              width: Math.round(bounds.width * 0.68),
              height: Math.round(bounds.height * 0.74),
            },
            bounds,
          );

      if (surface.kind === "app") {
        // App surfaces map to a built-in tab
        const surfaceTab = surface.contentRef as Tab;
        if (!TAB_LABELS[surfaceTab]) continue; // invalid tab
        preloadTabView(surfaceTab);

        setWindows((prev) => [
          ...prev,
          {
            id: windowId,
            tab: surfaceTab,
            z: surface.zIndex ?? nextZ,
            minimized: surface.state === "minimized",
            maximized: false,
            snapped: null,
            surfaceId,
            ...rect,
          },
        ]);
      } else if (surface.kind === "webview" || surface.kind === "media") {
        // Webview/media surfaces render as iframe windows
        setWindows((prev) => [
          ...prev,
          {
            id: windowId,
            tab: "chat" as Tab, // fallback tab (unused for rendering, needed for type)
            z: surface.zIndex ?? nextZ,
            minimized: surface.state === "minimized",
            maximized: false,
            snapped: null,
            surfaceId,
            url: toEmbedUrl(surface.contentRef),
            surfaceLabel: surface.label,
            ...rect,
          },
        ]);
      }
    }

    // 3. Surface state updates (minimized/open) from remote
    for (const win of currentWindows) {
      if (!win.surfaceId) continue;
      if (ownedSurfaceIdsRef.current.has(win.surfaceId)) continue;
      const surface = storeSurfaces[win.surfaceId];
      if (!surface) continue;

      const shouldBeMinimized = surface.state === "minimized";
      if (win.minimized !== shouldBeMinimized) {
        setWindows((prev) =>
          prev.map((w) =>
            w.id === win.id ? { ...w, minimized: shouldBeMinimized } : w,
          ),
        );
      }
    }
  }, [storeSurfaces]);

  const commandActions = useMemo<CommandAction[]>(() => {
    const actions: CommandAction[] = [];

    for (const windowTab of allTabs.concat(launchTabs.filter(t => !allTabs.includes(t)))) {
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
      {/* ── Wallpaper Background ── */}
      <WallpaperBg wallpaper={wallpaper} onChangeWallpaper={onChangeWallpaper} />

      {/* ── Status Bar (minimal, macOS-style) ── */}
      <header className="os-statusbar">
        <div className="os-statusbar-left">
          <span className="os-statusbar-brand">GSV</span>
          <span className={`os-statusbar-dot ${connectionState}`} />
          <span className="os-statusbar-label">{connectionStateLabel}</span>
        </div>
        <div className="os-statusbar-right">
          <button
            type="button"
            className="os-statusbar-btn"
            onClick={onDisconnect}
            title="Disconnect"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
          </button>
          <span className="os-statusbar-clock">{clockLabel}</span>
        </div>
      </header>

      {/* ── Desktop (full canvas for windows) ── */}
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

        {visibleWindows.map((windowState) => {
          const isUrlWindow = Boolean(windowState.url);
          const windowTitle = isUrlWindow
            ? (windowState.surfaceLabel ?? "Webview")
            : TAB_LABELS[windowState.tab];
          const accentColor = isUrlWindow
            ? "hsl(260 70% 62%)"
            : TAB_ACCENTS[windowState.tab];

          return (
            <section
              key={windowState.id}
              className={`os-window ${
                focusedWindowId === windowState.id ? "focused" : ""
              } ${windowState.maximized ? "maximized" : ""}`}
              style={
                {
                  "--os-tab-accent": accentColor,
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
                onDoubleClick={() => toggleWindowMaximized(windowState.id)}
              >
                <div className="os-window-actions">
                  <button
                    type="button"
                    className="os-window-action close"
                    data-window-action
                    aria-label={`Close ${windowTitle}`}
                    onClick={() => closeWindow(windowState.id)}
                  />
                  <button
                    type="button"
                    className="os-window-action minimize"
                    data-window-action
                    aria-label={`Minimize ${windowTitle}`}
                    onClick={() => minimizeWindow(windowState.id)}
                  />
                  <button
                    type="button"
                    className="os-window-action maximize"
                    data-window-action
                    aria-label={`Toggle maximize ${windowTitle}`}
                    onClick={() => toggleWindowMaximized(windowState.id)}
                  />
                </div>
                <div className="os-window-title">
                  <span className="os-window-title-label">{windowTitle}</span>
                </div>
              </div>

              <div className="os-window-content">
                {isUrlWindow ? (
                  <div className="os-window-iframe-wrap">
                    <iframe
                      src={windowState.url}
                      title={windowTitle}
                      className="os-window-iframe"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
                      allow="autoplay; fullscreen; picture-in-picture"
                    />
                    <div className="os-window-iframe-fallback">
                      <span>{windowTitle}</span>
                      <a href={windowState.url} target="_blank" rel="noopener noreferrer">
                        Open externally
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                      </a>
                    </div>
                  </div>
                ) : (
                  <TabView tab={windowState.tab} />
                )}
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
          );
        })}

        {!visibleWindows.length ? (
          <div className="os-desktop-empty">
            <p>No open windows</p>
            <span>Click an app in the dock below, or press <kbd>⌘K</kbd></span>
          </div>
        ) : null}
      </main>

      {/* ── Dock (centered floating pill, icon-only) ── */}
      <div className="os-dock-container">
        <div className="os-dock">
          {launchTabs.map((windowTab) => {
            const isOpen = openTabs.has(windowTab);
            const isFocused = focusedTab === windowTab;
            return (
              <button
                key={windowTab}
                type="button"
                className={`os-dock-item ${isOpen ? "open" : ""} ${
                  isFocused ? "focused" : ""
                }`}
                onClick={(event) => onAppClick(event, windowTab)}
                onMouseEnter={() => preloadTabView(windowTab)}
                onFocus={() => preloadTabView(windowTab)}
                title={TAB_LABELS[windowTab]}
              >
                <span className="os-dock-item-icon" dangerouslySetInnerHTML={{ __html: TAB_ICONS[windowTab] }} />
              </button>
            );
          })}

          {/* ── Dynamic surface windows (webview/media) ── */}
          {surfaceWindows.length > 0 ? (
            <>
              <div className="os-dock-separator" />
              {surfaceWindows.map((sw) => {
                const isFocused = focusedWindowId === sw.id;
                return (
                  <button
                    key={`surface-${sw.id}`}
                    type="button"
                    className={`os-dock-item open ${isFocused ? "focused" : ""}`}
                    onClick={() => {
                      if (sw.minimized) {
                        setWindows((prev) =>
                          prev.map((w) =>
                            w.id === sw.id ? { ...w, minimized: false } : w,
                          ),
                        );
                      }
                      focusWindow(sw.id);
                    }}
                    title={sw.surfaceLabel ?? "Webview"}
                  >
                    <span className="os-dock-item-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                    </span>
                  </button>
                );
              })}
            </>
          ) : null}
        </div>
      </div>

      {/* ── Launcher / Command Palette ── */}
      {commandOpen ? (
        <div
          className="os-launcher-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setCommandOpen(false);
              setCommandQuery("");
            }
          }}
        >
          <div className="os-launcher" role="dialog" aria-modal="true">
            <div className="os-launcher-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input
                ref={commandInputRef}
                value={commandQuery}
                onChange={(event) => setCommandQuery(event.target.value)}
                placeholder="Search apps and commands..."
              />
            </div>
            <div className="os-launcher-results">
              {filteredCommandActions.length ? (
                filteredCommandActions.map((action, index) => (
                  <button
                    key={action.id}
                    type="button"
                    className={`os-launcher-item ${
                      index === selectedCommandIndex ? "active" : ""
                    }`}
                    onMouseEnter={() => setSelectedCommandIndex(index)}
                    onClick={() => executeCommand(action)}
                  >
                    <span className="os-launcher-item-label">{action.label}</span>
                    {action.hint ? (
                      <span className="os-launcher-item-hint">{action.hint}</span>
                    ) : null}
                  </button>
                ))
              ) : (
                <div className="os-launcher-empty">No results for "{commandQuery}"</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
