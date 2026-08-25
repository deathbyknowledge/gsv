import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

import { sendFrameToProcess } from "../shared/utils";
import { Kernel } from "./do";
import { USER_KERNEL_LOGIN_SOURCE_HEADER } from "../shared/kernel-names";
import {
  BINARY_FRAME_CANCEL,
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  buildBinaryFrame,
  parseBinaryFrame,
} from "@humansandmachines/gsv/protocol";

const sendFrameToProcessMock = vi.mocked(sendFrameToProcess);

function createKernel(): any {
  const kernel = Object.create(Kernel.prototype) as any;
  Object.defineProperty(kernel, "name", {
    value: "singleton",
    configurable: true,
  });
  kernel.userKernelMarker = null;
  kernel.activeScheduleRuns = new Map();
  kernel.activeRequests = new Map();
  kernel.activeMasterUserOperations = new Map();
  kernel.userKernelProvisioningFlights = new Map();
  kernel.confirmedUserKernelActivations = new Map();
  kernel.ctx = {
    storage: { transactionSync: (closure: () => unknown) => closure() },
    waitUntil: vi.fn(),
  };
  kernel.userKernels = {
    list: vi.fn(() => []),
    getByUid: vi.fn((uid: number) => ({
      username: uid === 0 ? "root" : `user-${uid}`,
      uid,
      lifecycle: "active",
    })),
  };
  kernel.procs = { get: vi.fn(() => null), list: vi.fn(() => []) };
  kernel.schedules = {
    listStored: vi.fn(() => []),
    releaseInterruptedRuns: vi.fn(() => 0),
  };
  return kernel;
}

describe("Kernel user marker admission", () => {
  it("never treats the singleton Master as an active user Kernel", async () => {
    const kernel = createKernel() as any;

    await expect(kernel.requireActiveUserKernel()).rejects.toThrow(
      "User Kernel is not active",
    );
  });

  it("fails closed for unprovisioned and non-active user Kernels", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });

    kernel.loadUserKernelMarker = vi.fn(async () => null);
    await expect(kernel.requireActiveUserKernel()).rejects.toThrow(
      "User Kernel is not active",
    );

    kernel.loadUserKernelMarker.mockResolvedValue({
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      lifecycle: "provisioning",
      updatedAt: 1,
    });
    await expect(kernel.requireActiveUserKernel()).rejects.toThrow(
      "User Kernel is not active",
    );
  });

  it("admits an active user Kernel marker", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    const active = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      updatedAt: 1,
    };
    kernel.loadUserKernelMarker = vi.fn(async () => active);

    await expect(kernel.requireActiveUserKernel()).resolves.toEqual(active);
  });
});

