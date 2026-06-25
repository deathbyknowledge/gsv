import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readPersistedDesktopLayout,
  selectRestoredActiveWindowId,
  serializeDesktopLayout,
  writePersistedDesktopLayout,
  type PersistedDesktopLayout,
  type SerializableDesktopWindow,
} from "./windowLayout";

function serializableWindow(
  windowId: string,
  overrides: Partial<SerializableDesktopWindow> = {},
): SerializableDesktopWindow {
  return {
    windowId,
    appId: `app-${windowId}`,
    appName: `App ${windowId}`,
    route: "/",
    title: `App ${windowId}`,
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
    persist: true,
    ...overrides,
  };
}

function stubLocalStorage(initial: Record<string, string> = {}) {
  const storage = new Map(Object.entries(initial));
  const localStorage = {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
    }),
  };

  vi.stubGlobal("window", { localStorage });

  return {
    localStorage,
    getStoredValue: (key: string) => storage.get(key) ?? null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("desktop window layout persistence", () => {
  it("serializes only persistent windows in z-index order", () => {
    const layout = serializeDesktopLayout(
      [
        serializableWindow("two", {
          appId: "files",
          appName: "Files",
          title: "Downloads",
          route: "/downloads",
          zIndex: 20,
        }),
        serializableWindow("preview", {
          appId: "preview",
          persist: false,
          zIndex: 30,
        }),
        serializableWindow("one", {
          appId: "chat",
          appName: "Chat",
          title: "Chat",
          zIndex: 10,
        }),
      ],
      "two",
    );

    expect(layout).toEqual({
      version: 1,
      activeAppId: "files",
      windows: [
        expect.objectContaining({
          appId: "chat",
          title: undefined,
          zIndex: 10,
        }),
        expect.objectContaining({
          appId: "files",
          title: "Downloads",
          route: "/downloads",
          zIndex: 20,
        }),
      ],
    });
  });

  it("does not persist active app ids for transient active windows", () => {
    const layout = serializeDesktopLayout(
      [
        serializableWindow("one", { appId: "chat", zIndex: 10 }),
        serializableWindow("preview", {
          appId: "preview",
          persist: false,
          zIndex: 20,
        }),
      ],
      "preview",
    );

    expect(layout.activeAppId).toBeNull();
  });

  it("round-trips stored layouts and filters invalid window entries", () => {
    const stored: PersistedDesktopLayout = {
      version: 1,
      activeAppId: "chat",
      windows: [
        {
          appId: "chat",
          route: "/",
          mode: "normal",
          lastVisibleMode: "normal",
          x: 1,
          y: 2,
          width: 300,
          height: 240,
          restoreX: 1,
          restoreY: 2,
          restoreWidth: 300,
          restoreHeight: 240,
          zIndex: 10,
        },
        {
          appId: "broken",
          mode: "hidden" as never,
          lastVisibleMode: "normal",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          restoreX: 0,
          restoreY: 0,
          restoreWidth: 1,
          restoreHeight: 1,
          zIndex: 1,
        },
      ],
    };
    stubLocalStorage({
      "gsv.desktop.layout.v1": JSON.stringify(stored),
    });

    expect(readPersistedDesktopLayout()).toEqual({
      version: 1,
      activeAppId: "chat",
      windows: [stored.windows[0]],
    });
  });

  it("returns null for missing or corrupt storage", () => {
    stubLocalStorage({
      "gsv.desktop.layout.v1": "{",
    });

    expect(readPersistedDesktopLayout()).toBeNull();
  });

  it("writes serialized layouts to localStorage", () => {
    const { localStorage, getStoredValue } = stubLocalStorage();
    const layout = serializeDesktopLayout([serializableWindow("one", { appId: "chat" })], "one");

    writePersistedDesktopLayout(layout);

    expect(localStorage.setItem).toHaveBeenCalledWith(
      "gsv.desktop.layout.v1",
      JSON.stringify(layout),
    );
    expect(getStoredValue("gsv.desktop.layout.v1")).toBe(JSON.stringify(layout));
  });

  it("selects the restored active window by app id before falling back", () => {
    expect(selectRestoredActiveWindowId(
      [
        { windowId: "one", appId: "chat", mode: "normal", zIndex: 10 },
        { windowId: "two", appId: "files", mode: "normal", zIndex: 20 },
        { windowId: "three", appId: "files", mode: "normal", zIndex: 30 },
      ],
      "files",
      "one",
    )).toBe("three");
  });

  it("ignores minimized windows when selecting restored active fallback", () => {
    expect(selectRestoredActiveWindowId(
      [
        { windowId: "one", appId: "chat", mode: "minimized", zIndex: 30 },
        { windowId: "two", appId: "files", mode: "normal", zIndex: 20 },
      ],
      "chat",
      null,
    )).toBe("two");
  });
});
