import { describe, expect, it } from "vitest";

import {
  activateManagedTelegramPairing,
  disconnectManagedTelegramPeer,
  finalizeManagedTelegramPairing,
  prepareManagedTelegramPairing,
  type ManagedTelegramPeerRoute,
  type ManagedTelegramPeerState,
} from "./managed-peer-state";

const previousRoute: ManagedTelegramPeerRoute = {
  installationId: "installation-old",
  localUid: 1000,
  generation: "generation-old",
  canonicalOrigin: "https://old.gsv.space",
  linkedAt: 1,
};
const nextRoute: ManagedTelegramPeerRoute = {
  installationId: "installation-new",
  localUid: 1000,
  generation: "generation-new",
  canonicalOrigin: "https://new.gsv.space",
  linkedAt: 2,
};

function pendingState(activeRoute = previousRoute): ManagedTelegramPeerState {
  return {
    version: 1,
    actorId: "12345",
    surfaceId: "12345",
    actorName: "Hank",
    activeRoute,
    pairing: {
      claimId: "claim-1",
      code: "ABCDEFGHJKLM",
      expiresAt: 10_000,
      status: "pending",
    },
  };
}

describe("managed Telegram peer state", () => {
  it("keeps the old route live until explicit confirmation activates the new one", () => {
    const prepared = prepareManagedTelegramPairing(pendingState(), {
      claimId: "claim-1",
      expiresAt: 10_000,
      operationId: "operation-1",
      route: nextRoute,
      now: 1_000,
    });

    expect(prepared.state.activeRoute).toEqual(previousRoute);
    expect(prepared.preparation.previousRoute).toEqual(previousRoute);
    expect(prepared.preparation.route).toEqual(nextRoute);

    const activated = activateManagedTelegramPairing(prepared.state, {
      claimId: "claim-1",
      expiresAt: 10_000,
      operationId: "operation-1",
      route: nextRoute,
    });
    expect(activated.state.activeRoute).toEqual(nextRoute);
    expect(activated.preparation.previousRoute).toEqual(previousRoute);

    const finalized = finalizeManagedTelegramPairing(activated.state, {
      claimId: "claim-1",
      expiresAt: 10_000,
      operationId: "operation-1",
      route: nextRoute,
    });
    expect(finalized.changed).toBe(true);
    expect(finalized.state.pairing?.status).toBe("finalized");
    expect(finalizeManagedTelegramPairing(finalized.state, {
      claimId: "claim-1",
      expiresAt: 10_000,
      operationId: "operation-1",
      route: nextRoute,
    }).changed).toBe(false);
  });

  it("does not let a replay change the target or route generation", () => {
    const prepared = prepareManagedTelegramPairing(pendingState(), {
      claimId: "claim-1",
      expiresAt: 10_000,
      operationId: "operation-1",
      route: nextRoute,
      now: 1_000,
    });
    expect(() => prepareManagedTelegramPairing(prepared.state, {
      claimId: "claim-1",
      expiresAt: 10_000,
      operationId: "operation-2",
      route: { ...nextRoute, generation: "different" },
      now: 1_000,
    })).toThrow("owned by another operation");
  });

  it("requires disconnect before moving an identity between users in one GSV", () => {
    expect(() => prepareManagedTelegramPairing(pendingState({
      ...previousRoute,
      installationId: "installation-new",
      localUid: 2000,
    }), {
      claimId: "claim-1",
      expiresAt: 10_000,
      operationId: "operation-1",
      route: nextRoute,
      now: 1_000,
    })).toThrow("Disconnect this Telegram identity");
  });

  it("fences disconnects by the exact active generation and replays them safely", () => {
    const state = pendingState(nextRoute);
    expect(() => disconnectManagedTelegramPeer(state, {
      operationId: "disconnect-1",
      route: { ...nextRoute, generation: "stale" },
    })).toThrow("route changed");

    const disconnected = disconnectManagedTelegramPeer(state, {
      operationId: "disconnect-1",
      route: nextRoute,
    });
    expect(disconnected.disconnected).toBe(true);
    expect(disconnected.state.activeRoute).toBeUndefined();
    expect(disconnected.state.pairing).toBeUndefined();
    expect(disconnectManagedTelegramPeer(disconnected.state, {
      operationId: "disconnect-1",
      route: nextRoute,
    }).disconnected).toBe(true);
  });
});
