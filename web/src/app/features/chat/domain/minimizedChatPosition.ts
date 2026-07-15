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
