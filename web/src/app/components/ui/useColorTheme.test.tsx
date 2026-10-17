import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRoot } from "../../testing/testHarness";
import type { ColorTheme, ColorThemeState } from "./useColorTheme";

const THEME_KEY = "gsv.instrument.theme";

/** The slice of `window` the hook touches: storage, the system appearance query and page events. */
function fakeWindow(options: { systemLight: boolean; stored?: string; blocked?: boolean }) {
  const stored = new Map<string, string>(options.stored === undefined ? [] : [[THEME_KEY, options.stored]]);
  const systemListeners = new Set<() => void>();
  const blocked = () => { if (options.blocked) throw new Error("storage blocked"); };
  const query = {
    get matches() { return options.systemLight; },
    addEventListener: (_type: string, listener: () => void) => { systemListeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { systemListeners.delete(listener); },
  };
  const page = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (key: string) => { blocked(); return stored.get(key) ?? null; },
      setItem: (key: string, value: string) => { blocked(); stored.set(key, value); },
      removeItem: (key: string) => { blocked(); stored.delete(key); },
    },
    matchMedia: () => query,
  });
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", page);
  return {
    stored,
    setSystemLight(light: boolean) {
      options.systemLight = light;
      for (const listener of systemListeners) listener();
    },
    /* another tab wrote the key */
    storageEvent(value: string | null, key: string | null = THEME_KEY) {
      if (value === null) stored.delete(THEME_KEY);
      else stored.set(THEME_KEY, value);
      // SAFETY: the hook reads only `key` from the storage event.
      page.dispatchEvent(Object.assign(new Event("storage"), { key }) as StorageEvent);
    },
  };
}

let state: ColorThemeState;
let auth: ColorThemeState;
let instrument: ColorThemeState;
let root: ReturnType<typeof createTestRoot>;

/* a fresh module per test, so a page-only choice from blocked storage does not leak between tests */
async function mount(fallback?: ColorTheme) {
  const { useColorTheme } = await import("./useColorTheme");
  function Harness() {
    state = useColorTheme(fallback);
    auth = useColorTheme("dark");
    instrument = useColorTheme("light");
    return null;
  }
  root = createTestRoot("Color theme");
  await root.render(<Harness />);
}

beforeEach(() => { vi.resetModules(); });
afterEach(async () => { await root?.unmount(); vi.unstubAllGlobals(); });

describe("color theme preference", () => {
  it("follows the system when nothing is stored", async () => {
    const page = fakeWindow({ systemLight: true });
    await mount();
    expect(state.preference).toBeNull();
    expect(state.theme).toBe("light");
    expect(auth.theme).toBe("dark");
    expect(instrument.theme).toBe("light");
    await act(() => page.setSystemLight(false));
    expect(state.theme).toBe("dark");
    expect(auth.theme).toBe("dark");
    expect(instrument.theme).toBe("light");
    expect(page.stored.has(THEME_KEY)).toBe(false);
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
    expect(state.preference).toBeNull();
    expect(state.theme).toBe("dark");
    expect(auth.theme).toBe("dark");
    expect(instrument.theme).toBe("light");
  });

  it("persists Match system separately from surface defaults and restores it on reload", async () => {
    const page = fakeWindow({ systemLight: false });
    await mount("light");
    expect(state.preference).toBeNull();
    expect(state.theme).toBe("light");
    await act(() => state.setPreference("light"));
    expect(page.stored.get(THEME_KEY)).toBe("light");
    expect(state.preference).toBe("light");
    expect(state.theme).toBe("light");
    await act(() => state.setPreference("system"));
    expect(page.stored.get(THEME_KEY)).toBe("system");
    expect(state.preference).toBe("system");
    expect(state.theme).toBe("dark");
    expect(auth.theme).toBe("dark");
    expect(instrument.theme).toBe("dark");
    await act(() => page.setSystemLight(true));
    expect(auth.theme).toBe("light");
    expect(instrument.theme).toBe("light");
    await root.unmount();
    vi.resetModules();
    await mount("light");
    expect(state.preference).toBe("system");
    expect(state.theme).toBe("light");
    expect(auth.theme).toBe("light");
    await act(() => page.setSystemLight(false));
    expect(state.theme).toBe("dark");
    expect(instrument.theme).toBe("dark");
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

  it("toggles from the surface default before a preference has been selected", async () => {
    const page = fakeWindow({ systemLight: false });
    await mount("light");
    await act(() => state.toggleTheme());
    expect(page.stored.get(THEME_KEY)).toBe("dark");
    expect(state.preference).toBe("dark");
    expect(auth.theme).toBe("dark");
    expect(instrument.theme).toBe("dark");
  });

  it("follows a choice made in another tab", async () => {
    const page = fakeWindow({ systemLight: false });
    await mount();
    await act(() => page.storageEvent("light"));
    expect(state.preference).toBe("light");
    expect(state.theme).toBe("light");
    expect(auth.theme).toBe("light");
    expect(instrument.theme).toBe("light");
    await act(() => page.storageEvent("system"));
    expect(auth.preference).toBe("system");
    expect(instrument.preference).toBe("system");
    expect(auth.theme).toBe("dark");
    expect(instrument.theme).toBe("dark");
    await act(() => page.setSystemLight(true));
    expect(auth.theme).toBe("light");
    expect(instrument.theme).toBe("light");
    await act(() => page.storageEvent(null));
    expect(state.preference).toBeNull();
    expect(state.theme).toBe("light");
    expect(auth.theme).toBe("dark");
    expect(instrument.theme).toBe("light");
    await act(() => page.storageEvent("system"));
    await act(() => page.storageEvent(null, null));
    expect(auth.theme).toBe("dark");
    expect(instrument.theme).toBe("light");
  });

  it("keeps the choice for this page when storage is blocked", async () => {
    const page = fakeWindow({ systemLight: true, blocked: true });
    await mount();
    expect(state.preference).toBeNull();
    expect(auth.theme).toBe("dark");
    expect(instrument.theme).toBe("light");
    await act(() => state.setPreference("dark"));
    expect(state.preference).toBe("dark");
    expect(state.theme).toBe("dark");
    await act(() => state.setPreference("system"));
    expect(state.preference).toBe("system");
    expect(state.theme).toBe("light");
    expect(auth.theme).toBe("light");
    expect(instrument.theme).toBe("light");
    await act(() => page.setSystemLight(false));
    expect(auth.theme).toBe("dark");
    expect(instrument.theme).toBe("dark");
    expect(page.stored.has(THEME_KEY)).toBe(false);
    await root.unmount();
    await mount();
    expect(instrument.theme).toBe("dark");
  });
});