describe("Kernel in-place runtime split", () => {
  it("provisions an existing singleton account on its first scoped route", async () => {
    const kernel = createKernel() as any;
    const provisioning = {
      username: "alice",
      uid: 1000,
      lifecycle: "provisioning",
      createdAt: 1,
      updatedAt: 1,
    };
    const active = { ...provisioning, lifecycle: "active", updatedAt: 2 };
    kernel.config = { get: vi.fn(() => null) };
    kernel.userKernels.get = vi.fn()
      .mockReturnValueOnce(provisioning)
      .mockReturnValue(active);
    kernel.ensureUserKernelProvisioned = vi.fn(async () => active);

    await expect(kernel.resolveUserKernelRoute("alice")).resolves.toEqual({
      ok: true,
      kernelName: "user:alice",
      loginSourceScope: "source:unavailable",
    });
    expect(kernel.ensureUserKernelProvisioned).toHaveBeenCalledWith("alice");
  });

  it("retries an active placement until the exact target activation is confirmed", async () => {
    const kernel = createKernel() as any;
    const active = {
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      createdAt: 1,
      updatedAt: 2,
    };
    const activateProvisionedUserKernel = vi.fn()
      .mockRejectedValueOnce(new Error("activation interrupted"))
      .mockResolvedValue({
        version: 1,
        kind: "user",
        username: "alice",
        uid: 1000,
        lifecycle: "active",
        updatedAt: 3,
      });
    const target = {
      setName: vi.fn(async () => undefined),
      activateProvisionedUserKernel,
    };
    kernel.userKernels = { get: vi.fn(() => active) };
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn(() => ({ name: "user:alice" })),
        get: vi.fn(() => target),
      },
    };

    await expect(kernel.ensureUserKernelProvisioned("alice")).rejects.toThrow(
      "activation interrupted",
    );
    expect(kernel.confirmedUserKernelActivations.has("alice")).toBe(false);

    await expect(kernel.ensureUserKernelProvisioned("alice")).resolves.toEqual(active);
    expect(activateProvisionedUserKernel).toHaveBeenCalledTimes(2);
    expect(kernel.confirmedUserKernelActivations.get("alice")).toBe(1000);
  });

  it("fails closed when an active placement cannot be reconciled on demand", async () => {
    const kernel = createKernel() as any;
    const active = {
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      createdAt: 1,
      updatedAt: 2,
    };
    kernel.config = { get: vi.fn(() => null) };
    kernel.userKernels.get = vi.fn(() => active);
    kernel.ensureUserKernelProvisioned = vi.fn(async () => {
      throw new Error("target is still provisioning");
    });

    await expect(kernel.resolveUserKernelRoute("alice")).resolves.toEqual({ ok: false });
    expect(kernel.ensureUserKernelProvisioned).toHaveBeenCalledWith("alice");
  });

  it("reconciles an interrupted active placement before routing a callback", async () => {
    const kernel = createKernel() as any;
    const active = {
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      createdAt: 1,
      updatedAt: 2,
    };
    kernel.userKernels.get = vi.fn(() => active);
    kernel.ensureUserKernelProvisioned = vi.fn()
      .mockRejectedValueOnce(new Error("target is still provisioning"))
      .mockImplementation(async () => {
        kernel.confirmedUserKernelActivations.set("alice", 1000);
        return active;
      });

    await expect(kernel.resolveUserKernelCallbackRoute("alice"))
      .resolves.toEqual({ ok: false });
    await expect(kernel.resolveUserKernelCallbackRoute("alice"))
      .resolves.toEqual({ ok: true, kernelName: "user:alice" });
    await expect(kernel.resolveUserKernelCallbackRoute("alice"))
      .resolves.toEqual({ ok: true, kernelName: "user:alice" });

    expect(kernel.ensureUserKernelProvisioned).toHaveBeenCalledTimes(2);
    expect(kernel.ensureUserKernelProvisioned).toHaveBeenCalledWith("alice");
  });

  it("does not reconcile a non-canonical callback locator", async () => {
    const kernel = createKernel() as any;
    kernel.userKernels.get = vi.fn();
    kernel.ensureUserKernelProvisioned = vi.fn();

    await expect(kernel.resolveUserKernelCallbackRoute("Alice"))
      .resolves.toEqual({ ok: false });
    expect(kernel.userKernels.get).not.toHaveBeenCalled();
    expect(kernel.ensureUserKernelProvisioned).not.toHaveBeenCalled();
  });

  it("derives a preserved personal-agent runtime route from its human owner", async () => {
    const kernel = createKernel() as any;
    const owner = { uid: 1000, gid: 1000, username: "alice", home: "/home/alice" };
    const actor = { uid: 2000, gid: 2000, username: "aria", home: "/home/aria" };
    kernel.auth = {
      getPasswdByUid: vi.fn((uid: number) => uid === owner.uid ? owner : uid === actor.uid ? actor : null),
      getPasswdEntries: vi.fn(() => [owner, actor]),
      getPersonalAgentUid: vi.fn((uid: number) => uid === owner.uid ? actor.uid : null),
      isPersonalAgentUid: vi.fn((uid: number) => uid === actor.uid),
      getAccountIdentity: vi.fn((username: string) => ({
        uid: username === owner.username ? owner.uid : actor.uid,
        state: "active",
      })),
    };
    kernel.userKernels.getByUid = vi.fn(() => ({
      username: owner.username,
      uid: owner.uid,
      lifecycle: "active",
    }));
    kernel.resolveUserKernelCallbackRoute = vi.fn(async () => ({
      ok: true,
      kernelName: "user:alice",
    }));

    await expect(kernel.resolvePreservedAppRuntimeRoute({
      uid: actor.uid,
      username: actor.username,
    })).resolves.toEqual({ ok: true, kernelName: "user:alice" });
    expect(kernel.resolveUserKernelCallbackRoute).toHaveBeenCalledWith("alice");
  });

  it("authorizes preserved runtime metadata from the current actor package scope", async () => {
    const kernel = createKernel() as any;
    const placement = { username: "alice", uid: 1000, lifecycle: "active" };
    const owner = { uid: 1000, gid: 1000, username: "alice", home: "/home/alice" };
    const actor = { uid: 2000, gid: 2000, username: "aria", home: "/home/aria" };
    const artifact = {
      hash: "sha256:current",
      mainModule: "index.js",
      modulePaths: ["index.js"],
      runtimeAccess: { daemon: { rpcSchedules: true } },
    };
    kernel.userKernels.get = vi.fn(() => placement);
    kernel.auth = {
      getPasswdByUid: vi.fn((uid: number) => uid === owner.uid ? owner : uid === actor.uid ? actor : null),
      getAccountIdentity: vi.fn(() => ({ uid: actor.uid, state: "active" })),
      getPersonalAgentUid: vi.fn((uid: number) => uid === owner.uid ? actor.uid : null),
      resolveGids: vi.fn((_username: string, gid: number) => [gid]),
    };
    kernel.packages = {
      resolve: vi.fn(() => ({
        packageId: "pkg-chat",
        enabled: true,
        reviewRequired: false,
        reviewedAt: null,
        updatedAt: 4321,
        artifact,
        manifest: {
          name: "chat",
          entrypoints: [{ kind: "ui", name: "main", route: "/apps/chat" }],
        },
      })),
    };
    kernel.caps = { resolve: vi.fn(() => []) };

    await expect(kernel.authorizePreservedAppRuntime({
      sourceKernelName: "user:alice",
      uid: owner.uid,
      ownerUid: owner.uid,
      runtime: {
        uid: actor.uid,
        username: actor.username,
        packageId: "pkg-chat",
        packageName: "chat",
        entrypointName: "main",
        routeBase: "/apps/chat",
      },
    })).resolves.toMatchObject({
      ok: true,
      identity: { uid: actor.uid, username: actor.username },
      packageUpdatedAt: 4321,
      artifact,
    });
    expect(kernel.packages.resolve).toHaveBeenCalledWith("pkg-chat", [
      { kind: "user", uid: actor.uid },
      { kind: "global" },
    ]);

    const now = Date.now();
    await expect(kernel.validateAppDaemonFrame({
      sourceKernelName: "user:alice",
      uid: owner.uid,
      appFrame: {
        uid: actor.uid,
        username: actor.username,
        packageId: "pkg-chat",
        packageName: "chat",
        packageUpdatedAt: 4321,
        packageArtifactHash: artifact.hash,
        entrypointName: "main",
        routeBase: "/apps/chat",
        issuedAt: now,
        expiresAt: now + 60_000,
      },
    })).resolves.toMatchObject({ ok: true, entrypointKind: "ui" });
  });

  it("does not replay singleton-owned IPC, routes, or schedules", async () => {
    const kernel = createKernel() as any;
    kernel.routes = { remove: vi.fn() };
    kernel.ipcCalls = {
      timeout: vi.fn(),
      claimDelivery: vi.fn(),
    };
    kernel.schedules = { getStored: vi.fn() };
    kernel.runSchedules = vi.fn();

    await kernel.onRouteExpired("route-1");
    await kernel.onIpcCallTimeout("ipc-1");
    await kernel.onIpcCallDelivery("ipc-1");
    await kernel.onScheduleDue("schedule-1");

    expect(kernel.routes.remove).not.toHaveBeenCalled();
    expect(kernel.ipcCalls.timeout).not.toHaveBeenCalled();
    expect(kernel.ipcCalls.claimDelivery).not.toHaveBeenCalled();
    expect(kernel.schedules.getStored).not.toHaveBeenCalled();
    expect(kernel.runSchedules).not.toHaveBeenCalled();
  });

  it("rejects a connected singleton request before runtime dispatch", async () => {
    const kernel = createKernel() as any;
    kernel.frameBodyChannels = new Map();
    kernel.dispatchKernelFrame = vi.fn();
    const sent: string[] = [];
    const connection = {
      id: "old-singleton-connection",
      state: {
        step: "connected",
        identity: {
          role: "user",
          process: { uid: 1000 },
          capabilities: ["fs.read"],
        },
      },
      send: (message: string) => sent.push(message),
    };

    await kernel.handleReq(connection, {
      type: "req",
      id: "old-request",
      call: "fs.read",
      args: { path: "/home/alice/private.txt" },
    });

    expect(kernel.dispatchKernelFrame).not.toHaveBeenCalled();
    expect(JSON.parse(sent[0])).toMatchObject({
      type: "res",
      id: "old-request",
      ok: false,
      error: {
        code: 409,
        message: "Username-scoped connection required",
      },
    });
  });

  it("keeps only adapter state control on the Master service-frame path", async () => {
    const kernel = createKernel() as any;
    const response = {
      type: "res",
      id: "adapter-state",
      ok: true,
      data: { ok: true },
    };
    kernel.handleServiceReq = vi.fn(async () => response);

    await expect(kernel.serviceFrame({
      type: "req",
      id: "adapter-state",
      call: "adapter.state.update",
      args: { adapter: "discord", accountId: "primary", state: "ready" },
    })).resolves.toEqual(response);
    expect(kernel.handleServiceReq).toHaveBeenCalledOnce();

    await expect(kernel.serviceFrame({
      type: "req",
      id: "old-runtime-service",
      call: "fs.read",
      args: { path: "/home/alice/private.txt" },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 400 },
    });
    expect(kernel.handleServiceReq).toHaveBeenCalledOnce();
  });
});

