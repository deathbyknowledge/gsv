import { describe, expect, it } from "vitest";
import type { SessionRegistryEntry } from "../protocol/session";
import type { Gateway } from "./do";
import { runRegistryBackfill, runRegistryRepair } from "./registry-maintenance";
import { GatewayRegistryStore } from "./registry-store";
import { stateIdFromLegacySessionKey } from "./thread-state";

function createMockGateway(params?: {
  sessionRegistry?: Record<string, SessionRegistryEntry>;
  defaultSpaceId?: string;
}) {
  const config: Record<string, unknown> = {
    spaces: {
      defaultSpaceId: params?.defaultSpaceId ?? "default",
    },
  };

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
  const sessionRegistry = params?.sessionRegistry ?? {};

  const gw = {
    sessionRegistry,
    threadRoutes: maps.threadRoutes,
    legacyThreadIndex: maps.legacyThreadIndex,
    registryStore,
    canonicalizeSessionKey(sessionKey: string) {
      return sessionKey.trim().toLowerCase();
    },
    getConfigPath(path: string): unknown {
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

describe("registry maintenance", () => {
  it("backfills legacy session entries into thread metadata and index", () => {
    const sessionKey = "agent:main:main";
    const { gw, maps } = createMockGateway({
      sessionRegistry: {
        [sessionKey]: {
          sessionKey,
          createdAt: 1000,
          lastActiveAt: 2000,
        },
      },
      defaultSpaceId: "home",
    });

    const result = runRegistryBackfill(gw, { dryRun: false });
    expect(result.ok).toBe(true);
    expect(result.scanned).toBe(1);
    expect(result.createdThreadMeta).toBe(1);
    expect(result.updatedSessions).toBe(1);
    expect(result.addedLegacyIndex).toBe(1);

    const entry = gw.sessionRegistry[sessionKey];
    expect(entry.threadId).toBeTruthy();
    expect(entry.spaceId).toBe("home");
    expect(entry.stateId).toBe(stateIdFromLegacySessionKey(sessionKey));
    expect(entry.agentId).toBe("main");

    const threadId = entry.threadId!;
    expect(maps.threadMeta[threadId]).toMatchObject({
      stateId: stateIdFromLegacySessionKey(sessionKey),
      spaceId: "home",
      agentId: "main",
      legacy: true,
      legacySessionKey: sessionKey,
    });
    expect(maps.legacyThreadIndex[sessionKey]).toBe(threadId);
  });

  it("supports dry-run backfill without mutating registry state", () => {
    const sessionKey = "agent:main:main";
    const { gw, maps } = createMockGateway({
      sessionRegistry: {
        [sessionKey]: {
          sessionKey,
          createdAt: 1,
          lastActiveAt: 2,
        },
      },
    });

    const result = runRegistryBackfill(gw, { dryRun: true });
    expect(result.scanned).toBe(1);
    expect(result.migrated).toBe(1);
    expect(result.createdThreadMeta).toBe(1);
    expect(result.updatedSessions).toBe(1);
    expect(result.addedLegacyIndex).toBe(1);

    expect(gw.sessionRegistry[sessionKey].threadId).toBeUndefined();
    expect(Object.keys(maps.threadMeta)).toHaveLength(0);
    expect(Object.keys(maps.legacyThreadIndex)).toHaveLength(0);
  });

  it("repairs dangling routes and legacy index entries", () => {
    const sessionKey = "agent:main:main";
    const { gw, maps } = createMockGateway({
      sessionRegistry: {
        [sessionKey]: {
          sessionKey,
          threadId: "thread-1",
          stateId: "thread:thread-1",
          spaceId: "default",
          agentId: "main",
          createdAt: 100,
          lastActiveAt: 200,
        },
      },
    });

    maps.threadRoutes["route:good"] = {
      threadId: "thread-1",
      routeTuple: {
        v: 1,
        spaceId: "default",
        agentId: "main",
        threadMode: "per-user",
        hasActor: true,
        surfaceHash: "surface-a",
      },
      createdAt: 100,
    };
    maps.threadRoutes["route:bad"] = {
      threadId: "missing-thread",
      routeTuple: {
        v: 1,
        spaceId: "default",
        agentId: "main",
        threadMode: "per-user",
        hasActor: true,
        surfaceHash: "surface-b",
      },
      createdAt: 100,
    };
    maps.legacyThreadIndex["agent:main:main"] = "missing-thread";

    const result = runRegistryRepair(gw, { dryRun: false });
    expect(result.ok).toBe(true);
    expect(result.scannedSessions).toBe(1);
    expect(result.createdThreadMeta).toBe(1);
    expect(result.removedDanglingRoutes).toBe(1);
    expect(result.removedDanglingLegacyIndex).toBe(1);

    expect(maps.threadMeta["thread-1"]).toMatchObject({
      stateId: "thread:thread-1",
      spaceId: "default",
      agentId: "main",
      legacy: false,
    });
    expect(maps.threadRoutes["route:good"]).toBeDefined();
    expect(maps.threadRoutes["route:bad"]).toBeUndefined();
    expect(maps.legacyThreadIndex["agent:main:main"]).toBeUndefined();
  });
});
