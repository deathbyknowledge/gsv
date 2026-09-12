import type { AdapterPairingRoute } from "./types";

export type AdapterPeerRoute = AdapterPairingRoute & { canonicalOrigin: string; linkedAt: number };
export type AdapterPeerPairing = {
  claimId: string;
  code: string;
  expiresAt: number;
  status: "pending" | "prepared" | "active" | "finalized";
  operationId?: string;
  preparedRoute?: AdapterPeerRoute;
  previousRoute?: AdapterPeerRoute;
};
export type AdapterPeerLink = {
  activeRoute?: AdapterPeerRoute;
  pairing?: AdapterPeerPairing;
  lastDisconnect?: { operationId: string; route: AdapterPeerRoute };
};
export type AdapterPairingTransition = { claimId: string; expiresAt: number; operationId: string; route: AdapterPeerRoute };

/** Provider identity and candidate presentation stay with the adapter; this owns the exclusive route. */
export function prepareAdapterPairing<State extends AdapterPeerLink>(state: State, input: AdapterPairingTransition & { now: number }, adapter: string) {
  const pairing = requirePairing(state, input);
  if (pairing.status !== "pending") {
    assertOperationReplay(pairing, input);
    return { state, pairing };
  }
  if (pairing.expiresAt <= input.now) throw new Error("Pairing code expired");
  if (state.activeRoute?.installationId === input.route.installationId && state.activeRoute.localUid !== input.route.localUid) {
    throw new Error(`Disconnect this ${adapter} identity before linking it to another user here`);
  }
  const prepared: AdapterPeerPairing = { ...pairing, status: "prepared", operationId: input.operationId, preparedRoute: input.route, previousRoute: state.activeRoute };
  return { state: { ...state, pairing: prepared }, pairing: prepared };
}

export function activateAdapterPairing<State extends AdapterPeerLink>(state: State, input: AdapterPairingTransition) {
  const pairing = requirePairing(state, input);
  assertOperationReplay(pairing, input);
  if (pairing.status === "pending") throw new Error("Pairing code was not prepared");
  if (pairing.status === "active" || pairing.status === "finalized") return { state, pairing };
  const active: AdapterPeerPairing = { ...pairing, status: "active" };
  return { state: { ...state, activeRoute: input.route, pairing: active }, pairing: active };
}

export function finalizeAdapterPairing<State extends AdapterPeerLink>(state: State, input: AdapterPairingTransition) {
  const pairing = requirePairing(state, input);
  assertOperationReplay(pairing, input);
  if (pairing.status !== "active" && pairing.status !== "finalized") throw new Error("Pairing code is not active");
  if (pairing.status === "finalized") return { state, pairing, changed: false };
  const finalized: AdapterPeerPairing = { ...pairing, status: "finalized" };
  return { state: { ...state, pairing: finalized }, pairing: finalized, changed: true };
}

export function disconnectAdapterPeer<State extends AdapterPeerLink>(state: State, input: { operationId: string; route: AdapterPairingRoute }, adapter: string) {
  const active = state.activeRoute;
  if (!active) {
    const replay = state.lastDisconnect;
    return { state, disconnected: Boolean(replay?.operationId === input.operationId && sameAdapterRoute(replay.route, input.route)) };
  }
  if (!sameAdapterRoute(active, input.route)) throw new Error(`${adapter} route changed before disconnect`);
  const next = { ...state, lastDisconnect: { operationId: input.operationId, route: active } };
  delete next.activeRoute;
  delete next.pairing;
  return { state: next, disconnected: true };
}

export function sameAdapterRoute(left: AdapterPairingRoute, right: AdapterPairingRoute): boolean {
  return left.installationId === right.installationId && left.localUid === right.localUid && left.generation === right.generation;
}

function requirePairing(state: AdapterPeerLink, input: Pick<AdapterPairingTransition, "claimId" | "expiresAt">): AdapterPeerPairing {
  const pairing = state.pairing;
  if (!pairing || pairing.claimId !== input.claimId || pairing.expiresAt !== input.expiresAt) throw new Error("Pairing code is invalid");
  return pairing;
}

function assertOperationReplay(pairing: AdapterPeerPairing, input: AdapterPairingTransition): void {
  if (pairing.operationId !== input.operationId || !pairing.preparedRoute || !sameAdapterRoute(pairing.preparedRoute, input.route)) throw new Error("Pairing code is owned by another operation");
}
