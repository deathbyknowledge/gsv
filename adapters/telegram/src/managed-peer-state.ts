import type {
  ManagedTelegramClaim,
  ManagedTelegramPeerRoute,
} from "../../../packages/gsv/src/protocol/managed.js";
import type { ManagedTelegramInbound } from "./managed-update";

export type ManagedTelegramPeerClaimState = {
  claimId: string;
  expiresAt: number;
  status: "pending" | "suspended" | "used";
  previousRoute?: ManagedTelegramPeerRoute;
  operationId?: string;
  activatedRoute?: ManagedTelegramPeerRoute;
};

export type ManagedTelegramPeerState = {
  version: 1;
  actorId: string;
  surfaceId: string;
  actorName?: string;
  actorHandle?: string;
  activeRoute?: ManagedTelegramPeerRoute;
  deletionSuspension?: {
    installationId: string;
    operationId: string;
    previousRoute: ManagedTelegramPeerRoute;
  };
  claim?: ManagedTelegramPeerClaimState;
};

export function bindManagedTelegramPeerIdentity(
  state: ManagedTelegramPeerState | undefined,
  inbound: ManagedTelegramInbound,
): ManagedTelegramPeerState {
  if (state && (
    state.actorId !== inbound.actorId
    || state.surfaceId !== inbound.surfaceId
  )) {
    throw new Error("Managed Telegram peer identity mismatch");
  }
  const actorName = inbound.actorName ?? state?.actorName;
  const actorHandle = inbound.actorHandle ?? state?.actorHandle;
  return {
    version: 1,
    actorId: inbound.actorId,
    surfaceId: inbound.surfaceId,
    ...(actorName ? { actorName } : {}),
    ...(actorHandle ? { actorHandle } : {}),
    ...(state?.activeRoute ? { activeRoute: state.activeRoute } : {}),
    ...(state?.deletionSuspension
      ? { deletionSuspension: state.deletionSuspension }
      : {}),
    ...(state?.claim ? { claim: state.claim } : {}),
  };
}

export function suspendManagedTelegramInstallationRouteState(
  state: ManagedTelegramPeerState,
  input: { installationId: string; operationId: string },
): { state: ManagedTelegramPeerState; suspended: boolean } {
  const existing = state.deletionSuspension;
  if (existing) {
    if (
      existing.installationId === input.installationId
      && existing.operationId === input.operationId
    ) {
      return { state, suspended: true };
    }
    if (existing.installationId === input.installationId) {
      throw new Error("Managed Telegram route is suspended by another deletion");
    }
  }
  if (state.activeRoute?.installationId !== input.installationId) {
    return { state, suspended: false };
  }
  const nextState: ManagedTelegramPeerState = {
    ...state,
    deletionSuspension: {
      installationId: input.installationId,
      operationId: input.operationId,
      previousRoute: state.activeRoute,
    },
  };
  delete nextState.activeRoute;
  return { state: nextState, suspended: true };
}

export function recoverManagedTelegramInstallationRouteState(
  state: ManagedTelegramPeerState,
  input: { installationId: string; operationId: string },
): { state: ManagedTelegramPeerState; recovered: boolean } {
  const suspension = state.deletionSuspension;
  if (!suspension) return { state, recovered: false };
  if (
    suspension.installationId !== input.installationId
    || suspension.operationId !== input.operationId
  ) {
    throw new Error("Managed Telegram route suspension does not match");
  }
  const nextState: ManagedTelegramPeerState = {
    ...state,
    ...(!state.activeRoute ? { activeRoute: suspension.previousRoute } : {}),
  };
  delete nextState.deletionSuspension;
  return { state: nextState, recovered: !state.activeRoute };
}

export function deleteManagedTelegramInstallationRouteState(
  state: ManagedTelegramPeerState,
  input: { installationId: string; operationId: string },
): { state: ManagedTelegramPeerState; deleted: boolean } {
  const suspension = state.deletionSuspension;
  if (
    suspension?.installationId === input.installationId
    && suspension.operationId !== input.operationId
  ) {
    throw new Error("Managed Telegram route suspension does not match");
  }
  const activeMatches = state.activeRoute?.installationId === input.installationId;
  const suspensionMatches = suspension?.installationId === input.installationId;
  const claimMatches = state.claim?.previousRoute?.installationId === input.installationId
    || state.claim?.activatedRoute?.installationId === input.installationId;
  if (!activeMatches && !suspensionMatches && !claimMatches) {
    return { state, deleted: false };
  }
  const nextState = { ...state };
  if (activeMatches) delete nextState.activeRoute;
  if (suspensionMatches) delete nextState.deletionSuspension;
  if (claimMatches) delete nextState.claim;
  return { state: nextState, deleted: true };
}

