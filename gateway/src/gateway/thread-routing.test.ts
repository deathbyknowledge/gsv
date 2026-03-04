import { describe, expect, it } from "vitest";
import { mergeConfig } from "../config";
import { DEFAULT_CONFIG } from "../config/defaults";
import type { ChannelInboundParams } from "../protocol/channel";
import type { SessionRegistryEntry } from "../protocol/session";
import type { Gateway } from "./do";
import { GatewayRegistryStore } from "./registry-store";
import { resolveInboundThreadRoute } from "./thread-routing";
import { stateIdFromLegacySessionKey } from "./thread-state";

function principalIdFor(
  channel: string,
  accountId: string,
  senderId: string,
): string {
  return `channel:${channel.trim().toLowerCase()}:${accountId.trim().toLowerCase()}:${senderId.trim().toLowerCase()}`;
}

function createInbound(params: {
  channel: string;
  accountId?: string;
  peerKind: "dm" | "group";
  peerId: string;
  senderId?: string;
  text?: string;
  messageId?: string;
}): ChannelInboundParams {
  return {
    channel: params.channel,
    accountId: params.accountId ?? "default",
    peer: {
      kind: params.peerKind,
      id: params.peerId,
      name: params.peerId,
    },
    sender: params.senderId
      ? {
          id: params.senderId,
          name: params.senderId,
        }
      : undefined,
    message: {
      id: params.messageId ?? crypto.randomUUID(),
      text: params.text ?? "hello",
    },
  };
}

function createMockGateway(configOverrides?: Record<string, unknown>) {
  const config = mergeConfig(DEFAULT_CONFIG, configOverrides as any) as Record<
    string,
    unknown
  >;

  const maps = {
    principalProfiles: {},
    spaceMembers: {},
    conversationBindings: {},
    threadRoutes: {},
    threadMeta: {},
    legacyThreadIndex: {},
    invites: {},
  };
  const registryStore = new GatewayRegistryStore(maps);
  const sessionRegistry: Record<string, SessionRegistryEntry> = {};
  const pendingPairs: Record<string, unknown> = {};

  const gw = {
    registryStore,
    sessionRegistry,
    pendingPairs,
    getFullConfig() {
      return config;
    },
    getConfigPath(path: string) {
      const parts = path.split(".");
      let current: unknown = config;
      for (const part of parts) {
        if (!current || typeof current !== "object") {
          return undefined;
        }
        current = (current as Record<string, unknown>)[part];
      }
      return current;
    },
  } as unknown as Gateway;

  return { gw, maps };
}

