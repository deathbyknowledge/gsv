import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWebSearch } from "./web-search";
import { testPeer } from "../../test-support/peers";
import type { KernelContext } from "../../kernel/context";
import type { WebSearchService, WebSearchTarget } from "@humansandmachines/gsv/services/web-search";
import { WEB_SEARCH_TIMEOUT_MS } from "@humansandmachines/gsv/services/web-search";

function context(service: WebSearchService, calls = ["web.search"], signal?: AbortSignal): KernelContext {
  // SAFETY: this fixture supplies every context field used by the search boundary.
  return {
    installationId: "inst-search", env: { WEB_SEARCH: service }, requestSignal: signal, defer: vi.fn(),
    peer: testPeer({ kind: "human", account: { uid: 1000, gid: 100, gids: [100], username: "test", home: "/home/test" }, calls }),
  } as KernelContext;
}

afterEach(() => vi.restoreAllMocks());

describe("web search boundary", () => {
  it("uses the trusted installation and rejects invalid input before admission", async () => {
    const search = vi.fn<WebSearchTarget["search"]>(async () => ({ provider: "fixture", results: [] }));
    const getInstallation = vi.fn<WebSearchService["getInstallation"]>(async () => ({ search, cancel: async () => {} }));
    const ctx = context({ getInstallation });
    await expect(handleWebSearch({ query: "news", limit: 11 }, ctx)).rejects.toThrow();
    expect(getInstallation).not.toHaveBeenCalled();
    await handleWebSearch({ query: " news ", includeDomains: ["example.com"] }, ctx);
    expect(getInstallation).toHaveBeenCalledWith("inst-search");
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ requestId: expect.any(String), search: { query: "news", includeDomains: ["example.com"] } }));
  });

  it("enforces capabilities and propagates cancellation to the provider owner", async () => {
    const cancel = vi.fn<WebSearchTarget["cancel"]>(async () => {});
    const search = vi.fn<WebSearchTarget["search"]>(() => new Promise(() => {}));
    const getInstallation = vi.fn<WebSearchService["getInstallation"]>(async () => ({ search, cancel }));
    await expect(handleWebSearch({ query: "news" }, context({ getInstallation }, []))).rejects.toThrow("Permission denied");
    expect(getInstallation).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = handleWebSearch({ query: "news" }, context({ getInstallation }, undefined, controller.signal));
    const failed = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
    controller.abort(new Error("cancelled"));
    await failed;
    expect(cancel).toHaveBeenCalledWith(search.mock.calls[0][0].requestId);
  });

  it.each(["cancel", "timeout"] as const)("returns and releases the target on %s even when provider cancellation hangs", async (cause) => {
    const controller = new AbortController();
    const timeout = new AbortController();
    const timeoutSignal = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const dispose = vi.fn();
    const cancel = vi.fn<WebSearchTarget["cancel"]>(() => new Promise(() => {}));
    const search = vi.fn<WebSearchTarget["search"]>(() => new Promise(() => {}));
    const getInstallation = vi.fn<WebSearchService["getInstallation"]>(async () => ({ search, cancel, [Symbol.dispose]: dispose }));
    const ctx = context({ getInstallation }, undefined, controller.signal);
    const pending = handleWebSearch({ query: "news" }, ctx);
    const failed = expect(pending).rejects.toThrow(cause);
    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
    (cause === "cancel" ? controller : timeout).abort(new Error(cause));
    await failed;
    expect(timeoutSignal).toHaveBeenCalledWith(WEB_SEARCH_TIMEOUT_MS);
    expect(cancel).toHaveBeenCalledWith(search.mock.calls[0][0].requestId);
    expect(ctx.defer).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes a target acquired after cancellation without starting a search", async () => {
    const controller = new AbortController();
    const target = { search: vi.fn(), cancel: vi.fn(), [Symbol.dispose]: vi.fn() };
    const acquired = Promise.withResolvers<WebSearchTarget>();
    const pending = handleWebSearch({ query: "news" }, context({ getInstallation: () => acquired.promise }, undefined, controller.signal));
    const failed = expect(pending).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await failed;
    acquired.resolve(target);
    await vi.waitFor(() => expect(target[Symbol.dispose]).toHaveBeenCalledOnce());
    expect(target.search).not.toHaveBeenCalled();
  });
});
