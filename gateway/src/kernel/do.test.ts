type KernelTestValue<T = string | number | boolean | null | undefined> = T;

import { beforeEach, describe, expect, it, vi } from "vitest";

import * as utils from "../shared/utils";
import * as personalController from "./personal-controller";
const getConversationByIdMock = vi.spyOn(utils, "getConversationById");

import { Kernel } from "./do";
import {
  BINARY_FRAME_CANCEL,
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  buildBinaryFrame,
  parseBinaryFrame,
} from "@humansandmachines/gsv/protocol";

const sendFrameToProcessMock = vi.spyOn(utils, "sendFrameToProcess");
const TEST_INSTALLATION_ID = "singleton";

describe("Kernel responsibility wakes", () => {
  it("durably admits a ready batch to the existing Ship process", async () => {
    const responsibility = {
      id: "r12y:11111111-1111-4111-8111-111111111111",
      ownerUid: 1000,
      title: "Repair adapter delivery",
      source: { kind: "system", component: "adapter" },
      assignee: { kind: "ship" },
      state: "open",
      priority: "high",
      revision: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const batch = {
      id: "batch:22222222-2222-4222-8222-222222222222",
      ownerUid: 1000,
      throughRevision: 1,
      eventId: "r12y.ready:batch:22222222-2222-4222-8222-222222222222",
      responsibilities: [responsibility],
      attemptCount: 0,
      createdAtMs: 1,
    };
    // SAFETY: test fixture is constructed with the asserted Kernel boundary shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.installationId = TEST_INSTALLATION_ID;
    kernel.responsibilities = {
      wakeState: vi.fn(() => ({
        ownerUid: 1000,
        generation: 1,
        taskId: "wake-1",
        scheduledAtMs: 1,
      })),
      createReadyBatch: vi.fn(() => batch),
      markBatchDelivered: vi.fn(),
      markBatchFailed: vi.fn(),
    };
    kernel.managedWorkGate = vi.fn(async () => ({ allowed: true }));
    kernel.buildKernelContext = vi.fn(() => ({}));
    kernel.reconcileResponsibilityWake = vi.fn(async () => {});
    const ensureShip = vi.spyOn(personalController, "ensurePersonalController")
      .mockResolvedValue("proc:ship");
    sendFrameToProcessMock.mockImplementationOnce(async (_installationId, _pid, frame) => ({
      type: "res",
      id: frame.type === "req" ? frame.id : "signal",
      ok: true,
      data: { eventId: batch.eventId, runId: "run:r12y", queued: false },
    }));

    try {
      await kernel.onResponsibilityWake(
        { ownerUid: 1000, generation: 1 },
        { id: "wake-1" },
      );
    } finally {
      ensureShip.mockRestore();
    }

    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      "proc:ship",
      expect.objectContaining({
        call: "proc.runtime.event.deliver",
        args: expect.objectContaining({
          eventId: batch.eventId,
          event: expect.objectContaining({
            type: "r12y.ready",
            ledgerRevision: 1,
            responsibilityIds: [responsibility.id],
          }),
        }),
      }),
    );
    expect(kernel.responsibilities.markBatchDelivered).toHaveBeenCalledWith(batch.id);
    expect(kernel.reconcileResponsibilityWake).toHaveBeenCalledWith(1000);
  });

  it("reconciles the current generation when a stale wake fires", async () => {
    // SAFETY: test fixture is constructed with the asserted Kernel boundary shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.responsibilities = {
      wakeState: vi.fn(() => ({
        ownerUid: 1000,
        generation: 2,
        taskId: "wake-2",
        scheduledAtMs: 2,
      })),
    };
    kernel.reconcileResponsibilityWake = vi.fn(async () => {});

    await kernel.onResponsibilityWake(
      { ownerUid: 1000, generation: 1 },
      { id: "wake-1" },
    );

    expect(kernel.reconcileResponsibilityWake).toHaveBeenCalledWith(1000);
  });
});

describe("Kernel service peer identity", () => {
  it("rejects an adapter frame that claims another binding identity", async () => {
    // SAFETY: this fixture isolates the service-frame admission boundary on Kernel.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.managedWorkGate = vi.fn(async () => ({ allowed: true }));
    kernel.buildServiceBindingIdentity = vi.fn(() => ({
      role: "service",
      process: {
        uid: 0,
        gid: 0,
        gids: [0, 102],
        username: "root",
        home: "/root",
        cwd: "/root",
      },
      capabilities: ["adapter.state.update"],
      channel: "telegram",
    }));
    kernel.dispatchPeerRequest = vi.fn();

    const response = await kernel.peerFrame(
      { id: "telegram", calls: ["adapter.state.update"] },
      {
        type: "req",
        id: "cross-adapter-state",
        call: "adapter.state.update",
        args: {
          adapter: "whatsapp",
          accountId: "primary",
          status: {
            accountId: "primary",
            connected: false,
            authenticated: false,
          },
        },
      },
    );

    expect(response).toMatchObject({
      type: "res",
      id: "cross-adapter-state",
      ok: false,
      error: {
        code: 403,
        message: "Service peer cannot act as another adapter",
      },
    });
    expect(kernel.dispatchPeerRequest).not.toHaveBeenCalled();
  });

  it("derives a one-call human peer for an adapter interaction", async () => {
    const link = {
      adapter: "telegram",
      accountId: "managed",
      actorId: "telegram:user:42",
      uid: 1000,
      metadata: {
        managed: true,
        surfaceKind: "dm",
        surfaceId: "chat-42",
        routeScope: "surface",
        routeGeneration: "generation-1",
      },
    };
    // SAFETY: this fixture isolates the linked adapter admission boundary.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.installationId = TEST_INSTALLATION_ID;
    kernel.managedWorkGate = vi.fn(async () => ({ allowed: true }));
    kernel.adapters = {
      identityLinks: { get: vi.fn(() => link) },
      surfaceRoutes: { get: vi.fn(() => null) },
    };
    kernel.auth = {
      getPasswdByUid: vi.fn(() => ({
        uid: 1000,
        gid: 1000,
        username: "alice",
        home: "/home/alice",
      })),
      resolveGids: vi.fn(() => [1000]),
    };
    kernel.caps = { resolve: vi.fn(() => ["proc.hil", "proc.send"]) };
    let dispatchContext: any;
    kernel.buildKernelContext = vi.fn((options) => {
      dispatchContext = { ...options, adapters: kernel.adapters };
      return dispatchContext;
    });
    kernel.dispatchPeerRequest = vi.fn(async (frame) => ({
      type: "res",
      id: frame.id,
      ok: true,
      data: { ok: true, resumed: true },
    }));
    const frame = {
      type: "req" as const,
      id: "approval-interaction",
      call: "proc.hil" as const,
      args: {
        pid: "proc-1",
        requestId: "request-1",
        decision: "approve" as const,
        remember: false,
      },
    };

    await expect(kernel.linkedAdapterPeerFrame(
      {
        id: "telegram",
        calls: [
          "adapter.inbound",
          "adapter.state.update",
          "adapter.delivery.claim",
          "adapter.delivery.report",
        ],
      },
      {
        accountId: "managed",
        actorId: "telegram:user:42",
        surface: { kind: "dm", id: "chat-42" },
        routeGeneration: "generation-1",
        interactionId: "callback-1",
      },
      frame,
    )).resolves.toMatchObject({ type: "res", id: frame.id, ok: true });

    expect(dispatchContext.callerOwnerUid).toBe(1000);
    expect(dispatchContext.peer.peer.principal.kind).toBe("human");
    expect(dispatchContext.peer.peer.grant.calls).toEqual(["proc.hil"]);
    expect(dispatchContext.peer.provenance).toMatchObject({
      kind: "adapter-link",
      serviceId: "telegram",
      accountId: "managed",
      actorId: "telegram:user:42",
    });
    expect(kernel.dispatchPeerRequest).toHaveBeenCalledWith(
      frame,
      { type: "kernel", id: "callback-1" },
      dispatchContext,
      { awaitRouted: true },
    );
  });

  it("rejects a linked adapter interaction after its route generation changes", async () => {
    // SAFETY: this fixture isolates the generation fence before user dispatch.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.managedWorkGate = vi.fn(async () => ({ allowed: true }));
    kernel.adapters = {
      identityLinks: {
        get: vi.fn(() => ({
          uid: 1000,
          metadata: {
            managed: true,
            surfaceKind: "dm",
            surfaceId: "chat-42",
            routeGeneration: "generation-2",
          },
        })),
      },
    };
    kernel.dispatchPeerRequest = vi.fn();

    await expect(kernel.linkedAdapterPeerFrame(
      { id: "telegram", calls: ["adapter.inbound"] },
      {
        accountId: "managed",
        actorId: "telegram:user:42",
        surface: { kind: "dm", id: "chat-42" },
        routeGeneration: "generation-1",
        interactionId: "callback-stale",
      },
      {
        type: "req",
        id: "approval-stale",
        call: "proc.hil",
        args: { requestId: "request-1", decision: "approve" },
      },
    )).resolves.toMatchObject({
      type: "res",
      id: "approval-stale",
      ok: false,
      error: { code: 409 },
    });
    expect(kernel.dispatchPeerRequest).not.toHaveBeenCalled();
  });
});

describe("Kernel managed adapter unlink", () => {
  it("deauthenticates and notifies the old owner after its last peer moves", async () => {
    const link = {
      adapter: "slack",
      accountId: "workspace-hash",
      actorId: "UOWNER",
      uid: 1000,
      createdAt: 1,
      linkedByUid: 1000,
      metadata: {
        managed: true,
        surfaceId: "DOWNER",
        routeGeneration: "old-route",
      },
    };
    const previousStatus = {
      adapter: "slack",
      accountId: "workspace-hash",
      connected: true,
      authenticated: true,
      mode: "managed-shared",
      lifecycleId: "adapter-account:slack",
      readyOwnerUid: 1000,
      ownerUid: 1000,
      updatedAt: 1,
    };
    const currentStatus = {
      ...previousStatus,
      authenticated: false,
      updatedAt: 2,
    };
    // SAFETY: this focused fixture supplies the Kernel stores and methods used
    // by the managed unlink boundary.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.adapters = {
      identityLinks: {
        get: vi.fn(() => link),
        unlink: vi.fn(() => true),
        listByAccount: vi.fn(() => []),
      },
      status: {
        get: vi.fn(() => previousStatus),
        setOwner: vi.fn(),
        upsert: vi.fn(() => currentStatus),
      },
    };
    kernel.buildKernelContext = vi.fn(() => ({
      adapters: kernel.adapters,
      auth: { isPersonalAgentUid: vi.fn(() => false) },
      responsibilities: {
        listActiveByDedupeKeyPrefix: vi.fn(() => []),
      },
      responsibilitySources: { isEnabled: vi.fn(() => false) },
    }));
    kernel.broadcastToUserUid = vi.fn();

    await expect(kernel.unlinkManagedAdapterIdentity("slack", {
      operationId: "move-peer",
      accountId: "workspace-hash",
      actorId: "UOWNER",
      surfaceId: "DOWNER",
      expectedLocalUid: 1000,
      expectedGeneration: "old-route",
    })).resolves.toEqual({ removed: true });

    expect(kernel.adapters.status.upsert).toHaveBeenCalledWith(
      "slack",
      "workspace-hash",
      expect.objectContaining({
        connected: true,
        authenticated: false,
        mode: "managed-shared",
      }),
    );
    expect(kernel.broadcastToUserUid).toHaveBeenCalledWith(
      1000,
      "adapter.status",
      { adapter: "slack", accountId: "workspace-hash" },
    );
  });
});

