import { describe, expect, it } from "vitest";
import {
  bindManagedSlackDm,
  bindManagedSlackPeer,
  managedSlackPairingCandidate,
  managedSlackPeerAllowsSurface,
} from "./managed-peer-state";

describe("managed Slack peer state", () => {
  it("keeps an actor-scoped route separate from observed surface authorization", () => {
    const state = bindManagedSlackDm(bindManagedSlackPeer(undefined, {
      accountId: `workspace:${"a".repeat(43)}`,
      teamId: "TWORK123",
      teamName: "Acme",
      botUserId: "UGSVBOT1",
      workspaceGeneration: "workspace-generation",
      inbound: {
        deliveryId: "event:EvALICE01",
        eventId: "EvALICE01",
        teamId: "TWORK123",
        messageId: "1700000000.000100",
        actorId: "UALICE01",
        surface: {
          kind: "channel",
          id: "CGENERAL1",
          threadId: "1700000000.000100",
        },
        text: "help",
        wasMentioned: true,
      },
    }), "DALICE01");

    expect(managedSlackPairingCandidate(state, 123)).toMatchObject({
      accountId: `workspace:${"a".repeat(43)}`,
      actorId: "UALICE01",
      surfaceId: "DALICE01",
      routeScope: "actor",
    });
    expect(managedSlackPeerAllowsSurface(state, {
      kind: "channel",
      id: "CGENERAL1",
      threadId: "1700000000.000100",
    })).toBe(true);
    expect(managedSlackPeerAllowsSurface(state, {
      kind: "channel",
      id: "CGENERAL1",
      threadId: "1700000002.000300",
    })).toBe(false);
    expect(managedSlackPeerAllowsSurface(state, {
      kind: "dm",
      id: "DALICE01",
      threadId: "1700000002.000300",
    })).toBe(true);
  });
});
