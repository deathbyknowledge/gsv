import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

import { sendFrameToProcess } from "../shared/utils";
import { Kernel } from "./do";
import {
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  buildBinaryFrame,
  parseBinaryFrame,
} from "@humansandmachines/gsv/protocol";

const sendFrameToProcessMock = vi.mocked(sendFrameToProcess);

describe("Kernel frame bodies", () => {
  it("decodes WebSocket body frames into a byte stream", async () => {
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.pendingFrameBodies = new Map();
    const connection = { id: "conn-1" };

    const frame = kernel.decodeWebSocketFrame(connection, {
      type: "req",
      id: "req-1",
      call: "fs.transfer.receive",
      args: { path: "/tmp/file" },
      body: { streamId: 7, length: 3 },
    });
    kernel.handleBinaryMessage(
      connection,
      buildBinaryFrame(7, BINARY_FRAME_DATA, new Uint8Array([1, 2, 3])),
    );
    kernel.handleBinaryMessage(connection, buildBinaryFrame(7, BINARY_FRAME_END));

    expect(frame.body.length).toBe(3);
    expect(
      new Uint8Array(await new Response(frame.body.stream).arrayBuffer()),
    ).toEqual(new Uint8Array([1, 2, 3]));
    expect(kernel.pendingFrameBodies.size).toBe(0);
  });

  it("announces a response body before sending its chunks", async () => {
    const sends: Array<string | ArrayBuffer> = [];
    const pending: Promise<unknown>[] = [];
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.nextFrameBodyStreamId = 1;
    kernel.outgoingFrameBodyReaders = new Map();
    kernel.ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
    const connection = {
      id: "connection-1",
      send: (message: string | ArrayBuffer) => sends.push(message),
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });

    kernel.sendWebSocketFrame(connection, {
      type: "res",
      id: "req-1",
      ok: true,
      data: { ok: true },
      body: { stream, length: 3 },
    });
    await Promise.all(pending);

    const descriptor = JSON.parse(sends[0] as string);
    const data = parseBinaryFrame(sends[1] as ArrayBuffer);
    const end = parseBinaryFrame(sends[2] as ArrayBuffer);
    expect(descriptor.body).toEqual({ streamId: 1, length: 3 });
    expect(data).toMatchObject({ streamId: descriptor.body.streamId, flags: BINARY_FRAME_DATA });
    expect(data?.payload).toEqual(new Uint8Array([4, 5, 6]));
    expect(end).toMatchObject({ flags: BINARY_FRAME_END });
  });

  it("rejects bodies that do not match their declared length", async () => {
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.pendingFrameBodies = new Map();
    const connection = { id: "conn-1" };
    const body = kernel.receiveFrameBody(connection, { streamId: 8, length: 3 });

    kernel.handleBinaryMessage(
      connection,
      buildBinaryFrame(8, BINARY_FRAME_DATA, new Uint8Array([1, 2])),
    );
    kernel.handleBinaryMessage(connection, buildBinaryFrame(8, BINARY_FRAME_END));

    await expect(new Response(body.stream).arrayBuffer()).rejects.toThrow(
      "Body length 2 did not match 3",
    );
    expect(kernel.pendingFrameBodies.size).toBe(0);
  });

  it("does not register bodies from an invalid response route", () => {
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.pendingFrameBodies = new Map();
    kernel.routes = { get: () => ({ deviceId: "expected-device" }) };
    kernel.isConnectionForDevice = vi.fn(() => false);

    kernel.handleRes({ id: "wrong-connection" }, {
      type: "res",
      id: "req-1",
      ok: true,
      body: { streamId: 9, length: 3 },
    });

    expect(kernel.pendingFrameBodies.size).toBe(0);
  });
});

