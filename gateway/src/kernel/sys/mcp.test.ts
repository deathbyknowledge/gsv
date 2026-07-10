import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";
import type { McpServerRecord } from "../mcp-store";
import {
  handleSysMcpAdd,
  handleSysMcpCall,
  handleSysMcpList,
  handleSysMcpRemove,
} from "./mcp";

type FakeMcpServers = {
  records: Map<string, McpServerRecord>;
  sdkServers: Map<string, SdkMcpServerRow>;
  upsert: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  findByUidName: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  addSdkServer: (input: {
    serverId: string;
    uid: number;
    name: string;
    url: string;
    transport?: string;
  }) => void;
};

type SdkMcpServerRow = {
  id: string;
  name: string;
  server_url: string;
  client_id: string | null;
  auth_url: string | null;
  callback_url: string;
  server_options: string | null;
};

function makeContext(
  uid: number,
  mcpServers: FakeMcpServers,
  options: { ownerUid?: number; processId?: string } = {},
): KernelContext {
  const ownerUid = options.ownerUid ?? uid;
  return {
    identity: {
      role: "user",
      process: {
        uid,
        gid: uid,
        gids: [uid],
        username: uid === 0 ? "root" : `user${uid}`,
        home: uid === 0 ? "/root" : `/home/user${uid}`,
        cwd: uid === 0 ? "/root" : `/home/user${uid}`,
      },
      capabilities: ["*"],
    },
    processId: options.processId,
    procs: {
      getOwnerUid: vi.fn((processId: string) =>
        processId === options.processId ? ownerUid : null
      ),
    },
    mcpServers,
    mcp: {
      mcpConnections: {},
      listServers: vi.fn(() => [...mcpServers.sdkServers.values()]),
      listTools: vi.fn(() => []),
      listResources: vi.fn(() => []),
      listPrompts: vi.fn(() => []),
    },
    addMcpServerConnection: vi.fn(async (input) => {
      mcpServers.addSdkServer({
        serverId: "server-1",
        uid: input.uid,
        name: input.name,
        url: input.url,
        transport: input.transport.type,
      });
      return {
        id: "server-1",
      };
    }),
    broadcastToUid: vi.fn(),
    removeMcpServerConnection: vi.fn(async () => undefined),
    callMcpTool: vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
    })),
  } as unknown as KernelContext;
}