describe("Kernel adapter inbound authority", () => {
  const frame = {
    type: "req" as const,
    id: "adapter-frame-1",
    call: "adapter.inbound" as const,
    args: {
      adapter: "discord",
      accountId: "primary",
      message: {
        id: "message-1",
        actor: { id: "actor-1", name: "Alice" },
        surface: { kind: "dm" as const, id: "surface-1" },
        text: "hello",
      },
    },
  };

  it("routes a current linked actor through the Master to its active user Kernel", async () => {
    const response = {
      type: "res" as const,
      id: frame.id,
      ok: true as const,
      data: { ok: true },
    };
    const serviceAdapterFrame = vi.fn(async () => response);
    const target = { setName: vi.fn(async () => undefined), serviceAdapterFrame };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    const activePlacement = {
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      createdAt: 1,
      updatedAt: 1,
    };
    kernel.adapters = {
      identityLinks: {
        get: vi.fn(() => ({ uid: 1000, generation: 3 })),
        isCurrentGeneration: vi.fn(() => true),
      },
      linkChallenges: { issue: vi.fn() },
    };
    kernel.userKernels = {
      getByUid: vi.fn(() => activePlacement),
      get: vi.fn(() => activePlacement),
    };
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn(() => ({ name: "user:alice" })),
        get: vi.fn(() => target),
      },
    };
    kernel.ensureUserKernelProvisioned = vi.fn(async () => {
      kernel.confirmedUserKernelActivations.set("alice", 1000);
      return activePlacement;
    });

    await expect(kernel.receiveAdapterInbound(frame)).resolves.toEqual(response);
    expect(serviceAdapterFrame).toHaveBeenCalledWith({
      sourceKernelName: "singleton",
      ownerUid: 1000,
      linkGeneration: 3,
      frame,
    });

    kernel.userKernels.getByUid.mockReturnValue({
      username: "alice",
      uid: 1000,
      lifecycle: "provisioning",
      createdAt: 1,
      updatedAt: 1,
    });
    await expect(kernel.receiveAdapterInbound(frame)).resolves.toEqual(response);
    expect(kernel.ensureUserKernelProvisioned).toHaveBeenCalledWith("alice");
    expect(kernel.ensureUserKernelProvisioned).toHaveBeenCalledTimes(2);
    expect(serviceAdapterFrame).toHaveBeenCalledTimes(2);
  });

  it("accepts direct adapter delivery only from the Master into an active target", async () => {
    const response = {
      type: "res" as const,
      id: frame.id,
      ok: true as const,
      data: { ok: true },
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.requireActiveUserKernel = vi.fn(async () => ({
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      updatedAt: 1,
    }));
    kernel.handleServiceReq = vi.fn(async () => response);
    const input = {
      sourceKernelName: "singleton",
      ownerUid: 1000,
      linkGeneration: 3,
      frame,
    };

    await expect(kernel.serviceAdapterFrame(input)).resolves.toEqual(response);
    expect(kernel.handleServiceReq).toHaveBeenCalledWith(frame, {
      routedAdapterOwnerUid: 1000,
      routedAdapterLinkGeneration: 3,
    });

    await expect(kernel.serviceAdapterFrame({
      ...input,
      sourceKernelName: "user:bob",
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 401, message: "Authentication failed" },
    });
    expect(kernel.handleServiceReq).toHaveBeenCalledOnce();
  });
});

