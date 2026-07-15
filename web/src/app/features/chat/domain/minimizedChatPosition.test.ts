import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_MINIMIZED_POSITION_STORAGE_KEY,
  chatMinimizedPositionAtPointer,
  clampChatMinimizedPosition,
  exceededChatMinimizedDragThreshold,
  readPersistedChatMinimizedPosition,
  writePersistedChatMinimizedPosition,
} from "./minimizedChatPosition";

function stubLocalStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const localStorage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  vi.stubGlobal("window", { localStorage });
  return { localStorage, values };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("restores a versioned position from localStorage", () => {
    stubLocalStorage({
      [CHAT_MINIMIZED_POSITION_STORAGE_KEY]: JSON.stringify({ version: 1, x: 140, y: 92 }),
    });

    expect(readPersistedChatMinimizedPosition()).toEqual({ x: 140, y: 92 });
  });

  it("ignores missing, corrupt, or invalid persisted positions", () => {
    const { values } = stubLocalStorage();
    expect(readPersistedChatMinimizedPosition()).toBeNull();

    values.set(CHAT_MINIMIZED_POSITION_STORAGE_KEY, "{");
    expect(readPersistedChatMinimizedPosition()).toBeNull();

    values.set(CHAT_MINIMIZED_POSITION_STORAGE_KEY, JSON.stringify({ version: 2, x: 1, y: 2 }));
    expect(readPersistedChatMinimizedPosition()).toBeNull();

    values.set(CHAT_MINIMIZED_POSITION_STORAGE_KEY, JSON.stringify({ version: 1, x: null, y: 2 }));
    expect(readPersistedChatMinimizedPosition()).toBeNull();
  });

  it("writes the committed position to localStorage", () => {
    const { localStorage, values } = stubLocalStorage();

    writePersistedChatMinimizedPosition({ x: 88, y: 64 });

    expect(localStorage.setItem).toHaveBeenCalledWith(
      CHAT_MINIMIZED_POSITION_STORAGE_KEY,
      JSON.stringify({ version: 1, x: 88, y: 64 }),
    );
    expect(values.get(CHAT_MINIMIZED_POSITION_STORAGE_KEY))
      .toBe(JSON.stringify({ version: 1, x: 88, y: 64 }));
  });

  it("does not change a stored preference when rendering it in smaller bounds", () => {
    stubLocalStorage({
      [CHAT_MINIMIZED_POSITION_STORAGE_KEY]: JSON.stringify({ version: 1, x: 640, y: 420 }),
    });
    const preferred = readPersistedChatMinimizedPosition();

    expect(preferred).not.toBeNull();
    expect(clampChatMinimizedPosition(
      preferred!,
      { width: 390, height: 700 },
      { width: 252, height: 60 },
    )).toEqual({ x: 130, y: 420 });
    expect(readPersistedChatMinimizedPosition()).toEqual({ x: 640, y: 420 });
  });

  it("tolerates unavailable browser storage", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
      },
    });

    expect(readPersistedChatMinimizedPosition()).toBeNull();
    expect(() => writePersistedChatMinimizedPosition({ x: 1, y: 2 })).not.toThrow();
  });
});
