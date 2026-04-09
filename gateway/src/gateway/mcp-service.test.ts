import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { McpService } from "./mcp-service";
import type { McpConfig } from "../config";

function makeConfig(servers: McpConfig["servers"] = {}): McpConfig {
  return { servers };
}

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({})),
}));

describe("McpService", () => {
  let service: McpService;

  beforeEach(async () => {
    service = new McpService();
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    (Client as any).mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi.fn().mockResolvedValue({ content: [] }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -- resolve: the core routing logic --

  describe("resolve", () => {
    it("resolves when server + cache + tool all match", () => {
      const config = makeConfig({ aeon: { url: "https://aeon.fly.dev/mcp" } });
      (service as any).toolCache.set("aeon", {
        tools: [{ name: "aeon__recall", description: "Search", inputSchema: {} }],
        fetchedAt: Date.now(),
      });

      const result = service.resolve("aeon__recall", config);
      expect(result).toEqual({
        serverId: "aeon",
        toolName: "recall",
        serverConfig: { url: "https://aeon.fly.dev/mcp" },
      });
    });

    it("returns null — unknown server", () => {
      expect(service.resolve("unknown__tool", makeConfig({}))).toBeNull();
    });

    it("returns null — tool not in cache", () => {
      const config = makeConfig({ aeon: { url: "https://aeon.fly.dev/mcp" } });
      (service as any).toolCache.set("aeon", {
        tools: [{ name: "aeon__ingest", description: "x", inputSchema: {} }],
        fetchedAt: Date.now(),
      });
      expect(service.resolve("aeon__recall", config)).toBeNull();
    });

    it("returns null — cold cache (fail closed)", () => {
      const config = makeConfig({ aeon: { url: "https://aeon.fly.dev/mcp" } });
      expect(service.resolve("aeon__recall", config)).toBeNull();
    });

    it("returns null — expired cache (fail closed)", () => {
      const config = makeConfig({ aeon: { url: "https://aeon.fly.dev/mcp", cacheTtlMs: 60_000 } });
      (service as any).toolCache.set("aeon", {
        tools: [{ name: "aeon__recall", description: "x", inputSchema: {} }],
        fetchedAt: Date.now() - 120_000,
      });
      expect(service.resolve("aeon__recall", config)).toBeNull();
    });

    it("returns null — malformed names", () => {
      const config = makeConfig({ aeon: { url: "https://aeon.fly.dev/mcp" } });
      expect(service.resolve("aeon", config)).toBeNull();
      expect(service.resolve("aeon__", config)).toBeNull();
    });
  });

  // -- listToolsCached: TTL enforcement --

  describe("listToolsCached", () => {
    it("returns cached tools when fresh, empty when expired", () => {
      const config = makeConfig({ s: { url: "https://s.dev/mcp", cacheTtlMs: 60_000 } });

      (service as any).toolCache.set("s", {
        tools: [{ name: "s__t", description: "x", inputSchema: {} }],
        fetchedAt: Date.now(),
      });
      expect(service.listToolsCached(config)).toHaveLength(1);

      // Expire it
      (service as any).toolCache.get("s").fetchedAt = Date.now() - 120_000;
      expect(service.listToolsCached(config)).toHaveLength(0);
    });
  });

  // -- refreshCache: the SDK integration seam --

  describe("refreshCache", () => {
    it("namespaces discovered tools as {serverId}__{toolName}", async () => {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      (Client as any).mockImplementation(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockResolvedValue({
          tools: [
            { name: "recall", description: "Search", inputSchema: { type: "object" } },
            { name: "ingest", description: "Store" },
          ],
        }),
      }));

      const config = makeConfig({ aeon: { url: "https://aeon.fly.dev/mcp" } });
      await service.refreshCache(config);

      const cached = service.listToolsCached(config);
      expect(cached.map((t) => t.name)).toEqual(["aeon__recall", "aeon__ingest"]);
    });

    it("clears stale cache on refresh failure", async () => {
      (service as any).toolCache.set("bad", {
        tools: [{ name: "bad__tool", description: "x", inputSchema: {} }],
        fetchedAt: Date.now(),
      });

      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      (Client as any).mockImplementation(() => ({
        connect: vi.fn().mockRejectedValue(new Error("connection refused")),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      await service.refreshCache(makeConfig({ bad: { url: "https://bad.dev/mcp" } }));
      expect(service.listToolsCached(makeConfig({ bad: { url: "https://bad.dev/mcp" } }))).toEqual([]);
    });
  });

  // -- nextCacheExpiryMs: alarm scheduling --

  describe("nextCacheExpiryMs", () => {
    it("returns undefined with no servers", () => {
      expect(service.nextCacheExpiryMs(makeConfig({}))).toBeUndefined();
    });

    it("defers uncached servers by one TTL (no spin-loop)", () => {
      const config = makeConfig({ s: { url: "https://s.dev/mcp", cacheTtlMs: 60_000 } });
      expect(service.nextCacheExpiryMs(config)!).toBeGreaterThan(Date.now());
    });
  });

  // -- URL validation: the security boundary --

  describe("URL validation", () => {
    it("rejects non-localhost HTTP and exotic protocols", async () => {
      const http = await service.callTool({ url: "http://evil.com/mcp" }, "t", {});
      expect(http.error).toContain("must use HTTPS");

      const ftp = await service.callTool({ url: "ftp://x.com/mcp" }, "t", {});
      expect(ftp.error).toContain("must use HTTPS");
    });

    it("allows localhost HTTP and HTTPS", async () => {
      const local = await service.callTool({ url: "http://localhost:3000/mcp" }, "t", {});
      expect(local.error).toBeUndefined();

      const https = await service.callTool({ url: "https://mcp.example.com/api" }, "t", {});
      expect(https.error).toBeUndefined();
    });
  });

  // -- invalidateCache --

  describe("invalidateCache", () => {
    it("clears one or all", () => {
      (service as any).toolCache.set("a", { tools: [], fetchedAt: 0 });
      (service as any).toolCache.set("b", { tools: [], fetchedAt: 0 });

      service.invalidateCache("a");
      expect((service as any).toolCache.has("a")).toBe(false);
      expect((service as any).toolCache.has("b")).toBe(true);

      service.invalidateCache();
      expect((service as any).toolCache.size).toBe(0);
    });
  });
});
