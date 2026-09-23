import { createCommandContext, InMemoryFs } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../../../kernel/context";
import type { NativeShellCommandOptions } from "./commands";
import { testPeer } from "../../../test-support/peers";
import { buildWebCommand } from "./web";

describe("web search shell command", () => {
  it("sends bounded options and target selection through the ordinary syscall transport", async () => {
    const result = { provider: "fixture", results: [{ title: "Source", url: "https://example.com/", snippet: "Excerpt" }] };
    const request = vi.fn<NonNullable<NativeShellCommandOptions["request"]>>(async (frame) => ({ type: "res", id: frame.id, ok: true, data: result }));
    // SAFETY: this fixture includes every field the web command and handler use.
    const ctx = {
      installationId: "inst-search", env: {},
      peer: testPeer({ kind: "human", account: { uid: 1000, gid: 100, gids: [100], username: "test", home: "/home/test" }, calls: ["web.search"] }),
    } as KernelContext;
    const command = buildWebCommand(ctx, request);
    const shell = createCommandContext({ fs: new InMemoryFs(), cwd: "/" });
    const output = await command.execute(["search", "--json", "--limit", "3", "--include-domain", "example.com", "current", "news"], shell);
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual(result);
    expect(request.mock.calls[0][0]).toMatchObject({ call: "web.search", args: { query: "current news", limit: 3, includeDomains: ["example.com"] } });
    expect(request.mock.calls[0][0].args).not.toHaveProperty("target");
    expect((await command.execute(["search", "--target", "personal-search", "news"], shell)).exitCode).toBe(0);
    expect(request.mock.calls[1][0]).toMatchObject({ call: "web.search", args: { query: "news", target: "personal-search" } });
    const invalid = await command.execute(["search", "--limit", "11", "news"], shell);
    expect(invalid.exitCode).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
    request.mockResolvedValueOnce({ type: "res", id: "denied", ok: false, error: { code: 403, message: "Access denied to target" } });
    expect((await command.execute(["search", "--target", "foreign", "news"], shell)).stderr).toContain("Access denied to target");
  });
});
