import { describe, expect, it } from "vitest";
import {
  chatMinimizedPositionAtPointer,
  clampChatMinimizedPosition,
  exceededChatMinimizedDragThreshold,
} from "./minimizedChatPosition";

describe("minimized chat position", () => {
  it("keeps an in-bounds position unchanged", () => {
    expect(clampChatMinimizedPosition(
      { x: 120, y: 80 },
      { width: 500, height: 300 },
      { width: 100, height: 60 },
    )).toEqual({ x: 120, y: 80 });
  });

  it("keeps the launcher inside every viewport edge", () => {
    const viewport = { width: 500, height: 300 };
    const launcher = { width: 100, height: 60 };

    expect(clampChatMinimizedPosition({ x: -40, y: -20 }, viewport, launcher))
      .toEqual({ x: 8, y: 8 });
    expect(clampChatMinimizedPosition({ x: 800, y: 600 }, viewport, launcher))
      .toEqual({ x: 392, y: 232 });
  });

  it("centers an axis when the usual margins do not fit", () => {
    expect(clampChatMinimizedPosition(
      { x: 40, y: 40 },
      { width: 100, height: 80 },
      { width: 96, height: 76 },
    )).toEqual({ x: 2, y: 2 });

    expect(clampChatMinimizedPosition(
      { x: 40, y: 40 },
      { width: 50, height: 40 },
      { width: 80, height: 60 },
    )).toEqual({ x: 0, y: 0 });
  });

  it("converts screen pointer coordinates into clamped viewport coordinates", () => {
    expect(chatMinimizedPositionAtPointer(
      { x: 300, y: 200 },
      { x: 20, y: 10 },
      { left: 100, top: 50, width: 500, height: 300 },
      { width: 100, height: 60 },
    )).toEqual({ x: 180, y: 140 });

    expect(chatMinimizedPositionAtPointer(
      { x: 20, y: 10 },
      { x: 20, y: 10 },
      { left: 100, top: 50, width: 500, height: 300 },
      { width: 100, height: 60 },
    )).toEqual({ x: 8, y: 8 });
  });

  it("distinguishes a click-sized wobble from a drag", () => {
    const start = { x: 20, y: 20 };

    expect(exceededChatMinimizedDragThreshold(start, { x: 23, y: 22 })).toBe(false);
    expect(exceededChatMinimizedDragThreshold(start, { x: 25, y: 20 })).toBe(true);
  });
});
