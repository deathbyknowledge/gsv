type KernelTestValue<T = string | number | boolean | null | undefined> = T;

import { describe, expect, it, vi } from "vitest";
import { testPeer } from "../test-support/peers";
import { dispatch, routedFrameTtlMs, type DispatchDeps } from "./dispatch";
import type { KernelContext } from "./context";
import type { RequestFrame } from "../protocol/frames";

function deviceRecord(targetId: string, online: boolean, implementsList = ["fs.*", "shell.*"]) {
  return {
    target_id: targetId,
    owner_uid: 1000,
    label: targetId,
    description: "",
    implements: implementsList,
    platform: "browser",
    version: "test",
    online,
    first_seen_at: 1,
    last_seen_at: 2,
    connected_at: online ? 2 : null,
    disconnected_at: online ? null : 2,
  };
}

function operationPeer(
  id: string,
  implementsList: string[],
  kind: "human" | "machine" = "machine",
) {
  return {
    id,
    sessionId: `session:${id}`,
    principal: {
      kind,
      account: {
        uid: 1000,
        gid: 1000,
        gids: [1000],
        username: "sam",
        home: "/home/sam",
        cwd: "/home/sam",
      },
    },
    grant: {
      calls: kind === "human" ? ["*"] : [],
      signals: kind === "human"
        ? ["target.status", "peer.pong", "message.committed"]
        : ["target.status", "peer.pong"],
      implements: implementsList,
    },
  };
}

function makeContext(): KernelContext {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
    peer: testPeer({ kind: "human", account: {
        uid: 1000,
        gid: 1000,
        gids: [1000],
        username: "sam",
        home: "/home/sam",
      } }),
    targets: {
      canAccess: vi.fn(() => true),
      get: vi.fn(() => deviceRecord("macbook", false)),
    },
    auth: {
      getPasswdByUid: vi.fn(() => null),
    },
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as KernelContext;
}

describe("routed frame deadlines", () => {
  it("leaves enough time for browser shell waits", () => {
    expect(routedFrameTtlMs({
      type: "req",
      id: "shell-default",
      call: "shell.exec",
      args: { input: "page wait '#ready' --timeout 120000" },
    })).toBe(11 * 60_000);
    expect(routedFrameTtlMs({
      type: "req",
      id: "shell-explicit",
      call: "shell.exec",
      args: { input: "sleep 120", timeout: 120_000 },
    })).toBe(130_000);
  });
});

function sendFrame(connection: { send(message: string): void }, frame: KernelTestValue): void {
  connection.send(JSON.stringify(frame));
}

