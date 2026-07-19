import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

import { sendFrameToProcess } from "../shared/utils";
import { Kernel } from "./do";
import {
  BINARY_FRAME_CANCEL,
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  buildBinaryFrame,
  parseBinaryFrame,
} from "@humansandmachines/gsv/protocol";

const sendFrameToProcessMock = vi.mocked(sendFrameToProcess);

describe("Kernel frame bodies", () => {
  it("persists only a pseudonymous login source in hibernation state", async () => {
    const values = new Map<string, string>();
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.config = {
      getExplicit: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string) => values.set(key, value),
    };
    const connection: any = {
      id: "source-connection",
      state: undefined,
      setState: vi.fn((state) => {
        connection.state = state;
      }),
    };

    await kernel.onConnect(connection, {
      request: new Request("https://gsv.test/ws", {
        headers: { "CF-Connecting-IP": "203.0.113.44" },
      }),
    });

    expect(connection.state).toMatchObject({
      step: "pending",
      loginSourceScope: expect.stringMatching(/^source:\d+:[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(connection.state)).not.toContain("203.0.113.44");

    const persistedState = structuredClone(connection.state);
    kernel.buildKernelContext = vi.fn((options) => options);
    const context = kernel.buildContext({
      ...connection,
      state: persistedState,
    });
    expect(context.loginSourceScope).toBe(persistedState.loginSourceScope);
  });

  it("passes request cancellation to Agents SDK MCP calls", async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    const kernel = Object.create(Kernel.prototype) as any;
    Object.defineProperty(kernel, "name", { value: "kernel-test" });
    kernel.mcp = { callTool };
    const controller = new AbortController();
    const ctx = kernel.buildKernelContext({ requestSignal: controller.signal });

    expect(ctx.kernelName).toBe("kernel-test");
    await ctx.callMcpTool("server-1", "lookup", { query: "gsv" }, ctx.requestSignal);

    expect(callTool).toHaveBeenCalledWith(
      {
        serverId: "server-1",
        name: "lookup",
        arguments: { query: "gsv" },
      },
      undefined,
      { signal: controller.signal },
    );
  });

  it("decodes WebSocket body frames into a byte stream", async () => {
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.frameBodyChannels = new Map();
    const connection = { id: "conn-1", send: vi.fn() };

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
    expect(kernel.frameBodyChannels.get(connection.id).pending.size).toBe(0);
  });

  it("announces a response body before sending its chunks", async () => {
    const sends: Array<string | ArrayBuffer> = [];
    const pending: Promise<unknown>[] = [];
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.frameBodyChannels = new Map();
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

  it("cancels an unfinished request body when a device responds early", async () => {
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.pendingAppResponses = new Map();
    kernel.devices = {
      get: () => ({ online: true }),
      canHandle: () => true,
    };
    const deviceConnection = {
      id: "device-connection",
      state: {
        step: "connected",
        identity: { role: "driver", device: "device-1" },
      },
    };
    kernel.connections = new Map([[deviceConnection.id, deviceConnection]]);
    kernel.findDeviceConnection = () => deviceConnection;
    kernel.registerRouteWithExpiry = vi.fn(async () => ({ cancel: vi.fn() }));
    const outgoing = { cancel: vi.fn(async () => {}) };
    kernel.sendWebSocketFrame = vi.fn((_connection: unknown, frame: { id: string }) => {
      queueMicrotask(() => kernel.pendingAppResponses.get(frame.id)?.({
        type: "res",
        id: frame.id,
        ok: true,
        data: { ok: true },
      }));
      return outgoing;
    });

    await kernel.requestDevice("device-1", "net.fetch", {}, {
      body: { stream: new ReadableStream(), length: 1 },
    });

    expect(outgoing.cancel).toHaveBeenCalledWith("Device request completed");
  });

  it("cancels a request body when device routing fails before send", async () => {
    const cancel = vi.fn();
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.devices = { get: () => null };

    await expect(kernel.requestDevice("offline-device", "fs.transfer.receive", {}, {
      body: {
        stream: new ReadableStream({ cancel }),
        length: 1,
      },
    })).rejects.toThrow("Device offline: offline-device");

    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({
      message: "Device offline: offline-device",
    }));
  });

  it("cancels the route and upload when a device request is aborted", async () => {
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.pendingAppResponses = new Map();
    kernel.devices = {
      get: () => ({ online: true }),
      canHandle: () => true,
    };
    const deviceConnection = {
      id: "device-connection",
      state: {
        step: "connected",
        identity: { role: "driver", device: "device-1" },
      },
    };
    kernel.connections = new Map([[deviceConnection.id, deviceConnection]]);
    kernel.findDeviceConnection = () => deviceConnection;
    const cancelRoute = vi.fn();
    kernel.registerRouteWithExpiry = vi.fn(async () => ({ cancel: cancelRoute }));
    const outgoing = { cancel: vi.fn(async () => {}) };
    kernel.sendWebSocketFrame = vi.fn(() => outgoing);
    const controller = new AbortController();
    const reason = new Error("caller stopped");

    const request = kernel.requestDevice("device-1", "net.fetch", {}, {
      body: { stream: new ReadableStream(), length: 1 },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(kernel.sendWebSocketFrame).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(cancelRoute).toHaveBeenCalledOnce();
    expect(outgoing.cancel).toHaveBeenCalledWith(reason);
    expect(kernel.sendWebSocketFrame).toHaveBeenLastCalledWith(
      deviceConnection,
      {
        type: "sig",
        signal: "request.cancel",
        payload: { id: expect.any(String), reason: "caller stopped" },
      },
    );
  });

  it("cancels announced bodies on requests rejected before dispatch", async () => {
    const sends: Array<string | ArrayBuffer> = [];
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.frameBodyChannels = new Map();
    kernel.auth = { isSetupMode: () => false };
    const connection = {
      id: "pending-connection",
      state: { step: "pending" },
      send: (message: string | ArrayBuffer) => sends.push(message),
    };

    await kernel.handleReq(connection, {
      type: "req",
      id: "denied-request",
      call: "fs.transfer.receive",
      args: { path: "/tmp/file" },
      body: { streamId: 12, length: 1 },
    });

    expect(JSON.parse(sends[0] as string)).toMatchObject({
      type: "res",
      id: "denied-request",
      ok: false,
      error: { code: 403 },
    });
    expect(parseBinaryFrame(sends[1] as ArrayBuffer)).toMatchObject({
      streamId: 12,
      flags: BINARY_FRAME_CANCEL | BINARY_FRAME_END,
    });
  });

  it("rejects bodies that do not match their declared length", async () => {
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.frameBodyChannels = new Map();
    const connection = { id: "conn-1", send: vi.fn() };
    const body = kernel.receiveFrameBody(connection, { streamId: 8, length: 3 });

    kernel.handleBinaryMessage(
      connection,
      buildBinaryFrame(8, BINARY_FRAME_DATA, new Uint8Array([1, 2])),
    );
    kernel.handleBinaryMessage(connection, buildBinaryFrame(8, BINARY_FRAME_END));

    await expect(new Response(body.stream).arrayBuffer()).rejects.toThrow(
      "Body length 2 did not match 3",
    );
    expect(kernel.frameBodyChannels.get(connection.id).pending.size).toBe(0);
  });

  it("does not register bodies from an invalid response route", () => {
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.frameBodyChannels = new Map();
    kernel.routes = {
      get: () => ({ deviceId: "expected-device", driverConnectionId: null }),
    };
    kernel.isConnectionForDevice = vi.fn(() => false);

    kernel.handleRes({ id: "wrong-connection" }, {
      type: "res",
      id: "req-1",
      ok: true,
      body: { streamId: 9, length: 3 },
    });

    expect(kernel.frameBodyChannels.size).toBe(0);
  });

  it("rejects a response from a different connection for the same device", () => {
    const route = {
      deviceId: "device-1",
      driverConnectionId: "current-connection",
      origin: { type: "app", id: "req-1" },
      call: "fs.read",
      scheduleId: null,
    };
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.routes = {
      get: vi.fn(() => route),
      remove: vi.fn(),
    };
    kernel.isConnectionForDevice = vi.fn(() => true);
    kernel.decodeWebSocketFrame = vi.fn();

    kernel.handleRes({ id: "stale-connection" }, {
      type: "res",
      id: "req-1",
      ok: true,
      data: { content: "stale" },
    });

    expect(kernel.decodeWebSocketFrame).not.toHaveBeenCalled();
    expect(kernel.routes.remove).not.toHaveBeenCalled();
  });

  it("accepts an authoritative response for a route created before connection binding", () => {
    const route = {
      deviceId: "device-1",
      driverConnectionId: null,
      origin: { type: "app", id: "req-1" },
      call: "fs.read",
      scheduleId: null,
    };
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.routes = {
      get: vi.fn(() => route),
      remove: vi.fn(() => route),
    };
    kernel.routedBodies = new Map();
    kernel.isConnectionForDevice = vi.fn(() => true);
    kernel.decodeWebSocketFrame = vi.fn((_connection: unknown, frame: unknown) => frame);
    kernel.deliverToOrigin = vi.fn();

    kernel.handleRes({ id: "current-connection" }, {
      type: "res",
      id: "req-1",
      ok: true,
      data: { content: "current" },
    });

    expect(kernel.routes.remove).toHaveBeenCalledWith("req-1");
    expect(kernel.deliverToOrigin).toHaveBeenCalledWith(route.origin, {
      type: "res",
      id: "req-1",
      ok: true,
      data: { content: "current" },
    });
  });

  it("fails a routed caller immediately when the response body descriptor is invalid", () => {
    const cancelBody = vi.fn(async () => {});
    const route = {
      deviceId: "device-1",
      driverConnectionId: "device-connection",
      origin: { type: "app", id: "req-1" },
      call: "net.fetch",
      scheduleId: "schedule-1",
    };
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.frameBodyChannels = new Map();
    kernel.routes = {
      get: vi.fn(() => route),
      remove: vi.fn(() => route),
    };
    kernel.routedBodies = new Map([["req-1", { cancel: cancelBody }]]);
    kernel.isConnectionForDevice = () => true;
    kernel.cancelSchedule = vi.fn(async () => {});
    kernel.deliverToOrigin = vi.fn();
    const connection = { id: "device-connection", send: vi.fn() };

    kernel.handleRes(connection, {
      type: "res",
      id: "req-1",
      ok: true,
      body: { streamId: 0, length: 3 },
    });

    expect(kernel.routes.remove).toHaveBeenCalledWith("req-1");
    expect(kernel.cancelSchedule).toHaveBeenCalledWith("schedule-1");
    expect(cancelBody).toHaveBeenCalledWith("Route cancelled");
    expect(kernel.routedBodies.size).toBe(0);
    expect(kernel.deliverToOrigin).toHaveBeenCalledWith(route.origin, {
      type: "res",
      id: "req-1",
      ok: false,
      error: {
        code: 502,
        message: "Invalid response from device device-1: Invalid binary stream id: 0",
      },
    });
    expect(JSON.parse(connection.send.mock.calls[0][0])).toEqual({
      type: "res",
      id: "req-1",
      ok: false,
      error: { code: 400, message: "Invalid binary stream id: 0" },
    });
  });

  it("cancels a response body that arrives after its route is gone", async () => {
    const sends: ArrayBuffer[] = [];
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.frameBodyChannels = new Map();
    kernel.routes = { get: () => null };
    const connection = {
      id: "conn-late",
      send: (message: ArrayBuffer) => sends.push(message),
    };

    kernel.handleRes(connection, {
      type: "res",
      id: "late-response",
      ok: true,
      body: { streamId: 9, length: 3 },
    });

    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(parseBinaryFrame(sends[0])).toMatchObject({
      streamId: 9,
      flags: BINARY_FRAME_CANCEL | BINARY_FRAME_END,
    });
  });

  it("stops a routed upload when the device response arrives", async () => {
    const cancel = vi.fn(async () => {});
    const route = {
      deviceId: "device-1",
      driverConnectionId: "device-connection",
      origin: { type: "app", id: "req-1" },
      call: "net.fetch",
      scheduleId: null,
    };
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.routes = {
      get: () => route,
      remove: () => route,
    };
    kernel.routedBodies = new Map([["req-1", { cancel }]]);
    kernel.isConnectionForDevice = () => true;
    kernel.decodeWebSocketFrame = (_connection: unknown, frame: unknown) => frame;
    kernel.deliverToOrigin = vi.fn();

    kernel.handleRes({ id: "device-connection" }, {
      type: "res",
      id: "req-1",
      ok: true,
      data: { ok: true },
    });

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("Device response received"));
    expect(kernel.routedBodies.size).toBe(0);
  });

  it("sends a cancellation frame when an inbound body is discarded", async () => {
    const sends: ArrayBuffer[] = [];
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.frameBodyChannels = new Map();
    const connection = {
      id: "conn-1",
      send: (message: ArrayBuffer) => sends.push(message),
    };
    const body = kernel.receiveFrameBody(connection, { streamId: 10 });

    await body.stream.cancel("body ignored");

    expect(parseBinaryFrame(sends[0])).toMatchObject({
      streamId: 10,
      flags: BINARY_FRAME_CANCEL | BINARY_FRAME_END,
    });
  });

  it("cancels an outgoing body pump when the receiver sends cancellation", async () => {
    const sends: Array<string | ArrayBuffer> = [];
    const pending: Promise<unknown>[] = [];
    let cancelled = false;
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.frameBodyChannels = new Map();
    kernel.ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
    const connection = {
      id: "connection-1",
      send: (message: string | ArrayBuffer) => sends.push(message),
    };
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
      cancel: () => {
        cancelled = true;
      },
    });

    kernel.sendWebSocketFrame(connection, {
      type: "res",
      id: "req-1",
      ok: true,
      body: { stream },
    });
    const descriptor = JSON.parse(sends[0] as string);
    kernel.handleBinaryMessage(
      connection,
      buildBinaryFrame(descriptor.body.streamId, BINARY_FRAME_CANCEL | BINARY_FRAME_END),
    );
    await Promise.all(pending);

    expect(cancelled).toBe(true);
    expect(sends).toHaveLength(1);
  });

  it("cancels a request body forwarded to a process", async () => {
    let reading!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let forwardedError: unknown;
    sendFrameToProcessMock.mockImplementationOnce(async (_pid, frame) => {
      const reader = frame.body!.stream.getReader();
      reading();
      try {
        await reader.read();
      } catch (error) {
        forwardedError = error;
        throw error;
      } finally {
        reader.releaseLock();
      }
      return null;
    });
    let sourceCancellation: unknown;
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel(reason) {
        sourceCancellation = reason;
      },
    }, { highWaterMark: 0 });
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.activeRequests = new Map();
    kernel.cancelledProcessRequests = new Map();
    kernel.routes = { get: () => null };
    kernel.buildProcessContext = () => ({
      callerOwnerUid: 0,
      identity: {
        role: "user",
        process: {
          uid: 0,
          gid: 0,
          gids: [0],
          username: "root",
          home: "/root",
          cwd: "/root",
        },
        capabilities: ["*"],
      },
      procs: {
        get: () => ({ ownerUid: 0 }),
      },
      conversations: {
        getByActivePid: () => null,
      },
    });
    kernel.buildDispatchDeps = () => ({});
    kernel.applyPostDispatchEffects = vi.fn();
    const request = kernel.handleProcessReq("source-process", {
      type: "req",
      id: "media-upload",
      call: "proc.media.write",
      args: {
        pid: "target-process",
        type: "image",
        mimeType: "image/png",
      },
      body: { stream: body, length: 1 },
    });
    await Promise.race([
      readStarted,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("forwarded body was not read")), 500);
      }),
    ]);

    expect(kernel.cancelProcessRequests(
      "source-process",
      ["media-upload"],
      "User interrupted upload",
    )).toBe(1);

    await expect(Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("forwarded body did not cancel")), 500);
      }),
    ])).resolves.toMatchObject({
      ok: false,
      error: { message: "User interrupted upload" },
    });
    expect(forwardedError).toEqual(new Error("User interrupted upload"));
    expect(sourceCancellation).toEqual(new Error("User interrupted upload"));

    let ignoredCancellation: unknown;
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "ignored-upload",
      ok: true,
      data: { ok: true },
    });
    await kernel.recvFrame("source-process", {
      type: "req",
      id: "ignored-upload",
      call: "proc.media.write",
      args: {
        pid: "target-process",
        type: "image",
        mimeType: "image/png",
      },
      body: {
        stream: new ReadableStream<Uint8Array>({
          cancel(reason) {
            ignoredCancellation = reason;
          },
        }),
        length: 1,
      },
    });

    expect(ignoredCancellation).toBe("Process request completed");
  });
});

