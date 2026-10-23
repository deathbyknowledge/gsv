import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRoot } from "../../../testing/testHarness";
import { peoplePath, readPeopleRoute, usePeopleRoute } from "./peopleNavigation";

afterEach(() => vi.unstubAllGlobals());

describe("People destinations", () => {
  it.each([
    { view: "inbox" as const, contactId: "contact/one+two", archived: true },
    { view: "requests" as const, requestId: "request-one", direction: "outgoing" as const, history: true },
    { view: "profile" as const, edit: false },
    { view: "profile" as const, edit: true, focusBio: false },
    { view: "profile" as const, edit: true, focusBio: true },
    { view: "contacts" as const },
  ])("restores a linked destination: %o", (route) => {
    const url = new URL(peoplePath(route), "https://ship.example");
    expect(url.pathname).toBe("/people");
    expect(readPeopleRoute(url.search)).toMatchObject(route);
  });

  it("retains the inactive view and restores browser history without navigating or losing its selection", async () => {
    let url = new URL("https://ship.example/people?contact=first");
    const events = new EventTarget();
    const pushState = vi.fn((_state: null, _unused: string, destination: string) => { url = new URL(destination); });
    vi.stubGlobal("document", {});
    vi.stubGlobal("window", {
      get location() { return url; }, history: { pushState },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    });
    const visit = (path: string) => { url = new URL(path, url); events.dispatchEvent(new Event("popstate")); };
    const root = createTestRoot("People navigation");
    let current: ReturnType<typeof usePeopleRoute> | undefined;
    function Probe() { current = usePeopleRoute(); return null; }
    try {
      await root.render(<Probe />);
      await act(() => current![1]({ view: "profile" }));
      expect(current![0].view).toBe("profile");
      await act(() => visit("/chat"));
      expect(current![0].view).toBe("profile");
      await act(() => current![1]({ view: "inbox", contactId: "completed-while-away" }));
      expect(window.location.pathname).toBe("/chat");
      await act(() => visit("/people?contact=first"));
      expect(current![0]).toMatchObject({ view: "inbox", contactId: "first" });
      await act(() => visit("/people"));
      expect(current![0].contactId).toBeNull();
      expect(pushState).toHaveBeenCalledTimes(1);
    } finally { await root.unmount(); }
  });
});
