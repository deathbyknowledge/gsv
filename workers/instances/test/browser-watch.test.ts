import { describe, expect, it, vi, type Mock } from "vitest";
import { decodeBrowserViewStream, type BrowserViewState } from "@humansandmachines/gsv/protocol";
import type { CloudBrowser } from "../src/browser";
import type { CapturedBrowserFrame } from "../src/browser-view";
import { BrowserWatch } from "../src/browser-watch";

type Subscription = {
  frame: (value: CapturedBrowserFrame) => void;
  error: (cause: unknown) => void;
  resolve: (unsubscribe: () => void) => void;
  reject: (cause: unknown) => void;
};
const image = (tabId: number): CapturedBrowserFrame => ({ tabId, documentId: `doc-${tabId}`, capturedAt: 1, width: 1280, height: 800, image: new Uint8Array([tabId]) });

async function fixture(work: (value: {
  watch: BrowserWatch;
  subscriptions: Map<number, Subscription>;
  select: (id: number) => void;
  failure: ReturnType<typeof vi.fn>;
  listTabs: Mock<CloudBrowser["listTabs"]>;
}) => Promise<void>) {
  const state: BrowserViewState = { kind: "state", activeTabId: 1, tabs: [1, 2, 3].map(id => ({ id, title: `Tab ${id}`, url: "about:blank" })) };
  const subscriptions = new Map<number, Subscription>();
  let change = () => {};
  const listTabs = vi.fn<CloudBrowser["listTabs"]>(async () => []);
  const browser: Pick<CloudBrowser, "listTabs" | "viewState" | "onViewChange" | "watchTab"> = {
    listTabs,
    viewState: () => state,
    onViewChange: listener => { change = listener; return () => { change = () => {}; }; },
    watchTab: (id, frame, error) => new Promise((resolve, reject) => { subscriptions.set(id, { frame, error, resolve, reject }); }),
  };
  const failure = vi.fn((cause: unknown) => new Error("view failed", { cause }));
  // SAFETY: BrowserWatch only uses the four operations implemented by this fixture.
  const watch = new BrowserWatch(browser as CloudBrowser, undefined, () => undefined, () => {}, failure, () => {});
  const started = watch.start();
  await vi.waitFor(() => expect(subscriptions.has(1)).toBe(true));
  subscriptions.get(1)!.resolve(() => {});
  await started;
  try { await work({ watch, subscriptions, select: id => { state.activeTabId = id; change(); }, failure, listTabs }); }
  finally { watch.view.close(); }
}

describe("browser tab following", () => {
  it("ignores a retired tab's late startup failure and frames", () => fixture(async ({ watch, subscriptions, select, failure }) => {
    select(2);
    select(3);
    const current = subscriptions.get(3)!;
    current.resolve(() => {});
    subscriptions.get(2)!.reject(new Error("Target page has been closed"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(failure).not.toHaveBeenCalled();
    current.frame(image(3));
    subscriptions.get(1)!.frame(image(1));
    subscriptions.get(1)!.error(new Error("Old screencast ended"));
    const packets = decodeBrowserViewStream(watch.view.body);
    expect((await packets.next()).value?.metadata).toMatchObject({ kind: "state", activeTabId: 3 });
    expect((await packets.next()).value?.metadata).toMatchObject({ kind: "frame", tabId: 3 });
    await packets.return();
    expect(failure).not.toHaveBeenCalled();
  }));

  it("releases a subscription that starts after the viewer moved to another tab", () => fixture(async ({ watch, subscriptions, select }) => {
    select(2); select(3);
    const retired = vi.fn(), current = vi.fn();
    subscriptions.get(3)!.resolve(current);
    subscriptions.get(2)!.resolve(retired);
    await vi.waitFor(() => expect(retired).toHaveBeenCalledOnce());
    expect(current).not.toHaveBeenCalled();
    watch.view.close();
    expect(current).toHaveBeenCalledOnce();
  }));

  it("refreshes tab ownership when a closing tab fails before its metadata arrives", () => fixture(async ({ watch, subscriptions, select, failure, listTabs }) => {
    select(2);
    listTabs.mockImplementationOnce(async () => { select(3); return []; });
    subscriptions.get(2)!.reject(new Error("Target page has been closed"));
    await vi.waitFor(() => expect(subscriptions.has(3)).toBe(true));
    subscriptions.get(3)!.resolve(() => {});
    subscriptions.get(3)!.frame(image(3));
    const packets = decodeBrowserViewStream(watch.view.body);
    expect((await packets.next()).value?.metadata).toMatchObject({ kind: "state", activeTabId: 3 });
    expect((await packets.next()).value?.metadata).toMatchObject({ kind: "frame", tabId: 3 });
    await packets.return();
    expect(failure).not.toHaveBeenCalled();
  }));

  it("retains a failure of the current tab for diagnosis", () => fixture(async ({ watch, subscriptions, select, failure }) => {
    select(2);
    const cause = new Error("Current screencast cannot start");
    subscriptions.get(2)!.reject(cause);
    await vi.waitFor(() => expect(failure).toHaveBeenCalledWith(cause));
    await expect(decodeBrowserViewStream(watch.view.body).next()).rejects.toThrow("view failed");
  }));
});