describe("Kernel device connection cleanup", () => {
  it("closes live driver connections when a machine is forgotten", () => {
    const alpha = {
      state: {
        step: "connected",
        identity: { role: "driver", device: "node-alpha" },
      },
      close: vi.fn(),
    };
    const beta = {
      state: {
        step: "connected",
        identity: { role: "driver", device: "node-beta" },
      },
      close: vi.fn(),
    };
    const user = {
      state: {
        step: "connected",
        identity: { role: "user" },
      },
      close: vi.fn(),
    };
    const kernel = Object.create(Kernel.prototype) as {
      connections: Map<string, unknown>;
      disconnectDeviceConnections(deviceId: string, reason: string): void;
      failRoutesForDevice: ReturnType<typeof vi.fn>;
      runRoutes: {
        clearForConnection: ReturnType<typeof vi.fn>;
      };
    };
    kernel.connections = new Map([
      ["alpha", alpha],
      ["beta", beta],
      ["user", user],
    ]);
    kernel.failRoutesForDevice = vi.fn();
    kernel.runRoutes = {
      clearForConnection: vi.fn(),
    };

    kernel.disconnectDeviceConnections("node-alpha", "Machine forgotten");

    expect(alpha.close).toHaveBeenCalledWith(1000, "Machine forgotten");
    expect(beta.close).not.toHaveBeenCalled();
    expect(user.close).not.toHaveBeenCalled();
    expect(kernel.connections.has("alpha")).toBe(false);
    expect(kernel.connections.has("beta")).toBe(true);
    expect(kernel.connections.has("user")).toBe(true);
    expect(kernel.runRoutes.clearForConnection).toHaveBeenCalledWith("alpha");
    expect(kernel.failRoutesForDevice).toHaveBeenCalledWith("node-alpha");
  });
});

describe("Kernel user signal broadcasts", () => {
  it("does not send user signals to driver or service sockets", () => {
    const user = { state: { identity: { role: "user", process: { uid: 1000 } } }, send: vi.fn() };
    const otherUser = { state: { identity: { role: "user", process: { uid: 2000 } } }, send: vi.fn() };
    const driver = { state: { identity: { role: "driver", process: { uid: 1000 } } }, send: vi.fn() };
    const service = { state: { identity: { role: "service", process: { uid: 1000 } } }, send: vi.fn() };
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.connections = new Map([
      ["user", user],
      ["other-user", otherUser],
      ["driver", driver],
      ["service", service],
    ]);

    kernel.broadcastToUserUid(1000, "notification.created", { id: "note-1" });

    expect(user.send).toHaveBeenCalledWith(JSON.stringify({
      type: "sig",
      signal: "notification.created",
      payload: { id: "note-1" },
    }));
    expect(otherUser.send).not.toHaveBeenCalled();
    expect(driver.send).not.toHaveBeenCalled();
    expect(service.send).not.toHaveBeenCalled();
  });
});

describe("Kernel package invalidations", () => {
  it("broadcasts package changes only within their package scope", () => {
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.broadcastToRole = vi.fn();
    kernel.broadcastToUserUid = vi.fn();

    kernel.applyPostDispatchEffects(
      { call: "pkg.add", args: {} },
      { ok: true, data: { package: { scope: { kind: "user", uid: 1000 } } } },
    );
    expect(kernel.broadcastToUserUid).toHaveBeenCalledWith(1000, "pkg.changed");
    expect(kernel.broadcastToRole).not.toHaveBeenCalled();

    kernel.broadcastToUserUid.mockClear();
    kernel.applyPostDispatchEffects(
      { call: "pkg.sync", args: {} },
      { ok: true, data: { packages: [{ scope: { kind: "global" } }] } },
    );
    expect(kernel.broadcastToRole).toHaveBeenCalledWith("user", "pkg.changed");
    expect(kernel.broadcastToUserUid).not.toHaveBeenCalled();

    kernel.broadcastToRole.mockClear();
    kernel.applyPostDispatchEffects(
      { call: "sys.bootstrap", args: {} },
      { ok: true, data: { packages: [] } },
    );
    expect(kernel.broadcastToRole).toHaveBeenCalledWith("user", "pkg.changed");

    kernel.broadcastToRole.mockClear();
    kernel.applyPostDispatchEffects(
      { call: "pkg.remove", args: {} },
      { ok: true, data: { package: {} } },
    );
    expect(kernel.broadcastToRole).not.toHaveBeenCalled();
  });
});

