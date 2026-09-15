import {
  activateAdapterPairing, disconnectAdapterPeer, finalizeAdapterPairing, prepareAdapterPairing,
  type AdapterPeerPairing, type AdapterPeerRoute, type AdapterPairingTransition,
} from "../../shared/src/pairing-route";
import type {
  AdapterPairingCandidate,
  AdapterPairingPreparation,
  AdapterPairingRoute,
} from "./types";
import type { ManagedWhatsAppInbound } from "./whatsapp-webhook";

export const MANAGED_WHATSAPP_ACCOUNT_ID = "managed";
/** Meta accepts free-form messages only within 24 hours of the person's last message. */
export const WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ManagedWhatsAppPeerRoute = AdapterPeerRoute;
export type ManagedWhatsAppPairingState = AdapterPeerPairing;

export type ManagedWhatsAppPeerState = {
  version: 1;
  actorId: string;
  surfaceId: string;
  actorName?: string;
  actorHandle?: string;
  /** When this number last messaged the platform number; it opens the customer service window. */
  lastInboundAt?: number;
  /** The most recent inbound message id, used for read receipts and the typing indicator. */
  lastInboundMessageId?: string;
  activeRoute?: ManagedWhatsAppPeerRoute;
  pairing?: ManagedWhatsAppPairingState;
  lastDisconnect?: {
    operationId: string;
    route: ManagedWhatsAppPeerRoute;
  };
};
export type ManagedWhatsAppInboundIdentity = Pick<
  ManagedWhatsAppInbound,
  "actorId" | "surfaceId" | "actorName" | "actorHandle" | "messageId" | "timestamp"
>;
type PairingTransition = { state: ManagedWhatsAppPeerState; preparation: AdapterPairingPreparation };
type FinalizeResult = PairingTransition & { changed: boolean };
type DisconnectResult = { state: ManagedWhatsAppPeerState; disconnected: boolean };

/** Records the sender's identity and the receipt that opens or extends the 24-hour window. */
export function bindManagedWhatsAppPeerIdentity(
  state: ManagedWhatsAppPeerState | undefined,
  inbound: ManagedWhatsAppInboundIdentity,
  now: number,
): ManagedWhatsAppPeerState {
  if (state && (state.actorId !== inbound.actorId || state.surfaceId !== inbound.surfaceId)) {
    throw new Error("Managed WhatsApp peer identity mismatch");
  }
  const receivedAt = Math.min(inbound.timestamp ?? now, now);
  const latest = receivedAt >= (state?.lastInboundAt ?? 0);
  return {
    version: 1,
    actorId: inbound.actorId,
    surfaceId: inbound.surfaceId,
    actorName: inbound.actorName ?? state?.actorName,
    actorHandle: inbound.actorHandle ?? state?.actorHandle,
    lastInboundAt: latest ? receivedAt : state?.lastInboundAt,
    lastInboundMessageId: latest ? inbound.messageId : state?.lastInboundMessageId,
    activeRoute: state?.activeRoute,
    pairing: state?.pairing,
    lastDisconnect: state?.lastDisconnect,
  };
}

export function whatsAppWindowOpen(state: ManagedWhatsAppPeerState, now: number): boolean {
  return state.lastInboundAt !== undefined
    && now - state.lastInboundAt < WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS;
}

export function pairingCandidate(
  state: ManagedWhatsAppPeerState,
  expiresAt: number,
): AdapterPairingCandidate {
  return {
    accountId: MANAGED_WHATSAPP_ACCOUNT_ID,
    actorId: state.actorId,
    surfaceId: state.surfaceId,
    actorName: state.actorName,
    actorHandle: state.actorHandle,
    expiresAt,
    linked: Boolean(state.activeRoute),
  };
}

export function prepareManagedWhatsAppPairing(state: ManagedWhatsAppPeerState, input: AdapterPairingTransition & { now: number }): PairingTransition {
  const next = prepareAdapterPairing(state, input, "WhatsApp");
  return { state: next.state, preparation: preparation(next.state, next.pairing) };
}

export function activateManagedWhatsAppPairing(state: ManagedWhatsAppPeerState, input: AdapterPairingTransition): PairingTransition {
  const next = activateAdapterPairing(state, input);
  return { state: next.state, preparation: preparation(next.state, next.pairing) };
}

export function finalizeManagedWhatsAppPairing(state: ManagedWhatsAppPeerState, input: AdapterPairingTransition): FinalizeResult {
  const next = finalizeAdapterPairing(state, input);
  return { state: next.state, preparation: preparation(next.state, next.pairing), changed: next.changed };
}

export function disconnectManagedWhatsAppPeer(state: ManagedWhatsAppPeerState, input: { operationId: string; route: AdapterPairingRoute }): DisconnectResult {
  return disconnectAdapterPeer(state, input, "Managed WhatsApp");
}

function preparation(
  state: ManagedWhatsAppPeerState,
  pairing: ManagedWhatsAppPairingState,
): AdapterPairingPreparation {
  if (!pairing.preparedRoute) throw new Error("Pairing route is unavailable");
  return {
    candidate: pairingCandidate(state, pairing.expiresAt),
    route: pairing.preparedRoute,
    previousRoute: pairing.previousRoute,
  };
}
