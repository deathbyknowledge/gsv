export type ChatMinimizedPoint = {
  x: number;
  y: number;
};

export type ChatMinimizedSize = {
  width: number;
  height: number;
};

export type ChatMinimizedViewport = ChatMinimizedSize & {
  left: number;
  top: number;
};

export const CHAT_MINIMIZED_DRAG_THRESHOLD = 4;
export const CHAT_MINIMIZED_VIEWPORT_MARGIN = 8;
export const CHAT_MINIMIZED_POSITION_STORAGE_KEY = "gsv.chat.minimized-position.v1";

type PersistedChatMinimizedPosition = ChatMinimizedPoint & {
  version: 1;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function readPersistedChatMinimizedPosition(): ChatMinimizedPoint | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(CHAT_MINIMIZED_POSITION_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedChatMinimizedPosition>;
    if (parsed.version !== 1 || !isFiniteNumber(parsed.x) || !isFiniteNumber(parsed.y)) {
      return null;
    }
    return { x: parsed.x, y: parsed.y };
  } catch {
    return null;
  }
}

export function writePersistedChatMinimizedPosition(position: ChatMinimizedPoint): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(CHAT_MINIMIZED_POSITION_STORAGE_KEY, JSON.stringify({
      version: 1,
      ...position,
    } satisfies PersistedChatMinimizedPosition));
  } catch {
    // Storage is optional; keep the current-session position when unavailable.
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function axisLimits(viewportSize: number, launcherSize: number, margin: number): [number, number] {
  const available = Math.max(0, viewportSize - launcherSize);
  const inset = Math.min(Math.max(0, margin), available / 2);
  return [inset, available - inset];
}

export function clampChatMinimizedPosition(
  position: ChatMinimizedPoint,
  viewport: ChatMinimizedSize,
  launcher: ChatMinimizedSize,
  margin = CHAT_MINIMIZED_VIEWPORT_MARGIN,
): ChatMinimizedPoint {
  const [minX, maxX] = axisLimits(viewport.width, launcher.width, margin);
  const [minY, maxY] = axisLimits(viewport.height, launcher.height, margin);
  return {
    x: clamp(position.x, minX, maxX),
    y: clamp(position.y, minY, maxY),
  };
}

export function chatMinimizedPositionAtPointer(
  pointer: ChatMinimizedPoint,
  pointerOffset: ChatMinimizedPoint,
  viewport: ChatMinimizedViewport,
  launcher: ChatMinimizedSize,
): ChatMinimizedPoint {
  return clampChatMinimizedPosition({
    x: pointer.x - viewport.left - pointerOffset.x,
    y: pointer.y - viewport.top - pointerOffset.y,
  }, viewport, launcher);
}

export function exceededChatMinimizedDragThreshold(
  start: ChatMinimizedPoint,
  current: ChatMinimizedPoint,
  threshold = CHAT_MINIMIZED_DRAG_THRESHOLD,
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > threshold;
}
