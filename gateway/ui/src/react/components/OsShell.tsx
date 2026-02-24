import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { TAB_GROUPS, TAB_ICONS, TAB_LABELS, type Tab } from "../../ui/types";
import { preloadTabView, TabView } from "../tabViews";

const WINDOW_MIN_WIDTH = 420;
const WINDOW_MIN_HEIGHT = 280;
const WINDOW_MARGIN = 12;

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
  restoreRect?: WindowRect;
};

type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

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
    x: 36 + (index % 6) * 24,
    y: 34 + (index % 6) * 18,
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
  const interactionRef = useRef<InteractionState | null>(null);
  const windowsRef = useRef<OsWindow[]>([]);
  const focusedWindowIdRef = useRef<number | null>(1);
  const nextWindowIdRef = useRef(2);
  const nextZRef = useRef(2);

  const [windows, setWindows] = useState<OsWindow[]>(() => {
    const bounds = getDesktopBounds(null);
    return [createWindow(tab, 1, 1, 0, bounds)];
  });
  const [focusedWindowId, setFocusedWindowId] = useState<number | null>(1);

  const launchTabs = useMemo(() => TAB_GROUPS.flatMap((group) => group.tabs), []);
  const openTabs = useMemo(() => new Set(windows.map((windowState) => windowState.tab)), [windows]);
  const visibleWindows = useMemo(
    () =>
      windows
        .filter((windowState) => !windowState.minimized)
        .sort((left, right) => left.z - right.z),
    [windows],
  );
  const focusedTab = useMemo(
    () => windows.find((windowState) => windowState.id === focusedWindowId)?.tab ?? null,
    [focusedWindowId, windows],
  );

  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  useEffect(() => {
    focusedWindowIdRef.current = focusedWindowId;
  }, [focusedWindowId]);

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
    (windowTab: Tab, syncTab = true) => {
      preloadTabView(windowTab);
      const existing = windowsRef.current.find(
        (windowState) => windowState.tab === windowTab,
      );
      if (existing) {
        focusWindow(existing.id, syncTab);
        return;
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
            ? { ...windowState, minimized: true }
            : windowState,
        ),
      );

      if (focusedWindowIdRef.current !== windowId) {
        return;
      }

      const nextVisible = currentWindows
        .filter(
          (windowState) =>
            windowState.id !== windowId && !windowState.minimized,
        )
        .sort((left, right) => right.z - left.z);
      if (!nextVisible.length) {
        setFocusedWindowId(null);
        return;
      }
      focusWindow(nextVisible[0].id);
    },
    [focusWindow],
  );

  const toggleWindowMaximized = useCallback(
    (windowId: number) => {
      const current = windowsRef.current.find((windowState) => windowState.id === windowId);
      if (!current) {
        return;
      }
      const bounds = getDesktopBounds(desktopRef.current);
      const nextZ = nextZRef.current++;
      setWindows((previous) =>
        previous.map((windowState) => {
          if (windowState.id !== windowId) {
            return windowState;
          }
          if (windowState.maximized) {
            const restored = clampRectToBounds(
              windowState.restoreRect ?? windowState,
              bounds,
            );
            return {
              ...windowState,
              ...restored,
              maximized: false,
              restoreRect: undefined,
              z: nextZ,
            };
          }
          return {
            ...windowState,
            x: 0,
            y: 0,
            width: bounds.width,
            height: bounds.height,
            maximized: true,
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

      focusWindow(windowId);
      interactionRef.current = {
        type: "drag",
        windowId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startRect: {
          x: target.x,
          y: target.y,
          width: target.width,
          height: target.height,
        },
      };
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

      setWindows((previous) =>
        previous.map((windowState) => {
          if (windowState.id !== interaction.windowId) {
            return windowState;
          }

          if (interaction.type === "drag") {
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
    };

    const stopInteraction = () => {
      if (!interactionRef.current) {
        return;
      }
      interactionRef.current = null;
      document.body.classList.remove("os-dragging");
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
  }, []);

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
    const existing = windowsRef.current.find((windowState) => windowState.tab === tab);
    if (existing) {
      if (focusedWindowIdRef.current !== existing.id || existing.minimized) {
        focusWindow(existing.id, false);
      }
      return;
    }
    openWindow(tab, false);
  }, [focusWindow, openWindow, tab]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }
      if (event.key.toLowerCase() !== "w") {
        return;
      }
      if (focusedWindowIdRef.current === null) {
        return;
      }
      event.preventDefault();
      closeWindow(focusedWindowIdRef.current);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeWindow]);

  return (
    <div className="os-shell">
      <header className="os-menubar">
        <div className="os-menubar-brand">
          <span className="os-menubar-logo">⚡</span>
          <span className="os-menubar-title">GSV Control OS</span>
        </div>
        <div className="os-menubar-status">
          <Badge className="ui-badge-fix" variant={connectionBadgeVariant}>
            {connectionState}
          </Badge>
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
                  return (
                    <button
                      key={windowTab}
                      type="button"
                      className={`os-launch-item ${isOpen ? "open" : ""} ${
                        isFocused ? "focused" : ""
                      }`}
                      onClick={() => openWindow(windowTab)}
                      onMouseEnter={() => preloadTabView(windowTab)}
                      onFocus={() => preloadTabView(windowTab)}
                    >
                      <span className="os-launch-icon">{TAB_ICONS[windowTab]}</span>
                      <span className="os-launch-label">{TAB_LABELS[windowTab]}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </aside>

        <main className="os-desktop" ref={desktopRef}>
          {visibleWindows.map((windowState) => (
            <section
              key={windowState.id}
              className={`os-window ${
                focusedWindowId === windowState.id ? "focused" : ""
              } ${windowState.maximized ? "maximized" : ""}`}
              style={{
                transform: `translate(${windowState.x}px, ${windowState.y}px)`,
                width: `${windowState.width}px`,
                height: `${windowState.height}px`,
                zIndex: windowState.z,
              }}
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
          return (
            <button
              key={windowTab}
              type="button"
              className={`os-dock-item ${isOpen ? "open" : ""} ${
                isFocused ? "focused" : ""
              }`}
              onClick={() => openWindow(windowTab)}
              onMouseEnter={() => preloadTabView(windowTab)}
              onFocus={() => preloadTabView(windowTab)}
            >
              <span className="os-dock-item-icon">{TAB_ICONS[windowTab]}</span>
              <span className="os-dock-item-label">{TAB_LABELS[windowTab]}</span>
              <span className="os-dock-indicator" />
            </button>
          );
        })}
      </footer>
    </div>
  );
}
