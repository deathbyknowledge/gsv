import { describe, expect, it, vi } from "vitest";
import { bodyFromBytes, bodyToBytes } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import type { AdapterServiceBinding } from "./adapter-handlers";
import {
  listVisibleAdapterTargets,
  requestAdapterTarget,
} from "./adapter-targets";
import { listAllVisibleTargets } from "./targets";

function rpcResult<T extends object>(value: T): T & Disposable {
  Object.defineProperty(value, Symbol.dispose, { value: vi.fn() });
  // SAFETY: the test helper attaches the disposer that Workers RPC adds to
  // every object-valued result.
  return value as T & Disposable;
}

function makeService(overrides: Partial<AdapterServiceBinding> = {}): AdapterServiceBinding {
  const service = {
    fetch: vi.fn(),
    adapterDescribe: vi.fn(async () => rpcResult({
      version: 1,
      id: "slack",
      displayName: "Slack",
      capabilities: {
        connect: false,
        disconnect: false,
        send: true,
        status: true,
        activity: false,
        pairing: true,
        targets: true,
        surfaces: ["dm", "channel", "thread"],
        media: { inbound: [], outbound: [] },
      },
    })),
    adapterTargetList: vi.fn(async () => rpcResult([{
      id: "workspace",
      label: "Slack — Acme",
      description: "Slack workspace",
      platform: "slack",
      version: "web-api",
      implements: ["shell.exec"],
    }])),
    adapterTargetExecute: vi.fn(async (_installation, _identity, _targetId, frame) => rpcResult({
      type: "res" as const,
      id: frame.id,
      ok: true as const,
      data: { status: "completed" as const, output: "ok\n", exitCode: 0 },
    })),
    adapterTargetCancel: vi.fn(async () => rpcResult({ cancelled: true })),
    ...overrides,
  };
  // SAFETY: the test double implements the service-binding methods exercised by
  // adapter target discovery, execution, and cancellation.
  return service as AdapterServiceBinding;
}

function makeContext(
  service: AdapterServiceBinding,
  options: { signal?: AbortSignal; deferred?: Promise<unknown>[] } = {},
): KernelContext {
  const link = {
    adapter: "slack",
    accountId: "workspace-hash",
    actorId: "UALICE01",
    uid: 1000,
    createdAt: 100,
    linkedByUid: 1000,
    metadata: { managed: true, routeGeneration: "route-generation" },
  };
  const context: Partial<KernelContext> = {
    installationId: "installation-1",
    identity: {
      role: "user",
      process: {
        uid: 2000,
        gid: 2000,
        gids: [2000],
        username: "ship",
        home: "/home/ship",
        cwd: "/home/ship",
      },
      capabilities: ["*"],
    },
    callerOwnerUid: 1000,
    procs: { getOwnerUid: vi.fn(() => 1000) },
    adapters: {
      identityLinks: { list: vi.fn(() => [link]) },
      status: {
        get: vi.fn(() => ({
          accountId: link.accountId,
          connected: true,
          authenticated: true,
          mode: "managed-shared",
          updatedAt: 200,
        })),
      },
    },
    auth: {
      getPasswdByUid: vi.fn(() => ({ username: "john" })),
    },
    env: { CHANNEL_SLACK: service },
    requestSignal: options.signal,
    defer: (promise) => {
      options.deferred?.push(promise);
    },
  };
  // SAFETY: the focused test supplies every KernelContext owner consulted by
  // adapter target discovery and routing.
  return context as KernelContext;
}