describe("Kernel nested dispatch", () => {
  it("cancels request bodies rejected by nested capability checks", async () => {
    let cancelled: unknown;
    const kernel = Object.create(Kernel.prototype) as any;
    const response = await kernel.requestDispatchedFrame(
      {
        type: "req",
        id: "nested-denied",
        call: "net.fetch",
        args: { url: "https://example.com" },
        body: {
          stream: new ReadableStream({
            cancel(reason) {
              cancelled = reason;
            },
          }),
          length: 1,
        },
      },
      { identity: { capabilities: [] } },
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 403, message: "Permission denied: net.fetch" },
    });
    expect(cancelled).toBe("Dispatched request rejected");
  });

  it("forwards cancellation for an awaited nested device request", async () => {
    const controller = new AbortController();
    const reason = new Error("new user message");
    const driver = {
      id: "driver-connection",
      state: {
        step: "connected",
        identity: {
          role: "driver",
          device: "workstation",
        },
      },
    };
    let route: any = null;
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.pendingAppResponses = new Map();
    kernel.activeRequests = new Map();
    kernel.cancelledProcessRequests = new Map();
    kernel.connections = new Map([[driver.id, driver]]);
    kernel.shellSessions = { get: vi.fn() };
    kernel.routedBodies = new Map();
    kernel.routes = {
      get: vi.fn((id: string) => route?.id === id ? route : null),
      remove: vi.fn((id: string) => {
        if (route?.id !== id) return null;
        const removed = {
          origin: route.origin,
          call: route.call,
          deviceId: route.deviceId,
          driverConnectionId: route.driverConnectionId,
          scheduleId: null,
        };
        route = null;
        return removed;
      }),
    };
    kernel.cancelSchedule = vi.fn(async () => {});
    kernel.registerRouteWithExpiry = vi.fn(async (input: any) => {
      route = { ...input, scheduleId: null };
      return {
        cancel: () => kernel.cancelRoute(input.id),
        attachBody: vi.fn(),
      };
    });
    kernel.sendWebSocketFrame = vi.fn(() => null);
    kernel.requestDevice = vi.fn();
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
        capabilities: ["shell.exec"],
      },
      devices: {
        canAccess: vi.fn(() => true),
        get: vi.fn(() => ({
          device_id: "workstation",
          owner_uid: 1000,
          label: "Workstation",
          description: "",
          implements: ["shell.exec"],
          platform: "linux",
          version: "test",
          online: true,
          first_seen_at: 1,
          last_seen_at: 2,
          connected_at: 2,
          disconnected_at: null,
        })),
      },
      auth: { getPasswdByUid: vi.fn(() => null) },
    };
    const request = kernel.requestDispatchedFrame(
      {
        type: "req",
        id: "nested-shell",
        call: "shell.exec",
        args: { target: "workstation", input: "sleep 300" },
      },
      ctx,
      controller.signal,
    );

    await vi.waitFor(() => expect(kernel.sendWebSocketFrame).toHaveBeenCalledWith(
      driver,
      {
        type: "req",
        id: "nested-shell",
        call: "shell.exec",
        args: { input: "sleep 300" },
      },
    ));
    expect(kernel.activeRequests.size).toBe(0);
    controller.abort(reason);

    await expect(request).rejects.toThrow("new user message");
    expect(kernel.sendWebSocketFrame).toHaveBeenCalledWith(
      driver,
      {
        type: "sig",
        signal: "request.cancel",
        payload: { id: "nested-shell", reason: "new user message" },
      },
    );
    expect(route).toBeNull();
  });
});

