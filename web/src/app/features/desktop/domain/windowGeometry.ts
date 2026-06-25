import type { DesktopWindowSnapTarget } from "./windowState";

export type DesktopWorkspaceBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type DesktopWindowDefaults = {
  minWidth: number;
  minHeight: number;
};

export type DesktopWindowSize = {
  width: number;
  height: number;
};

export type DesktopWindowPosition = {
  x: number;
  y: number;
};

export type DesktopWindowRect = DesktopWindowPosition & DesktopWindowSize;

export type DesktopResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export type DesktopResizeStart = {
  direction: DesktopResizeDirection;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
};

export const DESKTOP_WINDOW_MARGIN = 8;
export const DESKTOP_MIN_WINDOW_WIDTH = 320;
export const DESKTOP_MIN_WINDOW_HEIGHT = 240;
export const DESKTOP_SNAP_THRESHOLD = 30;

const ABSOLUTE_MIN_WINDOW_WIDTH = 200;
const ABSOLUTE_MIN_WINDOW_HEIGHT = 180;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizeWorkspaceBounds(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DesktopWorkspaceBounds {
  return {
    left: rect.left,
    top: rect.top,
    width: Math.max(rect.width, DESKTOP_MIN_WINDOW_WIDTH + DESKTOP_WINDOW_MARGIN * 2),
    height: Math.max(rect.height, DESKTOP_MIN_WINDOW_HEIGHT + DESKTOP_WINDOW_MARGIN * 2),
  };
}

export function minimumWindowSizeForWorkspace(
  defaults: DesktopWindowDefaults,
  bounds: DesktopWorkspaceBounds,
): DesktopWindowSize {
  const maxWidth = Math.max(bounds.width - DESKTOP_WINDOW_MARGIN * 2, ABSOLUTE_MIN_WINDOW_WIDTH);
  const maxHeight = Math.max(bounds.height - DESKTOP_WINDOW_MARGIN * 2, ABSOLUTE_MIN_WINDOW_HEIGHT);

  return {
    width: Math.min(Math.max(defaults.minWidth, DESKTOP_MIN_WINDOW_WIDTH), maxWidth),
    height: Math.min(Math.max(defaults.minHeight, DESKTOP_MIN_WINDOW_HEIGHT), maxHeight),
  };
}

export function fitWindowSizeToWorkspace(
  defaults: DesktopWindowDefaults,
  bounds: DesktopWorkspaceBounds,
  size: DesktopWindowSize,
): DesktopWindowSize {
  const maxWidth = Math.max(bounds.width - DESKTOP_WINDOW_MARGIN * 2, ABSOLUTE_MIN_WINDOW_WIDTH);
  const maxHeight = Math.max(bounds.height - DESKTOP_WINDOW_MARGIN * 2, ABSOLUTE_MIN_WINDOW_HEIGHT);
  const minSize = minimumWindowSizeForWorkspace(defaults, bounds);

  return {
    width: clamp(size.width, minSize.width, maxWidth),
    height: clamp(size.height, minSize.height, maxHeight),
  };
}

export function clampWindowPositionToWorkspace(
  bounds: DesktopWorkspaceBounds,
  rect: DesktopWindowRect,
): DesktopWindowPosition {
  const maxX = Math.max(bounds.width - rect.width - DESKTOP_WINDOW_MARGIN, DESKTOP_WINDOW_MARGIN);
  const maxY = Math.max(bounds.height - rect.height - DESKTOP_WINDOW_MARGIN, DESKTOP_WINDOW_MARGIN);

  return {
    x: clamp(rect.x, DESKTOP_WINDOW_MARGIN, maxX),
    y: clamp(rect.y, DESKTOP_WINDOW_MARGIN, maxY),
  };
}

export function snapOverlayRect(
  bounds: DesktopWorkspaceBounds,
  target: DesktopWindowSnapTarget,
): DesktopWindowRect {
  let x = 0;
  const y = 0;
  let width = bounds.width;
  const height = bounds.height;

  if (target === "left") {
    width = Math.floor(bounds.width / 2);
  } else if (target === "right") {
    width = Math.floor(bounds.width / 2);
    x = bounds.width - width;
  }

  return { x, y, width, height };
}

export function detectWindowSnapTarget(
  bounds: DesktopWorkspaceBounds,
  clientX: number,
  clientY: number,
): DesktopWindowSnapTarget | null {
  const leftEdge = bounds.left;
  const rightEdge = bounds.left + bounds.width;
  const topEdge = bounds.top;

  if (clientY <= topEdge + DESKTOP_SNAP_THRESHOLD) {
    return "maximize";
  }

  if (clientX <= leftEdge + DESKTOP_SNAP_THRESHOLD) {
    return "left";
  }

  if (clientX >= rightEdge - DESKTOP_SNAP_THRESHOLD) {
    return "right";
  }

  return null;
}

export function resizeWindowRect(
  bounds: DesktopWorkspaceBounds,
  minSize: DesktopWindowSize,
  resize: DesktopResizeStart,
  clientX: number,
  clientY: number,
): DesktopWindowRect {
  const startRight = resize.startX + resize.startWidth;
  const startBottom = resize.startY + resize.startHeight;
  const deltaX = clientX - resize.startClientX;
  const deltaY = clientY - resize.startClientY;

  let nextX = resize.startX;
  let nextY = resize.startY;
  let nextWidth = resize.startWidth;
  let nextHeight = resize.startHeight;

  if (resize.direction.includes("w")) {
    const maxX = startRight - minSize.width;
    nextX = clamp(resize.startX + deltaX, DESKTOP_WINDOW_MARGIN, maxX);
    nextWidth = startRight - nextX;
  } else if (resize.direction.includes("e")) {
    const maxWidth = Math.max(bounds.width - DESKTOP_WINDOW_MARGIN - resize.startX, minSize.width);
    nextWidth = clamp(resize.startWidth + deltaX, minSize.width, maxWidth);
  }

  if (resize.direction.includes("n")) {
    const maxY = startBottom - minSize.height;
    nextY = clamp(resize.startY + deltaY, DESKTOP_WINDOW_MARGIN, maxY);
    nextHeight = startBottom - nextY;
  } else if (resize.direction.includes("s")) {
    const maxHeight = Math.max(bounds.height - DESKTOP_WINDOW_MARGIN - resize.startY, minSize.height);
    nextHeight = clamp(resize.startHeight + deltaY, minSize.height, maxHeight);
  }

  return {
    x: nextX,
    y: nextY,
    width: nextWidth,
    height: nextHeight,
  };
}