describe("Kernel live credential fencing", () => {
  it("persists an exact-token fence and defers only the response socket close", () => {
    const caller = {
      id: "caller",
      state: {
        step: "connected",
        credential: { kind: "token", tokenId: "token-a", expiresAt: null },
      },
      close: vi.fn(),
    };
    const sibling = {
      id: "sibling",
      state: {
        step: "connected",
        credential: { kind: "token", tokenId: "token-a", expiresAt: null },
      },
      close: vi.fn(),
    };
    const otherToken = {
      id: "other-token",
      state: {
        step: "connected",
        credential: { kind: "token", tokenId: "token-b", expiresAt: null },
      },
      close: vi.fn(),
    };
    const password = {
      id: "password",
      state: { step: "connected", credential: { kind: "password" } },
      close: vi.fn(),
    };
    const rememberAll = vi.fn();
    const kernel = createKernel() as any;
    kernel.ctx = { storage: { transactionSync: (closure: () => unknown) => closure() } };
    kernel.tokenRevocations = { rememberAll };
    kernel.connections = new Map([
      [caller.id, caller],
      [sibling.id, sibling],
      [otherToken.id, otherToken],
      [password.id, password],
    ]);
    kernel.deferredCredentialClosures = new Set();

    kernel.persistAndFenceTokenRevocations([{
      tokenId: "token-a",
      uid: 1000,
      revokedAt: 10,
    }], caller.id);

    expect(rememberAll).toHaveBeenCalledBefore(sibling.close);
    expect(sibling.close).toHaveBeenCalledWith(1008, "Authentication expired");
    expect(caller.close).not.toHaveBeenCalled();
    expect(otherToken.close).not.toHaveBeenCalled();
    expect(password.close).not.toHaveBeenCalled();

    kernel.flushDeferredCredentialClosures();
    expect(caller.close).toHaveBeenCalledWith(1008, "Authentication expired");
  });

  it("fails closed for expired, tombstoned, and pre-upgrade connection state", () => {
    const kernel = createKernel() as any;
    kernel.tokenRevocations = {
      isRevoked: vi.fn((tokenId: string) => tokenId === "revoked-token"),
    };

    expect(kernel.isConnectionCredentialActive({
      step: "connected",
      credential: { kind: "password" },
    })).toBe(true);
    expect(kernel.isConnectionCredentialActive({
      step: "connected",
      credential: { kind: "token", tokenId: "future-token", expiresAt: Date.now() + 1_000 },
    })).toBe(true);
    expect(kernel.isConnectionCredentialActive({
      step: "connected",
      credential: { kind: "token", tokenId: "expired-token", expiresAt: Date.now() - 1 },
    })).toBe(false);
    expect(kernel.isConnectionCredentialActive({
      step: "connected",
      credential: { kind: "token", tokenId: "revoked-token", expiresAt: null },
    })).toBe(false);
    expect(kernel.isConnectionCredentialActive({ step: "connected" })).toBe(false);
  });

  it("excludes provenance-less sockets while rebuilding hibernated connections", () => {
    const stale = {
      id: "stale",
      state: {
        step: "connected",
        identity: { role: "user", process: { uid: 1000 } },
      },
      close: vi.fn(),
    };
    const current = {
      id: "current",
      state: {
        step: "connected",
        identity: { role: "user", process: { uid: 1000 } },
        credential: { kind: "password" },
      },
      close: vi.fn(),
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.getConnections = vi.fn(() => [stale, current]);
    kernel.connections = new Map();
    kernel.tokenRevocations = { isRevoked: vi.fn(() => false) };
    kernel.devices = { listOnline: vi.fn(() => []), setOnline: vi.fn() };
    kernel.broadcastDeviceStatus = vi.fn();

    kernel.rehydrateConnections();

    expect(stale.close).toHaveBeenCalledWith(1008, "Authentication expired");
    expect(kernel.connections.has(stale.id)).toBe(false);
    expect(kernel.connections.get(current.id)).toBe(current);
  });

  it("closes persisted singleton runtime sockets instead of rehydrating them", () => {
    const oldRuntime = {
      id: "old-singleton-runtime",
      state: {
        step: "connected",
        identity: { role: "user", process: { uid: 1000 } },
        credential: { kind: "password" },
      },
      close: vi.fn(),
    };
    const kernel = createKernel() as any;
    kernel.getConnections = vi.fn(() => [oldRuntime]);
    kernel.connections = new Map();
    kernel.auth = { isSetupMode: vi.fn(() => false) };
    kernel.config = { get: vi.fn(() => null) };
    kernel.devices = { listOnline: vi.fn(() => []), setOnline: vi.fn() };
    kernel.broadcastDeviceStatus = vi.fn();

    kernel.rehydrateConnections();

    expect(oldRuntime.close).toHaveBeenCalledWith(
      1008,
      "Username-scoped connection required",
    );
    expect(kernel.connections).toEqual(new Map());
  });

  it("reauthorizes target tombstones against exact Master revocation state", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.userKernels = {
      get: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        lifecycle: "active",
      })),
    };
    kernel.auth = {
      getToken: vi.fn(() => ({ tokenId: "token-a", uid: 1000, revokedAt: null })),
    };
    kernel.authorizeUserKernelSource = vi.fn((proof: { sourceKernelName: string; uid: number }) => (
      proof.sourceKernelName === "user:alice" && proof.uid === 1000
        ? kernel.userKernels.get("alice")
        : null
    ));
    const input = {
      sourceKernelName: "user:alice",
      username: "alice",
      uid: 1000,
      notice: { tokenId: "token-a", uid: 1000, revokedAt: 10 },
    };

    await expect(kernel.confirmTokenRevocationDelivery(input)).resolves.toBe(false);
    kernel.auth.getToken.mockReturnValue({ tokenId: "token-a", uid: 1000, revokedAt: 10 });
    await expect(kernel.confirmTokenRevocationDelivery(input)).resolves.toBe(true);
    await expect(kernel.confirmTokenRevocationDelivery({
      ...input,
      sourceKernelName: "user:bob",
    })).resolves.toBe(false);
  });

  it("rejects a forged target delivery before persisting its tombstone", async () => {
    const confirmTokenRevocationDelivery = vi.fn(async () => false);
    const masterStub = {
      setName: vi.fn(async () => {}),
      confirmTokenRevocationDelivery,
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn(() => ({ name: "singleton" })),
        get: vi.fn(() => masterStub),
      },
    };
    kernel.loadUserKernelMarker = vi.fn(async () => ({
      username: "alice",
      uid: 1000,
      lifecycle: "active",
    }));
    kernel.ctx = { storage: { transactionSync: (closure: () => unknown) => closure() } };
    kernel.tokenRevocations = { remember: vi.fn() };
    kernel.connections = new Map();
    const delivery = {
      sourceKernelName: "singleton",
      username: "alice",
      uid: 1000,
      notice: { tokenId: "still-active", uid: 1000, revokedAt: 10 },
    };

    await expect(kernel.receiveMasterTokenRevocation(delivery)).resolves.toBe(false);
    expect(confirmTokenRevocationDelivery).toHaveBeenCalledWith({
      sourceKernelName: "user:alice",
      username: "alice",
      uid: 1000,
      notice: delivery.notice,
    });
    expect(kernel.tokenRevocations.remember).not.toHaveBeenCalled();

    const close = vi.fn();
    kernel.connections = new Map([["connection-1", {
      id: "connection-1",
      state: {
        step: "connected",
        credential: { kind: "token", tokenId: "still-active", expiresAt: null },
      },
      close,
    }]]);
    kernel.deferredCredentialClosures = new Set();
    confirmTokenRevocationDelivery.mockResolvedValueOnce(true);
    await expect(kernel.receiveMasterTokenRevocation(delivery)).resolves.toBe(true);
    expect(kernel.tokenRevocations.remember).toHaveBeenCalledBefore(close);
    expect(close).toHaveBeenCalledWith(1008, "Authentication expired");
  });

  it("acknowledges an outbox row only after delivery and retries failures", async () => {
    const record = {
      tokenId: "token-a",
      uid: 1000,
      revokedAt: 10,
      attemptCount: 0,
      nextAttemptAt: 10,
      lastError: null,
    };
    const kernel = createKernel() as any;
    kernel.tokenRevocations = {
      listDue: vi.fn(() => [record]),
      acknowledge: vi.fn(),
      recordFailure: vi.fn(),
      nextAttemptAt: vi.fn(() => null),
    };
    kernel.deliverTokenRevocation = vi.fn(async () => {});

    await kernel.deliverTokenRevocationOutbox();
    expect(kernel.deliverTokenRevocation).toHaveBeenCalledWith(record);
    expect(kernel.tokenRevocations.acknowledge).toHaveBeenCalledWith("token-a", 1000);
    expect(kernel.tokenRevocations.recordFailure).not.toHaveBeenCalled();

    kernel.tokenRevocations.acknowledge.mockClear();
    kernel.deliverTokenRevocation.mockRejectedValueOnce(new Error("target unavailable"));
    await kernel.deliverTokenRevocationOutbox();
    expect(kernel.tokenRevocations.acknowledge).not.toHaveBeenCalled();
    expect(kernel.tokenRevocations.recordFailure).toHaveBeenCalledWith(
      "token-a",
      expect.any(Error),
    );
  });

  it("closes an expired token through the scheduled object payload", async () => {
    const connection = {
      id: "connection-1",
      state: {
        step: "connected",
        credential: { kind: "token", tokenId: "token-a", expiresAt: Date.now() - 1 },
      },
      close: vi.fn(),
    };
    const kernel = createKernel() as any;
    kernel.connections = new Map([[connection.id, connection]]);

    await kernel.onConnectionCredentialExpired({
      connectionId: connection.id,
      tokenId: "token-a",
    });

    expect(connection.close).toHaveBeenCalledWith(1008, "Authentication expired");

    connection.close.mockClear();
    connection.state.credential.expiresAt = null;
    await kernel.onConnectionCredentialExpired({
      connectionId: connection.id,
      tokenId: "token-a",
    });
    expect(connection.close).not.toHaveBeenCalled();
  });
});

