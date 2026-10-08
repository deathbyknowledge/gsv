import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRoot } from "../../testing/testHarness";
import type { ColorThemeState } from "./useColorTheme";

const THEME_KEY = "gsv.instrument.theme";
type Listener = (event: Event) => void;

/** The slice of `window` the hook touches: storage, the system appearance query and page events. */
function fakeWindow(options: { systemLight: boolean; stored?: string; blocked?: boolean }) {
  const stored = new Map<string, string>(options.stored === undefined ? [] : [[THEME_KEY, options.stored]]);
  const listeners = new Map<string, Set<Listener>>();
  const systemListeners = new Set<() => void>();
  const blocked = () => { if (options.blocked) throw new Error("storage blocked"); };
  const query = {
    get matches() { return options.systemLight; },
    addEventListener: (_type: string, listener: () => void) => { systemListeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { systemListeners.delete(listener); },
  };
  const page = {
    localStorage: {
      getItem: (key: string) => { blocked(); return stored.get(key) ?? null; },
      setItem: (key: string, value: string) => { blocked(); stored.set(key, value); },
      removeItem: (key: string) => { blocked(); stored.delete(key); },
    },
    matchMedia: () => query,
    addEventListener: (type: string, listener: Listener) => {
      const set = listeners.get(type) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: Listener) => { listeners.get(type)?.delete(listener); },
    dispatchEvent: (event: Event) => {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
  };
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", page);
  return {
    stored,
    setSystemLight(light: boolean) {
      options.systemLight = light;
      for (const listener of systemListeners) listener();
    },
    /* another tab wrote the key */
    storageEvent(value: string | null) {
      if (value === null) stored.delete(THEME_KEY);
      else stored.set(THEME_KEY, value);
      // SAFETY: the hook reads only `key` from the storage event.
      page.dispatchEvent(Object.assign(new Event("storage"), { key: THEME_KEY }) as StorageEvent);
    },
  };
}

let state: ColorThemeState;
let root: ReturnType<typeof createTestRoot>;

/* a fresh module per test, so a page-only choice from blocked storage does not leak between tests */
async function mount() {
  const { useColorTheme } = await import("./useColorTheme");
  function Harness() { state = useColorTheme(); return null; }
  root = createTestRoot("Color theme");
  await root.render(<Harness />);
}

beforeEach(() => { vi.resetModules(); });
afterEach(async () => { await root?.unmount(); vi.unstubAllGlobals(); });

describe("color theme preference", () => {
  it("follows the system when nothing is stored", async () => {
    const page = fakeWindow({ systemLight: true });
    await mount();
    expect(state.preference).toBe("system");
    expect(state.theme).toBe("light");
    await act(() => page.setSystemLight(false));
    expect(state.theme).toBe("dark");
  });

  it("keeps a stored light or dark choice regardless of the system", async () => {
    const page = fakeWindow({ systemLight: true, stored: "dark" });
    await mount();
    expect(state.preference).toBe("dark");
    expect(state.theme).toBe("dark");
    await act(() => page.setSystemLight(false));
    await act(() => page.setSystemLight(true));
    expect(state.theme).toBe("dark");
  });

  it("treats an unrecognised stored value as following the system", async () => {
    fakeWindow({ systemLight: false, stored: "purple" });
    await mount();
    expect(state.preference).toBe("system");
    expect(state.theme).toBe("dark");
  });

  it("stores an explicit choice and clears it to follow the system again", async () => {
    const page = fakeWindow({ systemLight: false });
    await mount();
    await act(() => state.setPreference("light"));
    expect(page.stored.get(THEME_KEY)).toBe("light");
    expect(state.preference).toBe("light");
    expect(state.theme).toBe("light");
    await act(() => state.setPreference("system"));
    expect(page.stored.has(THEME_KEY)).toBe(false);
    expect(state.preference).toBe("system");
    expect(state.theme).toBe("dark");
  });

  it("toggles from the system theme to a pinned opposite", async () => {
    const page = fakeWindow({ systemLight: false });
    await mount();
    await act(() => state.toggleTheme());
    expect(page.stored.get(THEME_KEY)).toBe("light");
    expect(state.preference).toBe("light");
    expect(state.theme).toBe("light");
    await act(() => state.toggleTheme());
    expect(state.preference).toBe("dark");
    expect(state.theme).toBe("dark");
  });

  it("follows a choice made in another tab", async () => {
    const page = fakeWindow({ systemLight: false });
    await mount();
    await act(() => page.storageEvent("light"));
    expect(state.preference).toBe("light");
    expect(state.theme).toBe("light");
    await act(() => page.storageEvent(null));
    expect(state.preference).toBe("system");
    expect(state.theme).toBe("dark");
  });

  it("keeps the choice for this page when storage is blocked", async () => {
    fakeWindow({ systemLight: true, blocked: true });
    await mount();
    expect(state.preference).toBe("system");
    await act(() => state.setPreference("dark"));
    expect(state.preference).toBe("dark");
    expect(state.theme).toBe("dark");
    await act(() => state.setPreference("system"));
    expect(state.preference).toBe("system");
    expect(state.theme).toBe("light");
  });
});
