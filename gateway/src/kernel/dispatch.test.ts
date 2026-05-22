import { describe, expect, it, vi } from "vitest";
import { dispatch, type DispatchDeps } from "./dispatch";
import type { KernelContext } from "./context";
import type { RequestFrame } from "../protocol/frames";

function deviceRecord(deviceId: string, online: boolean) {
  return {
    device_id: deviceId,
    owner_uid: 1000,
    label: deviceId,
    description: "",
    implements: ["fs.*", "shell.*"],
    platform: "browser",
    version: "test",
    lifecycle: "persistent" as const,
    online,
    first_seen_at: 1,
    last_seen_at: 2,
    connected_at: online ? 2 : null,
    disconnected_at: online ? null : 2,
  };
}

function makeContext(): KernelContext {
  return {
    identity: {
      process: {
        uid: 1000,
        gid: 1000,
        gids: [1000],
        username: "sam",
        home: "/home/sam",
      },
    },
    devices: {
      canAccess: vi.fn(() => true),
      get: vi.fn(() => deviceRecord("macbook", false)),
    },
  } as unknown as KernelContext;
}

describe("dispatch", () => {
  it("routes target syscalls to user-provided browser targets", async () => {
    const send = vi.fn();
    const scheduleExpiry = vi.fn();
    const routingTable = { register: vi.fn() };
    const deps = {
      routingTable,
      connections: new Map([
        ["conn_1", {
          state: {
            identity: {
              role: "user",
              process: { uid: 1000, gid: 1000, gids: [1000], username: "sam", home: "/home/sam" },
              capabilities: ["*"],
            },
            providedTargets: [{ targetId: "browser:conn_1" }],
          },
          send,
        }],
      ]),
      scheduleExpiry,
      shellSessions: {
        get: vi.fn(),
      },
    } as unknown as DispatchDeps;
    const ctx = {
      ...makeContext(),
      devices: {
        canAccess: vi.fn(() => true),
        get: vi.fn(() => deviceRecord("browser:conn_1", true)),
      },
    } as unknown as KernelContext;
    const frame = {
      type: "req",
      id: "req_1",
      call: "fs.read",
      args: { target: "browser:conn_1", path: "/desktop/windows.json" },
    } as RequestFrame<"fs.read">;

    const result = await dispatch(
      frame,
      { type: "process", id: "proc_1" },
      ctx,
      deps,
    );

    expect(result).toEqual({ handled: false });
    expect(scheduleExpiry).toHaveBeenCalledWith("req_1", 60_000);
    expect(routingTable.register).toHaveBeenCalledWith(
      "req_1",
      "fs.read",
      { type: "process", id: "proc_1" },
      "browser:conn_1",
      { ttlMs: 60_000 },
    );
    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: "req",
      id: "req_1",
      call: "fs.read",
      args: { path: "/desktop/windows.json" },
    }));
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(scheduleExpiry.mock.invocationCallOrder[0]);
  });

  it("returns cached failed shell sessions instead of rerouting to the device", async () => {
    const scheduleExpiry = vi.fn();
    const routingTable = { register: vi.fn() };
    const deps = {
      routingTable,
      connections: new Map(),
      scheduleExpiry,
      shellSessions: {
        get: vi.fn(() => ({
          sessionId: "sh_1",
          deviceId: "macbook",
          status: "failed",
          exitCode: null,
          error: "Device disconnected",
          createdAt: 1_000,
          updatedAt: 2_000,
          expiresAt: null,
        })),
      },
    } as unknown as DispatchDeps;
    const frame = {
      type: "req",
      id: "req_1",
      call: "shell.exec",
      args: { sessionId: "sh_1", input: "" },
    } as RequestFrame<"shell.exec">;

    const result = await dispatch(
      frame,
      { type: "process", id: "proc_1" },
      makeContext(),
      deps,
    );

    expect(result).toEqual({
      handled: true,
      response: {
        type: "res",
        id: "req_1",
        ok: true,
        data: {
          status: "failed",
          output: "",
          error: "Device disconnected",
          sessionId: "sh_1",
        },
      },
    });
    expect(scheduleExpiry).not.toHaveBeenCalled();
    expect(routingTable.register).not.toHaveBeenCalled();
  });

  it("routes adapter shell targets through adapter workers", async () => {
    const adapterShellExec = vi.fn(async () => ({
      status: "completed" as const,
      output: "ok",
      exitCode: 0,
      ok: true as const,
      pid: 0,
      stdout: "ok",
      stderr: "",
    }));
    const deps = {
      routingTable: { register: vi.fn() },
      connections: new Map(),
      scheduleExpiry: vi.fn(),
      shellSessions: {
        get: vi.fn(),
      },
    } as unknown as DispatchDeps;
    const ctx = {
      identity: {
        role: "user",
        process: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "sam",
          home: "/home/sam",
          cwd: "/home/sam",
          workspaceId: null,
        },
        capabilities: ["*"],
      },
      env: {
        CHANNEL_WHATSAPP: { adapterShellExec },
      },
      devices: {
        canAccess: vi.fn(),
        get: vi.fn(),
        canHandle: vi.fn(),
      },
      adapters: {
        identityLinks: {
          list: vi.fn(() => [{
            adapter: "whatsapp",
            accountId: "primary",
            actorId: "wa:jid:123@s.whatsapp.net",
            uid: 1000,
            createdAt: 1,
            linkedByUid: 1000,
            metadata: null,
          }]),
        },
        status: {
          list: vi.fn(() => [{
            adapter: "whatsapp",
            accountId: "primary",
            connected: true,
            authenticated: true,
            mode: "websocket",
            updatedAt: 2,
          }]),
        },
      },
    } as unknown as KernelContext;
    const frame = {
      type: "req",
      id: "req_adapter",
      call: "shell.exec",
      args: { target: "adapter:whatsapp:primary", input: "send +15551234567 hello" },
    } as RequestFrame<"shell.exec">;

    const result = await dispatch(
      frame,
      { type: "app", id: "app_1" },
      ctx,
      deps,
    );

    expect(result).toEqual({
      handled: true,
      response: {
        type: "res",
        id: "req_adapter",
        ok: true,
        data: {
          status: "completed",
          output: "ok",
          exitCode: 0,
          ok: true,
          pid: 0,
          stdout: "ok",
          stderr: "",
        },
      },
    });
    expect(adapterShellExec).toHaveBeenCalledWith("primary", { input: "send +15551234567 hello" });
    expect(deps.routingTable.register).not.toHaveBeenCalled();
  });
});
