import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRoot, deferred } from "../app/testing/testHarness";
import { DesktopApp } from "./DesktopApp";
import type { DesktopSession } from "./bridge";
import { useDesktopQuit } from "./useDesktopQuit";

function nativeWindow() {
  let close: (event: { preventDefault(): void }) => void;
  const stop = vi.fn();
  const listen = vi.fn(async (handler: typeof close) => { close = handler; return stop; });
  const invoke = vi.fn(async (_command: string): Promise<DesktopSession | void> => undefined);
  const window = Object.assign(new EventTarget(), {
    location: { search: "" },
    __TAURI__: { core: { invoke }, window: { getCurrentWindow: () => ({ onCloseRequested: listen }) } },
  });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", new EventTarget());
  return { window, invoke, listen, stop, close: () => {
    const preventDefault = vi.fn();
    close!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  } };
}

afterEach(() => vi.unstubAllGlobals());

describe("desktop quit", () => {
  it("handles native close while the root is still loading the welcome session", async () => {
    const h = nativeWindow();
    const loading = deferred<DesktopSession>();
    h.invoke.mockImplementation(async (command) => command === "desktop_session" ? loading.promise : undefined);
    const root = createTestRoot("Desktop welcome close");
    function Harness() { DesktopApp(); return null; }
    try {
      await root.render(<Harness />);
      await vi.waitFor(() => expect(h.listen).toHaveBeenCalledOnce());
      await act(() => { h.close(); });
      await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledWith("desktop_quit"));
      await act(async () => { loading.resolve({ generation: "welcome", origin: null, values: {} }); });
      expect(h.listen).toHaveBeenCalledOnce();
    } finally { await root.unmount(); }
    expect(h.stop).toHaveBeenCalledOnce();
  });

  it("retains one close listener across space changes and flushes the current session", async () => {
    const h = nativeWindow();
    const writes = deferred<void>();
    const onError = vi.fn();
    const first = vi.fn(async () => {});
    const second = vi.fn(() => writes.promise);
    let flush: (() => Promise<void>) | undefined;
    const root = createTestRoot("Desktop close ownership");
    function Harness() { useDesktopQuit(flush, onError); return null; }
    try {
      await root.render(<Harness />);
      flush = first;
      await root.render(<Harness />);
      flush = second;
      await root.render(<Harness />);
      expect(h.listen).toHaveBeenCalledOnce();
      await act(() => { h.close(); h.close(); });
      await vi.waitFor(() => expect(second).toHaveBeenCalledOnce());
      expect(first).not.toHaveBeenCalled();
      expect(h.invoke).not.toHaveBeenCalled();
      await act(async () => { writes.resolve(); });
      await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledExactlyOnceWith("desktop_quit"));
      expect(onError).not.toHaveBeenCalled();
    } finally { await root.unmount(); }
  });

  it("offers confirmation for unsent work, supports cancel, and retries failed persistence", async () => {
    const h = nativeWindow();
    h.window.addEventListener("beforeunload", (event) => event.preventDefault());
    const onError = vi.fn();
    const flush = vi.fn(async () => {}).mockRejectedValueOnce(new Error("Storage unavailable"));
    let state: ReturnType<typeof useDesktopQuit>;
    const root = createTestRoot("Desktop close guard");
    function Harness() { state = useDesktopQuit(flush, onError); return null; }
    try {
      await root.render(<Harness />);
      await act(() => { h.close(); });
      expect(state!.confirmation).toBe(true);
      expect(flush).not.toHaveBeenCalled();
      await act(() => { state.cancel(); });
      expect(state!.confirmation).toBe(false);
      expect(h.invoke).not.toHaveBeenCalled();
      await act(() => { h.close(); state.quit(); });
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("Could not quit GSV."));
      expect(h.invoke).not.toHaveBeenCalled();
      await act(() => { state.quit(); });
      await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledExactlyOnceWith("desktop_quit"));
    } finally { await root.unmount(); }
  });
});
