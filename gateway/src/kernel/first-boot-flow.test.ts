import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./connect", async (importOriginal) => {
  const original = await importOriginal<typeof import("./connect")>();
  return {
    ...original,
    ensureKernelBootstrapped: vi.fn(async () => undefined),
  };
});

vi.mock("./sys/setup", () => ({
  handleSysSetup: vi.fn(),
}));

vi.mock("./sys/setup-assist", () => ({
  handleSysSetupAssist: vi.fn(),
}));

vi.mock("./agents", async (importOriginal) => {
  const original = await importOriginal<typeof import("./agents")>();
  return {
    ...original,
    ensureDefaultConversationExecutor: vi.fn(async () => undefined),
  };
});

import { Kernel } from "./do";
import { FirstBootAdmission } from "./first-boot-admission";
import { handleSysSetup as runSetup } from "./sys/setup";
import { handleSysSetupAssist as runSetupAssist } from "./sys/setup-assist";

const runSetupMock = vi.mocked(runSetup);
const runSetupAssistMock = vi.mocked(runSetupAssist);

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function pendingConnection(id: string) {
  return { id, state: { step: "pending" } };
}

function setupResult() {
  return {
    server: { version: "test", release: "test" },
    user: {
      uid: 1000,
      gid: 1000,
      gids: [1000],
      username: "alice",
      home: "/home/alice",
      cwd: "/home/alice",
    },
    rootLocked: false,
  };
}

function setupFrame(id: string) {
  return {
    type: "req",
    id,
    call: "sys.setup",
    args: {},
  };
}

function assistFrame(id: string) {
  return {
    type: "req",
    id,
    call: "sys.setup.assist",
    args: {},
  };
}

function assignRequestTracking(kernel: any): void {
  Object.assign(kernel, {
    activeRequests: new Map(),
    routes: { get: () => null },
  });
}

describe("Kernel first-boot flow admission", () => {
  beforeEach(() => {
    runSetupMock.mockReset();
    runSetupAssistMock.mockReset();
  });

  it("lets only the winning concurrent setup mutate state or receive success", async () => {
    const first = deferred<ReturnType<typeof setupResult>>();
    runSetupMock.mockImplementation(async () => first.promise);
    const kernel = Object.create(Kernel.prototype) as any;
    Object.assign(kernel, {
      firstBootAdmission: new FirstBootAdmission(),
      auth: { isSetupMode: () => true },
      buildContext: (_connection: unknown, options: object = {}) => options,
      sendError: vi.fn(),
      sendOk: vi.fn(),
    });
    assignRequestTracking(kernel);
    const winner = pendingConnection("winner");
    const loser = pendingConnection("loser");

    const winningRequest = kernel.handleSysSetup(winner, setupFrame("setup-1"));
    await vi.waitFor(() => expect(runSetupMock).toHaveBeenCalledOnce());
    await kernel.handleSysSetup(loser, setupFrame("setup-2"));

    expect(runSetupMock).toHaveBeenCalledOnce();
    expect(kernel.sendError).toHaveBeenCalledWith(
      loser,
      "setup-2",
      409,
      "Setup already in progress",
    );
    expect(kernel.sendOk).not.toHaveBeenCalled();

    first.resolve(setupResult());
    await winningRequest;

    expect(kernel.sendOk).toHaveBeenCalledOnce();
    expect(kernel.sendOk).toHaveBeenCalledWith(winner, "setup-1", setupResult());
  });

  it("suppresses setup-assist output after a setup supersedes it", async () => {
    const assist = deferred<{ message: string; reviewReady: boolean; patches: [] }>();
    let setupMode = true;
    runSetupAssistMock.mockImplementation(async () => assist.promise);
    runSetupMock.mockImplementation(async () => {
      setupMode = false;
      return setupResult();
    });
    const kernel = Object.create(Kernel.prototype) as any;
    Object.assign(kernel, {
      firstBootAdmission: new FirstBootAdmission(),
      auth: { isSetupMode: () => setupMode },
      buildContext: (_connection: unknown, options: object = {}) => options,
      sendError: vi.fn(),
      sendOk: vi.fn(),
    });
    assignRequestTracking(kernel);
    const assistConnection = pendingConnection("assist");
    const setupConnection = pendingConnection("setup");

    const assistRequest = kernel.handleSysSetupAssist(
      assistConnection,
      assistFrame("assist-1"),
    );
    await vi.waitFor(() => expect(runSetupAssistMock).toHaveBeenCalledOnce());
    await kernel.handleSysSetup(setupConnection, setupFrame("setup-1"));

    assist.resolve({ message: "late answer", reviewReady: false, patches: [] });
    await assistRequest;

    expect(kernel.sendOk).toHaveBeenCalledOnce();
    expect(kernel.sendOk).toHaveBeenCalledWith(
      setupConnection,
      "setup-1",
      setupResult(),
    );
    expect(kernel.sendError).toHaveBeenCalledWith(
      assistConnection,
      "assist-1",
      409,
      "Setup assistance was superseded",
    );
  });

  it("aborts setup and waits for its owner to settle before a managed fence completes", async () => {
    const cleanup = deferred<void>();
    let requestSignal: AbortSignal | undefined;
    runSetupMock.mockImplementation(async (_args, ctx: any) => {
      requestSignal = ctx.requestSignal;
      await new Promise<void>((resolve) => {
        requestSignal!.addEventListener("abort", resolve, { once: true });
      });
      await cleanup.promise;
      requestSignal.throwIfAborted();
      return setupResult();
    });

    const kernel = Object.create(Kernel.prototype) as any;
    Object.assign(kernel, {
      firstBootAdmission: new FirstBootAdmission(),
      auth: { isSetupMode: () => true },
      buildContext: (_connection: unknown, options: object = {}) => options,
      sendError: vi.fn(),
      sendOk: vi.fn(),
      managedLifecycle: "updating",
      getConnections: () => [],
      webSocketAdmission: { close: vi.fn() },
      connections: new Map(),
      routedBodies: new Map(),
      frameBodyChannels: new Map(),
    });
    assignRequestTracking(kernel);

    const setupRequest = kernel.handleSysSetup(
      pendingConnection("setup"),
      setupFrame("setup-1"),
    );
    await vi.waitFor(() => expect(requestSignal).toBeDefined());

    let fenceSettled = false;
    const fence = kernel.managedFenceActiveRuntime().then(() => {
      fenceSettled = true;
    });
    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
    expect(fenceSettled).toBe(false);

    cleanup.resolve(undefined);
    await Promise.all([setupRequest, fence]);

    expect(fenceSettled).toBe(true);
    expect(kernel.activeRequests).toHaveLength(0);
    expect(kernel.sendOk).not.toHaveBeenCalled();
  });

  it("fails closed when an active request does not settle after cancellation", async () => {
    vi.useFakeTimers();
    try {
      const kernel = Object.create(Kernel.prototype) as any;
      Object.assign(kernel, {
        managedLifecycle: "updating",
        activeRequests: new Map([
          ["stuck", {
            origin: { type: "connection", id: "stuck" },
            controller: new AbortController(),
            settled: new Promise<void>(() => {}),
            settle: vi.fn(),
          }],
        ]),
        getConnections: () => [],
        webSocketAdmission: { close: vi.fn() },
        connections: new Map(),
        routedBodies: new Map(),
        frameBodyChannels: new Map(),
      });

      const fence = expect(kernel.managedFenceActiveRuntime()).rejects.toThrow(
        "Timed out waiting for active tenant requests to stop",
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await fence;

      expect(kernel.activeRequests.has("stuck")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
