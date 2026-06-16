import type { DesktopVisibleWindowMode, DesktopWindowMode } from "./windowLayout";

export type DesktopWindowStateRecord = {
  windowId: string;
  title: string;
  badge: string | null;
  dirty: boolean;
  mode: DesktopWindowMode;
  lastVisibleMode: DesktopVisibleWindowMode;
  x: number;
  y: number;
  width: number;
  height: number;
  restoreX: number;
  restoreY: number;
  restoreWidth: number;
  restoreHeight: number;
  zIndex: number;
};

export type DesktopWindowState = {
  activeWindowId: string | null;
  zCounter: number;
  windows: DesktopWindowStateRecord[];
};

export type DesktopWindowSnapTarget = "left" | "right" | "maximize";

export type DesktopWindowStateAction =
  | { type: "focus"; windowId: string }
  | { type: "close"; windowId: string }
  | { type: "maximize"; windowId: string }
  | { type: "minimize"; windowId: string }
  | { type: "restore"; windowId: string }
  | {
    type: "snap";
    windowId: string;
    target: DesktopWindowSnapTarget;
    workspaceWidth: number;
    workspaceHeight: number;
  }
  | { type: "cycle"; direction: 1 | -1 }
  | {
    type: "set-chrome";
    windowId: string;
    title?: string;
    badge?: string | null;
    dirty?: boolean;
  };

function visibleTopWindowId(windows: readonly DesktopWindowStateRecord[]): string | null {
  return windows
    .filter((record) => record.mode !== "minimized")
    .sort((left, right) => right.zIndex - left.zIndex)[0]?.windowId ?? null;
}

function updateWindow(
  state: DesktopWindowState,
  windowId: string,
  update: (record: DesktopWindowStateRecord) => DesktopWindowStateRecord,
): DesktopWindowState {
  let found = false;
  const windows = state.windows.map((record) => {
    if (record.windowId !== windowId) {
      return record;
    }
    found = true;
    return update(record);
  });

  return found ? { ...state, windows } : state;
}

function focusWindow(state: DesktopWindowState, windowId: string): DesktopWindowState {
  const record = state.windows.find((item) => item.windowId === windowId);
  if (!record || record.mode === "minimized") {
    return state;
  }

  const zCounter = state.zCounter + 1;
  return updateWindow(
    {
      ...state,
      activeWindowId: windowId,
      zCounter,
    },
    windowId,
    (item) => ({
      ...item,
      zIndex: zCounter,
    }),
  );
}

export function reduceDesktopWindowState(
  state: DesktopWindowState,
  action: DesktopWindowStateAction,
): DesktopWindowState {
  switch (action.type) {
    case "focus":
      return focusWindow(state, action.windowId);

    case "close": {
      const record = state.windows.find((item) => item.windowId === action.windowId);
      if (!record) {
        return state;
      }

      const windows = state.windows.filter((item) => item.windowId !== action.windowId);
      const activeWindowId = state.activeWindowId === action.windowId
        ? visibleTopWindowId(windows)
        : state.activeWindowId;
      return {
        ...state,
        activeWindowId,
        windows,
      };
    }

    case "maximize": {
      const record = state.windows.find((item) => item.windowId === action.windowId);
      if (!record || record.mode === "minimized") {
        return state;
      }

      const nextState = updateWindow(state, action.windowId, (item) => {
        if (item.mode === "maximized") {
          return {
            ...item,
            mode: "normal",
            lastVisibleMode: "normal",
            x: item.restoreX,
            y: item.restoreY,
            width: item.restoreWidth,
            height: item.restoreHeight,
          };
        }

        return {
          ...item,
          mode: "maximized",
          lastVisibleMode: "maximized",
          restoreX: item.x,
          restoreY: item.y,
          restoreWidth: item.width,
          restoreHeight: item.height,
        };
      });
      return focusWindow(nextState, action.windowId);
    }

    case "minimize": {
      const record = state.windows.find((item) => item.windowId === action.windowId);
      if (!record || record.mode === "minimized") {
        return state;
      }

      const nextState = updateWindow(state, action.windowId, (item) => ({
        ...item,
        mode: "minimized",
        lastVisibleMode: item.mode === "maximized" ? "maximized" : "normal",
      }));
      return {
        ...nextState,
        activeWindowId: state.activeWindowId === action.windowId
          ? visibleTopWindowId(nextState.windows)
          : state.activeWindowId,
      };
    }

    case "restore": {
      const record = state.windows.find((item) => item.windowId === action.windowId);
      if (!record || record.mode !== "minimized") {
        return state;
      }

      const nextState = updateWindow(state, action.windowId, (item) => ({
        ...item,
        mode: item.lastVisibleMode,
      }));
      return focusWindow(nextState, action.windowId);
    }

    case "snap": {
      if (action.target === "maximize") {
        return reduceDesktopWindowState(state, {
          type: "maximize",
          windowId: action.windowId,
        });
      }

      const record = state.windows.find((item) => item.windowId === action.windowId);
      if (!record || record.mode === "minimized") {
        return state;
      }

      const halfWidth = Math.floor(action.workspaceWidth / 2);
      const nextState = updateWindow(state, action.windowId, (item) => ({
        ...item,
        mode: "normal",
        lastVisibleMode: "normal",
        x: action.target === "left" ? 0 : action.workspaceWidth - halfWidth,
        y: 0,
        width: halfWidth,
        height: action.workspaceHeight,
      }));
      return focusWindow(nextState, action.windowId);
    }

    case "cycle": {
      const candidates = state.windows
        .filter((record) => record.mode !== "minimized")
        .sort((left, right) => left.zIndex - right.zIndex);
      if (candidates.length === 0) {
        return state;
      }

      const activeIndex = candidates.findIndex((record) => record.windowId === state.activeWindowId);
      const fallbackIndex = action.direction === 1 ? 0 : candidates.length - 1;
      const nextIndex = activeIndex < 0
        ? fallbackIndex
        : (activeIndex + action.direction + candidates.length) % candidates.length;
      return focusWindow(state, candidates[nextIndex].windowId);
    }

    case "set-chrome":
      return updateWindow(state, action.windowId, (item) => ({
        ...item,
        title: action.title ?? item.title,
        badge: action.badge === undefined ? item.badge : action.badge,
        dirty: action.dirty ?? item.dirty,
      }));
  }
}
