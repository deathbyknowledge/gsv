import { describe, expect, it } from "vitest";
import {
  centeredMobileRotorIndex,
  filterLauncherPaletteItems,
  mobileRotorMetrics,
  normalizeMobileRotorPosition,
  orderMobileWindowStack,
  shortestMobileRotorDelta,
  type LauncherWindowSummary,
} from "./launcherState";

function summary(
  windowId: string,
  overrides: Partial<LauncherWindowSummary> = {},
): LauncherWindowSummary {
  return {
    windowId,
    appId: "app",
    title: windowId,
    mode: "normal",
    active: false,
    zIndex: 1,
    ...overrides,
  };
}

describe("launcher palette helpers", () => {
  it("returns the first items for an empty query", () => {
    const items = [
      { search: "chat app", id: "chat" },
      { search: "files app", id: "files" },
      { search: "wiki app", id: "wiki" },
    ];

    expect(filterLauncherPaletteItems(items, "", 2).map((item) => item.id)).toEqual(["chat", "files"]);
  });

  it("matches all query parts case-insensitively", () => {
    const items = [
      { search: "focus chat window", id: "chat-window" },
      { search: "open chat app", id: "chat-app" },
      { search: "open files app", id: "files-app" },
    ];

    expect(filterLauncherPaletteItems(items, "CHAT window").map((item) => item.id)).toEqual(["chat-window"]);
  });
});

describe("mobile rotor helpers", () => {
  it("normalizes positions around the app count", () => {
    expect(normalizeMobileRotorPosition(-1, 5)).toBe(4);
    expect(normalizeMobileRotorPosition(7.25, 5)).toBe(2.25);
    expect(normalizeMobileRotorPosition(10, 0)).toBe(0);
  });

  it("finds the shortest wrapped delta to an item", () => {
    expect(shortestMobileRotorDelta(0, 4, 5)).toBe(1);
    expect(shortestMobileRotorDelta(4, 0, 5)).toBe(-1);
    expect(shortestMobileRotorDelta(2, 2.4, 5)).toBeCloseTo(-0.4);
  });

  it("chooses the rounded centered item", () => {
    expect(centeredMobileRotorIndex(4.6, 5)).toBe(0);
    expect(centeredMobileRotorIndex(2.4, 5)).toBe(2);
    expect(centeredMobileRotorIndex(0, 0)).toBe(-1);
  });

  it("calculates bounded rotor metrics from list height and app count", () => {
    const metrics = mobileRotorMetrics(600, 20);
    expect(metrics?.radius).toBe(216);
    expect(metrics?.depthRadius).toBeCloseTo(204);
    expect(metrics?.angleStep).toBeCloseTo((Math.PI * 2) / 11);
    expect(metrics?.activeRadius).toBe(4);
    expect(mobileRotorMetrics(0, 3)).toBeNull();
    expect(mobileRotorMetrics(600, 0)).toBeNull();
  });
});

describe("mobile window stack ordering", () => {
  it("puts the selected window first", () => {
    expect(orderMobileWindowStack([
      summary("one", { zIndex: 20 }),
      summary("two", { zIndex: 10 }),
    ], "two").map((item) => item.windowId)).toEqual(["two", "one"]);
  });

  it("orders active visible windows before visible and minimized windows", () => {
    expect(orderMobileWindowStack([
      summary("minimized", { mode: "minimized", zIndex: 100 }),
      summary("visible", { zIndex: 50 }),
      summary("active", { active: true, zIndex: 10 }),
    ], null).map((item) => item.windowId)).toEqual(["active", "visible", "minimized"]);
  });

  it("orders otherwise equivalent windows by descending z-index", () => {
    expect(orderMobileWindowStack([
      summary("low", { zIndex: 1 }),
      summary("high", { zIndex: 3 }),
      summary("mid", { zIndex: 2 }),
    ], null).map((item) => item.windowId)).toEqual(["high", "mid", "low"]);
  });
});