describe("dispatch", () => {
  it("routes target syscalls to connected human endpoints", async () => {
    const send = vi.fn();
    const cancelRoute = vi.fn();
    const registerRoute = vi.fn(async () => ({ cancel: cancelRoute }));
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const deps = {
      sendFrame,
      connections: new Map([
        ["conn_1", {
          id: "conn_1",
          state: {
            step: "connected",
            peer: operationPeer("browser:conn_1", ["fs.*", "shell.*"], "human"),
          },
          send,
        }],
      ]),
      registerRoute,
      shellSessions: {
        get: vi.fn(),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as DispatchDeps;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      ...makeContext(),
      targets: {
        canAccess: vi.fn(() => true),
        get: vi.fn(() => deviceRecord("browser:conn_1", true)),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const frame = {
      type: "req",
      id: "req_1",
      call: "fs.read",
      args: { target: "browser:conn_1", path: "/desktop/windows.json" },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
      targetId: "browser:conn_1",
      peerConnectionId: "conn_1",
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

  it("does not route work to a superseded driver connection", async () => {
    const registerRoute = vi.fn();
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const deps = {
      sendFrame,
      connections: new Map([
        ["old-connection", {
          id: "old-connection",
          state: {
            step: "superseded",
            peer: operationPeer("browser", ["fs.*"]),
          },
          send: vi.fn(),
        }],
      ]),
      registerRoute,
      shellSessions: { get: vi.fn() },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as DispatchDeps;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      ...makeContext(),
      targets: {
        canAccess: vi.fn(() => true),
        get: vi.fn(() => deviceRecord("browser", true)),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const result = await dispatch(
      {
        type: "req",
        id: "request-1",
        call: "fs.read",
        args: { target: "browser", path: "/tmp/file" },
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      } as RequestFrame<"fs.read">,
      { type: "process", id: "process-1" },
      ctx,
      deps,
    );

    expect(result).toEqual({
      handled: true,
      response: {
        type: "res",
        id: "request-1",
        ok: false,
        error: { code: 503, message: "No active connection for device: browser" },
      },
    });
    expect(registerRoute).not.toHaveBeenCalled();
  });

  it("uses the requested net.fetch timeout for routed device route ttl", async () => {
    const send = vi.fn();
    const registerRoute = vi.fn(async () => ({ cancel: vi.fn() }));
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const deps = {
      sendFrame,
      connections: new Map([
        ["conn_1", {
          id: "conn_1",
          state: {
            step: "connected",
            peer: operationPeer("linux-machine", ["net.fetch"]),
          },
          send,
        }],
      ]),
      registerRoute,
      shellSessions: {
        get: vi.fn(),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as DispatchDeps;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      ...makeContext(),
      targets: {
        canAccess: vi.fn(() => true),
        get: vi.fn(() => deviceRecord("linux-machine", true, ["net.fetch"])),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const frame = {
      type: "req",
      id: "req_fetch",
      call: "net.fetch",
      args: {
        target: "linux-machine",
        url: "https://provider.example/v1/chat/completions",
        method: "POST",
        timeoutMs: 180_000,
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame<"net.fetch">;

    const result = await dispatch(
      frame,
      { type: "process", id: "proc_1" },
      ctx,
      deps,
    );

    expect(result).toEqual({ handled: false });
    expect(registerRoute).toHaveBeenCalledWith({
      id: "req_fetch",
      call: "net.fetch",
      origin: { type: "process", id: "proc_1" },
      targetId: "linux-machine",
      peerConnectionId: "conn_1",
      ttlMs: 180_000,
    });
    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: "req",
      id: "req_fetch",
      call: "net.fetch",
      args: {
        url: "https://provider.example/v1/chat/completions",
        method: "POST",
        timeoutMs: 180_000,
      },
    }));
  });

  it("fails routed syscalls before sending when route registration fails", async () => {
    const send = vi.fn();
    const registerRoute = vi.fn(async () => {
      throw new Error("schedule unavailable");
    });
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const deps = {
      sendFrame,
      connections: new Map([
        ["conn_1", {
          id: "conn_1",
          state: {
            step: "connected",
            peer: operationPeer("browser:conn_1", ["fs.*", "shell.*"]),
          },
          send,
        }],
      ]),
      registerRoute,
      shellSessions: {
        get: vi.fn(),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as DispatchDeps;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      ...makeContext(),
      targets: {
        canAccess: vi.fn(() => true),
        get: vi.fn(() => deviceRecord("browser:conn_1", true)),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const frame = {
      type: "req",
      id: "req_1",
      call: "fs.read",
      args: { target: "browser:conn_1", path: "/desktop/windows.json" },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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

  it("forwards request bodies to device targets", async () => {
    const connection = {
      id: "conn_1",
      state: {
        step: "connected",
        peer: operationPeer("browser:conn_1", ["fs.*", "shell.*"]),
      },
      send: vi.fn(),
    };
    const outgoing = { cancel: vi.fn(async () => {}) };
    const forwarded = vi.fn(() => outgoing);
    const attachBody = vi.fn();
    const registerRoute = vi.fn(async () => ({ cancel: vi.fn(), attachBody }));
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const deps = {
      sendFrame: forwarded,
      connections: new Map([["conn_1", connection]]),
      registerRoute,
      shellSessions: {
        get: vi.fn(),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as DispatchDeps;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      ...makeContext(),
      targets: {
        canAccess: vi.fn(() => true),
        get: vi.fn(() => deviceRecord("browser:conn_1", true)),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
    const body = {
      stream: new ReadableStream<Uint8Array>(),
      length: 0,
    };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const frame = {
      type: "req",
      id: "req_1",
      call: "fs.transfer.receive",
      args: {
        target: "browser:conn_1",
        path: "/tmp/file.txt",
      },
      body,
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame<"fs.transfer.receive">;

    const result = await dispatch(
      frame,
      { type: "process", id: "proc_1" },
      ctx,
      deps,
    );

    expect(result).toEqual({ handled: false });
    expect(registerRoute).toHaveBeenCalledOnce();
    expect(forwarded).toHaveBeenCalledWith(connection, {
      type: "req",
      id: "req_1",
      call: "fs.transfer.receive",
      args: { path: "/tmp/file.txt" },
      body,
    });
    expect(attachBody).toHaveBeenCalledWith(outgoing);
  });

  it("cancels registered routes when sending to the target fails", async () => {
    const send = vi.fn(() => {
      throw new Error("websocket closed");
    });
    const cancelRoute = vi.fn();
    const registerRoute = vi.fn(async () => ({ cancel: cancelRoute }));
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const deps = {
      sendFrame,
      connections: new Map([
        ["conn_1", {
          id: "conn_1",
          state: {
            step: "connected",
            peer: operationPeer("browser:conn_1", ["fs.*", "shell.*"]),
          },
          send,
        }],
      ]),
      registerRoute,
      shellSessions: {
        get: vi.fn(),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as DispatchDeps;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      ...makeContext(),
      targets: {
        canAccess: vi.fn(() => true),
        get: vi.fn(() => deviceRecord("browser:conn_1", true)),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const frame = {
      type: "req",
      id: "req_1",
      call: "fs.read",
      args: { target: "browser:conn_1", path: "/desktop/windows.json" },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const deps = {
      connections: new Map(),
      registerRoute,
      shellSessions: {
        get: vi.fn(() => ({
          sessionId: "sh_1",
          targetId: "macbook",
          status: "failed",
          exitCode: null,
          error: "Device disconnected",
          createdAt: 1_000,
          updatedAt: 2_000,
          expiresAt: null,
        })),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as DispatchDeps;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const frame = {
      type: "req",
      id: "req_1",
      call: "shell.exec",
      args: { sessionId: "sh_1", input: "" },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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

  it("runs gsv target syscalls through the native target provider", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const deps = {
      connections: new Map(),
      registerRoute: vi.fn(),
      shellSessions: {
        get: vi.fn(),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as DispatchDeps;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const frame = {
      type: "req",
      id: "req_gsv",
      call: "shell.exec",
      args: { target: "gsv", input: "" },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
        id: "req_gsv",
        ok: true,
        data: {
          status: "failed",
          output: "",
          error: "input must not be empty",
        },
      },
    });
    expect(frame.args).toEqual({ input: "" });
    expect(deps.registerRoute).not.toHaveBeenCalled();
  });

  it("preserves ai.text.generate target for native AI routing checks", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const deps = {
      connections: new Map(),
      registerRoute: vi.fn(),
      shellSessions: {
        get: vi.fn(),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as DispatchDeps;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const frame = {
      type: "req",
      id: "req_ai",
      call: "ai.text.generate",
      args: { target: "local-gpu", messages: [] },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame<"ai.text.generate">;

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
        id: "req_ai",
        ok: false,
        error: {
          code: 500,
          message: "AI text generation target is not available: local-gpu",
        },
      },
    });
    expect(frame.args).toEqual({ target: "local-gpu", messages: [] });
    expect(deps.registerRoute).not.toHaveBeenCalled();
  });

  it("rejects obsolete adapter target ids", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const deps = {
      connections: new Map(),
      registerRoute: vi.fn(),
      shellSessions: {
        get: vi.fn(),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as DispatchDeps;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const frame = {
      type: "req",
      id: "req_adapter",
      call: "shell.exec",
      args: { target: "adapter:whatsapp:primary", input: "send +15551234567 hello" },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame<"shell.exec">;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      ...makeContext(),
      targets: {
        canAccess: vi.fn(() => false),
        get: vi.fn(() => null),
      },
      adapters: { identityLinks: { list: vi.fn(() => []) } },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

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
        ok: false,
        error: {
          code: 403,
          message: "Access denied to target: adapter:whatsapp:primary",
        },
      },
    });
    expect(deps.registerRoute).not.toHaveBeenCalled();
  });
});
