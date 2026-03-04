import { describe, expect, it } from "vitest";
import {
  authorizeCrossSpaceSessionOperation,
  authorizeSessionCapability,
  resolveSessionPolicyContext,
  resolveCapabilityForToolName,
} from "./authz";

function buildGatewayStub(params?: {
  sessionRegistry?: Record<string, Record<string, unknown>>;
  memberships?: Record<string, Record<string, { role: string }>>;
  threadMeta?: Record<string, Record<string, unknown>>;
  config?: Record<string, unknown>;
  owners?: Set<string>;
}) {
  const sessionRegistry = params?.sessionRegistry ?? {};
  const memberships = params?.memberships ?? {};
  const threadMeta = params?.threadMeta ?? {};
  const owners = params?.owners ?? new Set<string>();
  const config = params?.config ?? {};

  return {
    sessionRegistry,
    registryStore: {
      isOwner(principalId: string): boolean {
        return owners.has(principalId);
      },
      getSpaceMembers(spaceId: string): Record<string, { role: string }> {
        return memberships[spaceId] ?? {};
      },
      getThreadMeta(threadId: string): Record<string, unknown> | undefined {
        return threadMeta[threadId];
      },
    },
    getConfigPath(path: string): unknown {
      const parts = path.split(".");
      let current: unknown = config;
      for (const part of parts) {
        if (
          current &&
          typeof current === "object" &&
          part in (current as Record<string, unknown>)
        ) {
          current = (current as Record<string, unknown>)[part];
        } else {
          return undefined;
        }
      }
      return current;
    },
  } as any;
}

describe("resolveCapabilityForToolName", () => {
  it("maps native and transfer tools to policy capabilities", () => {
    expect(resolveCapabilityForToolName("gsv__ReadFile")).toBe("workspace.read");
    expect(resolveCapabilityForToolName("gsv__Message")).toBe("message.send");
    expect(resolveCapabilityForToolName("gsv__Transfer")).toBe("transfer.execute");
  });

  it("maps non-native tools to node.exec", () => {
    expect(resolveCapabilityForToolName("macbook__Bash")).toBe("node.exec");
  });
});

