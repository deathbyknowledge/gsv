import { describe, expect, it } from "vitest";
import {
  reduceDesktopWindowState,
  type DesktopWindowState,
  type DesktopWindowStateRecord,
} from "./windowState";

function windowRecord(
  windowId: string,
  overrides: Partial<DesktopWindowStateRecord> = {},
): DesktopWindowStateRecord {
  return {
    windowId,
    title: windowId,
    badge: null,
    dirty: false,
    mode: "normal",
    lastVisibleMode: "normal",
    x: 10,
    y: 20,
    width: 640,
    height: 480,
    restoreX: 10,
    restoreY: 20,
    restoreWidth: 640,
    restoreHeight: 480,
    zIndex: 100,
    ...overrides,
  };
}

function state(overrides: Partial<DesktopWindowState> = {}): DesktopWindowState {
  return {
    activeWindowId: null,
    zCounter: 100,
    windows: [],
    ...overrides,
  };
}

describe("reduceDesktopWindowState", () => {
  it("focuses visible windows and raises their z-index", () => {
    const next = reduceDesktopWindowState(
      state({
        windows: [
          windowRecord("one", { zIndex: 101 }),
          windowRecord("two", { zIndex: 102 }),
        ],
        zCounter: 102,
      }),
      { type: "focus", windowId: "one" },
    );

    expect(next.activeWindowId).toBe("one");
    expect(next.zCounter).toBe(103);
    expect(next.windows.find((record) => record.windowId === "one")?.zIndex).toBe(103);
  });

  it("does not focus minimized windows", () => {
    const current = state({
      activeWindowId: "one",
      zCounter: 102,
      windows: [
        windowRecord("one", { zIndex: 102 }),
        windowRecord("two", { mode: "minimized", zIndex: 101 }),
      ],
    });

    expect(reduceDesktopWindowState(current, { type: "focus", windowId: "two" })).toBe(current);
  });

  it("hands active focus to the highest visible window when closing", () => {
    const next = reduceDesktopWindowState(
      state({
        activeWindowId: "three",
        windows: [
          windowRecord("one", { zIndex: 101 }),
          windowRecord("two", { mode: "minimized", zIndex: 103 }),
          windowRecord("three", { zIndex: 104 }),
          windowRecord("four", { zIndex: 102 }),
        ],
      }),
      { type: "close", windowId: "three" },
    );

    expect(next.windows.map((record) => record.windowId)).toEqual(["one", "two", "four"]);
    expect(next.activeWindowId).toBe("four");
  });

  it("minimizes an active window and restores it to its previous visible mode", () => {
    const minimized = reduceDesktopWindowState(
      state({
        activeWindowId: "one",
        zCounter: 102,
        windows: [
          windowRecord("one", { mode: "maximized", zIndex: 102 }),
          windowRecord("two", { zIndex: 101 }),
        ],
      }),
      { type: "minimize", windowId: "one" },
    );

    expect(minimized.activeWindowId).toBe("two");
    expect(minimized.windows.find((record) => record.windowId === "one")).toMatchObject({
      mode: "minimized",
      lastVisibleMode: "maximized",
    });

    const restored = reduceDesktopWindowState(minimized, { type: "restore", windowId: "one" });
    expect(restored.activeWindowId).toBe("one");
    expect(restored.zCounter).toBe(103);
    expect(restored.windows.find((record) => record.windowId === "one")).toMatchObject({
      mode: "maximized",
      zIndex: 103,
    });
  });

  it("toggles maximize while preserving restore bounds", () => {
    const maximized = reduceDesktopWindowState(
      state({
        zCounter: 100,
        windows: [windowRecord("one", {
          x: 24,
          y: 32,
          width: 700,
          height: 500,
        })],
      }),
      { type: "maximize", windowId: "one" },
    );

    expect(maximized.activeWindowId).toBe("one");
    expect(maximized.windows[0]).toMatchObject({
      mode: "maximized",
      lastVisibleMode: "maximized",
      restoreX: 24,
      restoreY: 32,
      restoreWidth: 700,
      restoreHeight: 500,
      zIndex: 101,
    });

    const restored = reduceDesktopWindowState(maximized, { type: "maximize", windowId: "one" });
    expect(restored.windows[0]).toMatchObject({
      mode: "normal",
      lastVisibleMode: "normal",
      x: 24,
      y: 32,
      width: 700,
      height: 500,
      zIndex: 102,
    });
  });

  it("snaps windows into workspace halves and focuses them", () => {
    const next = reduceDesktopWindowState(
      state({ zCounter: 100, windows: [windowRecord("one")] }),
      {
        type: "snap",
        windowId: "one",
        target: "right",
        workspaceWidth: 1200,
        workspaceHeight: 800,
      },
    );

    expect(next.activeWindowId).toBe("one");
    expect(next.windows[0]).toMatchObject({
      mode: "normal",
      lastVisibleMode: "normal",
      x: 600,
      y: 0,
      width: 600,
      height: 800,
      zIndex: 101,
    });
  });

  it("cycles visible windows in z-index order", () => {
    const current = state({
      activeWindowId: "three",
      zCounter: 103,
      windows: [
        windowRecord("one", { zIndex: 101 }),
        windowRecord("two", { mode: "minimized", zIndex: 102 }),
        windowRecord("three", { zIndex: 103 }),
      ],
    });

    const next = reduceDesktopWindowState(current, { type: "cycle", direction: 1 });
    expect(next.activeWindowId).toBe("one");
    expect(next.windows.find((record) => record.windowId === "one")?.zIndex).toBe(104);
  });

  it("updates title badge and dirty chrome independently", () => {
    const current = state({ windows: [windowRecord("one")] });

    const titled = reduceDesktopWindowState(current, {
      type: "set-chrome",
      windowId: "one",
      title: "Draft",
    });
    const badged = reduceDesktopWindowState(titled, {
      type: "set-chrome",
      windowId: "one",
      badge: "3",
    });
    const dirty = reduceDesktopWindowState(badged, {
      type: "set-chrome",
      windowId: "one",
      dirty: true,
    });

    expect(dirty.windows[0]).toMatchObject({
      title: "Draft",
      badge: "3",
      dirty: true,
    });
  });
});
