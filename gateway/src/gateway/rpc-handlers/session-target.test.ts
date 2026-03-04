import { describe, expect, it } from "vitest";
import { RpcError } from "../../shared/utils";
import { resolveSessionTarget } from "./session-target";

function buildGatewayStub(params?: {
  canonicalize?: (sessionKey: string, agentIdHint?: string) => string;
  sessionRegistry?: Record<string, Record<string, unknown>>;
  threadMeta?: Record<string, Record<string, unknown>>;
}) {
  const canonicalize =
    params?.canonicalize ??
    ((sessionKey: string) => sessionKey.trim().toLowerCase());
  const sessionRegistry = params?.sessionRegistry ?? {};
  const threadMeta = params?.threadMeta ?? {};

  return {
    canonicalizeSessionKey(sessionKey: string, agentIdHint?: string): string {
      return canonicalize(sessionKey, agentIdHint);
    },
    getSessionRegistryEntry(sessionKey: string) {
      return sessionRegistry[sessionKey];
    },
    registryStore: {
      getThreadMeta(threadId: string) {
        return threadMeta[threadId];
      },
    },
  } as any;
}

describe("resolveSessionTarget", () => {
  it("resolves id: thread refs using thread meta", () => {
    const gw = buildGatewayStub({
      threadMeta: {
        "01thread": {
          stateId: "thread:01thread",
        },
      },
    });

    const target = resolveSessionTarget(gw, {
      threadRef: "id:01thread",
    });

    expect(target.threadId).toBe("01thread");
    expect(target.stateId).toBe("thread:01thread");
    expect(target.sessionDoName).toBe("thread:01thread");
    expect(target.sessionKey).toBe("thread:01thread");
  });

  it("resolves legacy thread meta back to legacy session key", () => {
    const gw = buildGatewayStub({
      threadMeta: {
        "legacy-thread": {
          stateId: "legacySession:agent:main:main",
        },
      },
    });

    const target = resolveSessionTarget(gw, {
      threadRef: "id:legacy-thread",
    });

    expect(target.threadId).toBe("legacy-thread");
    expect(target.stateId).toBe("legacySession:agent:main:main");
    expect(target.sessionDoName).toBe("agent:main:main");
    expect(target.sessionKey).toBe("agent:main:main");
  });

  it("treats bare threadRef as threadId when meta exists", () => {
    const gw = buildGatewayStub({
      threadMeta: {
        barethread: {
          stateId: "thread:barethread",
        },
      },
    });

    const target = resolveSessionTarget(gw, {
      threadRef: "barethread",
    });

    expect(target.threadId).toBe("barethread");
    expect(target.sessionDoName).toBe("thread:barethread");
  });

  it("falls back to canonical sessionKey when thread meta does not exist", () => {
    const gw = buildGatewayStub({
      canonicalize: (sessionKey: string) =>
        `canon:${sessionKey.trim().toLowerCase()}`,
      sessionRegistry: {
        "canon:agent:main:main": {
          threadId: "01thread",
          stateId: "thread:01thread",
        },
      },
    });

    const target = resolveSessionTarget(gw, {
      threadRef: "agent:MAIN:main",
    });

    expect(target.sessionKey).toBe("canon:agent:main:main");
    expect(target.sessionDoName).toBe("thread:01thread");
    expect(target.threadId).toBe("01thread");
    expect(target.stateId).toBe("thread:01thread");
  });

  it("rejects alias and addr threadRef formats in this phase", () => {
    const gw = buildGatewayStub();

    for (const threadRef of ["alias:personal", "addr:foo"]) {
      try {
        resolveSessionTarget(gw, { threadRef });
        throw new Error("expected resolveSessionTarget to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(RpcError);
        expect((error as RpcError).code).toBe(400);
      }
    }
  });
});
