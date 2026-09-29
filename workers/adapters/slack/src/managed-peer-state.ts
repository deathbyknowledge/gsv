import {
  activateAdapterPairing, disconnectAdapterPeer, finalizeAdapterPairing, prepareAdapterPairing,
  type AdapterPeerPairing, type AdapterPeerRoute, type AdapterPairingTransition,
} from "../../shared/src/pairing-route";
import type {
  AdapterPairingCandidate,
  AdapterPairingPreparation,
  AdapterPairingRoute,
  AdapterSurface,
} from "./types";
import type { SlackInbound } from "./slack-events";

export type ManagedSlackPeerRoute = AdapterPeerRoute;
export type ManagedSlackPairingState = AdapterPeerPairing;

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

export function prepareManagedSlackPairing(state: ManagedSlackPeerState, input: AdapterPairingTransition & { now: number }): PairingTransition {
  const next = prepareAdapterPairing(state, input, "Slack");
  return { state: next.state, preparation: preparation(next.state, next.pairing) };
}

export function activateManagedSlackPairing(state: ManagedSlackPeerState, input: AdapterPairingTransition): PairingTransition {
  const next = activateAdapterPairing(state, input);
  return { state: next.state, preparation: preparation(next.state, next.pairing) };
}

export function finalizeManagedSlackPairing(state: ManagedSlackPeerState, input: AdapterPairingTransition): FinalizeResult {
  const next = finalizeAdapterPairing(state, input);
  return { state: next.state, preparation: preparation(next.state, next.pairing), changed: next.changed };
}

export function disconnectManagedSlackPeer(state: ManagedSlackPeerState, input: { operationId: string; route: AdapterPairingRoute }): ManagedSlackDisconnectResult {
  return disconnectAdapterPeer(state, input, "Managed Slack");
}

export type ManagedSlackDisconnectResult = { state: ManagedSlackPeerState; disconnected: boolean };

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
