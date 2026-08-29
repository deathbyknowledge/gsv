import type {
  AdapterPairingCandidate,
  AdapterPairingPreparation,
  AdapterPairingRoute,
  AdapterSurface,
} from "./types";
import type { SlackInbound } from "./slack-events";

export type ManagedSlackPeerRoute = AdapterPairingRoute & {
  canonicalOrigin: string;
  linkedAt: number;
};

export type ManagedSlackPairingState = {
  claimId: string;
  code: string;
  expiresAt: number;
  status: "pending" | "prepared" | "active" | "finalized";
  operationId?: string;
  preparedRoute?: ManagedSlackPeerRoute;
  previousRoute?: ManagedSlackPeerRoute;
};

export type ManagedSlackObservedSurface = AdapterSurface & {
  observedAt: number;
};

export type ManagedSlackPeerState = {
  version: 1;
  accountId: string;
  teamId: string;
  teamName?: string;
  botUserId: string;
  workspaceGeneration: string;
  actorId: string;
  actorName?: string;
  actorHandle?: string;
  dmSurfaceId?: string;
  observedSurfaces: ManagedSlackObservedSurface[];
  activeRoute?: ManagedSlackPeerRoute;
  pairing?: ManagedSlackPairingState;
  lastDisconnect?: {
    operationId: string;
    route: ManagedSlackPeerRoute;
  };
};

type PairingTransition = {
  state: ManagedSlackPeerState;
  preparation: AdapterPairingPreparation;
};
type FinalizeResult = PairingTransition & { changed: boolean };

const MAX_OBSERVED_SURFACES = 128;

export function bindManagedSlackPeer(
  state: ManagedSlackPeerState | undefined,
  input: {
    accountId: string;
    teamId: string;
    teamName?: string;
    botUserId: string;
    workspaceGeneration: string;
    inbound: SlackInbound;
  },
): ManagedSlackPeerState {
  if (state && (
    state.accountId !== input.accountId
    || state.teamId !== input.teamId
    || state.actorId !== input.inbound.actorId
  )) {
    throw new Error("Managed Slack peer identity mismatch");
  }
  const observedAt = Date.now();
  const observed = observeSurface(state?.observedSurfaces ?? [], input.inbound.surface, observedAt);
  return {
    version: 1,
    accountId: input.accountId,
    teamId: input.teamId,
    teamName: input.teamName ?? state?.teamName,
    botUserId: input.botUserId,
    workspaceGeneration: input.workspaceGeneration,
    actorId: input.inbound.actorId,
    actorName: state?.actorName,
    actorHandle: state?.actorHandle,
    dmSurfaceId: input.inbound.surface.kind === "dm"
      ? input.inbound.surface.id
      : state?.dmSurfaceId,
    observedSurfaces: observed,
    activeRoute: state?.activeRoute,
    pairing: state?.pairing,
    lastDisconnect: state?.lastDisconnect,
  };
}

export function bindManagedSlackDm(
  state: ManagedSlackPeerState,
  dmSurfaceId: string,
): ManagedSlackPeerState {
  return {
    ...state,
    dmSurfaceId,
    observedSurfaces: observeSurface(
      state.observedSurfaces,
      { kind: "dm", id: dmSurfaceId },
      Date.now(),
    ),
  };
}

export function managedSlackPairingCandidate(
  state: ManagedSlackPeerState,
  expiresAt: number,
): AdapterPairingCandidate {
  if (!state.dmSurfaceId) throw new Error("Slack direct message is unavailable for pairing");
  return {
    accountId: state.accountId,
    actorId: state.actorId,
    surfaceId: state.dmSurfaceId,
    routeScope: "actor",
    actorName: state.actorName,
    actorHandle: state.actorHandle,
    expiresAt,
    linked: Boolean(state.activeRoute),
  };
}

export function prepareManagedSlackPairing(
  state: ManagedSlackPeerState,
  input: {
    claimId: string;
    expiresAt: number;
    operationId: string;
    route: ManagedSlackPeerRoute;
    now: number;
  },
): PairingTransition {
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
    throw new Error("Disconnect this Slack identity before linking it to another user here");
  }
  const prepared: ManagedSlackPairingState = {
    ...pairing,
    status: "prepared",
    operationId: input.operationId,
    preparedRoute: input.route,
    previousRoute: state.activeRoute,
  };
  const next = { ...state, pairing: prepared };
  return { state: next, preparation: preparation(next, prepared) };
}