describe("Kernel repository metadata authority", () => {
  const aliceIdentity = {
    role: "user",
    process: {
      uid: 1000,
      gid: 1000,
      gids: [1000],
      username: "alice",
      home: "/home/alice",
      cwd: "/home/alice",
    },
    capabilities: ["repo.apply"],
  } as const;

  it("accepts metadata mutations only from the active owner shard", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.userKernels = {
      get: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        lifecycle: "active",
      })),
    };
    kernel.resolveMasterSyscallIdentity = vi.fn(() => aliceIdentity);
    kernel.applyAuthorizedRepoMetadataMutation = vi.fn(() => ({ changed: true }));
    kernel.authorizeUserKernelSource = vi.fn((proof: { sourceKernelName: string; uid: number }) => proof.sourceKernelName === "user:alice"
        && proof.uid === 1000
      ? kernel.userKernels.get("alice")
      : null);
    const input = {
      sourceKernelName: "user:alice",
      callerOwnerUid: 1000,
      identity: aliceIdentity,
      mutation: {
        kind: "register",
        call: "repo.apply",
        repo: { owner: "alice", repo: "notes" },
      },
    };

    await expect(kernel.mutateUserRepoMetadata(input)).resolves.toEqual({ changed: true });
    expect(kernel.applyAuthorizedRepoMetadataMutation).toHaveBeenCalledWith(
      input.mutation,
      aliceIdentity,
      1000,
      expect.any(Function),
    );

    for (const forged of [
      { ...input, sourceKernelName: "user:bob" },
      { ...input, callerOwnerUid: 1001 },
    ]) {
      kernel.resolveMasterSyscallIdentity.mockClear();
      await expect(kernel.mutateUserRepoMetadata(forged)).rejects.toThrow(
        "Repository metadata authentication failed",
      );
      expect(kernel.resolveMasterSyscallIdentity).not.toHaveBeenCalled();
    }

    kernel.resolveMasterSyscallIdentity.mockReturnValueOnce(null);
    await expect(kernel.mutateUserRepoMetadata({
      ...input,
      identity: {
        ...aliceIdentity,
        process: { ...aliceIdentity.process, username: "root" },
      },
    })).rejects.toThrow("Repository metadata authentication failed");
  });

  it("reauthorizes the exact capability and repository owner before writing", async () => {
    const values = new Map<string, string>();
    const config = {
      get: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string) => values.set(key, value),
      delete: (key: string) => values.delete(key),
    };
    const context = {
      identity: aliceIdentity,
      auth: {
        getPasswdByUid: vi.fn(() => null),
        getPasswdByUsername: vi.fn(() => null),
      },
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.config = config;
    kernel.ctx = { storage: { transactionSync: (closure: () => unknown) => closure() } };
    kernel.buildKernelContext = vi.fn(() => context);

    await expect(kernel.applyAuthorizedRepoMetadataMutation({
      kind: "register",
      call: "repo.apply",
      repo: { owner: "alice", repo: "notes" },
    }, aliceIdentity, 1000)).resolves.toEqual({ changed: true });
    expect(values.has("repos/alice/notes/created_at")).toBe(true);
    expect(values.has("repos/alice/notes/updated_at")).toBe(true);

    await expect(kernel.applyAuthorizedRepoMetadataMutation({
      kind: "register",
      call: "repo.import",
      repo: { owner: "alice", repo: "notes" },
    }, aliceIdentity, 1000)).rejects.toThrow("Permission denied: repo.import");
    await expect(kernel.applyAuthorizedRepoMetadataMutation({
      kind: "register",
      call: "repo.apply",
      repo: { owner: "bob", repo: "notes" },
    }, aliceIdentity, 1000)).rejects.toThrow("Forbidden: cannot write repo bob/notes");
    await expect(kernel.applyAuthorizedRepoMetadataMutation({
      kind: "delete",
      call: "repo.apply",
      repo: { owner: "alice", repo: "notes" },
    }, aliceIdentity, 1000)).rejects.toThrow("Invalid repository metadata mutation");
  });

});