function createFakeMcpServers(): FakeMcpServers {
  const fake: FakeMcpServers = {
    records: new Map(),
    sdkServers: new Map(),
    upsert: vi.fn((input) => {
      const existing = fake.records.get(input.serverId);
      const now = input.now ?? 1_700_000_000_000;
      const record: McpServerRecord = {
        serverId: input.serverId,
        uid: input.uid,
        name: input.name,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      fake.records.set(record.serverId, record);
      return record;
    }),
    get: vi.fn((serverId) => fake.records.get(serverId) ?? null),
    findByUidName: vi.fn((uid, name) =>
      [...fake.records.values()].filter((record) =>
        record.uid === uid && record.name === name
      )
    ),
    list: vi.fn((uid) =>
      [...fake.records.values()].filter((record) => uid === undefined || record.uid === uid)
    ),
    delete: vi.fn((serverId, uid) => {
      const record = fake.records.get(serverId);
      if (!record || (uid !== undefined && record.uid !== uid)) return false;
      return fake.records.delete(serverId);
    }),
    addSdkServer: (input) => {
      fake.sdkServers.set(input.serverId, {
        id: input.serverId,
        name: `u${input.uid}:${input.name}`,
        server_url: new URL(input.url).href,
        client_id: null,
        auth_url: null,
        callback_url: "",
        server_options: JSON.stringify({
          transport: {
            type: input.transport ?? "auto",
          },
        }),
      });
    },
  };
  return fake;
}

describe("sys.mcp handlers", () => {
  let mcpServers: FakeMcpServers;

  beforeEach(() => {
    mcpServers = createFakeMcpServers();
  });

  it("adds a user-scoped MCP server through the connection manager", async () => {
    const ctx = makeContext(1000, mcpServers);

    const result = await handleSysMcpAdd({
      name: "GitHub",
      url: "https://mcp.example.com/mcp",
      callbackHost: "https://gsv.example.com",
      transport: { type: "streamable-http" },
    }, ctx);

    expect(ctx.addMcpServerConnection).toHaveBeenCalledWith(expect.objectContaining({
      uid: 1000,
      name: "GitHub",
      url: "https://mcp.example.com/mcp",
      callbackHost: "https://gsv.example.com",
      transport: { type: "streamable-http" },
    }));
    expect(result.server).toMatchObject({
      serverId: "server-1",
      uid: 1000,
      name: "GitHub",
    });
  });

  it("broadcasts MCP adds after storing the owner-scoped server record", async () => {
    const ctx = makeContext(1000, mcpServers);
    const broadcastToUid = ctx.broadcastToUid as ReturnType<typeof vi.fn>;

    await handleSysMcpAdd({
      name: "GitHub",
      url: "https://mcp.example.com/mcp",
    }, ctx);

    expect(broadcastToUid).toHaveBeenCalledWith(1000, "mcp.changed");
    expect(broadcastToUid.mock.invocationCallOrder[0]).toBeGreaterThan(
      (mcpServers.upsert as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
  });

  it("deduplicates MCP adds by caller, name, and URL", async () => {
    const ctx = makeContext(1000, mcpServers);
    mcpServers.upsert({
      serverId: "server-1",
      uid: 1000,
      name: "GitHub",
    });
    mcpServers.addSdkServer({
      serverId: "server-1",
      uid: 1000,
      name: "GitHub",
      url: "https://mcp.example.com/mcp",
    });

    const existing = await handleSysMcpAdd({
      name: "GitHub",
      url: "https://mcp.example.com/mcp",
    }, ctx);
    expect(existing.server.serverId).toBe("server-1");
    expect(ctx.addMcpServerConnection).not.toHaveBeenCalled();

    (ctx.addMcpServerConnection as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "server-2",
    });
    await handleSysMcpAdd({
      name: "GitHub Work",
      url: "https://mcp.example.com/mcp",
    }, ctx);
    expect(ctx.addMcpServerConnection).toHaveBeenCalledWith(expect.objectContaining({
      uid: 1000,
      name: "GitHub Work",
      url: "https://mcp.example.com/mcp",
    }));
  });

  it("rejects non-root MCP add for another uid", async () => {
    const ctx = makeContext(1000, mcpServers);

    await expect(handleSysMcpAdd({
      uid: 1001,
      name: "GitHub",
      url: "https://mcp.example.com/mcp",
    }, ctx)).rejects.toThrow("Permission denied: cannot add MCP servers for another user");
    expect(ctx.addMcpServerConnection).not.toHaveBeenCalled();
  });

  it("rejects non-local plain HTTP MCP servers", async () => {
    const ctx = makeContext(1000, mcpServers);

    await expect(handleSysMcpAdd({
      name: "Insecure",
      url: "http://mcp.example.com/mcp",
    }, ctx)).rejects.toThrow("url must use https");
    expect(ctx.addMcpServerConnection).not.toHaveBeenCalled();
  });

  it("lists and removes only caller-owned MCP servers", async () => {
    const ctx = makeContext(1000, mcpServers);
    mcpServers.upsert({
      serverId: "server-1",
      uid: 1000,
      name: "Owned",
    });
    mcpServers.addSdkServer({
      serverId: "server-1",
      uid: 1000,
      name: "Owned",
      url: "https://owned.example.com/mcp",
    });
    mcpServers.upsert({
      serverId: "server-2",
      uid: 1001,
      name: "Other",
    });
    mcpServers.addSdkServer({
      serverId: "server-2",
      uid: 1001,
      name: "Other",
      url: "https://other.example.com/mcp",
    });

    expect(handleSysMcpList({}, ctx).servers.map((server) => server.serverId)).toEqual(["server-1"]);
    expect(await handleSysMcpRemove({ serverId: "server-2" }, ctx)).toEqual({ removed: false });
    expect(await handleSysMcpRemove({ serverId: "server-1" }, ctx)).toEqual({ removed: true });
    expect(ctx.removeMcpServerConnection).toHaveBeenCalledWith("server-1");
    expect(ctx.broadcastToUid).toHaveBeenCalledWith(1000, "mcp.changed");
  });

  it("defaults process-originated MCP access to the owning human", async () => {
    const ctx = makeContext(2000, mcpServers, {
      ownerUid: 1000,
      processId: "proc-agent",
    });
    mcpServers.upsert({
      serverId: "server-1",
      uid: 1000,
      name: "Owner Search",
    });
    mcpServers.addSdkServer({
      serverId: "server-1",
      uid: 1000,
      name: "Owner Search",
      url: "https://owner.example.com/mcp",
    });
    mcpServers.upsert({
      serverId: "server-2",
      uid: 2000,
      name: "Agent Local",
    });
    mcpServers.addSdkServer({
      serverId: "server-2",
      uid: 2000,
      name: "Agent Local",
      url: "https://agent.example.com/mcp",
    });

    expect(handleSysMcpList({}, ctx).servers.map((server) => server.serverId)).toEqual(["server-1"]);

    await handleSysMcpCall({
      serverId: "server-1",
      name: "lookup",
      arguments: { query: "test" },
    }, ctx);

    expect(ctx.callMcpTool).toHaveBeenCalledWith("server-1", "lookup", { query: "test" });
  });

  it("calls only caller-owned MCP tools", async () => {
    const ctx = makeContext(1000, mcpServers);
    mcpServers.upsert({
      serverId: "server-1",
      uid: 1000,
      name: "Owned",
    });

    const result = await handleSysMcpCall({
      serverId: "server-1",
      name: "lookup",
      arguments: { query: "test" },
    }, ctx);

    expect(ctx.callMcpTool).toHaveBeenCalledWith("server-1", "lookup", { query: "test" });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    await expect(handleSysMcpCall({
      serverId: "missing",
      name: "lookup",
    }, ctx)).rejects.toThrow("MCP server not found");
  });

  it("reports discovery errors without mutating manager state", () => {
    const ctx = makeContext(1000, mcpServers);
    mcpServers.upsert({
      serverId: "server-1",
      uid: 1000,
      name: "Ready",
    });
    mcpServers.addSdkServer({
      serverId: "server-1",
      uid: 1000,
      name: "Ready",
      url: "https://ready.example.com/mcp",
    });
    ctx.mcp.mcpConnections["server-1"] = {
      connectionState: "connected",
      connectionError: "Capability discovery failed",
    } as never;
    (ctx.mcp.listTools as ReturnType<typeof vi.fn>).mockReturnValue([{
      name: "search",
      description: "Search",
      inputSchema: { type: "object" },
    }]);

    const result = handleSysMcpList({}, ctx);

    expect(result.servers[0]).toMatchObject({
      serverId: "server-1",
      state: "failed",
      error: "Capability discovery failed",
      tools: [{
        name: "search",
        description: "Search",
      }],
    });
    expect(ctx.mcp.mcpConnections["server-1"].connectionState).toBe("connected");
  });

  it("keeps ready servers with zero tools ready", () => {
    const ctx = makeContext(1000, mcpServers);
    mcpServers.upsert({
      serverId: "server-1",
      uid: 1000,
      name: "Empty MCP",
    });
    mcpServers.addSdkServer({
      serverId: "server-1",
      uid: 1000,
      name: "Empty MCP",
      url: "https://empty.example.com/mcp",
    });
    ctx.mcp.mcpConnections["server-1"] = {
      connectionState: "ready",
      connectionError: null,
    } as never;

    const result = handleSysMcpList({}, ctx);

    expect(result.servers[0]).toMatchObject({
      serverId: "server-1",
      state: "ready",
      error: null,
      tools: [],
    });
  });
});
