import { createCommandContext, InMemoryFs } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import type { WebSearchTarget } from "@humansandmachines/gsv/services/web-search";
import type { KernelContext } from "../../../kernel/context";
import { testPeer } from "../../../test-support/peers";
import { buildWebCommand } from "./web";

describe("web search shell command", () => {
  it("passes bounded options through the service boundary and supports JSON output", async () => {
    const result = { provider: "fixture", results: [{ title: "Source", url: "https://example.com/", snippet: "Excerpt" }] };
    const search = vi.fn<WebSearchTarget["search"]>(async () => result);
    // SAFETY: this fixture includes every field the web command and handler use.
    const ctx = {
      installationId: "inst-search", env: { WEB_SEARCH: { getInstallation: async () => ({ search, cancel: async () => {} }) } },
      peer: testPeer({ kind: "human", account: { uid: 1000, gid: 100, gids: [100], username: "test", home: "/home/test" }, calls: ["web.search"] }),
    } as KernelContext;
    const command = buildWebCommand(ctx);
    const shell = createCommandContext({ fs: new InMemoryFs(), cwd: "/" });
    const output = await command.execute(["search", "--json", "--limit", "3", "--include-domain", "example.com", "current", "news"], shell);
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual(result);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ search: { query: "current news", limit: 3, includeDomains: ["example.com"] } }));
    const invalid = await command.execute(["search", "--limit", "11", "news"], shell);
    expect(invalid.exitCode).toBe(1);
    expect(search).toHaveBeenCalledOnce();
  });
});
