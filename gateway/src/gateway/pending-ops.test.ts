import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  GatewayPendingOperationsService,
  PENDING_LOGS_RESULT_KIND,
  PENDING_TOOL_RESULT_KIND,
  isPendingLogOperation,
  isPendingToolOperation,
  sanitizePendingLogRoute,
  sanitizePendingToolRoute,
} from "./pending-ops";

type MockKvStorage = {
  get: (key: string) => unknown;
  put: (key: string, value: unknown) => void;
  delete: (key: string) => boolean;
  list: (opts?: { prefix?: string }) => Array<[string, unknown]>;
};

type MockKvStorageWithStore = MockKvStorage & {
  store: Map<string, unknown>;
};

function createMockKv(): MockKvStorageWithStore {
  const store = new Map<string, unknown>();
  return {
    store,
    get: (key) => store.get(key),
    put: (key, value) => store.set(key, value),
    delete: (key) => store.delete(key),
    list: (opts) => {
      const prefix = opts?.prefix ?? "";
      return Array.from(store.entries()).filter(([key]) =>
        key.startsWith(prefix),
      );
    },
  };
}

describe("pending operations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates tool operation payloads", () => {
    const record = {
      kind: PENDING_TOOL_RESULT_KIND,
      createdAt: Date.now(),
      payload: {
        route: {
          kind: "client",
          clientId: "client-1",
          frameId: "frame-1",
          createdAt: 1,
        },
      },
    };

    expect(isPendingToolOperation(record)).toBe(true);
    expect(
      isPendingToolOperation({ kind: "tool.result", createdAt: Date.now() }),
    ).toBe(false);
  });

  it("validates logs operation payloads", () => {
    const record = {
      kind: PENDING_LOGS_RESULT_KIND,
      createdAt: Date.now(),
      payload: {
        route: {
          clientId: "client-1",
          frameId: "frame-1",
          nodeId: "node-1",
          createdAt: 123,
        },
      },
    };

    expect(isPendingLogOperation(record)).toBe(true);
  });

  it("sanitizes stored tool route", () => {
    expect(
      sanitizePendingToolRoute({
        kind: "client",
        clientId: "client-1",
        frameId: "frame-1",
        createdAt: 12,
      }),
    ).toEqual({
      kind: "client",
      clientId: "client-1",
      frameId: "frame-1",
      createdAt: 12,
    });
  });

  it("sanitizes stored log route", () => {
    expect(
      sanitizePendingLogRoute({
        clientId: "client-1",
        frameId: "frame-1",
        nodeId: "node-1",
        createdAt: 12,
      }),
    ).toEqual({
      clientId: "client-1",
      frameId: "frame-1",
      nodeId: "node-1",
      createdAt: 12,
    });
  });

  it("registers and consumes tool calls", () => {
    const pending = new GatewayPendingOperationsService(createMockKv());
    const route = {
      kind: "session" as const,
      sessionKey: "agent:main:abc",
    };

    pending.registerToolCall("call-1", route);
    expect(pending.consumeToolCall("call-1")).toEqual(route);
    expect(pending.consumeToolCall("call-1")).toBeUndefined();
  });

  it("registers and consumes log calls", () => {
    const pending = new GatewayPendingOperationsService(createMockKv());
    const route = {
      clientId: "client-1",
      frameId: "frame-1",
      nodeId: "node-1",
      createdAt: 5,
    };

    pending.registerLogCall("call-1", route);
    expect(pending.consumeLogCall("call-1")).toEqual(route);
    expect(pending.consumeLogCall("call-1")).toBeUndefined();
  });

  it("cleans up client pending operations", () => {
    const pending = new GatewayPendingOperationsService(createMockKv());
    pending.registerToolCall("tool-call", {
      kind: "client",
      clientId: "client-1",
      frameId: "frame-1",
      createdAt: 1,
    });
    pending.registerLogCall("log-call", {
      clientId: "client-1",
      frameId: "frame-2",
      nodeId: "node-1",
      createdAt: 2,
    });

    pending.cleanupClientPendingOperations("client-1");
    expect(pending.consumeToolCall("tool-call")).toBeUndefined();
    expect(pending.consumeLogCall("log-call")).toBeUndefined();
  });

  it("collects failed log calls by node", () => {
    const pending = new GatewayPendingOperationsService(createMockKv());
    pending.registerLogCall("log-call", {
      clientId: "client-1",
      frameId: "frame-1",
      nodeId: "node-1",
      createdAt: 1,
    });
    pending.registerLogCall("other-log-call", {
      clientId: "client-2",
      frameId: "frame-2",
      nodeId: "node-2",
      createdAt: 2,
    });

    const failed = pending.failPendingLogCallsForNode("node-1");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual({
      callId: "log-call",
      clientId: "client-1",
      frameId: "frame-1",
    });
    expect(pending.consumeLogCall("other-log-call")).toEqual({
      clientId: "client-2",
      frameId: "frame-2",
      nodeId: "node-2",
      createdAt: 2,
    });
  });

  it("tracks next expiration and cleans up expired calls", () => {
    const pending = new GatewayPendingOperationsService(createMockKv());
    vi.setSystemTime(1_000);

    pending.registerToolCall(
      "tool-call",
      {
        kind: "session",
        sessionKey: "agent:main:abc",
      },
      { ttlMs: 1_500 },
    );
    pending.registerLogCall(
      "log-call",
      {
        clientId: "client-1",
        frameId: "frame-1",
        nodeId: "node-1",
        createdAt: 0,
      },
      { ttlMs: 2_000 },
    );

    expect(pending.getNextExpirationAtMs()).toBe(2_500);

    vi.setSystemTime(3_100);
    const expired = pending.cleanupExpired();

    expect(expired.toolCalls).toEqual([
      {
        callId: "tool-call",
        route: {
          kind: "session",
          sessionKey: "agent:main:abc",
        },
      },
    ]);
    expect(expired.logCalls).toEqual([
      {
        callId: "log-call",
        route: {
          clientId: "client-1",
          frameId: "frame-1",
          nodeId: "node-1",
          createdAt: 0,
        },
      },
    ]);

    expect(pending.consumeToolCall("tool-call")).toBeUndefined();
    expect(pending.consumeLogCall("log-call")).toBeUndefined();
    expect(pending.getNextExpirationAtMs()).toBeUndefined();
  });

  it("ignores invalid call entries during cleanup", () => {
    const mockKv = createMockKv();
    const pending = new GatewayPendingOperationsService(mockKv);
    const { store } = mockKv;

    const brokenKey = "pendingOperations:bad-call";
    store.set(brokenKey, { kind: "tool.result", payload: {} });

    expect(() => {
      pending.cleanupExpired(1_000);
    }).not.toThrow();

    expect(store.has(brokenKey)).toBe(false);
  });
});