describe("Kernel frame bodies", () => {
  it("persists only a pseudonymous login source in hibernation state", async () => {
    const values = new Map<string, string>();
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
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

  it("accepts only the edge-derived source scope in a user Kernel", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    const connection: any = {
      state: undefined,
      setState: vi.fn((state) => {
        connection.state = state;
      }),
    };
    const scope = `source:123:${"a".repeat(64)}`;

    await kernel.onConnect(connection, {
      request: new Request("https://gsv.test/ws/alice", {
        headers: {
          "CF-Connecting-IP": "203.0.113.44",
          [USER_KERNEL_LOGIN_SOURCE_HEADER]: scope,
        },
      }),
    });

    expect(connection.state).toEqual({
      step: "pending",
      loginSourceScope: scope,
    });
    expect(JSON.stringify(connection.state)).not.toContain("203.0.113.44");
  });

  it("passes request cancellation to Agents SDK MCP calls", async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.ctx = {
      storage: { transactionSync: (closure: () => unknown) => closure() },
    };
    kernel.mcp = { callTool };
    const controller = new AbortController();
    const ctx = kernel.buildKernelContext({ requestSignal: controller.signal });

    expect(ctx.kernelName).toBe("singleton");
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
    kernel.frameBodyChannels = new Map();
    kernel.auth = { isSetupMode: () => false };
    kernel.config = { get: () => null };
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:root" });
    kernel.requireActiveUserKernel = vi.fn(async () => ({
      username: "root",
      uid: 0,
      lifecycle: "active",
    }));
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
    kernel.authorizeRegisteredProcessRuntime = vi.fn(async () => true);
    kernel.procs = {
      get: vi.fn(() => ({
        ownerUid: 0,
        packageSecurityRevision: null,
      })),
    };
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

    expect(await kernel.cancelProcessRequests(
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as {
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
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
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

  it("consumes an exact Master signal authorization only once", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.masterUserSignalAuthorizations = new Map();
    kernel.userKernels = {
      get: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        lifecycle: "active",
      })),
    };
    const input = {
      authorization: "signal-authorization",
      targetKernelName: "user:alice",
      username: "alice",
      uid: 1000,
      signal: "notification.created",
      payloadJson: JSON.stringify({ id: "note-1" }),
    };
    kernel.masterUserSignalAuthorizations.set(input.authorization, {
      expiresAt: Date.now() + 10_000,
      signal: {
        targetKernelName: input.targetKernelName,
        username: input.username,
        uid: input.uid,
        signal: input.signal,
        payloadJson: input.payloadJson,
      },
    });

    await expect(kernel.consumeMasterUserSignalAuthorization({
      ...input,
      payloadJson: JSON.stringify({ id: "tampered" }),
    })).resolves.toBe(false);
    await expect(kernel.consumeMasterUserSignalAuthorization(input)).resolves.toBe(false);

    kernel.masterUserSignalAuthorizations.set(input.authorization, {
      expiresAt: Date.now() + 10_000,
      signal: {
        targetKernelName: input.targetKernelName,
        username: input.username,
        uid: input.uid,
        signal: input.signal,
        payloadJson: input.payloadJson,
      },
    });
    await expect(kernel.consumeMasterUserSignalAuthorization(input)).resolves.toBe(true);
    await expect(kernel.consumeMasterUserSignalAuthorization(input)).resolves.toBe(false);
  });

  it("broadcasts a Master signal only after its target consumes the one-shot", async () => {
    const consumeMasterUserSignalAuthorization = vi.fn(async () => true);
    const master = {
      setName: vi.fn(async () => undefined),
      consumeMasterUserSignalAuthorization,
    };
    const marker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      updatedAt: 1,
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn(() => ({ name: "singleton" })),
        get: vi.fn(() => master),
      },
    };
    kernel.userKernelMarker = marker;
    kernel.broadcastToUserUid = vi.fn();
    const input = {
      sourceKernelName: "singleton",
      authorization: "signal-authorization",
      username: "alice",
      uid: 1000,
      signal: "notification.created",
      payloadJson: JSON.stringify({ id: "note-1" }),
    };

    await expect(kernel.receiveMasterUserSignal(input)).resolves.toBe(true);
    expect(consumeMasterUserSignalAuthorization).toHaveBeenCalledWith({
      authorization: input.authorization,
      targetKernelName: "user:alice",
      username: "alice",
      uid: 1000,
      signal: input.signal,
      payloadJson: input.payloadJson,
    });
    expect(kernel.broadcastToUserUid).toHaveBeenCalledWith(
      1000,
      input.signal,
      { id: "note-1" },
    );
  });
});

