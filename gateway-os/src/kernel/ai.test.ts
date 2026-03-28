import { describe, expect, it } from "vitest";
import type { KernelContext } from "./context";
import { handleAiTools } from "./ai";

function makeContext(
  options: {
    uid: number;
    capabilities: string[];
  },
): KernelContext {
  return {
    env: {} as Env,
    sql: {} as SqlStorage,
    auth: {} as KernelContext["auth"],
    caps: {} as KernelContext["caps"],
    config: {} as KernelContext["config"],
    devices: {
      listForUser() {
        return [];
      },
    } as unknown as KernelContext["devices"],
    procs: {} as KernelContext["procs"],
    workspaces: {} as KernelContext["workspaces"],
    adapters: {} as KernelContext["adapters"],
    runRoutes: {} as KernelContext["runRoutes"],
    connection: {} as KernelContext["connection"],
    identity: {
      role: "user",
      process: {
        uid: options.uid,
        gid: options.uid,
        gids: [options.uid],
        username: options.uid === 0 ? "root" : "sam",
        home: options.uid === 0 ? "/root" : "/home/sam",
        cwd: options.uid === 0 ? "/root" : "/home/sam",
        workspaceId: null,
      },
      capabilities: options.capabilities,
    },
    serverVersion: "test",
  };
}

describe("ai.tools", () => {
  it("exposes operator sql tools only for mcp profile", async () => {
    const root = makeContext({ uid: 0, capabilities: ["*"] });

    const mcpTools = await handleAiTools({ profile: "mcp" }, root);
    const taskTools = await handleAiTools({ profile: "task" }, root);

    expect(mcpTools.tools.map((tool) => tool.name)).toContain("SqlQuery");
    expect(mcpTools.tools.map((tool) => tool.name)).toContain("SqlExec");
    expect(taskTools.tools.map((tool) => tool.name)).not.toContain("SqlQuery");
    expect(taskTools.tools.map((tool) => tool.name)).not.toContain("SqlExec");
  });

  it("keeps operator sql tools hidden for non-root mcp processes", async () => {
    const user = makeContext({ uid: 1000, capabilities: ["fs.*", "proc.*"] });
    const result = await handleAiTools({ profile: "mcp" }, user);

    expect(result.tools.map((tool) => tool.name)).not.toContain("SqlQuery");
    expect(result.tools.map((tool) => tool.name)).not.toContain("SqlExec");
  });
});