describe("adapter-backed targets", () => {
  it("projects a linked adapter actor as an opaque owner target", async () => {
    const service = makeService();
    const ctx = makeContext(service);

    const targets = await listVisibleAdapterTargets(ctx);

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      targetId: expect.stringMatching(/^slack-target:[a-f0-9]{64}$/),
      ownerUid: 1000,
      ownerUsername: "john",
      label: "Slack — Acme",
      platform: "slack",
      online: true,
      implements: ["shell.exec"],
      route: {
        kind: "adapter",
        adapter: "slack",
        accountId: "workspace-hash",
        actorId: "UALICE01",
        routeGeneration: "route-generation",
        adapterTargetId: "workspace",
      },
    });
    expect(service.adapterTargetList).toHaveBeenCalledWith(
      { installationId: "installation-1" },
      {
        accountId: "workspace-hash",
        actorId: "UALICE01",
        routeGeneration: "route-generation",
      },
    );
  });

  it("requires the adapter descriptor to opt into targets", async () => {
    const service = makeService({
      adapterDescribe: vi.fn(async () => rpcResult({
        version: 1,
        id: "slack",
        displayName: "Slack",
        capabilities: {
          connect: false,
          disconnect: false,
          send: true,
          status: true,
          activity: false,
          pairing: true,
          surfaces: ["dm"],
          media: { inbound: [], outbound: [] },
        },
      })),
    });

    await expect(listVisibleAdapterTargets(makeContext(service))).resolves.toEqual([]);
    expect(service.adapterTargetList).not.toHaveBeenCalled();
  });

  it("bounds stalled discovery, preserves local targets, and disposes a late result", async () => {
    vi.useFakeTimers();
    let resolveDescriptor!: (value: ReturnType<typeof rpcResult>) => void;
    const descriptor = rpcResult({
      version: 1 as const,
      id: "slack",
      displayName: "Slack",
      capabilities: {
        connect: false,
        disconnect: false,
        send: true,
        status: true,
        activity: false,
        pairing: true,
        targets: true,
        surfaces: ["dm" as const],
        media: { inbound: [], outbound: [] },
      },
    });
    const descriptorPromise = new Promise<typeof descriptor>((resolve) => {
      resolveDescriptor = resolve;
    });
    const service = makeService({
      adapterDescribe: vi.fn(() => descriptorPromise),
    });
    const deferred: Promise<unknown>[] = [];
    const ctx = makeContext(service, { deferred });
    const localTarget = {
      device_id: "laptop",
      owner_uid: 1000,
      label: "Laptop",
      description: "Local machine",
      implements: ["shell.exec"],
      platform: "linux",
      version: "1",
      online: true,
      first_seen_at: 10,
      last_seen_at: 20,
      connected_at: 10,
      disconnected_at: null,
    };
    // SAFETY: the focused test supplies the device-store method consulted by
    // target projection; no other device-store operation is reachable here.
    ctx.devices = {
      listForUser: vi.fn(() => [localTarget]),
    } as KernelContext["devices"];

    try {
      const discovery = listAllVisibleTargets(ctx);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(discovery).resolves.toEqual([
        expect.objectContaining({ targetId: "laptop", label: "Laptop", online: true }),
      ]);
      resolveDescriptor(descriptor);
      await Promise.all(deferred);
      expect(descriptor[Symbol.dispose]).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes a syscall through the adapter and preserves the response envelope", async () => {
    const service = makeService();
    const ctx = makeContext(service);
    const [target] = await listVisibleAdapterTargets(ctx);

    const response = await requestAdapterTarget({
      type: "req",
      id: "request-1",
      call: "shell.exec",
      args: { input: "slack whoami" },
      runId: "process-run-1",
    }, target!, Date.now() + 120_000, ctx);

    expect(response).toEqual({
      type: "res",
      id: "request-1",
      ok: true,
      data: { status: "completed", output: "ok\n", exitCode: 0 },
    });
    expect(service.adapterTargetExecute).toHaveBeenCalledWith(
      { installationId: "installation-1" },
      expect.objectContaining({ routeGeneration: "route-generation" }),
      "workspace",
      expect.objectContaining({
        id: "request-1",
        call: "shell.exec",
        runId: "process-run-1",
        deadlineAt: expect.any(Number),
      }),
    );
  });

  it("retains a body-bearing RPC response until its stream reaches a terminal outcome", async () => {
    const completed = rpcResult({
      type: "res" as const,
      id: "request-body-complete",
      ok: true as const,
      data: { status: "completed" as const, output: "", exitCode: 0 },
      body: bodyFromBytes(new TextEncoder().encode("adapter bytes")),
    });
    const cancelled = rpcResult({
      type: "res" as const,
      id: "request-body-cancel",
      ok: true as const,
      data: { status: "completed" as const, output: "", exitCode: 0 },
      body: bodyFromBytes(new TextEncoder().encode("unused bytes")),
    });
    const service = makeService({
      adapterTargetExecute: vi.fn()
        .mockResolvedValueOnce(completed)
        .mockResolvedValueOnce(cancelled),
    });
    const ctx = makeContext(service);
    const [target] = await listVisibleAdapterTargets(ctx);

    const completeResponse = await requestAdapterTarget({
      type: "req",
      id: "request-body-complete",
      call: "shell.exec",
      args: { input: "slack export" },
    }, target!, Date.now() + 120_000, ctx);
    expect(completed[Symbol.dispose]).not.toHaveBeenCalled();
    if (!completeResponse.ok || !completeResponse.body) {
      throw new Error("Expected a body-bearing adapter response");
    }
    await expect(bodyToBytes(completeResponse.body)).resolves.toEqual(
      new TextEncoder().encode("adapter bytes"),
    );
    expect(completed[Symbol.dispose]).toHaveBeenCalledOnce();

    const cancelResponse = await requestAdapterTarget({
      type: "req",
      id: "request-body-cancel",
      call: "shell.exec",
      args: { input: "slack export" },
    }, target!, Date.now() + 120_000, ctx);
    expect(cancelled[Symbol.dispose]).not.toHaveBeenCalled();
    if (!cancelResponse.ok || !cancelResponse.body) {
      throw new Error("Expected a body-bearing adapter response");
    }
    await cancelResponse.body.stream.cancel("not needed");
    expect(cancelled[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("cancels the owning adapter call when the caller aborts", async () => {
    const pending = new Promise<never>(() => undefined);
    const service = makeService({
      adapterTargetExecute: vi.fn(() => pending),
    });
    const controller = new AbortController();
    const deferred: Promise<unknown>[] = [];
    const ctx = makeContext(service, { signal: controller.signal, deferred });
    const [target] = await listVisibleAdapterTargets(ctx);
    const responsePromise = requestAdapterTarget({
      type: "req",
      id: "request-cancel",
      call: "shell.exec",
      args: { input: "slack conversations list" },
    }, target!, Date.now() + 120_000, ctx);

    await vi.waitFor(() => expect(service.adapterTargetExecute).toHaveBeenCalled());
    controller.abort(new Error("Process aborted"));

    await expect(responsePromise).resolves.toMatchObject({
      type: "res",
      id: "request-cancel",
      ok: false,
      error: { code: 499, message: "Process aborted" },
    });
    await Promise.all(deferred);
    expect(service.adapterTargetCancel).toHaveBeenCalledWith(
      { installationId: "installation-1" },
      expect.objectContaining({ routeGeneration: "route-generation" }),
      "workspace",
      "request-cancel",
    );
  });

  it("enforces the Kernel route deadline and cancels the adapter call", async () => {
    const pending = new Promise<never>(() => undefined);
    const service = makeService({
      adapterTargetExecute: vi.fn(() => pending),
    });
    const deferred: Promise<unknown>[] = [];
    const ctx = makeContext(service, { deferred });
    const [target] = await listVisibleAdapterTargets(ctx);

    const response = await requestAdapterTarget({
      type: "req",
      id: "request-timeout",
      call: "shell.exec",
      args: { input: "slack conversations list" },
    }, target!, Date.now() - 1, ctx);

    expect(response).toMatchObject({
      type: "res",
      id: "request-timeout",
      ok: false,
      error: { code: 504, message: expect.stringContaining("timed out") },
    });
    await Promise.all(deferred);
    expect(service.adapterTargetCancel).toHaveBeenCalledWith(
      { installationId: "installation-1" },
      expect.objectContaining({ routeGeneration: "route-generation" }),
      "workspace",
      "request-timeout",
    );
  });
});