describe("Kernel package app authorization", () => {
  it("uses account capabilities without elevating from the package manifest", () => {
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.auth = {
      getPasswdByUid: vi.fn(() => ({
        uid: 1000,
        gid: 1000,
        username: "alice",
        home: "/home/alice",
      })),
      resolveGids: vi.fn(() => [1000, 100]),
    };
    kernel.caps = { resolve: vi.fn(() => ["fs.read"]) };

    const identity = kernel.buildAppBindingIdentity(
      {
        uid: 1000,
        username: "alice",
        packageId: "pkg-admin",
        packageName: "admin",
        entrypointName: "main",
        routeBase: "/apps/admin",
        issuedAt: 1,
        expiresAt: 2,
      },
      ["sys.config.set"],
    );

    expect(identity?.capabilities).toEqual(["fs.read"]);
    expect(kernel.caps.resolve).toHaveBeenCalledWith([1000, 100]);
  });
});

describe("Kernel service binding identity", () => {
  it("rejects service calls instead of fabricating a missing root account", async () => {
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.auth = { getPasswdByUid: vi.fn(() => null) };
    kernel.caps = { resolve: vi.fn(() => []) };

    await expect(kernel.handleServiceReq({
      type: "req",
      id: "service-without-root",
      call: "adapter.status",
      args: { adapter: "discord" },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 503,
        message: "Service identity is not configured",
      },
    });
  });
});

describe("Kernel MCP connection cleanup", () => {
  it("removes newly registered MCP servers when the initial connection fails", async () => {
    const kernel = Object.create(Kernel.prototype) as {
      addMcpServerConnection(input: {
        uid: number;
        name: string;
        url: string;
        callbackHost: string;
        transport: { type: "auto" };
      }): Promise<unknown>;
      createMcpOAuthProvider: ReturnType<typeof vi.fn>;
      mcp: {
        registerServer: ReturnType<typeof vi.fn>;
        connectToServer: ReturnType<typeof vi.fn>;
      };
      removeMcpServer: ReturnType<typeof vi.fn>;
    };
    kernel.createMcpOAuthProvider = vi.fn(() => ({}));
    kernel.mcp = {
      registerServer: vi.fn(async () => undefined),
      connectToServer: vi.fn(async () => ({
        state: "failed",
        error: "connection rejected",
      })),
    };
    kernel.removeMcpServer = vi.fn(async () => undefined);
    const expectedError =
      "Failed to connect to MCP server at https://tinyfish.example/mcp: connection rejected";

    await expect(
      kernel.addMcpServerConnection({
        uid: 1000,
        name: "TinyFish",
        url: "https://tinyfish.example/mcp",
        callbackHost: "https://gsv.example.com",
        transport: { type: "auto" },
      }),
    ).rejects.toThrow(expectedError);

    const serverId = kernel.mcp.registerServer.mock.calls[0][0];
    expect(kernel.removeMcpServer).toHaveBeenCalledWith(serverId);
  });

  it("passes custom MCP headers as serializable request options", async () => {
    type RegisteredServerOptions = {
      transport: {
        requestInit?: {
          headers?: Record<string, string>;
        };
      };
    };
    const kernel = Object.create(Kernel.prototype) as {
      addMcpServerConnection(input: {
        uid: number;
        name: string;
        url: string;
        callbackHost: string;
        transport: {
          type: "sse";
          headers: Record<string, string>;
        };
      }): Promise<unknown>;
      createMcpOAuthProvider: ReturnType<typeof vi.fn>;
      mcp: {
        registerServer: ReturnType<typeof vi.fn>;
        connectToServer: ReturnType<typeof vi.fn>;
      };
    };
    let registeredOptions: RegisteredServerOptions | null = null;
    kernel.createMcpOAuthProvider = vi.fn(() => ({}));
    kernel.mcp = {
      registerServer: vi.fn(async (_serverId: string, options: RegisteredServerOptions) => {
        registeredOptions = options;
      }),
      connectToServer: vi.fn(async () => ({
        state: "authenticating",
        authUrl: "https://tinyfish.example/oauth",
      })),
    };

    await kernel.addMcpServerConnection({
      uid: 1000,
      name: "TinyFish",
      url: "https://tinyfish.example/mcp",
      callbackHost: "https://gsv.example.com",
      transport: {
        type: "sse",
        headers: {
          Authorization: "Bearer user-token",
          "X-API-Key": "custom-key",
        },
      },
    });

    expect(JSON.parse(JSON.stringify(registeredOptions?.transport.requestInit))).toEqual({
      headers: {
        Authorization: "Bearer user-token",
        "X-API-Key": "custom-key",
      },
    });
  });
});