export function issueManagedTelegramClaim(
  state: ManagedTelegramPeerState,
  input: {
    claimId: string;
    now: number;
    expiresAt: number;
    suspendActiveRoute: boolean;
  },
): { state: ManagedTelegramPeerState; claim: ManagedTelegramPeerClaimState } {
  const existing = state.claim;
  const reusable = existing
    && (
      existing.status === "suspended"
      || (existing.status === "pending" && existing.expiresAt > input.now)
    );
  const claim: ManagedTelegramPeerClaimState = reusable
    ? existing
    : {
        claimId: input.claimId,
        expiresAt: input.expiresAt,
        status: "pending",
        ...(state.activeRoute ?? existing?.previousRoute
          ? { previousRoute: state.activeRoute ?? existing?.previousRoute }
          : {}),
      };
  const shouldSuspend = input.suspendActiveRoute && claim.status !== "used";
  const suspendedClaim: ManagedTelegramPeerClaimState = shouldSuspend
    ? {
        ...claim,
        ...(state.activeRoute ?? claim.previousRoute
          ? { previousRoute: state.activeRoute ?? claim.previousRoute }
          : {}),
      }
    : claim;
  const nextState = { ...state, claim: suspendedClaim };
  if (shouldSuspend) delete nextState.activeRoute;
  return {
    state: nextState,
    claim: suspendedClaim,
  };
}

export function suspendManagedTelegramClaimState(
  state: ManagedTelegramPeerState,
  input: {
    claimId: string;
    expiresAt: number;
    operationId: string;
    now: number;
  },
): {
  state: ManagedTelegramPeerState;
  claim: ManagedTelegramPeerClaimState;
  previousRoute?: ManagedTelegramPeerRoute;
} {
  const claim = matchingClaim(state, input.claimId, input.expiresAt);
  if (claim.status === "used") {
    throw new Error("Managed Telegram claim was already used");
  }
  if (claim.status === "suspended") {
    if (claim.operationId !== input.operationId) {
      throw new Error("Managed Telegram claim is owned by another operation");
    }
    return {
      state,
      claim,
      ...(claim.previousRoute ? { previousRoute: claim.previousRoute } : {}),
    };
  }
  if (claim.expiresAt <= input.now) {
    throw new Error("Managed Telegram claim expired");
  }

  const previousRoute = state.activeRoute ?? claim.previousRoute;
  const suspended: ManagedTelegramPeerClaimState = {
    ...claim,
    status: "suspended",
    operationId: input.operationId,
    ...(previousRoute ? { previousRoute } : {}),
  };
  const nextState = { ...state, claim: suspended };
  delete nextState.activeRoute;
  return {
    state: nextState,
    claim: suspended,
    ...(previousRoute ? { previousRoute } : {}),
  };
}

export function activateManagedTelegramClaimState(
  state: ManagedTelegramPeerState,
  input: {
    claimId: string;
    expiresAt: number;
    operationId: string;
    route: ManagedTelegramPeerRoute;
  },
): { state: ManagedTelegramPeerState; claim: ManagedTelegramPeerClaimState } {
  const claim = matchingClaim(state, input.claimId, input.expiresAt);
  if (claim.status === "used") {
    if (
      claim.operationId !== input.operationId
      || !claim.activatedRoute
      || !sameRoute(claim.activatedRoute, input.route)
    ) {
      throw new Error("Managed Telegram claim was already used with different input");
    }
    return { state, claim };
  }
  if (claim.status !== "suspended" || claim.operationId !== input.operationId) {
    throw new Error("Managed Telegram claim is not suspended by this operation");
  }

  const used: ManagedTelegramPeerClaimState = {
    ...claim,
    status: "used",
    activatedRoute: input.route,
  };
  return {
    state: {
      ...state,
      activeRoute: input.route,
      claim: used,
    },
    claim: used,
  };
}

export function publicManagedTelegramClaim(
  state: ManagedTelegramPeerState,
  claim: ManagedTelegramPeerClaimState,
): ManagedTelegramClaim {
  const activeRoute = state.activeRoute ?? claim.previousRoute;
  return {
    claimId: claim.claimId,
    actorId: state.actorId,
    surfaceId: state.surfaceId,
    ...(state.actorName ? { actorName: state.actorName } : {}),
    ...(state.actorHandle ? { actorHandle: state.actorHandle } : {}),
    expiresAt: claim.expiresAt,
    ...(activeRoute ? { activeRoute } : {}),
  };
}

function matchingClaim(
  state: ManagedTelegramPeerState,
  claimId: string,
  expiresAt: number,
): ManagedTelegramPeerClaimState {
  const claim = state.claim;
  if (
    !claim
    || claim.claimId !== claimId
    || claim.expiresAt !== expiresAt
  ) {
    throw new Error("Managed Telegram claim is invalid");
  }
  return claim;
}

function sameRoute(
  left: ManagedTelegramPeerRoute,
  right: ManagedTelegramPeerRoute,
): boolean {
  return left.installationId === right.installationId
    && left.localUid === right.localUid
    && left.canonicalOrigin === right.canonicalOrigin
    && left.linkedAt === right.linkedAt;
}