function connectedPeer(
  kind: "human" | "machine" | "service",
  id: string,
  uid = 1000,
  implementsList: string[] = [],
) {
  return {
    id,
    sessionId: `session:${id}`,
    principal: {
      kind,
      account: {
        uid,
        gid: uid,
        gids: [uid],
        username: `user-${uid}`,
        home: `/home/user-${uid}`,
        cwd: `/home/user-${uid}`,
      },
    },
    grant: {
      calls: kind === "human" ? ["*"] : [],
      signals: kind === "human"
        ? ["mcp.changed", "proc.run.stream", "proc.changed", "message.committed", "device.status"]
        : kind === "machine"
          ? ["device.status", "peer.pong"]
          : [],
      implements: implementsList,
    },
  };
}

function createRoutedKernel() {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  const kernel = Object.create(Kernel.prototype) as any;
  kernel.installationId = TEST_INSTALLATION_ID;
  kernel.connections = new Map();
  return kernel;
}

describe("Kernel frame bodies", () => {
  it("passes request cancellation to Kernel MCP calls", async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.mcp = { callTool };
    const controller = new AbortController();
    const ctx = kernel.buildKernelContext({ requestSignal: controller.signal });

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

  it("cancels an unfinished request body when a device responds early", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.pendingKernelResponses = new Map();
    kernel.devices = {
      get: () => ({ online: true }),
      canHandle: () => true,
    };
    const deviceConnection = {
      id: "device-connection",
      state: {
        step: "connected",
        peer: connectedPeer("machine", "device-1", 1000, ["net.fetch"]),
      },
    };
    kernel.connections = new Map([[deviceConnection.id, deviceConnection]]);
    kernel.findDeviceConnection = () => deviceConnection;
    kernel.registerRouteWithExpiry = vi.fn(async () => ({ cancel: vi.fn() }));
    const outgoing = { cancel: vi.fn(async () => {}) };
    kernel.sendWebSocketFrame = vi.fn((_connection: KernelTestValue, frame: { id: string }) => {
      queueMicrotask(() => kernel.pendingKernelResponses.get(frame.id)?.({
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.pendingKernelResponses = new Map();
    kernel.devices = {
      get: () => ({ online: true }),
      canHandle: () => true,
    };
    const deviceConnection = {
      id: "device-connection",
      state: {
        step: "connected",
        peer: connectedPeer("machine", "device-1", 1000, ["net.fetch"]),
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.env = {};
    kernel.installationId = TEST_INSTALLATION_ID;
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

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    expect(JSON.parse(sends[0] as string)).toMatchObject({
      type: "res",
      id: "denied-request",
      ok: false,
      error: { code: 403 },
    });
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    expect(parseBinaryFrame(sends[1] as ArrayBuffer)).toMatchObject({
      streamId: 12,
      flags: BINARY_FRAME_CANCEL | BINARY_FRAME_END,
    });
  });

  it("rejects bodies that do not match their declared length", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.routes = {
      get: vi.fn(() => route),
      remove: vi.fn(() => route),
    };
    kernel.routedBodies = new Map();
    kernel.isConnectionForDevice = vi.fn(() => true);
    kernel.decodeWebSocketFrame = vi.fn((_connection: KernelTestValue, frame: KernelTestValue) => frame);
    kernel.deliverToOrigin = vi.fn();

    kernel.handleRes({ id: "current-connection" }, {
      type: "res",
      id: "req-1",
      ok: true,
      data: {
        ok: true,
        path: "/current.txt",
        kind: "text",
        contentType: "text/plain",
        size: 7,
      },
    });

    expect(kernel.routes.remove).toHaveBeenCalledWith("req-1");
    expect(kernel.deliverToOrigin).toHaveBeenCalledWith(route.origin, {
      type: "res",
      id: "req-1",
      ok: true,
      data: {
        ok: true,
        path: "/current.txt",
        kind: "text",
        contentType: "text/plain",
        size: 7,
      },
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.routes = {
      get: () => route,
      remove: () => route,
    };
    kernel.routedBodies = new Map([["req-1", { cancel }]]);
    kernel.isConnectionForDevice = () => true;
    kernel.decodeWebSocketFrame = (_connection: KernelTestValue, frame: KernelTestValue) => frame;
    kernel.deliverToOrigin = vi.fn();

    kernel.handleRes({ id: "device-connection" }, {
      type: "res",
      id: "req-1",
      ok: true,
      data: {
        ok: true,
        url: "https://example.com",
        status: 200,
        statusText: "OK",
        headers: {},
        redirected: false,
      },
    });

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("Device response received"));
    expect(kernel.routedBodies.size).toBe(0);
  });

  it("sends a cancellation frame when an inbound body is discarded", async () => {
    const sends: ArrayBuffer[] = [];
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    const pending: Promise<KernelTestValue>[] = [];
    let cancelled = false;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.frameBodyChannels = new Map();
    kernel.ctx = { waitUntil: (promise: Promise<KernelTestValue>) => pending.push(promise) };
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const descriptor = JSON.parse(sends[0] as string);
    kernel.handleBinaryMessage(
      connection,
      buildBinaryFrame(descriptor.body.streamId, BINARY_FRAME_CANCEL | BINARY_FRAME_END),
    );
    await Promise.all(pending);

    expect(cancelled).toBe(true);
    expect(sends).toHaveLength(1);
  });

});

describe("Kernel nested dispatch", () => {
  it("cancels request bodies rejected by nested capability checks", async () => {
    let cancelled: KernelTestValue;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    expect(cancelled).toBe("Dispatched request completed");
  });

  it("forwards cancellation for an awaited nested device request", async () => {
    const controller = new AbortController();
    const reason = new Error("new user message");
    const driver = {
      id: "driver-connection",
      state: {
        step: "connected",
        peer: connectedPeer("machine", "workstation", 1000, ["shell.exec"]),
      },
    };
    let route: any = null;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.pendingKernelResponses = new Map();
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
    expect(kernel.activeRequests.size).toBe(1);
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
    const peer = connectedPeer("machine", "browser", 1000, ["fs.*"]);
    const oldConnection: any = {
      id: "old-connection",
      state: {
        step: "connected",
        peer,
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.connections = new Map([[oldConnection.id, oldConnection]]);

    kernel.activateConnection(replacement, {
      step: "connected",
      peer,
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
        peer: connectedPeer("machine", "browser", 1000, ["fs.*"]),
      },
    };
    const replacement = {
      id: "new-connection",
      state: {
        step: "connected",
        peer: connectedPeer("machine", "browser", 1000, ["fs.*"]),
      },
    };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
        peer: connectedPeer("machine", "browser", 1000, ["fs.*"]),
      },
    };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.connections = new Map([[connection.id, connection]]);
    kernel.sendWebSocketFrame = vi.fn();

    kernel.handleSig(connection, {
      type: "sig",
      signal: "peer.ping",
      payload: { at: 1234, nonce: "ping-1" },
      seq: 7,
    });

    expect(kernel.sendWebSocketFrame).toHaveBeenCalledWith(connection, {
      type: "sig",
      signal: "peer.pong",
      payload: { at: 1234, nonce: "ping-1" },
      seq: 7,
    });
  });

  it("aborts native requests when their origin disconnects", () => {
    const controller = new AbortController();
    const connection = {
      id: "connection-1",
      state: { step: "connected", peer: connectedPeer("human", "web") },
    };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
        peer: connectedPeer("machine", "node-alpha", 1000, ["fs.*"]),
      },
      close: vi.fn(),
    };
    const beta = {
      state: {
        step: "connected",
        peer: connectedPeer("machine", "node-beta", 1000, ["fs.*"]),
      },
      close: vi.fn(),
    };
    const user = {
      state: {
        step: "connected",
        peer: connectedPeer("human", "web"),
      },
      close: vi.fn(),
    };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as {
      connections: Map<string, KernelTestValue>;
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
    const user = { state: { peer: connectedPeer("human", "web", 1000) }, send: vi.fn() };
    const otherUser = { state: { peer: connectedPeer("human", "web-other", 2000) }, send: vi.fn() };
    const driver = { state: { peer: connectedPeer("machine", "machine", 1000, ["fs.*"]) }, send: vi.fn() };
    const service = { state: { peer: connectedPeer("service", "telegram", 0) }, send: vi.fn() };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.connections = new Map([
      ["user", user],
      ["other-user", otherUser],
      ["driver", driver],
      ["service", service],
    ]);

    kernel.broadcastToUserUid(1000, "mcp.changed", { id: "mcp-1" });

    expect(user.send).toHaveBeenCalledWith(JSON.stringify({
      type: "sig",
      signal: "mcp.changed",
      payload: { id: "mcp-1" },
    }));
    expect(otherUser.send).not.toHaveBeenCalled();
    expect(driver.send).not.toHaveBeenCalled();
    expect(service.send).not.toHaveBeenCalled();
  });

  it("sends raw Process activity only to its routed or observing connections", () => {
    const routed = {
      state: { peer: connectedPeer("human", "routed", 1000) },
      send: vi.fn(),
    };
    const observing = {
      state: {
        peer: connectedPeer("human", "observing", 1000),
        observedProcessIds: ["proc-1"],
      },
      send: vi.fn(),
    };
    const idle = {
      state: { peer: connectedPeer("human", "idle", 1000) },
      send: vi.fn(),
    };
    const other = {
      state: {
        peer: connectedPeer("human", "other", 2000),
        observedProcessIds: ["proc-1"],
      },
      send: vi.fn(),
    };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.connections = new Map([
      ["routed", routed],
      ["observing", observing],
      ["idle", idle],
      ["other", other],
    ]);
    const frame = {
      type: "sig",
      signal: "proc.run.stream",
      payload: { pid: "proc-1", runId: "run-1", seq: 1 },
    };

    kernel.broadcastProcessSignal(1000, "proc-1", {
      kind: "connection",
      connectionId: "routed",
    }, frame);

    const encoded = JSON.stringify(frame);
    expect(routed.send).toHaveBeenCalledWith(encoded);
    expect(observing.send).toHaveBeenCalledWith(encoded);
    expect(idle.send).not.toHaveBeenCalled();
    expect(other.send).not.toHaveBeenCalled();
  });

  it("sends only a content-free Process invalidation to idle owner connections", () => {
    const routed = {
      state: { peer: connectedPeer("human", "routed", 1000) },
      send: vi.fn(),
    };
    const idle = {
      state: { peer: connectedPeer("human", "idle", 1000) },
      send: vi.fn(),
    };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.connections = new Map([["routed", routed], ["idle", idle]]);
    const frame = {
      type: "sig",
      signal: "proc.changed",
      payload: {
        pid: "proc-1",
        runId: "run-private",
        changes: ["messages"],
        content: "private model activity",
        messageId: 42,
        queuedCount: 1,
        timestamp: 123,
      },
    };

    kernel.broadcastProcessSignal(1000, "proc-1", {
      kind: "connection",
      connectionId: "routed",
    }, frame);

    expect(JSON.parse(routed.send.mock.calls[0][0])).toEqual(frame);
    expect(JSON.parse(idle.send.mock.calls[0][0])).toEqual({
      type: "sig",
      signal: "proc.changed",
      payload: {
        pid: "proc-1",
        changes: ["messages"],
        queuedCount: 1,
        timestamp: 123,
      },
    });
  });
});

describe("Kernel canonical message commits", () => {
  const process = {
    processId: "proc-1",
    uid: 1001,
    gid: 1001,
    home: "/home/personal",
    ownerUid: 1000,
    isPersonalController: true,
    label: "Personal",
  };
  const conversation = {
    id: "conv:ship",
    ownerUid: 1000,
    kind: "ship",
    title: "Ship",
    handlerPid: "proc-1",
    latestSequence: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  function buildCommitKernel(route: Record<string, KernelTestValue> | null) {
    const kernel = createRoutedKernel();
    kernel.procs = { get: vi.fn(() => process) };
    kernel.conversations = {
      get: vi.fn(() => conversation),
      ensureShip: vi.fn(() => conversation),
      recordSequence: vi.fn(),
    };
    kernel.runRoutes = {
      get: vi.fn(() => route),
      delete: vi.fn(),
    };
    kernel.materializePersonalAdapterFallback = vi.fn(() => null);
    kernel.queueAdapterSignalDelivery = vi.fn(async () => undefined);
    return kernel;
  }

  function conversationStub() {
    return {
      initialize: vi.fn(async () => undefined),
      append: vi.fn(async (input: any) => ({
        created: true,
        message: {
          id: input.messageId,
          conversationId: conversation.id,
          sequence: 2,
          author: input.author,
          text: input.text,
          media: input.media ?? [],
          origin: input.origin,
          processId: input.processId,
          runId: input.runId,
          createdAt: input.createdAt,
        },
      })),
    };
  }

  it("directs a message only to the originating client while syncing other clients", async () => {
    const route = {
      kind: "connection",
      runId: "run-1",
      processId: "proc-1",
      uid: 1000,
      connectionId: "origin",
    };
    const kernel = buildCommitKernel(route);
    const origin = {
      state: { peer: connectedPeer("human", "origin", 1000) },
      send: vi.fn(),
    };
    const observer = {
      state: { peer: connectedPeer("human", "observer", 1000) },
      send: vi.fn(),
    };
    kernel.connections = new Map([["origin", origin], ["observer", observer]]);
    getConversationByIdMock.mockReset();
    getConversationByIdMock.mockReturnValueOnce(conversationStub());

    const message = await kernel.commitProcessMessage("proc-1", {
      runId: "run-1",
      actionId: "send-1",
      conversationId: conversation.id,
      text: "hello",
    });

    expect(JSON.parse(origin.send.mock.calls[0][0])).toMatchObject({
      signal: "message.committed",
      payload: { message: { id: message.id, text: "hello" }, directed: true },
    });
    expect(JSON.parse(observer.send.mock.calls[0][0])).toMatchObject({
      signal: "message.committed",
      payload: { message: { id: message.id, text: "hello" }, directed: false },
    });
    expect(kernel.runRoutes.delete).not.toHaveBeenCalled();
  });

  it("keeps a silenced client route until the terminal run signal", async () => {
    const route = {
      kind: "connection",
      runId: "run-silenced",
      processId: "proc-1",
      uid: 1000,
      connectionId: "origin",
    };
    const kernel = buildCommitKernel(route);

    await kernel.deliverProcessMessageStream("proc-1", {
      type: "sig",
      signal: "proc.message.stream",
      payload: {
        pid: "proc-1",
        runId: "run-silenced",
        conversationId: conversation.id,
        messageId: "draft:run-silenced",
        phase: "silenced",
        timestamp: 1,
      },
    });

    expect(kernel.runRoutes.delete).not.toHaveBeenCalled();
  });

  it("uses the last authorized private destination only for an explicit Personal message", async () => {
    const route = {
      kind: "adapter",
      runId: "run-background",
      processId: "proc-1",
      uid: 1000,
      destination: {
        kind: "adapter",
        adapter: "telegram",
        accountId: "managed",
        actorId: "actor-1",
        surface: { kind: "dm", id: "chat-1" },
      },
    };
    const kernel = buildCommitKernel(null);
    kernel.materializePersonalAdapterFallback.mockReturnValue(route);
    const synced = {
      state: { peer: connectedPeer("human", "web", 1000) },
      send: vi.fn(),
    };
    kernel.connections = new Map([["web", synced]]);
    getConversationByIdMock.mockReset();
    getConversationByIdMock.mockReturnValueOnce(conversationStub());

    const message = await kernel.commitProcessMessage("proc-1", {
      runId: "run-background",
      actionId: "send-background",
      text: "new mail",
    });

    expect(kernel.queueAdapterSignalDelivery).toHaveBeenCalledWith(
      route,
      {
        type: "sig",
        signal: "message.committed",
        payload: { message, directed: true },
      },
      1,
    );
    expect(JSON.parse(synced.send.mock.calls[0][0])).toMatchObject({
      signal: "message.committed",
      payload: { directed: false },
    });
  });

  it("does not redirect a disconnected client conversation to an adapter", async () => {
    const kernel = buildCommitKernel(null);
    kernel.connections = new Map();
    getConversationByIdMock.mockReset();
    getConversationByIdMock.mockReturnValueOnce(conversationStub());

    await kernel.commitProcessMessage("proc-1", {
      runId: "run-disconnected-client",
      actionId: "send-disconnected",
      conversationId: conversation.id,
      text: "stays in Ship",
    });

    expect(kernel.materializePersonalAdapterFallback).not.toHaveBeenCalled();
    expect(kernel.queueAdapterSignalDelivery).not.toHaveBeenCalled();
  });

  it("uses a distinct idempotency identity for every send in one run", async () => {
    const kernel = buildCommitKernel(null);
    kernel.connections = new Map();
    const stub = conversationStub();
    getConversationByIdMock.mockReset();
    getConversationByIdMock.mockReturnValue(stub);

    await kernel.commitProcessMessage("proc-1", {
      runId: "run-multiple-sends",
      actionId: "progress-send",
      conversationId: conversation.id,
      text: "Still working.",
    });
    await kernel.commitProcessMessage("proc-1", {
      runId: "run-multiple-sends",
      actionId: "final-send",
      conversationId: conversation.id,
      text: "Finished.",
    });

    expect(stub.append.mock.calls.map(([input]: [any]) => input.idempotencyKey)).toEqual([
      "output:proc-1:run-multiple-sends:progress-send",
      "output:proc-1:run-multiple-sends:final-send",
    ]);
    expect(stub.append.mock.calls.map(([input]: [any]) => input.messageId))
      .toEqual([expect.any(String), expect.any(String)]);
    expect(stub.append.mock.calls[0][0].messageId)
      .not.toBe(stub.append.mock.calls[1][0].messageId);
  });
});

describe("Kernel process signal routing", () => {
  function buildKernel(route: Record<string, KernelTestValue>) {
    const kernel = createRoutedKernel();
    kernel.procs = {
      getOwnerUid: vi.fn(() => 1000),
      get: vi.fn(() => ({
        processId: "proc-1",
        ownerUid: 1000,
        isPersonalController: false,
        state: "idle",
        activeRunId: null,
        queuedCount: 0,
      })),
    };
    kernel.adapters = {
      surfaceRoutes: { clearLegacyForProcess: vi.fn() },
      privateDestinations: { get: vi.fn(() => null), clearIfMatches: vi.fn() },
    };
    kernel.dispatchSignalWatches = vi.fn(async () => {});
    kernel.runRoutes = {
      get: vi.fn(() => route),
      delete: vi.fn(),
      materializeProcessApprovalRoute: vi.fn(() => null),
    };
    kernel.broadcastToUserUid = vi.fn();
    kernel.broadcastProcessSignal = vi.fn((_uid, _processId, _route, frame) => {
      kernel.broadcastToUserUid(1000, frame.signal, frame.payload);
    });
    kernel.deliverSignalToConnection = vi.fn();
    kernel.deliverSignalToAdapter = vi.fn(async () => ({ state: "delivered" }));
    kernel.schedule = vi.fn(async () => ({ id: "scheduled-delivery" }));
    return kernel;
  }

  const preferredDestination = {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    kind: "adapter" as const,
    adapter: "telegram",
    accountId: "bot",
    actorId: "telegram:user:42",
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    surface: { kind: "dm" as const, id: "chat-42" },
  };

  function buildPersonalFallbackKernel(options: {
    exactRoute?: Record<string, KernelTestValue> | null;
    preferred?: typeof preferredDestination | null;
    authorized?: boolean;
  } = {}) {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = buildKernel((options.exactRoute ?? null) as any);
    const process = {
      processId: "proc-1",
      ownerUid: 1000,
      isPersonalController: true,
      state: "idle",
      activeRunId: null,
      queuedCount: 0,
    };
    kernel.procs.get.mockReturnValue(process);
    const preferred = options.preferred === undefined
      ? preferredDestination
      : options.preferred;
    const getPreferred = vi.fn(() => preferred
      ? { uid: 1000, destination: preferred, updatedAt: 1 }
      : null);
    const clearPreferred = vi.fn(() => true);
    kernel.adapters.privateDestinations = {
      get: getPreferred,
      clearIfMatches: clearPreferred,
    };
    const link = options.authorized === false
      ? null
      : {
          adapter: "telegram",
          accountId: "bot",
          actorId: "telegram:user:42",
          uid: 1000,
          metadata: { surfaceKind: "dm", surfaceId: "chat-42" },
        };
    kernel.buildProcessContext = vi.fn(() => ({
      procs: kernel.procs,
      adapters: {
        identityLinks: { get: vi.fn(() => link) },
        surfaceRoutes: { get: vi.fn(() => null), resolveRoute: vi.fn(() => null) },
        privateDestinations: kernel.adapters.privateDestinations,
      },
    }));
    const setAdapterRoute = vi.fn((input) => ({
      kind: "adapter",
      ...input,
      createdAt: 1,
      expiresAt: 2,
    }));
    kernel.runRoutes.setAdapterRoute = setAdapterRoute;
    kernel.attemptAdapterSignalDelivery = vi.fn(async () => {});
    kernel.queueAdapterSignalDelivery = vi.fn(async () => {});
    return {
      kernel,
      getPreferred,
      clearPreferred,
      setAdapterRoute,
    };
  }

  const connectionRoute = {
    kind: "connection",
    runId: "run-1",
    processId: "proc-1",
    uid: 1000,
    connectionId: "connection-1",
  };

  function hilPayload(runId: string, requestId: string) {
    return {
      pid: "proc-1",
      runId,
      requestId,
      callId: `call-${requestId}`,
      toolName: "Shell",
      syscall: "shell.exec",
      target: "gsv",
      args: { input: "date" },
      createdAt: 1,
    };
  }

  it("hands an exact HIL signal to the adapter and stops Kernel retries after acceptance", async () => {
    const adapterFrame = vi.fn(async () => null);
    const route = {
      kind: "adapter",
      runId: "run-frame",
      processId: "proc-1",
      uid: 1000,
      destination: {
        kind: "adapter",
        adapter: "telegram",
        accountId: "managed",
        actorId: "telegram:user:42",
        surface: { kind: "dm", id: "chat-42" },
      },
      replyToId: "provider-message-1",
      routeGeneration: "generation-1",
    };
    const kernel = buildKernel(route);
    kernel.installationEnv = {
      CHANNEL_TELEGRAM: {
        adapterDescribe: vi.fn(async () => ({
          version: 1,
          id: "telegram",
          displayName: "Telegram",
          capabilities: {
            connect: true,
            disconnect: true,
            send: true,
            status: true,
            activity: true,
            pairing: false,
            surfaces: ["dm"],
            media: { inbound: [], outbound: [] },
          },
        })),
        adapterFrame,
      },
    };
    kernel.procs.get.mockReturnValue({
      processId: "proc-1",
      ownerUid: 1000,
      isPersonalController: false,
    });
    kernel.buildProcessContext = vi.fn(() => ({
      adapters: {
        identityLinks: {
          get: vi.fn(() => ({
            uid: 1000,
            metadata: { surfaceKind: "dm", surfaceId: "chat-42" },
          })),
        },
        surfaceRoutes: { get: vi.fn(() => null) },
        privateDestinations: { clearIfMatches: vi.fn() },
      },
    }));
    const payload = hilPayload(route.runId, "request-frame");

    await expect(kernel.deliverAdapterPeerSignal(route, {
      type: "sig",
      signal: "proc.run.hil.requested",
      payload,
    })).resolves.toEqual({ state: "accepted" });

    expect(adapterFrame).toHaveBeenCalledWith(
      { installationId: TEST_INSTALLATION_ID },
      {
        deliveryId: "run-frame:hil:request-frame",
        accountId: "managed",
        actorId: "telegram:user:42",
        surface: { kind: "dm", id: "chat-42" },
        replyToId: "provider-message-1",
        routeGeneration: "generation-1",
        processId: "proc-1",
        runId: "run-frame",
        processMode: "work",
      },
      {
        type: "sig",
        signal: "proc.run.hil.requested",
        payload,
      },
      undefined,
    );
  });

  it("claims only the current route and lets a successful final report retire it", async () => {
    const route = {
      kind: "adapter",
      runId: "run-claim",
      processId: "proc-1",
      uid: 1000,
      destination: {
        kind: "adapter",
        adapter: "slack",
        accountId: "workspace-1",
        actorId: "UALICE01",
        surface: { kind: "dm", id: "DALICE01" },
      },
      routeGeneration: "generation-1",
    };
    const kernel = buildKernel(route);
    kernel.isAdapterHilRequestPending = vi.fn(async () => true);
    const reference = {
      adapter: "slack",
      accountId: "workspace-1",
      deliveryId: "message-1",
      actorId: "UALICE01",
      surface: { kind: "dm", id: "DALICE01" },
      routeGeneration: "generation-1",
      processId: "proc-1",
      runId: "run-claim",
      kind: "message" as const,
    };

    await expect(kernel.claimAdapterDelivery(reference)).resolves.toEqual({
      ok: true,
      deliver: true,
    });
    await expect(kernel.claimAdapterDelivery({
      ...reference,
      routeGeneration: "generation-stale",
    })).resolves.toEqual({
      ok: true,
      deliver: false,
      reason: "route_changed",
    });
    await expect(kernel.reportAdapterDelivery({
      ...reference,
      state: "sent",
      attempts: 1,
      messageId: "provider-1",
    })).resolves.toEqual({ ok: true });
    expect(kernel.runRoutes.delete).toHaveBeenCalledWith("run-claim");
  });

  function historyResponse(pendingHil: ReturnType<typeof hilPayload> | null) {
    return {
      type: "res",
      id: "history-response",
      ok: true,
      data: {
        ok: true,
        pid: "proc-1",
        messages: [],
        messageCount: 0,
        pendingHil,
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as const;
  }

  it("acknowledges HIL only after its durable delivery work is queued", async () => {
    let release!: () => void;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.updateProcessRuntimeFromSignal = vi.fn(() => true);
    kernel.enqueueProcessSignal = vi.fn(() => queued);
    kernel.completeIpcCallsForProcessSignal = vi.fn();
    const frame = {
      type: "sig",
      signal: "proc.run.hil.requested",
      payload: { pid: "proc-1", runId: "run-hil", requestId: "hil-1" },
    };

    let acknowledged = false;
    const receiving = kernel.recvFrame("proc-1", frame).then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    release();
    await receiving;
    expect(kernel.enqueueProcessSignal).toHaveBeenCalledWith("proc-1", frame, frame);
  });

  it("broadcasts connection-routed HIL requests without duplicating the origin", async () => {
    const kernel = buildKernel(connectionRoute);
    const frame = {
      type: "sig",
      signal: "proc.run.hil.requested",
      payload: { pid: "proc-1", runId: "run-1", requestId: "hil-1" },
    };

    await kernel.handleProcessSignal("proc-1", frame, frame);

    expect(kernel.broadcastToUserUid).toHaveBeenCalledWith(1000, frame.signal, frame.payload);
    expect(kernel.deliverSignalToConnection).not.toHaveBeenCalled();
    expect(kernel.deliverSignalToAdapter).not.toHaveBeenCalled();
  });

  it("broadcasts adapter-routed HIL requests and durably queues attempt one", async () => {
    const route = {
      kind: "adapter",
      runId: "run-1",
      processId: "proc-1",
      uid: 1000,
      destination: {
        kind: "adapter",
        adapter: "discord",
        accountId: "account-1",
        actorId: "actor-1",
        surface: { kind: "dm", id: "surface-1" },
      },
    };
    const kernel = buildKernel(route);
    const frame = {
      type: "sig",
      signal: "proc.run.hil.requested",
      payload: { pid: "proc-1", runId: "run-1", requestId: "hil-1" },
    };

    await kernel.handleProcessSignal("proc-1", frame, frame);

    expect(kernel.broadcastToUserUid).toHaveBeenCalledWith(1000, frame.signal, frame.payload);
    expect(kernel.deliverSignalToAdapter).not.toHaveBeenCalled();
    expect(kernel.schedule).toHaveBeenCalledWith(
      expect.any(Date),
      "onAdapterSignalDelivery",
      expect.objectContaining({
        runId: route.runId,
        signal: frame.signal,
        attempt: 1,
      }),
      expect.objectContaining({ idempotent: true }),
    );
  });

  it("materializes a background child's inherited approval route", async () => {
    const inherited = {
      kind: "adapter",
      runId: "run-child",
      processId: "proc-1",
      uid: 1000,
      destination: {
        kind: "adapter",
        adapter: "telegram",
        accountId: "bot",
        actorId: "actor-1",
        surface: { kind: "dm", id: "chat-1" },
      },
    };
    const kernel = buildKernel(null);
    kernel.runRoutes.materializeProcessApprovalRoute.mockReturnValue(inherited);
    const frame = {
      type: "sig",
      signal: "proc.run.hil.requested",
      payload: { pid: "proc-1", runId: inherited.runId, requestId: "hil-child" },
    };

    await kernel.handleProcessSignal("proc-1", frame, frame);

    expect(kernel.runRoutes.materializeProcessApprovalRoute).toHaveBeenCalledWith({
      processId: "proc-1",
      runId: inherited.runId,
      uid: 1000,
    });
    expect(kernel.schedule).toHaveBeenCalledWith(
      expect.any(Date),
      "onAdapterSignalDelivery",
      expect.objectContaining({ runId: inherited.runId, signal: frame.signal }),
      expect.objectContaining({ idempotent: true }),
    );
  });

  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  it("does not treat process completion as a user message", async () => {
    const { kernel, setAdapterRoute } = buildPersonalFallbackKernel();
    const frame = {
      type: "sig",
      signal: "proc.run.finished",
      payload: { pid: "proc-1", runId: "run-background", text: "Mail is ready.", queuedCount: 0 },
    };

    await kernel.handleProcessSignal("proc-1", frame, frame);

    expect(setAdapterRoute).not.toHaveBeenCalled();
    expect(kernel.attemptAdapterSignalDelivery).not.toHaveBeenCalled();
    expect(kernel.broadcastToUserUid).toHaveBeenCalledOnce();
  });

  it("routes a background personal HIL request to the last active private destination", async () => {
    const { kernel, setAdapterRoute } = buildPersonalFallbackKernel();
    const frame = {
      type: "sig",
      signal: "proc.run.hil.requested",
      payload: hilPayload("run-background-hil", "hil-background"),
    };

    await kernel.handleProcessSignal("proc-1", frame, frame);

    expect(setAdapterRoute).toHaveBeenCalledOnce();
    expect(kernel.queueAdapterSignalDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ destination: preferredDestination }),
      frame,
      1,
    );
  });

  it("does not redirect a disconnected client approval to an adapter", async () => {
    const { kernel, setAdapterRoute } = buildPersonalFallbackKernel();
    const frame = {
      type: "sig",
      signal: "proc.run.hil.requested",
      payload: {
        ...hilPayload("run-client-hil", "hil-client"),
        conversationId: "conv:home",
      },
    };

    await kernel.handleProcessSignal("proc-1", frame, frame);

    expect(setAdapterRoute).not.toHaveBeenCalled();
    expect(kernel.queueAdapterSignalDelivery).not.toHaveBeenCalled();
    expect(kernel.broadcastToUserUid).toHaveBeenCalledOnce();
  });

  it("drops and clears a revoked personal fallback before adapter delivery", async () => {
    const { kernel, setAdapterRoute, clearPreferred } = buildPersonalFallbackKernel({
      authorized: false,
    });
    const frame = {
      type: "sig",
      signal: "proc.run.hil.requested",
      payload: hilPayload("run-revoked", "hil-revoked"),
    };

    await kernel.handleProcessSignal("proc-1", frame, frame);

    expect(clearPreferred).toHaveBeenCalledWith(1000, preferredDestination);
    expect(setAdapterRoute).not.toHaveBeenCalled();
    expect(kernel.attemptAdapterSignalDelivery).not.toHaveBeenCalled();
    expect(kernel.broadcastToUserUid).toHaveBeenCalledOnce();
  });

  it("keeps exact Web routes exclusive and leaves no-destination personal runs Web-only", async () => {
    const exact = {
      kind: "connection",
      runId: "run-web",
      processId: "proc-1",
      uid: 1000,
      connectionId: "web-1",
    };
    const web = buildPersonalFallbackKernel({ exactRoute: exact });
    const webFrame = {
      type: "sig",
      signal: "proc.run.finished",
      payload: { pid: "proc-1", runId: "run-web", text: "web", queuedCount: 0 },
    };
    await web.kernel.handleProcessSignal("proc-1", webFrame, webFrame);
    expect(web.getPreferred).not.toHaveBeenCalled();
    expect(web.setAdapterRoute).not.toHaveBeenCalled();

    const noDestination = buildPersonalFallbackKernel({ preferred: null });
    const noDestinationFrame = {
      type: "sig",
      signal: "proc.run.finished",
      payload: { pid: "proc-1", runId: "run-no-destination", text: "web only", queuedCount: 0 },
    };
    await noDestination.kernel.handleProcessSignal(
      "proc-1",
      noDestinationFrame,
      noDestinationFrame,
    );
    expect(noDestination.setAdapterRoute).not.toHaveBeenCalled();
    expect(noDestination.kernel.broadcastToUserUid).toHaveBeenCalledOnce();
  });

  it("clears legacy DM routes only after a process becomes fully idle", async () => {
    const terminal = {
      type: "sig",
      signal: "proc.run.finished",
      payload: { pid: "proc-1", runId: "run-1", text: "done", queuedCount: 0 },
    };
    const idle = buildKernel(connectionRoute);
    await idle.handleProcessSignal("proc-1", terminal, terminal);
    expect(idle.adapters.surfaceRoutes.clearLegacyForProcess).toHaveBeenCalledWith("proc-1");

    const queued = buildKernel(connectionRoute);
    queued.procs.get.mockReturnValue({
      processId: "proc-1",
      ownerUid: 1000,
      isPersonalController: false,
      state: "queued",
      activeRunId: null,
      queuedCount: 1,
    });
    await queued.handleProcessSignal("proc-1", terminal, terminal);
    expect(queued.adapters.surfaceRoutes.clearLegacyForProcess).not.toHaveBeenCalled();
  });

  it("suppresses a queued HIL prompt after its approval is resolved", async () => {
    sendFrameToProcessMock.mockReset();
    sendFrameToProcessMock.mockResolvedValueOnce(historyResponse(null));
    const route = {
      kind: "adapter",
      runId: "run-hil-resolved",
      processId: "proc-1",
      uid: 1000,
      destination: {
        kind: "adapter",
        adapter: "telegram",
        accountId: "bot",
        actorId: "actor-1",
        surface: { kind: "dm", id: "chat-1" },
      },
    };
    const kernel = buildKernel(route);

    await kernel.onAdapterSignalDelivery({
      runId: route.runId,
      processId: route.processId,
      signal: "proc.run.hil.requested",
      payload: hilPayload(route.runId, "hil-resolved"),
      attempt: 2,
    });

    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      route.processId,
      expect.objectContaining({
        type: "req",
        call: "proc.history",
      }),
    );
    expect(kernel.deliverSignalToAdapter).not.toHaveBeenCalled();
    expect(kernel.schedule).not.toHaveBeenCalled();
  });

  it("suppresses an older queued HIL prompt after the run advances to another approval", async () => {
    sendFrameToProcessMock.mockReset();
    const route = {
      kind: "adapter",
      runId: "run-hil-next",
      processId: "proc-1",
      uid: 1000,
      destination: {
        kind: "adapter",
        adapter: "telegram",
        accountId: "bot",
        actorId: "actor-1",
        surface: { kind: "dm", id: "chat-1" },
      },
    };
    sendFrameToProcessMock.mockResolvedValueOnce(
      historyResponse(hilPayload(route.runId, "hil-current")),
    );
    const kernel = buildKernel(route);

    await kernel.onAdapterSignalDelivery({
      runId: route.runId,
      processId: route.processId,
      signal: "proc.run.hil.requested",
      payload: hilPayload(route.runId, "hil-old"),
      attempt: 3,
    });

    expect(kernel.deliverSignalToAdapter).not.toHaveBeenCalled();
    expect(kernel.schedule).not.toHaveBeenCalled();
  });

  it("continues retrying a HIL prompt while that exact approval is pending", async () => {
    sendFrameToProcessMock.mockReset();
    const route = {
      kind: "adapter",
      runId: "run-hil-pending",
      processId: "proc-1",
      uid: 1000,
      destination: {
        kind: "adapter",
        adapter: "telegram",
        accountId: "bot",
        actorId: "actor-1",
        surface: { kind: "dm", id: "chat-1" },
      },
    };
    const payload = hilPayload(route.runId, "hil-pending");
    sendFrameToProcessMock.mockResolvedValueOnce(historyResponse(payload));
    const kernel = buildKernel(route);
    kernel.deliverSignalToAdapter.mockResolvedValueOnce({
      state: "retryable",
      error: "adapter temporarily unavailable",
    });

    await kernel.onAdapterSignalDelivery({
      runId: route.runId,
      processId: route.processId,
      signal: "proc.run.hil.requested",
      payload,
      attempt: 2,
    });

    expect(kernel.deliverSignalToAdapter).toHaveBeenCalledWith(route, {
      type: "sig",
      signal: "proc.run.hil.requested",
      payload,
    });
    expect(kernel.schedule).toHaveBeenCalledWith(
      expect.any(Date),
      "onAdapterSignalDelivery",
      expect.objectContaining({ attempt: 3 }),
      expect.any(Object),
    );
  });

  it("uses request-specific delivery notice identities for approvals in one run", async () => {
    const route = {
      kind: "adapter",
      runId: "run-multiple-hil",
      processId: "proc-1",
      uid: 1000,
      destination: {
        kind: "adapter",
        adapter: "telegram",
        accountId: "bot",
        actorId: "actor-1",
        surface: { kind: "dm", id: "chat-1" },
      },
    };
    const kernel = buildKernel(route);

    await kernel.queueProcessDeliveryNotice(
      route,
      {
        type: "sig",
        signal: "proc.run.hil.requested",
        payload: hilPayload(route.runId, "hil-first"),
      },
      { state: "permanent", message: "First approval delivery failed." },
    );
    await kernel.queueProcessDeliveryNotice(
      route,
      {
        type: "sig",
        signal: "proc.run.hil.requested",
        payload: hilPayload(route.runId, "hil-second"),
      },
      { state: "permanent", message: "Second approval delivery failed." },
    );

    const first = kernel.schedule.mock.calls[0][2];
    const second = kernel.schedule.mock.calls[1][2];
    expect(first).toMatchObject({ deliveryKind: "hil", requestId: "hil-first" });
    expect(second).toMatchObject({ deliveryKind: "hil", requestId: "hil-second" });
    expect(first.noticeId).not.toBe(second.noticeId);
  });

  it("broadcasts ordinary run signals once instead of duplicating the origin route", async () => {
    const kernel = buildKernel(connectionRoute);
    const frame = {
      type: "sig",
      signal: "proc.run.stream",
      payload: { pid: "proc-1", runId: "run-1", event: { type: "text_delta", delta: "hi" } },
    };

    await kernel.handleProcessSignal("proc-1", frame, frame);

    expect(kernel.broadcastToUserUid).toHaveBeenCalledOnce();
    expect(kernel.broadcastToUserUid).toHaveBeenCalledWith(1000, frame.signal, frame.payload);
    expect(kernel.deliverSignalToConnection).not.toHaveBeenCalled();
  });

  it("durably retries a committed adapter message without deleting its route", async () => {
    const route = {
      kind: "adapter",
      runId: "run-retry",
      processId: "proc-1",
      uid: 1000,
      destination: {
        kind: "adapter",
        adapter: "telegram",
        accountId: "bot",
        actorId: "actor-1",
        surface: { kind: "dm", id: "chat-1" },
      },
    };
    const kernel = buildKernel(route);
    kernel.deliverSignalToAdapter.mockResolvedValue({
      state: "retryable",
      error: "service binding disconnected",
    });
    kernel.schedule = vi.fn(async () => ({ id: "retry-job" }));
    const frame = {
      type: "sig",
      signal: "message.committed",
      payload: {
        message: {
          id: "msg:retry",
          conversationId: "conv:home",
          sequence: 2,
          author: { kind: "process", pid: "proc-1", uid: 1001 },
          text: "done",
          origin: { kind: "process", pid: "proc-1", runId: route.runId },
          processId: "proc-1",
          runId: route.runId,
          createdAt: 2,
        },
      },
    };

    await kernel.attemptAdapterSignalDelivery(route, frame, 1);

    expect(kernel.schedule).toHaveBeenCalledWith(
      expect.any(Date),
      "onAdapterSignalDelivery",
      expect.objectContaining({
        runId: route.runId,
        processId: route.processId,
        signal: "message.committed",
        attempt: 2,
      }),
      expect.objectContaining({ idempotent: true }),
    );
    expect(kernel.runRoutes.delete).not.toHaveBeenCalled();
  });

  it("keeps a committed-message route until its ambiguous delivery notice is acknowledged", async () => {
    const route = {
      kind: "adapter",
      runId: "run-ambiguous",
      processId: "proc-1",
      uid: 1000,
      destination: {
        kind: "adapter",
        adapter: "whatsapp",
        accountId: "primary",
        actorId: "actor-1",
        surface: { kind: "dm", id: "chat-1" },
      },
    };
    const kernel = buildKernel(route);
    kernel.deliverSignalToAdapter.mockResolvedValue({
      state: "ambiguous",
      error: "provider acknowledgement was lost",
    });
    kernel.queueProcessDeliveryNotice = vi.fn(async () => {});
    const frame = {
      type: "sig",
      signal: "message.committed",
      payload: {
        message: {
          id: "msg:ambiguous",
          conversationId: "conv:home",
          sequence: 2,
          author: { kind: "process", pid: "proc-1", uid: 1001 },
          text: "done",
          origin: { kind: "process", pid: "proc-1", runId: route.runId },
          processId: "proc-1",
          runId: route.runId,
          createdAt: 2,
        },
      },
    };

    await kernel.attemptAdapterSignalDelivery(route, frame, 1);

    expect(kernel.runRoutes.delete).not.toHaveBeenCalled();
    expect(kernel.queueProcessDeliveryNotice).toHaveBeenCalledWith(
      route,
      frame,
      expect.objectContaining({
        state: "ambiguous",
        message: expect.stringContaining("not retried"),
      }),
    );
  });

  it("suppresses stale delivery notices after their run route is cleared", async () => {
    sendFrameToProcessMock.mockReset();
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.runRoutes = { get: vi.fn(() => null), delete: vi.fn() };

    await kernel.onProcessDeliveryNotice({
      noticeId: "notice:stale",
      runId: "run-stale",
      processId: "proc-1",
      deliveryKind: "final",
      state: "exhausted",
      message: "Delivery stopped.",
      cleanupRunRoute: true,
    });

    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
    expect(kernel.runRoutes.delete).not.toHaveBeenCalled();
  });

  it("suppresses a HIL delivery notice after its approval is resolved", async () => {
    sendFrameToProcessMock.mockReset();
    sendFrameToProcessMock.mockResolvedValueOnce(historyResponse(null));
    const route = {
      kind: "adapter",
      runId: "run-hil-notice-stale",
      processId: "proc-1",
    };
    const kernel = createRoutedKernel();
    kernel.runRoutes = { get: vi.fn(() => route), delete: vi.fn() };

    await kernel.onProcessDeliveryNotice({
      noticeId: "notice:hil:stale",
      runId: route.runId,
      processId: route.processId,
      deliveryKind: "hil",
      requestId: "hil-stale",
      state: "exhausted",
      message: "Approval delivery stopped.",
      cleanupRunRoute: false,
    });

    expect(sendFrameToProcessMock).toHaveBeenCalledTimes(1);
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      route.processId,
      expect.objectContaining({
        type: "req",
        call: "proc.history",
      }),
    );
    expect(kernel.runRoutes.delete).not.toHaveBeenCalled();
  });

  it("records a request-specific HIL delivery notice while its approval is pending", async () => {
    sendFrameToProcessMock.mockReset();
    const route = {
      kind: "adapter",
      runId: "run-hil-notice-current",
      processId: "proc-1",
    };
    const pending = hilPayload(route.runId, "hil-current");
    sendFrameToProcessMock
      .mockResolvedValueOnce(historyResponse(pending))
      .mockResolvedValueOnce(null);
    const kernel = createRoutedKernel();
    kernel.runRoutes = { get: vi.fn(() => route), delete: vi.fn() };

    await kernel.onProcessDeliveryNotice({
      noticeId: "notice:hil:current",
      runId: route.runId,
      processId: route.processId,
      deliveryKind: "hil",
      requestId: pending.requestId,
      state: "ambiguous",
      message: "Approval delivery is ambiguous.",
      cleanupRunRoute: false,
    });

    expect(sendFrameToProcessMock).toHaveBeenLastCalledWith(
      TEST_INSTALLATION_ID,
      route.processId,
      expect.objectContaining({
        type: "sig",
        signal: "proc.delivery.notice",
        payload: expect.objectContaining({
          noticeId: "notice:hil:current",
          requestId: pending.requestId,
        }),
      }),
    );
    expect(kernel.runRoutes.delete).not.toHaveBeenCalled();
  });

  it("clears a final run route only after its delivery notice is accepted", async () => {
    sendFrameToProcessMock.mockReset();
    sendFrameToProcessMock.mockResolvedValueOnce(null);
    const route = {
      kind: "adapter",
      runId: "run-notice",
      processId: "proc-1",
    };
    const kernel = createRoutedKernel();
    kernel.runRoutes = { get: vi.fn(() => route), delete: vi.fn() };

    await kernel.onProcessDeliveryNotice({
      noticeId: "notice:accepted",
      runId: route.runId,
      processId: route.processId,
      deliveryKind: "final",
      state: "ambiguous",
      message: "Delivery is ambiguous.",
      cleanupRunRoute: true,
    });

    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      route.processId,
      expect.objectContaining({
        signal: "proc.delivery.notice",
        payload: expect.objectContaining({ noticeId: "notice:accepted" }),
      }),
    );
    expect(kernel.runRoutes.delete).toHaveBeenCalledWith(route.runId);
  });
});

describe("Kernel adapter route replies", () => {
  const route = {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    kind: "adapter" as const,
    runId: "run-adapter-reply",
    processId: "proc-1",
    uid: 1000,
    destination: {
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      kind: "adapter" as const,
      adapter: "telegram",
      accountId: "bot",
      actorId: "telegram:user:42",
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      surface: { kind: "dm" as const, id: "chat-42" },
    },
    replyToId: "incoming-42",
    routeGeneration: "generation-42",
    createdAt: 1,
    expiresAt: 2,
  };

  it("starts adapter typing from the process lifecycle signal", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const adapterSetActivity = vi.fn(async () => ({ ok: true as const }));
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.env = { CHANNEL_TELEGRAM: { adapterSetActivity } };
    kernel.installationId = TEST_INSTALLATION_ID;

    await expect(kernel.deliverSignalToAdapter(route, {
      type: "sig",
      signal: "proc.run.started",
      payload: { runId: route.runId },
    })).resolves.toEqual({ state: "delivered" });

    expect(adapterSetActivity).toHaveBeenCalledTimes(1);
    expect(adapterSetActivity).toHaveBeenCalledWith(
      { installationId: TEST_INSTALLATION_ID },
      route.destination.accountId,
      route.destination.surface,
      {
        kind: "typing",
        active: true,
        routeGeneration: "generation-42",
      },
    );
  });

  it("streams a retained resource after its originating Process is gone", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    const key = `home/sam/.gsv/media/archived-media:${"a".repeat(64)}`;
    const revision = '"archive-revision"';
    kernel.installationId = TEST_INSTALLATION_ID;
    kernel.auth = {
      getPasswdByUid: vi.fn(() => ({
        uid: 1001,
        gid: 1001,
        username: "sam",
        home: "/home/sam",
      })),
    };
    kernel.installationStorage = {
      get: vi.fn(async () => ({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([4, 5, 6]));
            controller.close();
          },
        }),
        httpEtag: revision,
        size: 3,
        httpMetadata: { contentType: "image/png" },
        customMetadata: {
          purpose: "resource",
          uid: "1001",
          gid: "1001",
          mode: "400",
          sourceEtag: '"source-revision"',
          sourceContentType: "image/png",
        },
      })),
    };

    const bundle = await kernel.bundleConversationReplyMedia("conv:home", [{
      type: "resource",
      ref: {
        type: "file",
        target: "gsv",
        path: `/${key}`,
        revision,
        contentType: "image/png",
        size: 3,
      },
      mediaType: "image",
      filename: "hand.png",
    }], 1001);

    expect(bundle.media).toEqual([{
      type: "image",
      mimeType: "image/png",
      filename: "hand.png",
      size: 3,
      body: { offset: 0, length: 3 },
    }]);
    const body = bundle.body;
    expect(body).toBeDefined();
    if (!body) throw new Error("Expected bundled resource body");
    expect([
      ...new Uint8Array(await new Response(body.stream).arrayBuffer()),
    ]).toEqual([4, 5, 6]);
    expect(kernel.procs).toBeUndefined();
  });

  it("rejects message media whose descriptor differs from its conversation object", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    const key = `conversations/conv%3Ahome/media/msg%3Atwo/0`;
    const cancel = vi.fn(async () => undefined);
    kernel.installationId = TEST_INSTALLATION_ID;
    getConversationByIdMock.mockReturnValueOnce({
      readMedia: vi.fn(async () => ({
        key,
        mimeType: "image/png",
        size: 3,
        stream: { cancel },
      })),
    });

    await expect(kernel.bundleConversationReplyMedia("conv:home", [{
      type: "document",
      mimeType: "application/pdf",
      filename: "report.pdf",
      key,
      conversationId: "conv:home",
      size: 3,
    }], 1001)).rejects.toThrow("descriptor does not match");
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("Kernel scheduled process reply routes", () => {
  const destination = {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    kind: "adapter" as const,
    adapter: "telegram",
    accountId: "bot",
    actorId: "telegram:user:42",
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    surface: { kind: "dm" as const, id: "chat-42" },
  };

  function makeScheduledProcessKernel() {
    const setAdapterRoute = vi.fn();
    const deleteRoute = vi.fn();
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.buildScheduleContext = vi.fn(() => ({
      identity: {
        role: "user",
        capabilities: ["proc.send", "adapter.send"],
      },
      adapters: {
        identityLinks: {
          get: vi.fn(() => ({
            adapter: "telegram",
            accountId: "bot",
            actorId: "telegram:user:42",
            uid: 1000,
            metadata: { surfaceKind: "dm", surfaceId: "chat-42" },
          })),
        },
        surfaceRoutes: { get: vi.fn(() => null) },
      },
    }));
    kernel.procs = { get: vi.fn(() => ({ ownerUid: 1000 })) };
    kernel.runRoutes = {
      setAdapterRoute,
      delete: deleteRoute,
    };
    const record = {
      id: "schedule-1",
      name: "Reminder",
      ownerUid: 1000,
      target: {
        kind: "process.event",
        pid: "proc-1",
        message: "Check the oven.",
        replyTo: destination,
      },
    };
    return { kernel, record, setAdapterRoute, deleteRoute };
  }

  beforeEach(() => {
    sendFrameToProcessMock.mockReset();
  });

  it("turns a Ship schedule occurrence into one durable responsibility", async () => {
    const create = vi.fn(() => ({
      record: { id: "r12y:schedule" },
      created: true,
      revision: 1,
    }));
    const waitUntil = vi.fn();
    // SAFETY: test fixture is constructed with the asserted Kernel internals.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.ctx = { waitUntil };
    kernel.buildScheduleContext = vi.fn(() => ({ identity: { capabilities: ["r12y.create"] } }));
    kernel.responsibilities = { create };
    kernel.reconcileResponsibilityWake = vi.fn(async () => {});
    const record = {
      id: "schedule-r12y",
      name: "Daily review",
      ownerUid: 1000,
      target: {
        kind: "responsibility",
        message: "Review unresolved mail.",
        data: { mailbox: "primary" },
        priority: "high",
      },
    };

    const result = await kernel.dispatchScheduleTarget(
      record,
      1_800_000_000_000,
      1_800_000_000_100,
      "due:1800000000000",
    );

    expect(result).toEqual({
      kind: "responsibility",
      responsibilityId: "r12y:schedule",
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      ownerUid: 1000,
      title: "Run scheduled responsibility: Daily review",
      details: {
        eventType: "schedule.due",
        scheduleId: "schedule-r12y",
        occurrenceKey: "due:1800000000000",
        scheduledAtMs: 1_800_000_000_000,
        firedAtMs: 1_800_000_000_100,
        message: "Review unresolved mail.",
        data: { mailbox: "primary" },
      },
      source: { kind: "schedule", scheduleId: "schedule-r12y" },
      assignee: { kind: "ship" },
      state: "open",
      priority: "high",
      dedupeKey: "schedule.due:schedule-r12y:due:1800000000000",
      actor: { kind: "system", component: "scheduler" },
      observedByShip: false,
    }));
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("converts legacy route-bound Ship events into responsibility-only delivery", async () => {
    const create = vi.fn(() => ({
      record: { id: "r12y:legacy-schedule" },
      created: true,
      revision: 1,
    }));
    // SAFETY: this focused Kernel fixture supplies every field used by schedule dispatch.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.ctx = { waitUntil: vi.fn() };
    kernel.buildScheduleContext = vi.fn(() => ({
      identity: { capabilities: ["adapter.send", "proc.send", "r12y.create"] },
    }));
    kernel.procs = { get: vi.fn(() => ({ ownerUid: 1000, isPersonalController: true })) };
    kernel.responsibilities = { create };
    kernel.reconcileResponsibilityWake = vi.fn(async () => {});
    kernel.runRoutes = { setAdapterRoute: vi.fn() };

    const result = await kernel.dispatchScheduleTarget({
      id: "schedule-legacy-ship-event",
      name: "Daily review",
      ownerUid: 1000,
      target: {
        kind: "process.event",
        pid: "proc:ship",
        message: "Review the day.",
        replyTo: destination,
      },
    }, 100, 101, "occurrence-1");

    expect(result).toEqual({
      kind: "responsibility",
      responsibilityId: "r12y:legacy-schedule",
    });
    expect(kernel.runRoutes.setAdapterRoute).not.toHaveBeenCalled();
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("preserves a preallocated reply route when Process transport admission is ambiguous", async () => {
    const { kernel, record, setAdapterRoute, deleteRoute } = makeScheduledProcessKernel();
    sendFrameToProcessMock.mockRejectedValueOnce(new Error("Process response was lost"));

    await expect(kernel.dispatchScheduleTarget(record, 100, 101, "occurrence-1")).rejects.toThrow(
      "Process response was lost",
    );

    expect(setAdapterRoute).toHaveBeenCalledWith(expect.objectContaining({
      processId: "proc-1",
      uid: 1000,
      destination,
    }));
    expect(deleteRoute).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "malformed",
      response: () => null,
      error: "proc.schedule.deliver did not return a response",
      deletesRoute: false,
    },
    {
      label: "explicit error",
      response: (request: { id: string }) => ({
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        type: "res" as const,
        id: request.id,
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        ok: false as const,
        error: { code: 503, message: "Process rejected the event" },
      }),
      error: "Process rejected the event",
      deletesRoute: false,
    },
    {
      label: "mismatched admission",
      response: (request: { id: string }) => ({
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        type: "res" as const,
        id: request.id,
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        ok: true as const,
        data: { ok: true, runId: "unexpected-run" },
      }),
      error: "proc.schedule.deliver admitted an unexpected reply run",
      deletesRoute: true,
    },
  ])("handles a $label response according to admission certainty", async ({
    response,
    error,
    deletesRoute,
  }) => {
    const { kernel, record, setAdapterRoute, deleteRoute } = makeScheduledProcessKernel();
    sendFrameToProcessMock.mockImplementationOnce(async (_installationId, _pid, request) => response(request));

    await expect(kernel.dispatchScheduleTarget(
      record,
      100,
      101,
      "occurrence-1",
    )).rejects.toThrow(error);

    const route = setAdapterRoute.mock.calls[0]?.[0];
    expect(route).toBeDefined();
    if (deletesRoute) {
      expect(deleteRoute).toHaveBeenCalledWith(route.runId);
    } else {
      expect(deleteRoute).not.toHaveBeenCalled();
    }
  });
});

describe("Kernel MCP connection cleanup", () => {
  it("removes newly registered MCP servers when the initial connection fails", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as {
      addMcpServerConnection(input: {
        uid: number;
        name: string;
        url: string;
        callbackHost: string;
        transport: { type: "auto" };
      }): Promise<KernelTestValue>;
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

  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  it("passes custom MCP headers as serializable request options", async () => {
    type RegisteredServerOptions = {
      transport: {
        requestInit?: {
          headers?: Record<string, string>;
        };
      };
    };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
      }): Promise<KernelTestValue>;
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
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      type: "res" as const,
      id: "req-1",
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
      ): Promise<KernelTestValue>;
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
  it("projects process titles into the process registry", () => {
    const setLabel = vi.fn(() => true);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.procs = {
      get: vi.fn(() => ({ activeRunId: null, lastActiveAt: null })),
      setLabel,
      updateRuntimeState: vi.fn(),
    };

    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.changed",
      payload: {
        changes: ["title"],
        title: "  Review migration plan  ",
      },
    }, null)).toBe(true);

    expect(setLabel).toHaveBeenCalledWith("proc-1", "Review migration plan");
  });

  it("waits for earlier process signals before acknowledging a run finish", async () => {
    let releaseStarted!: () => void;
    const startedBlocked = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const events: string[] = [];
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.ctx = { waitUntil: vi.fn() };
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
    const updateRuntimeState = vi.fn((_pid: string, patch: Record<string, KernelTestValue>) => {
      Object.assign(record, patch);
    });
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.procs = {
      get: vi.fn(() => record),
      updateRuntimeState,
    };

    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.started",
      payload: { runId: "run-new", timestamp: 200 },
    }, "run-new")).toBe(true);
    expect(record).toMatchObject({ activeRunId: "run-new", lastActiveAt: 200 });

    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.started",
      payload: { runId: "run-old", timestamp: 150 },
    }, "run-old")).toBe(false);

    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.finished",
      payload: { runId: "run-old", timestamp: 250 },
    }, "run-old")).toBe(true);
    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.output",
      payload: { runId: "run-old", timestamp: 300 },
    }, "run-old")).toBe(false);

    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.finished",
      payload: { runId: "run-new", timestamp: 400 },
    }, "run-new")).toBe(true);
    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.started",
      payload: { runId: "run-old", timestamp: 350 },
    }, "run-old")).toBe(false);

    expect(updateRuntimeState).toHaveBeenCalledTimes(2);
    expect(record).toMatchObject({ activeRunId: null, lastActiveAt: 400 });
  });

  it("relays an older run's tool finish without mutating its active successor", async () => {
    const record = {
      activeRunId: "run-successor",
      lastActiveAt: 500,
      state: "waiting_tool",
    };
    let delivered: Promise<void> | null = null;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.ctx = {
      waitUntil: vi.fn((promise: Promise<void>) => {
        delivered = promise;
      }),
    };
    kernel.procs = {
      get: vi.fn(() => record),
      getOwnerUid: vi.fn(() => 1000),
      updateRuntimeState: vi.fn((_pid: string, patch: Record<string, KernelTestValue>) => {
        Object.assign(record, patch);
      }),
    };
    kernel.pendingProcessSignals = new Map();
    kernel.dispatchSignalWatches = vi.fn(async () => {});
    kernel.runRoutes = { get: vi.fn(() => null), delete: vi.fn() };
    kernel.broadcastToUserUid = vi.fn();
    kernel.broadcastProcessSignal = vi.fn((_uid, _processId, _route, emitted) => {
      kernel.broadcastToUserUid(1000, emitted.signal, emitted.payload);
    });
    kernel.completeIpcCallsForProcessSignal = vi.fn();
    const frame = {
      type: "sig",
      signal: "proc.run.tool.finished",
      payload: {
        pid: "proc-1",
        runId: "run-older",
        executionId: "execution-older",
        callId: "call-older",
        outcome: "cancelled",
        timestamp: 600,
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as const;

    await kernel.recvFrame("proc-1", frame);
    await delivered;

    expect(record).toEqual({
      activeRunId: "run-successor",
      lastActiveAt: 500,
      state: "waiting_tool",
    });
    expect(kernel.procs.updateRuntimeState).not.toHaveBeenCalled();
    expect(kernel.broadcastToUserUid).toHaveBeenCalledWith(
      1000,
      frame.signal,
      frame.payload,
    );
  });
});

