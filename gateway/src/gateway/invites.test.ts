import { describe, expect, it } from "vitest";
import { claimInviteForPrincipal, createInvite } from "./invites";
import { GatewayRegistryStore } from "./registry-store";
import type { Gateway } from "./do";

function createMockGateway() {
  const config: Record<string, unknown> = {
    channels: {
      whatsapp: {
        dmPolicy: "pairing",
        allowFrom: [] as string[],
      },
    },
  };

  const registryStore = new GatewayRegistryStore({
    principalProfiles: {},
    spaceMembers: {},
    conversationBindings: {},
    threadRoutes: {},
    threadMeta: {},
    legacyThreadIndex: {},
    invites: {},
  });

  const gw = {
    registryStore,
    pendingPairs: {},
    getConfigPath(path: string) {
      const segments = path.split(".");
      let current: unknown = config;
      for (const segment of segments) {
        if (!current || typeof current !== "object") {
          return undefined;
        }
        current = (current as Record<string, unknown>)[segment];
      }
      return current;
    },
    setConfigPath(path: string, value: unknown) {
      const segments = path.split(".");
      let current = config;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        const next = current[segment];
        if (!next || typeof next !== "object") {
          current[segment] = {};
        }
        current = current[segment] as Record<string, unknown>;
      }
      current[segments[segments.length - 1]] = value;
    },
  } as unknown as Gateway;

  return { gw, config };
}

describe("invite helpers", () => {
  it("creates an active invite", () => {
    const { gw } = createMockGateway();

    const invite = createInvite(gw, {
      homeSpaceId: "Owner",
      role: "member",
    });

    expect(invite.status).toBe("active");
    expect(invite.code.length).toBeGreaterThanOrEqual(6);
    expect(invite.homeSpaceId).toBe("owner");
    expect(gw.registryStore.listInvites()[invite.inviteId]).toBeDefined();
  });

  it("claims invite and binds principal membership", () => {
    const { gw, config } = createMockGateway();

    const invite = createInvite(gw, {
      code: "join-1234",
      homeSpaceId: "household",
      role: "guest",
    });

    gw.pendingPairs["whatsapp:+15551234567"] = {
      channel: "whatsapp",
      senderId: "+15551234567",
      requestedAt: Date.now(),
    };

    const claimed = claimInviteForPrincipal(gw, {
      code: invite.code,
      principalId: "channel:whatsapp:default:+15551234567",
      channel: "whatsapp",
      senderId: "+15551234567",
    });

    expect(claimed.ok).toBe(true);
    if (!claimed.ok) {
      throw new Error("expected successful claim");
    }

    expect(claimed.homeSpaceId).toBe("household");
    expect(gw.registryStore.getPrincipalProfile(claimed.principalId)?.status).toBe(
      "bound",
    );
    expect(gw.registryStore.getSpaceMembers("household")[claimed.principalId]?.role)
      .toBe("guest");
    expect(gw.pendingPairs["whatsapp:+15551234567"]).toBeUndefined();
    expect(
      (config.channels as { whatsapp: { allowFrom: string[] } }).whatsapp.allowFrom,
    ).toContain("+15551234567");
  });

  it("rejects claims when invite is principal-restricted", () => {
    const { gw } = createMockGateway();

    const invite = createInvite(gw, {
      code: "LOCKED123",
      homeSpaceId: "owner",
      principalId: "channel:whatsapp:default:+15550000001",
    });

    const claimed = claimInviteForPrincipal(gw, {
      code: invite.code,
      principalId: "channel:whatsapp:default:+15550000002",
    });

    expect(claimed.ok).toBe(false);
    if (claimed.ok) {
      throw new Error("expected claim to fail");
    }
    expect(claimed.reason).toBe("principal-mismatch");
  });
});
