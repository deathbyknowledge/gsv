import { describe, expect, it } from "vitest";
import {
  activateManagedTelegramClaimState,
  bindManagedTelegramPeerIdentity,
  deleteManagedTelegramInstallationRouteState,
  issueManagedTelegramClaim,
  recoverManagedTelegramInstallationRouteState,
  suspendManagedTelegramInstallationRouteState,
  suspendManagedTelegramClaimState,
  type ManagedTelegramPeerState,
} from "./managed-peer-state";

const OLD_ROUTE = {
  installationId: "inst_old",
  localUid: 1000,
  canonicalOrigin: "https://old.gsv.space",
  linkedAt: 100,
};
const NEW_ROUTE = {
  installationId: "inst_new",
  localUid: 2000,
  canonicalOrigin: "https://new.gsv.space",
  linkedAt: 200,
};

describe("managed Telegram peer state", () => {
  it("binds one Durable Object permanently to one private peer", () => {
    const state = bindManagedTelegramPeerIdentity(undefined, inbound("123"));
    expect(state.actorId).toBe("123");
    expect(() => bindManagedTelegramPeerIdentity(state, inbound("456")))
      .toThrow("identity mismatch");
  });

  it("suspends the old route before a relink and replays one operation", () => {
    const initial: ManagedTelegramPeerState = {
      ...bindManagedTelegramPeerIdentity(undefined, inbound("123")),
      activeRoute: OLD_ROUTE,
    };
    const issued = issueManagedTelegramClaim(initial, {
      claimId: "claim_1234567890abcdef",
      now: 1_000,
      expiresAt: 11_000,
      suspendActiveRoute: false,
    });
    expect(issued.state.activeRoute).toEqual(OLD_ROUTE);

    const suspended = suspendManagedTelegramClaimState(issued.state, {
      claimId: issued.claim.claimId,
      expiresAt: issued.claim.expiresAt,
      operationId: "operation_1",
      now: 2_000,
    });
    expect(suspended.state.activeRoute).toBeUndefined();
    expect(suspended.previousRoute).toEqual(OLD_ROUTE);
    expect(suspendManagedTelegramClaimState(suspended.state, {
      claimId: issued.claim.claimId,
      expiresAt: issued.claim.expiresAt,
      operationId: "operation_1",
      now: 20_000,
    })).toEqual(suspended);
    expect(() => suspendManagedTelegramClaimState(suspended.state, {
      claimId: issued.claim.claimId,
      expiresAt: issued.claim.expiresAt,
      operationId: "operation_2",
      now: 2_000,
    })).toThrow("another operation");
  });

  it("activates only the operation that owns the suspension", () => {
    const initial: ManagedTelegramPeerState = {
      ...bindManagedTelegramPeerIdentity(undefined, inbound("123")),
      activeRoute: OLD_ROUTE,
    };
    const issued = issueManagedTelegramClaim(initial, {
      claimId: "claim_1234567890abcdef",
      now: 1_000,
      expiresAt: 11_000,
      suspendActiveRoute: false,
    });
    const suspended = suspendManagedTelegramClaimState(issued.state, {
      claimId: issued.claim.claimId,
      expiresAt: issued.claim.expiresAt,
      operationId: "operation_1",
      now: 2_000,
    });

    expect(() => activateManagedTelegramClaimState(suspended.state, {
      claimId: issued.claim.claimId,
      expiresAt: issued.claim.expiresAt,
      operationId: "operation_2",
      route: NEW_ROUTE,
    })).toThrow("not suspended by this operation");

    const activated = activateManagedTelegramClaimState(suspended.state, {
      claimId: issued.claim.claimId,
      expiresAt: issued.claim.expiresAt,
      operationId: "operation_1",
      route: NEW_ROUTE,
    });
    expect(activated.state.activeRoute).toEqual(NEW_ROUTE);
    expect(activateManagedTelegramClaimState(activated.state, {
      claimId: issued.claim.claimId,
      expiresAt: issued.claim.expiresAt,
      operationId: "operation_1",
      route: NEW_ROUTE,
    })).toEqual(activated);
    expect(() => activateManagedTelegramClaimState(activated.state, {
      claimId: issued.claim.claimId,
      expiresAt: issued.claim.expiresAt,
      operationId: "operation_1",
      route: { ...NEW_ROUTE, installationId: "inst_other" },
    })).toThrow("different input");
  });

  it("suspends an installation route and restores it only when still unclaimed", () => {
    const initial: ManagedTelegramPeerState = {
      ...bindManagedTelegramPeerIdentity(undefined, inbound("123")),
      activeRoute: OLD_ROUTE,
    };
    const suspended = suspendManagedTelegramInstallationRouteState(initial, {
      installationId: OLD_ROUTE.installationId,
      operationId: "deletion_1",
    });
    expect(suspended.suspended).toBe(true);
    expect(suspended.state.activeRoute).toBeUndefined();

    const recovered = recoverManagedTelegramInstallationRouteState(suspended.state, {
      installationId: OLD_ROUTE.installationId,
      operationId: "deletion_1",
    });
    expect(recovered.recovered).toBe(true);
    expect(recovered.state.activeRoute).toEqual(OLD_ROUTE);

    const relinked = recoverManagedTelegramInstallationRouteState({
      ...suspended.state,
      activeRoute: NEW_ROUTE,
    }, {
      installationId: OLD_ROUTE.installationId,
      operationId: "deletion_1",
    });
    expect(relinked.recovered).toBe(false);
    expect(relinked.state.activeRoute).toEqual(NEW_ROUTE);
    expect(relinked.state.deletionSuspension).toBeUndefined();
  });

  it("scrubs every stale route reference during final deletion", () => {
    const state: ManagedTelegramPeerState = {
      ...bindManagedTelegramPeerIdentity(undefined, inbound("123")),
      deletionSuspension: {
        installationId: OLD_ROUTE.installationId,
        operationId: "deletion_1",
        previousRoute: OLD_ROUTE,
      },
      claim: {
        claimId: "claim_1234567890abcdef",
        expiresAt: 11_000,
        status: "used",
        previousRoute: OLD_ROUTE,
        activatedRoute: OLD_ROUTE,
      },
    };

    const deleted = deleteManagedTelegramInstallationRouteState(state, {
      installationId: OLD_ROUTE.installationId,
      operationId: "deletion_1",
    });
    expect(deleted.deleted).toBe(true);
    expect(deleted.state.activeRoute).toBeUndefined();
    expect(deleted.state.deletionSuspension).toBeUndefined();
    expect(deleted.state.claim).toBeUndefined();
  });
});

function inbound(peerId: string) {
  return {
    deliveryId: "update:1",
    messageId: "1",
    actorId: peerId,
    surfaceId: peerId,
    text: "hello",
    unsupportedContent: false,
  };
}