describe("Kernel process signal routing", () => {
  function buildKernel(route: Record<string, unknown>) {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      updatedAt: 1,
    };
    kernel.procs = { getOwnerUid: vi.fn(() => 1000) };
    kernel.dispatchSignalWatches = vi.fn(async () => {});
    kernel.runRoutes = { get: vi.fn(() => route), delete: vi.fn() };
    kernel.broadcastToUserUid = vi.fn();
    kernel.deliverSignalToConnection = vi.fn();
    kernel.deliverSignalToAdapter = vi.fn(async () => {});
    kernel.authorizeRegisteredProcessRuntime = vi.fn(async () => true);
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

describe("Kernel adapter run route revocation", () => {
  const activeLink = {
    adapter: "discord",
    accountId: "primary",
    actorId: "actor-1",
    uid: 1000,
    generation: 3,
    createdAt: 1,
    linkedByUid: 0,
    metadata: null,
  };

  it("authorizes only the active user Kernel and exact current link generation", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.userKernels = {
      get: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        lifecycle: "active",
      })),
    };
    kernel.adapters = {
      identityLinks: {
        get: vi.fn(() => activeLink),
        isCurrentGeneration: vi.fn((
          _adapter: string,
          _accountId: string,
          _actorId: string,
          generation: number,
        ) => generation === activeLink.generation),
      },
    };
    kernel.authorizeUserKernelSource = vi.fn((proof: { sourceKernelName: string; uid: number }) => (
      proof.sourceKernelName === "user:alice" && proof.uid === 1000
        ? kernel.userKernels.get("alice")
        : null
    ));
    const input = {
      sourceKernelName: "user:alice",
      ownerUid: 1000,
      adapter: "discord",
      accountId: "primary",
      actorId: "actor-1",
      linkGeneration: 3,
    };

    await expect(kernel.authorizeAdapterRunRoute(input)).resolves.toBe(true);
    await expect(kernel.authorizeAdapterRunRoute({
      ...input,
      linkGeneration: 1,
    })).resolves.toBe(false);
    await expect(kernel.authorizeAdapterRunRoute({
      ...input,
      sourceKernelName: "user:bob",
    })).resolves.toBe(false);

    kernel.adapters.identityLinks.get.mockReturnValue(null);
    await expect(kernel.authorizeAdapterRunRoute(input)).resolves.toBe(false);
  });

  it("deletes a stale route without adapter delivery and accepts the exact link generation", async () => {
    const adapterSend = vi.fn(async () => ({ ok: true }));
    const adapterSetActivity = vi.fn(async () => ({ ok: true }));
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.env = {
      CHANNEL_DISCORD: {
        adapterSend,
        adapterSetActivity,
      },
    };
    kernel.isAdapterRunRouteCurrent = vi.fn(async (candidate: { linkGeneration: number }) => (
      candidate.linkGeneration === activeLink.generation
    ));
    kernel.runRoutes = { delete: vi.fn() };
    const route = {
      kind: "adapter",
      runId: "run-stale",
      uid: 1000,
      adapter: "discord",
      accountId: "primary",
      actorId: "actor-1",
      linkGeneration: 1,
      surfaceKind: "dm",
      surfaceId: "surface-1",
      createdAt: 1,
      expiresAt: 10_000,
    };
    const frame = {
      type: "sig",
      signal: "proc.run.finished",
      payload: { text: "finished" },
    };

    await kernel.deliverSignalToAdapter(route, frame);

    expect(kernel.runRoutes.delete).toHaveBeenCalledWith("run-stale");
    expect(adapterSend).not.toHaveBeenCalled();
    expect(adapterSetActivity).not.toHaveBeenCalled();

    const currentRoute = {
      ...route,
      runId: "run-current",
      linkGeneration: activeLink.generation,
    };
    await kernel.deliverSignalToAdapter(currentRoute, frame);

    expect(kernel.runRoutes.delete).toHaveBeenCalledTimes(1);
    expect(adapterSend).toHaveBeenCalledWith("primary", {
      surface: { kind: "dm", id: "surface-1", threadId: undefined },
      text: "finished",
    });
    expect(adapterSetActivity).toHaveBeenCalledWith(
      "primary",
      { kind: "dm", id: "surface-1", threadId: undefined },
      { kind: "typing", active: false },
    );
  });
});

