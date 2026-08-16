import type {
  AdapterPairingCandidate,
  AdapterPairingPreparation,
  AdapterPairingRoute,
} from "./types";
import type { ManagedTelegramInbound } from "./managed-update";

export type ManagedTelegramPeerRoute = AdapterPairingRoute & {
  canonicalOrigin: string;
  linkedAt: number;
};

export type ManagedTelegramPairingState = {
  claimId: string;
  code: string;
  expiresAt: number;
  status: "pending" | "prepared" | "active" | "finalized";
  operationId?: string;
  preparedRoute?: ManagedTelegramPeerRoute;
  previousRoute?: ManagedTelegramPeerRoute;
};

export type ManagedTelegramPeerState = {
  version: 1;
  actorId: string;
  surfaceId: string;
  actorName?: string;
  actorHandle?: string;
  activeRoute?: ManagedTelegramPeerRoute;
  pairing?: ManagedTelegramPairingState;
  lastDisconnect?: {
    operationId: string;
    route: ManagedTelegramPeerRoute;
  };
};

export function bindManagedTelegramPeerIdentity(
  state: ManagedTelegramPeerState | undefined,
  inbound: ManagedTelegramInbound,
): ManagedTelegramPeerState {
  if (state && (state.actorId !== inbound.actorId || state.surfaceId !== inbound.surfaceId)) {
    throw new Error("Managed Telegram peer identity mismatch");
  }
  return {
    version: 1,
    actorId: inbound.actorId,
    surfaceId: inbound.surfaceId,
    ...(inbound.actorName || state?.actorName
      ? { actorName: inbound.actorName ?? state?.actorName }
      : {}),
    ...(inbound.actorHandle || state?.actorHandle
      ? { actorHandle: inbound.actorHandle ?? state?.actorHandle }
      : {}),
    ...(state?.activeRoute ? { activeRoute: state.activeRoute } : {}),
    ...(state?.pairing ? { pairing: state.pairing } : {}),
    ...(state?.lastDisconnect ? { lastDisconnect: state.lastDisconnect } : {}),
  };
}

export function pairingCandidate(
  state: ManagedTelegramPeerState,
  expiresAt: number,
): AdapterPairingCandidate {
  return {
    accountId: "managed",
    actorId: state.actorId,
    surfaceId: state.surfaceId,
    ...(state.actorName ? { actorName: state.actorName } : {}),
    ...(state.actorHandle ? { actorHandle: state.actorHandle } : {}),
    expiresAt,
    linked: Boolean(state.activeRoute),
  };
}

export function prepareManagedTelegramPairing(
  state: ManagedTelegramPeerState,
  input: {
    claimId: string;
    expiresAt: number;
    operationId: string;
    route: ManagedTelegramPeerRoute;
    now: number;
  },
): { state: ManagedTelegramPeerState; preparation: AdapterPairingPreparation } {
  const pairing = requirePairing(state, input.claimId, input.expiresAt);
  if (pairing.status !== "pending") {
    assertOperationReplay(pairing, input.operationId, input.route);
    return { state, preparation: preparation(state, pairing) };
  }
  if (pairing.expiresAt <= input.now) throw new Error("Pairing code expired");
  if (
    state.activeRoute?.installationId === input.route.installationId
    && state.activeRoute.localUid !== input.route.localUid
  ) {
    throw new Error("Disconnect this Telegram identity before linking it to another user here");
  }
  const prepared: ManagedTelegramPairingState = {
    ...pairing,
    status: "prepared",
    operationId: input.operationId,
    preparedRoute: input.route,
    ...(state.activeRoute ? { previousRoute: state.activeRoute } : {}),
  };
  const next = { ...state, pairing: prepared };
  return { state: next, preparation: preparation(next, prepared) };
}

export function activateManagedTelegramPairing(
  state: ManagedTelegramPeerState,
  input: {
    claimId: string;
    expiresAt: number;
    operationId: string;
    route: ManagedTelegramPeerRoute;
  },
): { state: ManagedTelegramPeerState; preparation: AdapterPairingPreparation } {
  const pairing = requirePairing(state, input.claimId, input.expiresAt);
  assertOperationReplay(pairing, input.operationId, input.route);
  if (pairing.status === "pending") throw new Error("Pairing code was not prepared");
  if (pairing.status === "active" || pairing.status === "finalized") {
    return { state, preparation: preparation(state, pairing) };
  }
  const active: ManagedTelegramPairingState = { ...pairing, status: "active" };
  const next = { ...state, activeRoute: input.route, pairing: active };
  return { state: next, preparation: preparation(next, active) };
}

export function finalizeManagedTelegramPairing(
  state: ManagedTelegramPeerState,
  input: {
    claimId: string;
    expiresAt: number;
    operationId: string;
    route: ManagedTelegramPeerRoute;
  },
): { state: ManagedTelegramPeerState; preparation: AdapterPairingPreparation; changed: boolean } {
  const pairing = requirePairing(state, input.claimId, input.expiresAt);
  assertOperationReplay(pairing, input.operationId, input.route);
  if (pairing.status !== "active" && pairing.status !== "finalized") {
    throw new Error("Pairing code is not active");
  }
  if (pairing.status === "finalized") {
    return { state, preparation: preparation(state, pairing), changed: false };
  }
  const finalized: ManagedTelegramPairingState = { ...pairing, status: "finalized" };
  const next = { ...state, pairing: finalized };
  return { state: next, preparation: preparation(next, finalized), changed: true };
}

export function disconnectManagedTelegramPeer(
  state: ManagedTelegramPeerState,
  input: { operationId: string; route: AdapterPairingRoute },
): { state: ManagedTelegramPeerState; disconnected: boolean } {
  const active = state.activeRoute;
  if (!active) {
    const replay = state.lastDisconnect;
    if (replay?.operationId === input.operationId && sameRoute(replay.route, input.route)) {
      return { state, disconnected: true };
    }
    return { state, disconnected: false };
  }
  if (!sameRoute(active, input.route)) {
    throw new Error("Managed Telegram route changed before disconnect");
  }
  const next = {
    ...state,
    lastDisconnect: { operationId: input.operationId, route: active },
  };
  delete next.activeRoute;
  delete next.pairing;
  return { state: next, disconnected: true };
}

function preparation(
  state: ManagedTelegramPeerState,
  pairing: ManagedTelegramPairingState,
): AdapterPairingPreparation {
  if (!pairing.preparedRoute) throw new Error("Pairing route is unavailable");
  return {
    candidate: pairingCandidate(state, pairing.expiresAt),
    route: pairing.preparedRoute,
    ...(pairing.previousRoute ? { previousRoute: pairing.previousRoute } : {}),
  };
}

function requirePairing(
  state: ManagedTelegramPeerState,
  claimId: string,
  expiresAt: number,
): ManagedTelegramPairingState {
  const pairing = state.pairing;
  if (!pairing || pairing.claimId !== claimId || pairing.expiresAt !== expiresAt) {
    throw new Error("Pairing code is invalid");
  }
  return pairing;
}

function assertOperationReplay(
  pairing: ManagedTelegramPairingState,
  operationId: string,
  route: AdapterPairingRoute,
): void {
  if (
    pairing.operationId !== operationId
    || !pairing.preparedRoute
    || !sameRoute(pairing.preparedRoute, route)
  ) {
    throw new Error("Pairing code is owned by another operation");
  }
}

function sameRoute(left: AdapterPairingRoute, right: AdapterPairingRoute): boolean {
  return left.installationId === right.installationId
    && left.localUid === right.localUid
    && left.generation === right.generation;
}