export function activateManagedSlackPairing(
  state: ManagedSlackPeerState,
  input: {
    claimId: string;
    expiresAt: number;
    operationId: string;
    route: ManagedSlackPeerRoute;
  },
): PairingTransition {
  const pairing = requirePairing(state, input.claimId, input.expiresAt);
  assertOperationReplay(pairing, input.operationId, input.route);
  if (pairing.status === "pending") throw new Error("Pairing code was not prepared");
  if (pairing.status === "active" || pairing.status === "finalized") {
    return { state, preparation: preparation(state, pairing) };
  }
  const active = { ...pairing, status: "active" as const };
  const next = { ...state, activeRoute: input.route, pairing: active };
  return { state: next, preparation: preparation(next, active) };
}

export function finalizeManagedSlackPairing(
  state: ManagedSlackPeerState,
  input: {
    claimId: string;
    expiresAt: number;
    operationId: string;
    route: ManagedSlackPeerRoute;
  },
): FinalizeResult {
  const pairing = requirePairing(state, input.claimId, input.expiresAt);
  assertOperationReplay(pairing, input.operationId, input.route);
  if (pairing.status !== "active" && pairing.status !== "finalized") {
    throw new Error("Pairing code is not active");
  }
  if (pairing.status === "finalized") {
    return { state, preparation: preparation(state, pairing), changed: false };
  }
  const finalized = { ...pairing, status: "finalized" as const };
  const next = { ...state, pairing: finalized };
  return { state: next, preparation: preparation(next, finalized), changed: true };
}

export function disconnectManagedSlackPeer(
  state: ManagedSlackPeerState,
  input: { operationId: string; route: AdapterPairingRoute },
): ManagedSlackDisconnectResult {
  const active = state.activeRoute;
  if (!active) {
    const replay = state.lastDisconnect;
    if (replay?.operationId === input.operationId && sameRoute(replay.route, input.route)) {
      return { state, disconnected: true };
    }
    return { state, disconnected: false };
  }
  if (!sameRoute(active, input.route)) throw new Error("Managed Slack route changed before disconnect");
  const next: ManagedSlackPeerState = {
    ...state,
    activeRoute: undefined,
    pairing: undefined,
    lastDisconnect: { operationId: input.operationId, route: active },
  };
  return { state: next, disconnected: true };
}

export type ManagedSlackDisconnectResult = {
  state: ManagedSlackPeerState;
  disconnected: boolean;
};

export function managedSlackPeerAllowsSurface(
  state: ManagedSlackPeerState,
  surface: AdapterSurface,
): boolean {
  if (surface.kind === "dm") return surface.id === state.dmSurfaceId;
  return state.observedSurfaces.some((observed) => sameSurface(observed, surface));
}

function observeSurface(
  observed: ManagedSlackObservedSurface[],
  surface: AdapterSurface,
  observedAt: number,
): ManagedSlackObservedSurface[] {
  const retained = observed.filter((candidate) => !sameSurface(candidate, surface));
  retained.push({ ...surface, observedAt });
  return retained
    .sort((left, right) => right.observedAt - left.observedAt)
    .slice(0, MAX_OBSERVED_SURFACES);
}

function sameSurface(left: AdapterSurface, right: AdapterSurface): boolean {
  return left.kind === right.kind
    && left.id === right.id
    && (left.threadId ?? "") === (right.threadId ?? "");
}

function preparation(
  state: ManagedSlackPeerState,
  pairing: ManagedSlackPairingState,
): AdapterPairingPreparation {
  if (!pairing.preparedRoute) throw new Error("Pairing route is unavailable");
  return {
    candidate: managedSlackPairingCandidate(state, pairing.expiresAt),
    route: pairing.preparedRoute,
    previousRoute: pairing.previousRoute,
  };
}

function requirePairing(
  state: ManagedSlackPeerState,
  claimId: string,
  expiresAt: number,
): ManagedSlackPairingState {
  const pairing = state.pairing;
  if (!pairing || pairing.claimId !== claimId || pairing.expiresAt !== expiresAt) {
    throw new Error("Pairing code is invalid");
  }
  return pairing;
}

function assertOperationReplay(
  pairing: ManagedSlackPairingState,
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