describe("Kernel device connection cleanup", () => {
  it("makes a replacement authoritative before closing the old connection", () => {
    const identity = {
      role: "driver",
      process: { uid: 1000 },
      device: "browser",
    };
    const oldConnection: any = {
      id: "old-connection",
      state: {
        step: "connected",
        identity,
        clientId: "browser",
      },
      setState: vi.fn((state) => {
        oldConnection.state = state;
      }),
      close: vi.fn(),
    };
    const replacement: any = {
      id: "new-connection",
      state: { step: "pending" },
      setState: vi.fn((state) => {
        replacement.state = state;
      }),
      close: vi.fn(),
    };
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.connections = new Map([[oldConnection.id, oldConnection]]);

    kernel.activateConnection(replacement, {
      step: "connected",
      identity,
      clientId: "browser",
    });

    expect(kernel.connections.get(replacement.id)).toBe(replacement);
    expect(kernel.connections.has(oldConnection.id)).toBe(false);
    expect(oldConnection.state.step).toBe("superseded");
    expect(oldConnection.close).toHaveBeenCalledWith(1000, "Replaced by newer connection");
    expect(replacement.setState.mock.invocationCallOrder[0])
      .toBeLessThan(oldConnection.close.mock.invocationCallOrder[0]);
  });

  it("does not let a superseded close disconnect its replacement", () => {
    const oldConnection = {
      id: "old-connection",
      state: {
        step: "superseded",
        identity: { role: "driver", device: "browser" },
      },
    };
    const replacement = {
      id: "new-connection",
      state: {
        step: "connected",
        identity: { role: "driver", device: "browser" },
      },
    };
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.connections = new Map([[replacement.id, replacement]]);
    kernel.activeRequests = new Map();
    kernel.closeFrameBodyChannel = vi.fn();
    kernel.devices = { setOnline: vi.fn() };
    kernel.broadcastDeviceStatus = vi.fn();
    kernel.failRoutesForDevice = vi.fn();
    kernel.failRoutesForDriverConnection = vi.fn();
    kernel.failRoutesForConnection = vi.fn();
    kernel.runRoutes = { clearForConnection: vi.fn() };

    kernel.onClose(oldConnection);

    expect(kernel.connections.get(replacement.id)).toBe(replacement);
    expect(kernel.devices.setOnline).not.toHaveBeenCalled();
    expect(kernel.broadcastDeviceStatus).not.toHaveBeenCalled();
    expect(kernel.failRoutesForDevice).not.toHaveBeenCalled();
    expect(kernel.failRoutesForDriverConnection).toHaveBeenCalledWith(oldConnection.id);
  });

  it("replies to an authoritative driver ping on the same connection", () => {
    const connection = {
      id: "driver-connection",
      state: {
        step: "connected",
        identity: { role: "driver", device: "browser" },
      },
    };
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.connections = new Map([[connection.id, connection]]);
    kernel.sendWebSocketFrame = vi.fn();

    kernel.handleSig(connection, {
      type: "sig",
      signal: "device.ping",
      payload: { at: 1234, nonce: "ping-1" },
      seq: 7,
    });

    expect(kernel.sendWebSocketFrame).toHaveBeenCalledWith(connection, {
      type: "sig",
      signal: "device.pong",
      payload: { at: 1234, nonce: "ping-1" },
      seq: 7,
    });
  });

  it("aborts native requests when their origin disconnects", () => {
    const controller = new AbortController();
    const connection = {
      id: "connection-1",
      state: { step: "connected", identity: { role: "user" } },
    };
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.connections = new Map([[connection.id, connection]]);
    kernel.activeRequests = new Map([
      ["request-1", {
        origin: { type: "connection", id: connection.id },
        controller,
      }],
    ]);
    kernel.routes = { get: vi.fn(() => null) };
    kernel.closeFrameBodyChannel = vi.fn();
    kernel.failRoutesForConnection = vi.fn();
    kernel.runRoutes = { clearForConnection: vi.fn() };

    kernel.onClose(connection);

    expect(controller.signal.reason).toEqual(new Error("Origin disconnected"));
    expect(kernel.failRoutesForConnection).toHaveBeenCalledWith(connection.id);
  });

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

describe("Kernel process signal routing", () => {
  function buildKernel(route: Record<string, unknown>) {
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.procs = { getOwnerUid: vi.fn(() => 1000) };
    kernel.dispatchSignalWatches = vi.fn(async () => {});
    kernel.runRoutes = { get: vi.fn(() => route), delete: vi.fn() };
    kernel.broadcastToUserUid = vi.fn();
    kernel.deliverSignalToConnection = vi.fn();
    kernel.deliverSignalToAdapter = vi.fn(async () => {});
    return kernel;
  }

  const connectionRoute = {
    kind: "connection",
    runId: "run-1",
    uid: 1000,
    connectionId: "connection-1",
  };

  it("broadcasts connection-routed HIL requests without duplicating the origin", async () => {
    const kernel = buildKernel(connectionRoute);
    const frame = {
      type: "sig",
      signal: "proc.run.hil.requested",
      payload: { pid: "proc-1", runId: "run-1", requestId: "hil-1" },
    };

    await kernel.handleProcessSignal("proc-1", frame);

    expect(kernel.broadcastToUserUid).toHaveBeenCalledWith(1000, frame.signal, frame.payload);
    expect(kernel.deliverSignalToConnection).not.toHaveBeenCalled();
    expect(kernel.deliverSignalToAdapter).not.toHaveBeenCalled();
  });

  it("broadcasts adapter-routed HIL requests and preserves adapter delivery", async () => {
    const route = {
      kind: "adapter",
      runId: "run-1",
      uid: 1000,
      adapter: "discord",
      accountId: "account-1",
      surfaceKind: "dm",
      surfaceId: "surface-1",
    };
    const kernel = buildKernel(route);
    const frame = {
      type: "sig",
      signal: "proc.run.hil.requested",
      payload: { pid: "proc-1", runId: "run-1", requestId: "hil-1" },
    };

    await kernel.handleProcessSignal("proc-1", frame);

    expect(kernel.broadcastToUserUid).toHaveBeenCalledWith(1000, frame.signal, frame.payload);
    expect(kernel.deliverSignalToAdapter).toHaveBeenCalledWith(route, frame);
  });

  it("keeps ordinary run signals exclusive to their connection route", async () => {
    const kernel = buildKernel(connectionRoute);
    const frame = {
      type: "sig",
      signal: "proc.run.stream",
      payload: { pid: "proc-1", runId: "run-1", event: { type: "text_delta", delta: "hi" } },
    };

    await kernel.handleProcessSignal("proc-1", frame);

    expect(kernel.broadcastToUserUid).not.toHaveBeenCalled();
    expect(kernel.deliverSignalToConnection).toHaveBeenCalledWith(connectionRoute, frame, 1000);
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
      routes: { get: ReturnType<typeof vi.fn> };
      cancelProcessRequests(processId: string, requestIds: string[], reason?: string): number;
      activeRequests: Map<
        string,
        { origin: { type: "process"; id: string }; controller: AbortController }
      >;
      cancelledProcessRequests: Map<
        string,
        { expiresAt: number; reason: string }
      >;
      requestProcessNetFetch(
        processId: string,
        target: string,
        args: { url: string; timeoutMs: number },
        options?: {
          ttlMs?: number;
          internalPurpose?: "model-transport";
          body?: { stream: ReadableStream<Uint8Array>; length?: number };
          requestId?: string;
        },
      ): Promise<unknown>;
    };
    Object.defineProperty(kernel, "name", { value: "kernel-device-test" });
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
    kernel.routes = { get: vi.fn(() => null) };
    kernel.activeRequests = new Map();
    kernel.cancelledProcessRequests = new Map();
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

    expect(result).toMatchObject({ ok: true, data: { status: 204 } });
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
    let bodyCancelled = false;

    await expect(kernel.requestProcessNetFetch(
      "proc_1",
      "linux-machine",
      { url: "https://example.com", timeoutMs: 180000 },
      {
        ttlMs: 180000,
        body: {
          stream: new ReadableStream({
            cancel() {
              bodyCancelled = true;
            },
          }),
          length: 3,
        },
      },
    )).rejects.toThrow("Permission denied: net.fetch");

    expect(bodyCancelled).toBe(true);
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

    expect(result).toMatchObject({ ok: true, data: { status: 204 } });
    expect(requestDevice).toHaveBeenCalledWith(
      "linux-machine",
      "net.fetch",
      { url: "https://example.com", timeoutMs: 180000 },
      { ttlMs: 180000 },
    );
  });

  it("registers cancellable process net.fetch requests", async () => {
    const { kernel, requestDevice } = buildKernelForDeviceRequest();

    await kernel.requestProcessNetFetch(
      "proc_1",
      "linux-machine",
      { url: "https://example.com", timeoutMs: 180000 },
      { ttlMs: 180000, requestId: "fetch-1" },
    );

    expect(requestDevice).toHaveBeenCalledWith(
      "linux-machine",
      "net.fetch",
      { url: "https://example.com", timeoutMs: 180000 },
      expect.objectContaining({
        ttlMs: 180000,
        id: "fetch-1",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(kernel.activeRequests.size).toBe(0);
  });

  it("only lets the owning process cancel an active request", () => {
    const kernel = Object.create(Kernel.prototype) as any;
    const controller = new AbortController();
    kernel.activeRequests = new Map([
      ["fetch-1", { origin: { type: "process", id: "proc_1" }, controller }],
    ]);
    kernel.cancelledProcessRequests = new Map();
    kernel.routes = { get: vi.fn(() => null) };

    expect(kernel.cancelProcessRequests("proc_2", ["fetch-1"])).toBe(0);
    expect(controller.signal.aborted).toBe(false);
    expect(kernel.cancelProcessRequests("proc_1", ["fetch-1"], "stopped")).toBe(1);
    expect(controller.signal.reason).toEqual(new Error("stopped"));
  });

  it("forwards routed cancellation only for the owning process", () => {
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.activeRequests = new Map();
    kernel.cancelledProcessRequests = new Map();
    kernel.routes = {
      get: vi.fn(() => ({
        id: "search-1",
        origin: { type: "process", id: "proc_1" },
        deviceId: "device-1",
        driverConnectionId: "driver-connection",
      })),
    };
    kernel.sendDeviceRequestCancel = vi.fn();
    kernel.cancelRoute = vi.fn();

    expect(kernel.cancelProcessRequests("proc_2", ["search-1"], "stopped")).toBe(0);
    expect(kernel.sendDeviceRequestCancel).not.toHaveBeenCalled();
    expect(kernel.cancelProcessRequests("proc_1", ["search-1"], "stopped")).toBe(1);
    expect(kernel.sendDeviceRequestCancel).toHaveBeenCalledWith(
      "device-1",
      "driver-connection",
      "search-1",
      "stopped",
    );
    expect(kernel.cancelRoute).toHaveBeenCalledWith("search-1");
  });

  it("cancels a connection request without exposing the control signal", () => {
    const kernel = Object.create(Kernel.prototype) as any;
    const controller = new AbortController();
    kernel.activeRequests = new Map([
      ["request-1", { origin: { type: "connection", id: "conn-1" }, controller }],
    ]);
    kernel.routes = { get: vi.fn(() => null) };

    kernel.handleRequestCancel(
      { id: "conn-1", state: { step: "connected" } },
      {
        type: "sig",
        signal: "request.cancel",
        payload: { id: "request-1", reason: "client timed out" },
      },
    );

    expect(controller.signal.reason).toEqual(new Error("client timed out"));
  });

  it("honors cancellation that arrives before process fetch registration", async () => {
    const { kernel, requestDevice } = buildKernelForDeviceRequest();

    expect(kernel.cancelProcessRequests("proc_1", ["fetch-early"], "superseded")).toBe(1);
    await expect(kernel.requestProcessNetFetch(
      "proc_1",
      "linux-machine",
      { url: "https://example.com", timeoutMs: 180000 },
      { requestId: "fetch-early" },
    )).rejects.toThrow("superseded");

    expect(requestDevice).not.toHaveBeenCalled();
    expect(kernel.cancelledProcessRequests.size).toBe(0);
  });
});

describe("Kernel process runtime projection", () => {
  it("waits for earlier process signals before acknowledging a run finish", async () => {
    let releaseStarted!: () => void;
    const startedBlocked = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const events: string[] = [];
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.pendingProcessSignals = new Map();
    kernel.extractRunId = vi.fn((payload) => payload.runId);
    kernel.updateProcessRuntimeFromSignal = vi.fn(() => true);
    kernel.completeIpcCallsForProcessSignal = vi.fn();
    kernel.handleProcessSignal = vi.fn(async (_pid: string, frame: { signal: string }) => {
      events.push(`${frame.signal}:start`);
      if (frame.signal === "proc.run.started") {
        await startedBlocked;
      }
      events.push(`${frame.signal}:done`);
    });

    await kernel.recvFrame("proc-1", {
      type: "sig",
      signal: "proc.run.started",
      payload: { runId: "run-1" },
    });
    await vi.waitFor(() => expect(events).toEqual(["proc.run.started:start"]));

    let finishAcknowledged = false;
    const finishing = kernel.recvFrame("proc-1", {
      type: "sig",
      signal: "proc.run.finished",
      payload: { runId: "run-1" },
    }).then(() => {
      finishAcknowledged = true;
    });
    await Promise.resolve();
    expect(finishAcknowledged).toBe(false);

    releaseStarted();
    await finishing;
    expect(events).toEqual([
      "proc.run.started:start",
      "proc.run.started:done",
      "proc.run.finished:start",
      "proc.run.finished:done",
    ]);
  });

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
