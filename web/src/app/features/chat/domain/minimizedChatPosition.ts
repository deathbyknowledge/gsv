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

const persistedChatMinimizedPositionSchema = z.object({
  version: z.literal(1),
  x: z.number().finite(),
  y: z.number().finite(),
});

export function readPersistedChatMinimizedPosition(): ChatMinimizedPoint | null {
  const storage = globalThis.window?.localStorage;
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(CHAT_MINIMIZED_POSITION_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = persistedChatMinimizedPositionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }
    return { x: parsed.data.x, y: parsed.data.y };
  } catch {
    return null;
  }
}

export function writePersistedChatMinimizedPosition(position: ChatMinimizedPoint): void {
  const storage = globalThis.window?.localStorage;
  if (!storage) {
    return;
  }
  try {
    storage.setItem(CHAT_MINIMIZED_POSITION_STORAGE_KEY, JSON.stringify({
      version: 1,
      ...position,
    } satisfies ChatMinimizedPoint & { version: 1 }));
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
import { z } from "zod";
