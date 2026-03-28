import { describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import { handleProcSpawn } from "./proc-handlers";
import { sendFrameToProcess } from "../shared/utils";

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(async () => ({
    type: "res",
    id: crypto.randomUUID(),
    ok: true,
    data: { ok: true },
  })),
}));

function makeContext(uid: number): KernelContext {
  return {
    env: {} as Env,
    sql: {} as SqlStorage,
    auth: {} as KernelContext["auth"],
    caps: {} as KernelContext["caps"],
    config: {} as KernelContext["config"],
    devices: {} as KernelContext["devices"],
    procs: {
      get: vi.fn(() => null),
      spawn: vi.fn(),
    } as unknown as KernelContext["procs"],
    workspaces: {} as KernelContext["workspaces"],
    adapters: {} as KernelContext["adapters"],
    runRoutes: {} as KernelContext["runRoutes"],
    connection: {} as KernelContext["connection"],
    identity: {
      role: "user",
      process: {
        uid,
        gid: uid,
        gids: [uid],
        username: uid === 0 ? "root" : "sam",
        home: uid === 0 ? "/root" : "/home/sam",
        cwd: uid === 0 ? "/root" : "/home/sam",
        workspaceId: null,
      },
      capabilities: uid === 0 ? ["*"] : ["proc.*"],
    },
    serverVersion: "test",
  };
}

describe("proc.spawn", () => {
  it("spawns mcp processes with an explicit mcp: pid prefix", async () => {
    const ctx = makeContext(0);
    const result = await handleProcSpawn({ profile: "mcp", label: "MCP Operator" }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pid.startsWith("mcp:")).toBe(true);
      expect(result.profile).toBe("mcp");
    }

    const procs = ctx.procs as unknown as { spawn: ReturnType<typeof vi.fn> };
    expect(procs.spawn).toHaveBeenCalledTimes(1);
    expect(sendFrameToProcess).toHaveBeenCalled();
  });

  it("rejects mcp spawns for non-root callers", async () => {
    const ctx = makeContext(1000);
    const result = await handleProcSpawn({ profile: "mcp" }, ctx);

    expect(result).toEqual({
      ok: false,
      error: "Permission denied: mcp profile requires root",
    });

    const procs = ctx.procs as unknown as { spawn: ReturnType<typeof vi.fn> };
    expect(procs.spawn).not.toHaveBeenCalled();
  });
});