describe("resolveInboundThreadRoute", () => {
  it("imports legacy session entries without forking state identity", async () => {
    const { gw, maps } = createMockGateway({
      spaces: { defaultSpaceId: "default" },
    });
    const principalId = principalIdFor("whatsapp", "default", "+15551230001");

    gw.registryStore.upsertPrincipalProfile(principalId, {
      homeSpaceId: "default",
      homeAgentId: "main",
      status: "bound",
    });
    gw.registryStore.setMember("default", principalId, "member");

    gw.sessionRegistry["agent:main:main"] = {
      sessionKey: "agent:main:main",
      threadId: "legacy-thread-1",
      createdAt: 100,
      lastActiveAt: 200,
    };

    const inbound = createInbound({
      channel: "whatsapp",
      peerKind: "dm",
      peerId: "+15551230001",
      senderId: "+15551230001",
    });

    const first = await resolveInboundThreadRoute(gw, inbound);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") {
      throw new Error("expected route resolution");
    }
    expect(first.threadId).toBe("legacy-thread-1");
    expect(first.stateDoName).toBe("agent:main:main");
    expect(first.stateId).toBe(stateIdFromLegacySessionKey("agent:main:main"));

    const second = await resolveInboundThreadRoute(gw, {
      ...inbound,
      message: { ...inbound.message, id: "msg-2" },
    });
    expect(second.status).toBe("ok");
    if (second.status !== "ok") {
      throw new Error("expected route resolution");
    }
    expect(second.threadId).toBe("legacy-thread-1");
    expect(second.stateDoName).toBe("agent:main:main");

    expect(maps.threadMeta["legacy-thread-1"]).toMatchObject({
      legacy: true,
      stateId: stateIdFromLegacySessionKey("agent:main:main"),
    });
    expect(maps.legacyThreadIndex["agent:main:main"]).toBe("legacy-thread-1");
    expect(Object.keys(maps.threadRoutes)).toHaveLength(1);
  });

  it("uses one shared thread for group-shared mode", async () => {
    const { gw } = createMockGateway({
      spaces: { defaultSpaceId: "default" },
    });
    const surfaceId = "channel:discord:default:group:guild-1";
    gw.registryStore.upsertConversationBinding(surfaceId, {
      spaceId: "team-space",
      agentId: "main",
      groupMode: "group-shared",
    });

    const alice = principalIdFor("discord", "default", "alice");
    const bob = principalIdFor("discord", "default", "bob");
    for (const principalId of [alice, bob]) {
      gw.registryStore.upsertPrincipalProfile(principalId, {
        homeSpaceId: "personal",
        homeAgentId: "main",
        status: "bound",
      });
      gw.registryStore.setMember("team-space", principalId, "member");
    }

    const aliceRoute = await resolveInboundThreadRoute(gw, createInbound({
      channel: "discord",
      peerKind: "group",
      peerId: "guild-1",
      senderId: "alice",
      messageId: "g1",
    }));
    const bobRoute = await resolveInboundThreadRoute(gw, createInbound({
      channel: "discord",
      peerKind: "group",
      peerId: "guild-1",
      senderId: "bob",
      messageId: "g2",
    }));

    expect(aliceRoute.status).toBe("ok");
    expect(bobRoute.status).toBe("ok");
    if (aliceRoute.status !== "ok" || bobRoute.status !== "ok") {
      throw new Error("expected route resolution");
    }
    expect(aliceRoute.threadMode).toBe("group-shared");
    expect(bobRoute.threadMode).toBe("group-shared");
    expect(aliceRoute.threadId).toBe(bobRoute.threadId);
  });

  it("splits threads by sender in per-user-in-group mode", async () => {
    const { gw } = createMockGateway({
      spaces: { defaultSpaceId: "default" },
    });
    const surfaceId = "channel:discord:default:group:guild-2";
    gw.registryStore.upsertConversationBinding(surfaceId, {
      spaceId: "team-space",
      agentId: "main",
      groupMode: "per-user-in-group",
    });

    const alice = principalIdFor("discord", "default", "alice");
    const bob = principalIdFor("discord", "default", "bob");
    for (const principalId of [alice, bob]) {
      gw.registryStore.upsertPrincipalProfile(principalId, {
        homeSpaceId: "personal",
        homeAgentId: "main",
        status: "bound",
      });
      gw.registryStore.setMember("team-space", principalId, "member");
    }

    const aliceRoute = await resolveInboundThreadRoute(gw, createInbound({
      channel: "discord",
      peerKind: "group",
      peerId: "guild-2",
      senderId: "alice",
      messageId: "u1",
    }));
    const bobRoute = await resolveInboundThreadRoute(gw, createInbound({
      channel: "discord",
      peerKind: "group",
      peerId: "guild-2",
      senderId: "bob",
      messageId: "u2",
    }));

    expect(aliceRoute.status).toBe("ok");
    expect(bobRoute.status).toBe("ok");
    if (aliceRoute.status !== "ok" || bobRoute.status !== "ok") {
      throw new Error("expected route resolution");
    }
    expect(aliceRoute.threadMode).toBe("per-user-in-group");
    expect(bobRoute.threadMode).toBe("per-user-in-group");
    expect(aliceRoute.threadId).not.toBe(bobRoute.threadId);
  });

  it("applies onboarding policies for unbound principals", async () => {
    const baseInbound = createInbound({
      channel: "whatsapp",
      peerKind: "dm",
      peerId: "+15550000001",
      senderId: "+15550000001",
      messageId: "onboard-1",
    });

    const blockedPolicies = new Set(["manual", "invite"]);
    const policyCases = [
      { policy: "manual", expectedRole: undefined },
      { policy: "invite", expectedRole: undefined },
      { policy: "auto-guest", expectedRole: "guest" },
      { policy: "auto-bind-default", expectedRole: "member" },
    ] as const;

    for (const testCase of policyCases) {
      const { gw } = createMockGateway({
        spaces: { defaultSpaceId: "default" },
        channels: {
          whatsapp: {
            ...DEFAULT_CONFIG.channels.whatsapp,
            principalBindingPolicy: testCase.policy,
          },
        },
      });

      const result = await resolveInboundThreadRoute(gw, {
        ...baseInbound,
        message: {
          ...baseInbound.message,
          id: `onboard-${testCase.policy}`,
        },
      });

      const principalId = principalIdFor("whatsapp", "default", "+15550000001");

      if (blockedPolicies.has(testCase.policy)) {
        expect(result.status).toBe("blocked");
        if (result.status !== "blocked") {
          throw new Error("expected blocked route");
        }
        expect(result.state).toBe("allowed_unbound");
        expect(result.reason).toBe("principal-unbound");
        expect(gw.registryStore.getPrincipalProfile(principalId)).toBeUndefined();
      } else {
        expect(result.status).toBe("ok");
        if (result.status !== "ok") {
          throw new Error("expected successful route");
        }
        const profile = gw.registryStore.getPrincipalProfile(principalId);
        expect(profile?.status).toBe("bound");
        expect(profile?.homeSpaceId).toBe("default");
        const role = gw.registryStore.getSpaceMembers("default")[principalId]?.role;
        expect(role).toBe(testCase.expectedRole);
      }
    }
  });
});
