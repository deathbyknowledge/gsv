import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { createTestRoot } from "../../../testing/testHarness";
import { navigateApp, useAppLocation } from "../../../services/navigation/appNavigation";
import { usePreferencesLeavePrompt } from "./usePreferencesLeavePrompt";

afterEach(() => vi.unstubAllGlobals());

function browser() {
  const entries = [{ url: "https://ship.example/chat", state: { gsvAppIndex: 0 } },
    { url: "https://ship.example/chat/settings", state: { gsvAppIndex: 1 } }];
  let at = 1;
  const events = new EventTarget();
  const confirm = vi.fn(() => false);
  const history = {
    get state() { return entries[at]!.state; },
    pushState(state: { gsvAppIndex: number }, _unused: string, url: string) { entries.splice(++at, entries.length, { url, state }); },
    replaceState(state: { gsvAppIndex: number }, _unused: string, url: string) { entries[at] = { url, state }; },
    go(delta: number) { queueMicrotask(() => { at += delta; events.dispatchEvent(new Event("popstate")); }); },
  };
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", {
    get location() { return new URL(entries[at]!.url); }, history, confirm,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
  });
  return { history, confirm, entries, position: () => at };
}

it("warns before app navigation and leaves retained drafts alone when staying", async () => {
  const page = browser();
  const root = createTestRoot("Preferences leave prompt");
  let enabled = true;
  function Harness() { usePreferencesLeavePrompt(enabled); return null; }
  try {
    await root.render(<Harness />);
    expect(navigateApp("/chat/settings?section=account")).toBe(false);
    expect(page.confirm).toHaveBeenCalledOnce();
    expect(page.position()).toBe(1);
    page.confirm.mockReturnValue(true);
    expect(navigateApp("/chat/settings?section=logs")).toBe(true);
    expect(window.location.search).toBe("?section=logs");
    enabled = false;
    await root.render(<Harness />);
    page.confirm.mockClear();
    expect(navigateApp("/people")).toBe(true);
    expect(page.confirm).not.toHaveBeenCalled();
  } finally { await root.unmount(); }
});

it.each([-1, 1])("restores the history position after cancelling a browser traversal (%s), then allows leaving", async (direction) => {
  const page = browser();
  if (direction === 1) {
    page.history.pushState({ gsvAppIndex: 2 }, "", "https://ship.example/chat/settings?section=logs");
    page.history.go(-1);
    await Promise.resolve();
  }
  const root = createTestRoot("Preferences browser history");
  let location: ReturnType<typeof useAppLocation>;
  function Harness() { usePreferencesLeavePrompt(true); location = useAppLocation(); return null; }
  try {
    await root.render(<Harness />);
    await act(async () => { page.history.go(direction); await Promise.resolve(); });
    expect(page.position()).toBe(1);
    expect(window.location.pathname).toBe("/chat/settings");
    expect(location!.pathname).toBe("/chat/settings");
    expect(page.entries).toHaveLength(direction === 1 ? 3 : 2);
    page.confirm.mockReturnValue(true);
    await act(async () => { page.history.go(direction); await Promise.resolve(); });
    expect(page.position()).toBe(1 + direction);
    expect(location!.pathname).toBe(direction === 1 ? "/chat/settings" : "/chat");
  } finally { await root.unmount(); }
});