describe("authorizeSessionCapability", () => {
  it("allows when no space policy context exists (compat mode)", () => {
    const gw = buildGatewayStub({
      sessionRegistry: {
        "agent:main:main": {
          sessionKey: "agent:main:main",
          createdAt: 1,
          lastActiveAt: 2,
        },
      },
    });

    const result = authorizeSessionCapability({
      gw,
      sessionKey: "agent:main:main",
      capability: "message.send",
    });
    expect(result.ok).toBe(true);
  });

  it("denies capability via role policy", () => {
    const gw = buildGatewayStub({
      sessionRegistry: {
        thread1: {
          sessionKey: "thread1",
          spaceId: "household",
          principalId: "channel:whatsapp:default:+1555",
          createdAt: 1,
          lastActiveAt: 2,
        },
      },
      memberships: {
        household: {
          "channel:whatsapp:default:+1555": { role: "guest" },
        },
      },
      config: {
        roles: {
          guest: {
            allowCapabilities: ["delivery.reply", "threads.read"],
            denyCapabilities: ["message.send"],
          },
        },
        spaces: {
          entries: {
            household: {
              policy: {
                allowCapabilities: ["*"],
                denyCapabilities: [],
              },
            },
          },
        },
      },
    });

    const result = authorizeSessionCapability({
      gw,
      sessionKey: "thread1",
      capability: "message.send",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("denied by role policy");
  });

  it("enforces role-space intersection", () => {
    const gw = buildGatewayStub({
      sessionRegistry: {
        thread1: {
          sessionKey: "thread1",
          spaceId: "household",
          principalId: "channel:whatsapp:default:+1555",
          createdAt: 1,
          lastActiveAt: 2,
        },
      },
      memberships: {
        household: {
          "channel:whatsapp:default:+1555": { role: "member" },
        },
      },
      config: {
        roles: {
          member: {
            allowCapabilities: ["workspace.read", "workspace.write"],
            denyCapabilities: [],
          },
        },
        spaces: {
          entries: {
            household: {
              policy: {
                allowCapabilities: ["workspace.read"],
                denyCapabilities: [],
              },
            },
          },
        },
      },
    });

    const writeResult = authorizeSessionCapability({
      gw,
      sessionKey: "thread1",
      capability: "workspace.write",
    });
    const readResult = authorizeSessionCapability({
      gw,
      sessionKey: "thread1",
      capability: "workspace.read",
    });

    expect(writeResult.ok).toBe(false);
    expect(readResult.ok).toBe(true);
  });
});

describe("resolveSessionPolicyContext", () => {
  it("falls back to explicit space when session entry is missing", () => {
    const gw = buildGatewayStub();

    const ctx = resolveSessionPolicyContext({
      gw,
      sessionKey: "thread:01A",
      fallbackSpaceId: "Household",
    });

    expect(ctx.spaceId).toBe("household");
    expect(ctx.isOwner).toBe(false);
  });

  it("resolves owner from session principal", () => {
    const principalId = "channel:whatsapp:default:+1555";
    const gw = buildGatewayStub({
      sessionRegistry: {
        "thread:01A": {
          sessionKey: "thread:01A",
          spaceId: "owner",
          principalId,
          createdAt: 1,
          lastActiveAt: 2,
        },
      },
      owners: new Set([principalId]),
    });

    const ctx = resolveSessionPolicyContext({
      gw,
      sessionKey: "thread:01A",
    });

    expect(ctx.spaceId).toBe("owner");
    expect(ctx.principalId).toBe(principalId);
    expect(ctx.isOwner).toBe(true);
    expect(ctx.role).toBe("owner");
  });
});

describe("authorizeCrossSpaceSessionOperation", () => {
  it("denies cross-space operation for non-owner", () => {
    const gw = buildGatewayStub({
      sessionRegistry: {
        "thread:source": {
          sessionKey: "thread:source",
          spaceId: "alpha",
          principalId: "channel:whatsapp:default:+100",
          createdAt: 1,
          lastActiveAt: 2,
        },
        "thread:target": {
          sessionKey: "thread:target",
          spaceId: "beta",
          principalId: "channel:whatsapp:default:+200",
          createdAt: 1,
          lastActiveAt: 2,
        },
      },
    });

    const authz = authorizeCrossSpaceSessionOperation({
      gw,
      operation: "session-send",
      sourceSessionKey: "thread:source",
      targetSessionKey: "thread:target",
    });

    expect(authz.ok).toBe(false);
    expect(authz.reason).toContain("cross-space session-send denied");
  });

  it("allows cross-space operation for owner", () => {
    const ownerPrincipalId = "channel:whatsapp:default:+100";
    const gw = buildGatewayStub({
      sessionRegistry: {
        "thread:source": {
          sessionKey: "thread:source",
          spaceId: "alpha",
          principalId: ownerPrincipalId,
          createdAt: 1,
          lastActiveAt: 2,
        },
        "thread:target": {
          sessionKey: "thread:target",
          spaceId: "beta",
          principalId: "channel:whatsapp:default:+200",
          createdAt: 1,
          lastActiveAt: 2,
        },
      },
      owners: new Set([ownerPrincipalId]),
    });

    const authz = authorizeCrossSpaceSessionOperation({
      gw,
      operation: "session-send",
      sourceSessionKey: "thread:source",
      targetSessionKey: "thread:target",
    });

    expect(authz.ok).toBe(true);
  });

  it("resolves target space by thread metadata", () => {
    const gw = buildGatewayStub({
      sessionRegistry: {
        "thread:source": {
          sessionKey: "thread:source",
          spaceId: "alpha",
          principalId: "channel:whatsapp:default:+100",
          createdAt: 1,
          lastActiveAt: 2,
        },
      },
      threadMeta: {
        "01THREAD": {
          spaceId: "beta",
        },
      },
    });

    const authz = authorizeCrossSpaceSessionOperation({
      gw,
      operation: "session-send",
      sourceSessionKey: "thread:source",
      targetThreadId: "01THREAD",
    });

    expect(authz.ok).toBe(false);
    expect(authz.targetSpaceId).toBe("beta");
  });
});
