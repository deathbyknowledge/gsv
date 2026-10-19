import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceLegacyChatPath } from "./navigation";

afterEach(() => vi.unstubAllGlobals());

describe("legacy Chat links", () => {
  it.each([
    ["/zen", "/chat"],
    ["/zen/settings", "/chat/settings"],
  ])("rewrites %s while preserving browser handoff and history state", (oldPath, newPath) => {
    const state = { selectedProcess: "process-1" };
    const location = new URL(`https://space.example${oldPath}?browserInstance=instance&browserHandoff=login#viewer`);
    const replaceState = vi.fn((_state: typeof state, _unused: string, _url: URL) => {});
    vi.stubGlobal("window", { location, history: { state, replaceState } });

    replaceLegacyChatPath();

    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState.mock.calls[0][0]).toBe(state);
    expect(replaceState.mock.calls[0][2].href).toBe(`https://space.example${newPath}?browserInstance=instance&browserHandoff=login#viewer`);
  });

  it("leaves current routes alone", () => {
    const location = new URL("https://space.example/chat?browserInstance=instance");
    const replaceState = vi.fn();
    vi.stubGlobal("window", { location, history: { state: null, replaceState } });

    replaceLegacyChatPath();

    expect(replaceState).not.toHaveBeenCalled();
  });
});
