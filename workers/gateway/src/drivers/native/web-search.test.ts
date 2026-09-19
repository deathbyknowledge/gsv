import { describe, expect, it, vi } from "vitest";
import { handleWebSearch } from "./web-search";
import { testPeer } from "../../test-support/peers";
import type { KernelContext } from "../../kernel/context";
import type { WebSearchService, WebSearchTarget } from "@humansandmachines/gsv/services/web-search";

function context(service: WebSearchService, calls = ["web.search"], signal?: AbortSignal): KernelContext {
  // SAFETY: this fixture supplies every context field used by the search boundary.
  return {
    installationId: "inst-search", env: { WEB_SEARCH: service }, requestSignal: signal,
    peer: testPeer({ kind: "human", account: { uid: 1000, gid: 100, gids: [100], username: "test", home: "/home/test" }, calls }),
  } as KernelContext;
}

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
});
