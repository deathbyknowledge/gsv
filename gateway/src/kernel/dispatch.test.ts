import { describe, expect, it, vi } from "vitest";
import { dispatch, type DispatchDeps } from "./dispatch";
import type { KernelContext } from "./context";
import type { RequestFrame } from "../protocol/frames";

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
      get: vi.fn(() => ({ online: false })),
      canHandle: vi.fn(() => true),
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
        get: vi.fn(() => ({ online: true })),
        canHandle: vi.fn(() => true),
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
});
