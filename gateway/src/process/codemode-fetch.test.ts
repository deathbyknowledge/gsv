import { describe, expect, it, vi } from "vitest";
import {
  buildCodeModeMcpToolBindings,
  buildCodeModeSource,
  performCodeModeFetch,
} from "./codemode";

describe("CodeMode fetch bridge", () => {
  it("preserves redirect mode when performing host fetches", async () => {
    const fetchMock = vi.fn(async (input: Request) => {
      expect(input.redirect).toBe("manual");
      return new Response("redirect", {
        status: 302,
        headers: { location: "https://example.test/final" },
      });
    });

    const result = await performCodeModeFetch({
      url: "https://example.test/redirect",
      method: "GET",
      headers: [],
      redirect: "manual",
    }, fetchMock);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.status).toBe(302);
    expect(result.headers).toContainEqual(["location", "https://example.test/final"]);
  });

  it("rejects responses above the content-length limit", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("ok", {
        headers: { "content-length": "5" },
      })
    );

    await expect(performCodeModeFetch({
      url: "https://example.test/large",
      method: "GET",
      headers: [],
    }, fetchMock, 4)).rejects.toThrow("fetch response body exceeds CodeMode limit of 4 bytes");
  });

  it("rejects streamed responses that exceed the body limit", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5]));
          controller.close();
        },
      }))
    );

    await expect(performCodeModeFetch({
      url: "https://example.test/stream",
      method: "GET",
      headers: [],
    }, fetchMock, 4)).rejects.toThrow("fetch response body exceeds CodeMode limit of 4 bytes");
  });

  it("serializes fetch redirect mode from sandbox requests", () => {
    const source = buildCodeModeSource(`
      await fetch("https://example.test/redirect", { redirect: "manual" });
    `);

    expect(source).toContain("const redirect = __fetchRedirectMode(input, init);");
    expect(source).toContain("if (redirect) normalized.redirect = redirect;");
  });

  it("does not mount MCP tools over CodeMode fetch globals", () => {
    const mcpToolBindings = buildCodeModeMcpToolBindings([
      {
        serverId: "server-1",
        name: "Network",
        state: "ready",
        tools: [{
          name: "fetch",
          description: "Fetch through MCP",
          inputSchema: null,
          outputSchema: null,
        }],
      },
    ]);

    expect(mcpToolBindings.map((binding) => binding.functionName)).toEqual(["Network_fetch"]);

    const source = buildCodeModeSource("return await Network_fetch({});", { mcpToolBindings });

    expect(source.match(/\bconst fetch\b/g)).toHaveLength(1);
    expect(source).toContain("const Network_fetch = async");
    expect(source).not.toContain("const fetch = async (args = {}) => __unwrapMcpResult");
  });
});
