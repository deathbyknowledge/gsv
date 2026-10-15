import type { JSX } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRoot } from "../../testing/testHarness";
import { AppLink as SessionLink, useAppLocation as useSessionLocation, navigateApp } from "./appNavigation";

function browser() {
  let url = new URL("https://ship.example/");
  const events = new EventTarget();
  vi.stubGlobal("document", {});
  const pushState = vi.fn((_state: null, _unused: string, destination: string) => { url = new URL(destination, url); });
  const replaceState = vi.fn((_state: null, _unused: string, destination: string) => { url = new URL(destination, url); });
  vi.stubGlobal("window", {
    get location() { return url; },
    history: { pushState, replaceState },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  });
  return { pushState, replaceState, visit: (path: string, event = "popstate") => {
    url = new URL(path, url);
    events.dispatchEvent(new Event(event));
  } };
}

function click(options: Partial<JSX.TargetedMouseEvent<HTMLAnchorElement>> = {}) {
  // SAFETY: SessionLink only reads these mouse-event fields in this focused navigation fixture.
  return { button: 0, defaultPrevented: false, preventDefault: vi.fn(), ...options } as JSX.TargetedMouseEvent<HTMLAnchorElement>;
}

afterEach(() => vi.unstubAllGlobals());

describe("session navigation", () => {
  it("records distinct app destinations while redirects and repeated selections do not add entries", async () => {
    const history = browser();
    const root = createTestRoot("App history");
    let current: ReturnType<typeof useSessionLocation> | undefined;
    function Probe() { current = useSessionLocation(); return null; }
    try {
      await root.render(<Probe />);
      await act(() => navigateApp("/chat", { replace: true }));
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "https://ship.example/chat");
      await act(() => navigateApp("/people"));
      await act(() => navigateApp("/people?contact=first"));
      await act(() => navigateApp("/people?contact=first"));
      expect(history.pushState.mock.calls.map((call) => call[2])).toEqual([
        "https://ship.example/people", "https://ship.example/people?contact=first",
      ]);
      expect(current).toEqual({ pathname: "/people", revision: 3 });
      await act(() => history.visit("/people"));
      expect(current).toEqual({ pathname: "/people", revision: 4 });
      expect(history.pushState).toHaveBeenCalledTimes(2);
      expect(() => navigateApp("https://another.example/")).toThrow("local destination");
    } finally { await root.unmount(); }
  });

  it("navigates locally and observes browser back and forward without a reload", async () => {
    const history = browser();
    const root = createTestRoot("The session navigation hook");
    let current: ReturnType<typeof useSessionLocation> | undefined;
    function Probe() { current = useSessionLocation(); return null; }
    try {
      await root.render(<Probe />);
      const link = SessionLink({ href: "/recover-member", children: "Recover" });
      const event = click();
      await act(() => link.props.onClick(event));
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(history.pushState).toHaveBeenCalledWith(null, "", "https://ship.example/recover-member");
      expect(current).toEqual({ pathname: "/recover-member", revision: 1 });
      await act(() => history.visit("/"));
      expect(current).toEqual({ pathname: "/", revision: 2 });
      await act(() => history.visit("/recover-member"));
      expect(current).toEqual({ pathname: "/recover-member", revision: 3 });
    } finally { await root.unmount(); }
  });

  it("leaves modified clicks, other buttons, new tabs, and foreign links to the browser", () => {
    const history = browser();
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { button: 1 }, { defaultPrevented: true }]) {
      const event = click(options);
      SessionLink({ href: "/recover-member", children: "Recover" }).props.onClick(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    for (const props of [{ href: "/recover-member", target: "_blank" }, { href: "https://owner.example/" }]) {
      const event = click();
      SessionLink({ ...props, children: "Recover" }).props.onClick(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(history.pushState).not.toHaveBeenCalled();
  });

  it("re-enters a recovery screen when a new fragment arrives without copying its secret into route state", async () => {
    const history = browser();
    history.visit("/recover");
    const root = createTestRoot("The recovery navigation hook");
    let current: ReturnType<typeof useSessionLocation> | undefined;
    function Probe() { current = useSessionLocation(); return null; }
    try {
      await root.render(<Probe />);
      await act(() => history.visit("/recover#id=next&secret=proof", "hashchange"));
      expect(current).toEqual({ pathname: "/recover", revision: 1 });
      expect(JSON.stringify(current)).not.toContain("secret");
    } finally { await root.unmount(); }
  });
});
