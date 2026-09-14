import {
  activateAdapterPairing, disconnectAdapterPeer, finalizeAdapterPairing, prepareAdapterPairing,
  type AdapterPeerPairing, type AdapterPeerRoute, type AdapterPairingTransition,
} from "../../shared/src/pairing-route";
import type {
  AdapterPairingCandidate,
  AdapterPairingPreparation,
  AdapterPairingRoute,
} from "./types";
import type { ManagedTelegramInbound } from "./managed-update";

export type ManagedTelegramPeerRoute = AdapterPeerRoute;
export type ManagedTelegramPairingState = AdapterPeerPairing;

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
type PairingTransition = { state: ManagedTelegramPeerState; preparation: AdapterPairingPreparation };
type FinalizeResult = PairingTransition & { changed: boolean };
type DisconnectResult = { state: ManagedTelegramPeerState; disconnected: boolean };

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
    actorName: inbound.actorName ?? state?.actorName,
    actorHandle: inbound.actorHandle ?? state?.actorHandle,
    activeRoute: state?.activeRoute,
    pairing: state?.pairing,
    lastDisconnect: state?.lastDisconnect,
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
    actorName: state.actorName,
    actorHandle: state.actorHandle,
    expiresAt,
    linked: Boolean(state.activeRoute),
  };
}

export function prepareManagedTelegramPairing(state: ManagedTelegramPeerState, input: AdapterPairingTransition & { now: number }): PairingTransition {
  const next = prepareAdapterPairing(state, input, "Telegram");
  return { state: next.state, preparation: preparation(next.state, next.pairing) };
}

export function activateManagedTelegramPairing(state: ManagedTelegramPeerState, input: AdapterPairingTransition): PairingTransition {
  const next = activateAdapterPairing(state, input);
  return { state: next.state, preparation: preparation(next.state, next.pairing) };
}

export function finalizeManagedTelegramPairing(state: ManagedTelegramPeerState, input: AdapterPairingTransition): FinalizeResult {
  const next = finalizeAdapterPairing(state, input);
  return { state: next.state, preparation: preparation(next.state, next.pairing), changed: next.changed };
}

export function disconnectManagedTelegramPeer(state: ManagedTelegramPeerState, input: { operationId: string; route: AdapterPairingRoute }): DisconnectResult {
  return disconnectAdapterPeer(state, input, "Managed Telegram");
}

function preparation(
  state: ManagedTelegramPeerState,
  pairing: ManagedTelegramPairingState,
): AdapterPairingPreparation {
  if (!pairing.preparedRoute) throw new Error("Pairing route is unavailable");
  return {
    candidate: pairingCandidate(state, pairing.expiresAt),
    route: pairing.preparedRoute,
    previousRoute: pairing.previousRoute,
  };
}
