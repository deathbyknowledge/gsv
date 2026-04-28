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
