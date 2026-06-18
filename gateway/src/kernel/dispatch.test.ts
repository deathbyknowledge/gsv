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
  it("routes target syscalls to browser driver targets", async () => {
    const send = vi.fn();
    const cancelRoute = vi.fn();
    const registerRoute = vi.fn(async () => ({ cancel: cancelRoute }));
    const deps = {
      connections: new Map([
        ["conn_1", {
          state: {
            identity: {
              role: "driver",
              process: { uid: 1000, gid: 1000, gids: [1000], username: "sam", home: "/home/sam" },
              capabilities: ["*"],
              device: "browser:conn_1",
              implements: ["fs.*", "shell.*"],
            },
          },
          send,
        }],
      ]),
      registerRoute,
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
    expect(registerRoute).toHaveBeenCalledWith({
      id: "req_1",
      call: "fs.read",
      origin: { type: "process", id: "proc_1" },
      deviceId: "browser:conn_1",
      ttlMs: 60_000,
    });
    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: "req",
      id: "req_1",
      call: "fs.read",
      args: { path: "/desktop/windows.json" },
    }));
    expect(registerRoute.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(cancelRoute).not.toHaveBeenCalled();
  });

  it("fails routed syscalls before sending when route registration fails", async () => {
    const send = vi.fn();
    const registerRoute = vi.fn(async () => {
      throw new Error("schedule unavailable");
    });
    const deps = {
      connections: new Map([
        ["conn_1", {
          state: {
            identity: {
              role: "driver",
              process: { uid: 1000, gid: 1000, gids: [1000], username: "sam", home: "/home/sam" },
              capabilities: ["*"],
              device: "browser:conn_1",
              implements: ["fs.*", "shell.*"],
            },
          },
          send,
        }],
      ]),
      registerRoute,
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

    expect(result).toEqual({
      handled: true,
      response: {
        type: "res",
        id: "req_1",
        ok: false,
        error: {
          code: 500,
          message: "Failed to register route for fs.read: schedule unavailable",
        },
      },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("fails routed transfer syscalls before sending when binary route registration fails", async () => {
    const send = vi.fn();
    const cancelRoute = vi.fn();
    const registerRoute = vi.fn(async () => ({ cancel: cancelRoute }));
    const registerBinaryRoute = vi.fn(() => {
      throw new Error("Binary stream id already active: 123");
    });
    const deps = {
      connections: new Map([
        ["conn_1", {
          state: {
            identity: {
              role: "driver",
              process: { uid: 1000, gid: 1000, gids: [1000], username: "sam", home: "/home/sam" },
              capabilities: ["*"],
              device: "browser:conn_1",
              implements: ["fs.*", "shell.*"],
            },
          },
          send,
        }],
      ]),
      registerRoute,
      registerBinaryRoute,
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
      call: "fs.transfer.receive",
      args: {
        target: "browser:conn_1",
        path: "/tmp/file.txt",
        streamId: 123,
        expectedSize: 4,
      },
    } as RequestFrame<"fs.transfer.receive">;

    const result = await dispatch(
      frame,
      { type: "process", id: "proc_1" },
      ctx,
      deps,
    );

    expect(result).toEqual({
      handled: true,
      response: {
        type: "res",
        id: "req_1",
        ok: false,
        error: {
          code: 500,
          message: "Failed to register route for fs.transfer.receive: Binary stream id already active: 123",
        },
      },
    });
    expect(registerRoute).toHaveBeenCalledOnce();
    expect(registerBinaryRoute).toHaveBeenCalledWith({
      requestId: "req_1",
      streamId: 123,
      origin: { type: "process", id: "proc_1" },
      deviceId: "browser:conn_1",
      ttlMs: 60_000,
    });
    expect(cancelRoute).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("cancels registered routes when sending to the target fails", async () => {
    const send = vi.fn(() => {
      throw new Error("websocket closed");
    });
    const cancelRoute = vi.fn();
    const registerRoute = vi.fn(async () => ({ cancel: cancelRoute }));
    const deps = {
      connections: new Map([
        ["conn_1", {
          state: {
            identity: {
              role: "driver",
              process: { uid: 1000, gid: 1000, gids: [1000], username: "sam", home: "/home/sam" },
              capabilities: ["*"],
              device: "browser:conn_1",
              implements: ["fs.*", "shell.*"],
            },
          },
          send,
        }],
      ]),
      registerRoute,
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

    expect(result).toEqual({
      handled: true,
      response: {
        type: "res",
        id: "req_1",
        ok: false,
        error: {
          code: 500,
          message: "Failed to send fs.read to device browser:conn_1: websocket closed",
        },
      },
    });
    expect(cancelRoute).toHaveBeenCalledOnce();
  });

  it("returns cached failed shell sessions instead of rerouting to the device", async () => {
    const registerRoute = vi.fn();
    const deps = {
      connections: new Map(),
      registerRoute,
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
    expect(registerRoute).not.toHaveBeenCalled();
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
      connections: new Map(),
      registerRoute: vi.fn(),
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
    expect(deps.registerRoute).not.toHaveBeenCalled();
  });
});