describe("Kernel service binding identity", () => {
  it("rejects service calls instead of fabricating a missing root account", async () => {
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as {
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
    Object.defineProperty(kernel, "name", { value: "singleton" });
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
    const kernel = createKernel() as {
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
    Object.defineProperty(kernel, "name", { value: "singleton" });
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
    const kernel = createKernel() as {
      ctx: { storage: { transactionSync: (closure: () => unknown) => unknown } };
      env: Record<string, never>;
      procs: {
        get: ReturnType<typeof vi.fn>;
        getIdentity: ReturnType<typeof vi.fn>;
      };
      caps: { resolve: ReturnType<typeof vi.fn> };
      auth: { getPasswdByUid: ReturnType<typeof vi.fn> };
      devices: {
        canAccess: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
      };
      requestDevice: typeof requestDevice;
      routes: { get: ReturnType<typeof vi.fn> };
      cancelProcessRequests(
        processId: string,
        requestIds: string[],
        reason?: string,
      ): Promise<number>;
      activeRequests: Map<
        string,
        { origin: { type: "process"; id: string }; controller: AbortController }
      >;
      cancelledProcessRequests: Map<
        string,
        { expiresAt: number; reason: string }
      >;
      authorizeRegisteredProcessRuntime: ReturnType<typeof vi.fn>;
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
    Object.defineProperty(kernel, "name", { value: "user:root" });
    (kernel as any).requireActiveUserKernel = vi.fn(async () => ({
      username: "root",
      uid: 0,
      lifecycle: "active",
    }));
    kernel.ctx = {
      storage: { transactionSync: (closure: () => unknown) => closure() },
    };
    kernel.env = {};
    kernel.procs = {
      get: vi.fn(() => ({
        ownerUid: 0,
        packageSecurityRevision: null,
      })),
      getIdentity: vi.fn(() => ({
        uid: 0,
        gid: 0,
        gids: [0],
        username: "root",
        home: "/root",
        cwd: "/root",
      })),
    };
    (kernel as any).resolveUserKernelAccountIdentity = vi.fn(async () => ({
      ok: true,
      identity: {
        uid: 0,
        gid: 0,
        gids: [0],
        username: "root",
        home: "/root",
        cwd: "/root",
      },
      capabilities: options.capabilities ?? ["net.fetch"],
    }));
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
    kernel.authorizeRegisteredProcessRuntime = vi.fn(async () => true);
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
      expect.objectContaining({
        ttlMs: 180000,
      }),
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
      expect.objectContaining({
        ttlMs: 180000,
      }),
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

  it("only lets the owning process cancel an active request", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:root" });
    kernel.requireActiveUserKernel = vi.fn(async () => ({
      username: "root",
      uid: 0,
      lifecycle: "active",
    }));
    kernel.procs = { get: vi.fn(() => ({ ownerUid: 0 })) };
    const controller = new AbortController();
    kernel.activeRequests = new Map([
      ["fetch-1", { origin: { type: "process", id: "proc_1" }, controller }],
    ]);
    kernel.cancelledProcessRequests = new Map();
    kernel.routes = { get: vi.fn(() => null) };

    expect(await kernel.cancelProcessRequests("proc_2", ["fetch-1"])).toBe(0);
    expect(controller.signal.aborted).toBe(false);
    expect(await kernel.cancelProcessRequests("proc_1", ["fetch-1"], "stopped")).toBe(1);
    expect(controller.signal.reason).toEqual(new Error("stopped"));
  });

  it("forwards routed cancellation only for the owning process", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:root" });
    kernel.requireActiveUserKernel = vi.fn(async () => ({
      username: "root",
      uid: 0,
      lifecycle: "active",
    }));
    kernel.procs = { get: vi.fn(() => ({ ownerUid: 0 })) };
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

    expect(await kernel.cancelProcessRequests("proc_2", ["search-1"], "stopped")).toBe(0);
    expect(kernel.sendDeviceRequestCancel).not.toHaveBeenCalled();
    expect(await kernel.cancelProcessRequests("proc_1", ["search-1"], "stopped")).toBe(1);
    expect(kernel.sendDeviceRequestCancel).toHaveBeenCalledWith(
      "device-1",
      "driver-connection",
      "search-1",
      "stopped",
    );
    expect(kernel.cancelRoute).toHaveBeenCalledWith("search-1");
  });

  it("cancels a connection request without exposing the control signal", () => {
    const kernel = createKernel() as any;
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

    expect(await kernel.cancelProcessRequests("proc_1", ["fetch-early"], "superseded")).toBe(1);
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

describe("Kernel IPC completion", () => {
  beforeEach(() => {
    sendFrameToProcessMock.mockReset();
  });

  it("schedules timeout callbacks no earlier than their deadline", async () => {
    const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
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
      const kernel = createKernel() as any;
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
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      updatedAt: 1,
    };
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
    const kernel = createKernel() as any;
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