describe("Kernel IPC completion", () => {
  beforeEach(() => {
    sendFrameToProcessMock.mockReset();
  });

  it("schedules timeout callbacks no earlier than their deadline", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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

    await kernel.scheduleIpcCallTimeout("delegated-timeout", deadlineAt, {
      mode: "supervise",
      intervalMs: 600_000,
      checkInCount: 0,
    });
    expect(kernel.schedule).toHaveBeenLastCalledWith(
      expect.any(Date),
      "onIpcCallTimeout",
      {
        callId: "delegated-timeout",
        mode: "supervise",
        intervalMs: 600_000,
        checkInCount: 0,
      },
      { idempotent: true },
    );
  });

  it("expires an ordinary IPC call without terminating its target", async () => {
    const call = { callId: "regular-call", targetPid: "worker" };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.ipcCalls = {
      get: vi.fn(() => call),
      timeout: vi.fn(() => true),
    };
    kernel.queueIpcCallDelivery = vi.fn();
    kernel.returnDelegatedResponsibility = vi.fn();

    await kernel.onIpcCallTimeout(call.callId);

    expect(kernel.queueIpcCallDelivery).toHaveBeenCalledWith(call.callId);
    expect(kernel.returnDelegatedResponsibility).toHaveBeenCalledWith(call);
  });

  it("converts legacy delegated kill deadlines into supervision checkpoints", async () => {
    const call = {
      callId: "delegated-call",
      targetPid: "worker",
      status: "pending",
    };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.ipcCalls = {
      get: vi.fn(() => call),
      timeout: vi.fn(),
    };
    kernel.continueSupervisedIpcCall = vi.fn(async () => {});

    await kernel.onIpcCallTimeout({
      callId: call.callId,
      terminateTargetOnTimeout: true,
    });

    expect(kernel.continueSupervisedIpcCall).toHaveBeenCalledWith(
      expect.objectContaining({ callId: call.callId }),
      call,
      undefined,
    );
    expect(kernel.ipcCalls.timeout).not.toHaveBeenCalled();
  });

  it("renews supervised calls and reports that work is still running", async () => {
    const checkedAt = 10_000;
    const call = {
      callId: "delegated-call",
      ownerUid: 1000,
      sourcePid: "ship",
      sourceRunId: "ship-run",
      targetPid: "worker",
      targetRunId: "worker-run",
      status: "pending",
      deadlineAt: checkedAt,
      createdAt: 1_000,
      response: null,
      error: null,
      responsibilityId: null,
    };
    const now = vi.spyOn(Date, "now").mockReturnValue(checkedAt);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.installationId = TEST_INSTALLATION_ID;
    kernel.managedWorkGate = vi.fn(async () => ({ allowed: true }));
    kernel.scheduleIpcCallTimeoutTask = vi.fn(async () => ({
      id: "next-check",
      time: (checkedAt + 60_000) / 1_000,
    }));
    kernel.recordDelegationCheckIn = vi.fn();
    kernel.ipcCalls = {
      get: vi.fn(() => call),
      timeout: vi.fn(),
      renewDeadline: vi.fn((_callId: string, deadlineAt: number) => ({
        ...call,
        deadlineAt,
      })),
    };

    try {
      await kernel.onIpcCallTimeout({
        callId: call.callId,
        mode: "supervise",
        intervalMs: 60_000,
        checkInCount: 0,
      });
    } finally {
      now.mockRestore();
    }

    expect(kernel.scheduleIpcCallTimeoutTask).toHaveBeenCalledWith(
      call.callId,
      checkedAt + 60_000,
      {
        mode: "supervise",
        intervalMs: 60_000,
        checkInCount: 1,
      },
    );
    expect(kernel.ipcCalls.renewDeadline).toHaveBeenCalledWith(
      call.callId,
      checkedAt + 60_000,
    );
    expect(kernel.ipcCalls.timeout).not.toHaveBeenCalled();
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      call.sourcePid,
      expect.objectContaining({
        type: "sig",
        signal: "ipc.overdue",
        payload: expect.objectContaining({
          callId: call.callId,
          targetPid: call.targetPid,
          nextCheckAt: checkedAt + 60_000,
        }),
      }),
    );
  });

  it("defers supervision without admitting Process work while restricted", async () => {
    const checkedAt = 10_000;
    const call = {
      callId: "delegated-call",
      ownerUid: 1000,
      sourcePid: "ship",
      sourceRunId: "ship-run",
      targetPid: "worker",
      targetRunId: "worker-run",
      status: "pending",
      deadlineAt: checkedAt,
      createdAt: 1_000,
      response: null,
      error: null,
      responsibilityId: null,
    };
    const now = vi.spyOn(Date, "now").mockReturnValue(checkedAt);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.managedWorkGate = vi.fn(async () => ({
      allowed: false,
      code: 423,
      message: "Managed installation is suspended",
    }));
    kernel.scheduleIpcCallTimeoutTask = vi.fn(async () => ({
      id: "lifecycle-recheck",
      time: (checkedAt + 60_000) / 1_000,
    }));
    kernel.recordDelegationCheckIn = vi.fn();
    kernel.ipcCalls = {
      get: vi.fn(() => call),
      timeout: vi.fn(),
      renewDeadline: vi.fn(),
    };

    try {
      await kernel.onIpcCallTimeout(
        {
          callId: call.callId,
          mode: "supervise",
          intervalMs: 60_000,
          checkInCount: 2,
        },
        { id: "current-supervision-task", time: checkedAt / 1_000 },
      );
    } finally {
      now.mockRestore();
    }

    expect(kernel.scheduleIpcCallTimeoutTask).toHaveBeenCalledWith(
      call.callId,
      checkedAt + 60_000,
      {
        mode: "supervise",
        intervalMs: 60_000,
        checkInCount: 2,
        lifecycleRecheckFor: "current-supervision-task",
      },
    );
    expect(kernel.ipcCalls.renewDeadline).not.toHaveBeenCalled();
    expect(kernel.recordDelegationCheckIn).not.toHaveBeenCalled();
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("retries a failed overdue-checkpoint delivery", async () => {
    const checkedAt = 10_000;
    const call = {
      callId: "delegated-call",
      ownerUid: 1000,
      sourcePid: "ship",
      sourceRunId: "ship-run",
      targetPid: "worker",
      targetRunId: "worker-run",
      status: "pending",
      deadlineAt: checkedAt,
      createdAt: 1_000,
      response: null,
      error: null,
      responsibilityId: null,
    };
    const now = vi.spyOn(Date, "now").mockReturnValue(checkedAt);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.installationId = TEST_INSTALLATION_ID;
    kernel.managedWorkGate = vi.fn(async () => ({ allowed: true }));
    kernel.scheduleIpcCallTimeoutTask = vi.fn(async () => ({
      id: "next-check",
      time: (checkedAt + 60_000) / 1_000,
    }));
    kernel.recordDelegationCheckIn = vi.fn();
    kernel.ipcCalls = {
      get: vi.fn(() => call),
      timeout: vi.fn(),
      renewDeadline: vi.fn((_callId: string, deadlineAt: number) => ({
        ...call,
        deadlineAt,
      })),
    };
    sendFrameToProcessMock.mockRejectedValueOnce(new Error("process unavailable"));

    try {
      await expect(kernel.onIpcCallTimeout(
        {
          callId: call.callId,
          mode: "supervise",
          intervalMs: 60_000,
          checkInCount: 0,
        },
        { id: "current-supervision-task", time: checkedAt / 1_000 },
      )).rejects.toThrow("process unavailable");
    } finally {
      now.mockRestore();
    }

    expect(kernel.scheduleIpcCallTimeoutTask).toHaveBeenCalledWith(
      call.callId,
      checkedAt + 60_000,
      {
        mode: "supervise",
        intervalMs: 60_000,
        checkInCount: 1,
      },
    );
    expect(kernel.ipcCalls.renewDeadline).toHaveBeenCalledWith(
      call.callId,
      checkedAt + 60_000,
    );
  });

  it("schedules a delayed supervision successor from the callback time", async () => {
    const originalDeadlineAt = 10_000;
    const invokedAt = 100_000;
    const intervalMs = 60_000;
    const nextCheckAt = invokedAt + intervalMs;
    const call = {
      callId: "delayed-delegated-call",
      ownerUid: 1000,
      sourcePid: "ship",
      sourceRunId: "ship-run",
      targetPid: "worker",
      targetRunId: "worker-run",
      status: "pending",
      deadlineAt: originalDeadlineAt,
      createdAt: 1_000,
      response: null,
      error: null,
      responsibilityId: null,
    };
    const now = vi.spyOn(Date, "now").mockReturnValue(invokedAt);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.installationId = TEST_INSTALLATION_ID;
    kernel.managedWorkGate = vi.fn(async () => ({ allowed: true }));
    kernel.scheduleIpcCallTimeoutTask = vi.fn(async () => ({
      id: "next-check",
      time: nextCheckAt / 1_000,
    }));
    kernel.recordDelegationCheckIn = vi.fn();
    kernel.ipcCalls = {
      get: vi.fn(() => call),
      timeout: vi.fn(),
      renewDeadline: vi.fn((_callId: string, deadlineAt: number) => ({
        ...call,
        deadlineAt,
      })),
    };

    try {
      await kernel.onIpcCallTimeout(
        {
          callId: call.callId,
          mode: "supervise",
          intervalMs,
          checkInCount: 0,
        },
        { id: "late-supervision-task", time: originalDeadlineAt / 1_000 },
      );
    } finally {
      now.mockRestore();
    }

    expect(kernel.scheduleIpcCallTimeoutTask).toHaveBeenCalledWith(
      call.callId,
      nextCheckAt,
      {
        mode: "supervise",
        intervalMs,
        checkInCount: 1,
      },
    );
    expect(kernel.ipcCalls.renewDeadline).toHaveBeenCalledWith(
      call.callId,
      nextCheckAt,
    );
    expect(kernel.recordDelegationCheckIn).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineAt: nextCheckAt }),
      invokedAt,
      nextCheckAt,
      1,
    );
  });

  it("keeps delegated responsibility assigned during a supervision check-in", () => {
    const responsibilityId = "r12y:11111111-1111-4111-8111-111111111111";
    const responsibility = {
      id: responsibilityId,
      ownerUid: 1000,
      title: "Inspect the deployment",
      details: { request: "inspect" },
      source: { kind: "process", processId: "proc:ship", runId: "run:ship" },
      assignee: { kind: "process", processId: "proc:worker" },
      state: "active",
      priority: "normal",
      revision: 4,
      createdAtMs: 1,
      updatedAtMs: 2,
    };
    const update = vi.fn(() => ({
      record: responsibility,
      revision: responsibility.revision + 1,
      changed: true,
    }));
    const reconcileResponsibilityWake = vi.fn(async () => {});
    const waitUntil = vi.fn();
    // SAFETY: test fixture is constructed with the asserted Kernel boundary shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.responsibilities = {
      get: vi.fn(() => responsibility),
      update,
    };
    kernel.reconcileResponsibilityWake = reconcileResponsibilityWake;
    kernel.ctx = { waitUntil };
    const call = {
      callId: "ipc:call-1",
      ownerUid: 1000,
      sourcePid: "proc:ship",
      sourceRunId: "run:ship",
      targetPid: "proc:worker",
      targetRunId: "run:worker",
      status: "pending",
      deadlineAt: 10_000,
      createdAt: 1_000,
      response: null,
      error: null,
      responsibilityId,
    };

    kernel.recordDelegationCheckIn(call, 10_000, 70_000, 2);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      ownerUid: 1000,
      id: responsibilityId,
      expectedRevision: 4,
      patch: expect.objectContaining({
        nextCheckAtMs: 70_000,
        leaseExpiresAtMs: 70_000,
        details: {
          request: "inspect",
          delegation: {
            eventType: "process.delegation.check_in",
            callId: call.callId,
            processId: call.targetPid,
            runId: call.targetRunId,
            status: "pending",
            checkedAtMs: 10_000,
            nextCheckAtMs: 70_000,
            checkInCount: 2,
          },
        },
      }),
      actor: {
        kind: "event",
        eventType: "process.delegation.check_in",
        eventId: `${call.callId}:2`,
      },
      observedByShip: false,
      now: 10_000,
    }));
    expect(update.mock.calls[0]![0].patch).not.toHaveProperty("assignee");
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(reconcileResponsibilityWake).toHaveBeenCalledWith(1000);
  });

  it("cancels pending calls owned by an aborted source run", async () => {
    const cancelBySourceRun = vi.fn();
    const completeByRun = vi.fn(() => []);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
        result: {
          text: null,
          media: [{
            type: "document",
            mimeType: "application/pdf",
            key: `home/worker/.gsv/media/archived-media:${"b".repeat(64)}`,
            path: `/home/worker/.gsv/media/archived-media:${"b".repeat(64)}`,
            size: 42,
          }],
        },
        delivery: { kind: "none" },
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
    expect(completeByRun).toHaveBeenCalledWith(expect.objectContaining({
      response: expect.objectContaining({
        media: [expect.objectContaining({
          path: `/home/worker/.gsv/media/archived-media:${"b".repeat(64)}`,
        })],
      }),
    }));
  });

  it("completes a call from the Process result independently of human delivery", async () => {
    const completeByRun = vi.fn(() => ["call-1"]);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.procs = { getOwnerUid: vi.fn(() => 1000) };
    kernel.ipcCalls = {
      cancelBySourceRun: vi.fn(),
      completeByRun,
      get: vi.fn(() => ({ callId: "call-1" })),
    };
    kernel.queueIpcCallDelivery = vi.fn();
    kernel.returnDelegatedResponsibility = vi.fn();

    await kernel.completeIpcCallsForProcessSignal("proc-worker", {
      type: "sig",
      signal: "proc.run.finished",
      payload: {
        runId: "run-worker",
        status: "ok",
        reason: "ipc.returned",
        result: { text: "Private worker result." },
        delivery: { kind: "silence", reason: "No human delivery." },
      },
    });

    expect(completeByRun).toHaveBeenCalledWith({
      uid: 1000,
      targetPid: "proc-worker",
      runId: "run-worker",
      response: {
        text: "Private worker result.",
        usage: null,
      },
      error: null,
    });
    expect(kernel.returnDelegatedResponsibility).toHaveBeenCalledWith({ callId: "call-1" });
    expect(kernel.queueIpcCallDelivery).toHaveBeenCalledWith("call-1");
  });

  it.each([
    {
      status: "completed",
      error: null,
      eventType: "process.delegation.completed",
      blocker: null,
    },
    {
      status: "timed_out",
      error: "IPC call timed out",
      eventType: "process.delegation.timed_out",
      blocker: "IPC call timed out",
    },
    {
      status: "completed",
      error: "Worker run failed",
      eventType: "process.delegation.failed",
      blocker: "Worker run failed",
    },
    {
      status: "completed",
      error: "Target process was killed",
      eventType: "process.delegation.killed",
      blocker: "Target process was killed",
    },
  ] as const)(
    "returns a $eventType responsibility to Ship exactly once",
    ({ status, error, eventType, blocker }) => {
      const responsibilityId = "r12y:11111111-1111-4111-8111-111111111111";
      let responsibility = {
        id: responsibilityId,
        ownerUid: 1000,
        title: "Inspect the deployment",
        details: { request: "inspect" },
        source: { kind: "process", processId: "proc:ship", runId: "run:ship" },
        assignee: { kind: "process", processId: "proc:worker" },
        state: "active",
        priority: "normal",
        leaseExpiresAtMs: 10_000,
        revision: 4,
        createdAtMs: 1,
        updatedAtMs: 2,
      };
      const update = vi.fn((input) => {
        responsibility = {
          ...responsibility,
          ...input.patch,
          details: input.patch.details,
          revision: responsibility.revision + 1,
          updatedAtMs: input.now,
        };
        return {
          record: responsibility,
          revision: responsibility.revision,
          changed: true,
        };
      });
      const reconcileResponsibilityWake = vi.fn(async () => {});
      const waitUntil = vi.fn();
      // SAFETY: test fixture is constructed with the asserted Kernel boundary shape.
      const kernel = Object.create(Kernel.prototype) as any;
      kernel.responsibilities = {
        get: vi.fn(() => responsibility),
        update,
      };
      kernel.reconcileResponsibilityWake = reconcileResponsibilityWake;
      kernel.ctx = { waitUntil };
      const call = {
        callId: "ipc:call-1",
        ownerUid: 1000,
        sourcePid: "proc:ship",
        sourceRunId: "run:ship",
        targetPid: "proc:worker",
        targetRunId: "run:worker",
        status,
        deadlineAt: 9_000,
        createdAt: 1_000,
        response: status === "completed" && error === null ? { text: "done" } : null,
        error,
        responsibilityId,
      };

      kernel.returnDelegatedResponsibility(call);
      kernel.returnDelegatedResponsibility(call);

      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith(expect.objectContaining({
        ownerUid: 1000,
        id: responsibilityId,
        expectedRevision: 4,
        patch: expect.objectContaining({
          assignee: { kind: "ship" },
          state: "open",
          blocker,
          nextCheckAtMs: null,
          leaseExpiresAtMs: null,
          details: {
            request: "inspect",
            delegation: expect.objectContaining({
              eventType,
              callId: "ipc:call-1",
              processId: "proc:worker",
              runId: "run:worker",
              sourceRunId: "run:ship",
              status,
            }),
          },
        }),
        actor: {
          kind: "event",
          eventType,
          eventId: "ipc:call-1",
        },
        observedByShip: false,
      }));
      const delegation = update.mock.calls[0]![0].patch.details.delegation;
      if (error) {
        expect(delegation.error).toBe(error);
      } else {
        expect(delegation).not.toHaveProperty("error");
      }
      expect(responsibility.assignee).toEqual({ kind: "ship" });
      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(reconcileResponsibilityWake).toHaveBeenCalledWith(1000);
    },
  );

  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  it.each(["ipc.reply", "ipc.timeout"] as const)(
    "includes source-run correlation in %s payloads",
    async (signal) => {
      sendFrameToProcessMock.mockResolvedValue(null);
      const kernel = createRoutedKernel();
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

      expect(sendFrameToProcessMock).toHaveBeenCalledWith(TEST_INSTALLATION_ID, "proc-source", {
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
          ...(signal === "ipc.reply" ? { response: call.response } : undefined),
          ...(call.error ? { error: call.error } : undefined),
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.ipcCalls = {
      claimDelivery: vi.fn(() => call),
      releaseDelivery,
      remove,
    };
    kernel.returnDelegatedResponsibility = vi.fn();
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

  it("returns delegated work without signaling a replaced Ship process", async () => {
    const call = {
      callId: "call-orphaned-source",
      ownerUid: 1000,
      sourcePid: "proc:old-ship",
      sourceRunId: "run:old-ship",
      targetPid: "proc:worker",
      targetRunId: "run:worker",
      status: "completed",
      deadlineAt: 1234,
      createdAt: 1000,
      response: { text: "done" },
      error: null,
      responsibilityId: "r12y:11111111-1111-4111-8111-111111111111",
    };
    const remove = vi.fn();
    // SAFETY: this focused Kernel fixture supplies every field used by IPC delivery.
    const kernel = Object.create(Kernel.prototype) as any;
    kernel.ipcCalls = {
      claimDelivery: vi.fn(() => call),
      remove,
    };
    kernel.procs = { get: vi.fn(() => null) };
    kernel.returnDelegatedResponsibility = vi.fn();

    await kernel.deliverIpcCall(call.callId);

    expect(kernel.returnDelegatedResponsibility).toHaveBeenCalledWith(call);
    expect(remove).toHaveBeenCalledWith(call.callId);
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  it("queues terminal IPC delivery as an idempotent retrying job", () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