describe("Kernel CLI download refresh coordination", () => {
  it("runs explicit refreshes after an in-flight automatic refresh", async () => {
    const kernel = Object.create(Kernel.prototype) as {
      cliDownloadsRefresh: Promise<void> | null;
      withCliDownloadsRefreshSlot<T>(
        run: () => Promise<T>,
        options?: { waitForExisting?: boolean },
      ): Promise<T>;
    };
    kernel.cliDownloadsRefresh = null;
    const order: string[] = [];
    let releaseAutoRefresh: () => void = () => {};

    const automaticRefresh = kernel.withCliDownloadsRefreshSlot(async () => {
      order.push("auto:start");
      await new Promise<void>((resolve) => {
        releaseAutoRefresh = resolve;
      });
      order.push("auto:end");
    });

    let explicitStarted = false;
    const explicitRefresh = kernel.withCliDownloadsRefreshSlot(async () => {
      explicitStarted = true;
      order.push("explicit");
      return "updated";
    }, { waitForExisting: true });

    await Promise.resolve();
    expect(explicitStarted).toBe(false);

    releaseAutoRefresh();

    await expect(explicitRefresh).resolves.toBe("updated");
    await automaticRefresh;
    expect(order).toEqual(["auto:start", "auto:end", "explicit"]);
  });
});

describe("Kernel process device requests", () => {
  function buildKernelForDeviceRequest(options: {
    capabilities?: string[];
    implements?: string[];
  } = {}) {
    const device = {
      device_id: "linux-machine",
      owner_uid: 0,
      label: "Linux machine",
      description: "",
      implements: options.implements ?? ["net.fetch"],
      platform: "linux",
      version: "test",
      online: true,
      first_seen_at: 1,
      last_seen_at: 2,
      connected_at: 2,
      disconnected_at: null,
    };
    const requestDevice = vi.fn(async () => ({
      type: "res" as const,
      id: "req-1",
      ok: true as const,
      data: {
        ok: true,
        url: "https://example.com",
        status: 204,
        statusText: "No Content",
        headers: {},
        redirected: false,
        bodyBase64: "",
        bodyBytes: 0,
      },
    }));
    const kernel = Object.create(Kernel.prototype) as {
      env: Record<string, never>;
      procs: { getIdentity: ReturnType<typeof vi.fn> };
      caps: { resolve: ReturnType<typeof vi.fn> };
      auth: { getPasswdByUid: ReturnType<typeof vi.fn> };
      devices: {
        canAccess: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
      };
      requestDevice: typeof requestDevice;
      requestProcessNetFetch(
        processId: string,
        target: string,
        args: { url: string; timeoutMs: number },
        options?: { ttlMs?: number; internalPurpose?: "model-transport" },
      ): Promise<unknown>;
    };
    kernel.env = {};
    kernel.procs = { getIdentity: vi.fn(() => ({
      uid: 0,
      gid: 0,
      gids: [0],
      username: "root",
      home: "/root",
      cwd: "/root",
    })) };
    kernel.caps = { resolve: vi.fn(() => options.capabilities ?? ["net.fetch"]) };
    kernel.auth = { getPasswdByUid: vi.fn(() => null) };
    kernel.devices = {
      canAccess: vi.fn(() => true),
      get: vi.fn(() => device),
    };
    kernel.requestDevice = requestDevice;
    return { kernel, requestDevice };
  }

  it("validates the process target and calls requestDevice", async () => {
    const { kernel, requestDevice } = buildKernelForDeviceRequest();

    const result = await kernel.requestProcessNetFetch(
      "proc_1",
      "linux-machine",
      { url: "https://example.com", timeoutMs: 180000 },
      { ttlMs: 180000 },
    );

    expect(result).toMatchObject({ ok: true, status: 204 });
    expect(kernel.procs.getIdentity).toHaveBeenCalledWith("proc_1");
    expect(kernel.devices.canAccess).toHaveBeenCalledWith("linux-machine", 0, [0]);
    expect(requestDevice).toHaveBeenCalledWith(
      "linux-machine",
      "net.fetch",
      { url: "https://example.com", timeoutMs: 180000 },
      { ttlMs: 180000 },
    );
  });

  it("requires net.fetch capability for default process net fetches", async () => {
    const { kernel, requestDevice } = buildKernelForDeviceRequest({ capabilities: [] });

    await expect(kernel.requestProcessNetFetch(
      "proc_1",
      "linux-machine",
      { url: "https://example.com", timeoutMs: 180000 },
      { ttlMs: 180000 },
    )).rejects.toThrow("Permission denied: net.fetch");

    expect(requestDevice).not.toHaveBeenCalled();
  });

  it("allows internal model transport net fetches without tool capability", async () => {
    const { kernel, requestDevice } = buildKernelForDeviceRequest({ capabilities: [] });

    const result = await kernel.requestProcessNetFetch(
      "proc_1",
      "linux-machine",
      { url: "https://example.com", timeoutMs: 180000 },
      { ttlMs: 180000, internalPurpose: "model-transport" },
    );

    expect(result).toMatchObject({ ok: true, status: 204 });
    expect(requestDevice).toHaveBeenCalledWith(
      "linux-machine",
      "net.fetch",
      { url: "https://example.com", timeoutMs: 180000 },
      { ttlMs: 180000 },
    );
  });
});

describe("Kernel process runtime projection", () => {
  it("accepts a newer successor start and rejects an older reordered start", () => {
    const record = { activeRunId: "run-old", lastActiveAt: 100 };
    const updateRuntimeState = vi.fn((_pid: string, patch: Record<string, unknown>) => {
      Object.assign(record, patch);
    });
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.procs = {
      get: vi.fn(() => record),
      updateRuntimeState,
    };

    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.started",
      payload: { runId: "run-new", conversationId: "default", timestamp: 200 },
    }, "run-new")).toBe(true);
    expect(record).toMatchObject({ activeRunId: "run-new", lastActiveAt: 200 });

    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.started",
      payload: { runId: "run-old", conversationId: "default", timestamp: 150 },
    }, "run-old")).toBe(false);

    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.finished",
      payload: { runId: "run-old", conversationId: "default", timestamp: 250 },
    }, "run-old")).toBe(true);
    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.output",
      payload: { runId: "run-old", conversationId: "default", timestamp: 300 },
    }, "run-old")).toBe(false);

    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.finished",
      payload: { runId: "run-new", conversationId: "default", timestamp: 400 },
    }, "run-new")).toBe(true);
    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.started",
      payload: { runId: "run-old", conversationId: "default", timestamp: 350 },
    }, "run-old")).toBe(false);

    expect(updateRuntimeState).toHaveBeenCalledTimes(2);
    expect(record).toMatchObject({ activeRunId: null, lastActiveAt: 400 });
  });
});

describe("Kernel IPC completion", () => {
  beforeEach(() => {
    sendFrameToProcessMock.mockReset();
  });

  it("schedules timeout callbacks no earlier than their deadline", async () => {
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.schedule = vi.fn(async () => ({ id: "ipc-timeout" }));
    const deadlineAt = Date.now() + 1_250;

    await kernel.scheduleIpcCallTimeout("call-timeout", deadlineAt);

    const scheduledAt = kernel.schedule.mock.calls[0]?.[0];
    expect(scheduledAt).toBeInstanceOf(Date);
    expect(scheduledAt.getTime()).toBeGreaterThanOrEqual(deadlineAt);
    expect(kernel.schedule).toHaveBeenCalledWith(
      scheduledAt,
      "onIpcCallTimeout",
      "call-timeout",
    );
  });

  it("cancels pending calls owned by an aborted source run", async () => {
    const cancelBySourceRun = vi.fn();
    const completeByRun = vi.fn(() => []);
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.procs = { getOwnerUid: vi.fn(() => 1000) };
    kernel.ipcCalls = { cancelBySourceRun, completeByRun };

    await kernel.completeIpcCallsForProcessSignal("proc-source", {
      type: "sig",
      signal: "proc.run.finished",
      payload: {
        runId: "run-source",
        status: "aborted",
        reason: "user.superseded",
      },
    });

    expect(cancelBySourceRun).toHaveBeenCalledWith({
      uid: 1000,
      sourcePid: "proc-source",
      sourceRunId: "run-source",
    });
    expect(cancelBySourceRun.mock.invocationCallOrder[0]).toBeLessThan(
      completeByRun.mock.invocationCallOrder[0],
    );
  });

  it.each(["ipc.reply", "ipc.timeout"] as const)(
    "includes source-run correlation in %s payloads",
    async (signal) => {
      sendFrameToProcessMock.mockResolvedValue(null);
      const kernel = Object.create(Kernel.prototype) as any;
      const call = {
        callId: "call-1",
        sourcePid: "proc-source",
        sourceRunId: "run-source",
        targetPid: "proc-target",
        targetRunId: "run-target",
        status: signal === "ipc.reply" ? "completed" : "timed_out",
        deadlineAt: 1234,
        createdAt: 1000,
        response: signal === "ipc.reply" ? { text: "done" } : null,
        error: signal === "ipc.timeout" ? "IPC call timed out" : null,
      };

      await kernel.deliverIpcCallSignal(call);

      expect(sendFrameToProcessMock).toHaveBeenCalledWith("proc-source", {
        type: "sig",
        signal,
        payload: {
          callId: "call-1",
          sourcePid: "proc-source",
          sourceRunId: "run-source",
          targetPid: "proc-target",
          runId: "run-target",
          deadlineAt: 1234,
          createdAt: 1000,
          status: call.status,
          ...(signal === "ipc.reply" ? { response: call.response } : {}),
          ...(call.error ? { error: call.error } : {}),
        },
      });
    },
  );

  it("releases failed outbox deliveries and durably requeues them", async () => {
    const call = {
      callId: "call-retry",
      sourcePid: "proc-source",
      sourceRunId: "run-source",
      targetPid: "proc-target",
      targetRunId: "run-target",
      status: "completed",
      deadlineAt: 1234,
      createdAt: 1000,
      response: { text: "done" },
      error: null,
    };
    const releaseDelivery = vi.fn();
    const remove = vi.fn();
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.ipcCalls = {
      claimDelivery: vi.fn(() => call),
      releaseDelivery,
      remove,
    };
    kernel.schedule = vi.fn(async () => ({ id: "ipc-delivery-retry" }));
    sendFrameToProcessMock.mockRejectedValue(new Error("source unavailable"));

    await kernel.deliverIpcCall(call.callId);

    expect(releaseDelivery).toHaveBeenCalledWith(call.callId);
    expect(remove).not.toHaveBeenCalled();
    expect(kernel.schedule).toHaveBeenCalledWith(
      5,
      "onIpcCallDelivery",
      call.callId,
      {
        idempotent: false,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      },
    );
  });

  it("queues terminal IPC delivery as an idempotent retrying job", () => {
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.ctx = { waitUntil: vi.fn() };
    kernel.schedule = vi.fn(async () => ({ id: "ipc-delivery" }));

    kernel.queueIpcCallDelivery("call-queued");

    expect(kernel.schedule).toHaveBeenCalledWith(
      expect.any(Date),
      "onIpcCallDelivery",
      "call-queued",
      {
        idempotent: true,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      },
    );
    expect(kernel.ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });
});
