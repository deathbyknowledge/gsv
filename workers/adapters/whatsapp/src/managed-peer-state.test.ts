import { describe, expect, it } from "vitest";

import {
  activateManagedWhatsAppPairing,
  bindManagedWhatsAppPeerIdentity,
  disconnectManagedWhatsAppPeer,
  finalizeManagedWhatsAppPairing,
  prepareManagedWhatsAppPairing,
  WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS,
  whatsAppTemplatePending,
  whatsAppWindowOpen,
  withPendingWhatsAppTemplate,
  type ManagedWhatsAppPeerRoute,
  type ManagedWhatsAppPeerState,
} from "./managed-peer-state";
import { HELD_OUTBOUND_RETENTION_MS } from "./whatsapp-held-outbound";

const previousRoute: ManagedWhatsAppPeerRoute = {
  installationId: "installation-old",
  localUid: 1000,
  generation: "generation-old",
  canonicalOrigin: "https://old.gsv.space",
  linkedAt: 1,
};
const nextRoute: ManagedWhatsAppPeerRoute = {
  installationId: "installation-new",
  localUid: 1000,
  generation: "generation-new",
  canonicalOrigin: "https://new.gsv.space",
  linkedAt: 2,
};

function pendingState(activeRoute = previousRoute): ManagedWhatsAppPeerState {
  return {
    version: 1,
    actorId: "34611111189",
    surfaceId: "34611111189",
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

describe("managed WhatsApp peer state", () => {
  it("tracks the latest inbound message to open the customer service window", () => {
    const now = 1_700_000_000_000;
    const first = bindManagedWhatsAppPeerIdentity(undefined, {
      actorId: "34611111189", surfaceId: "34611111189", actorName: "Hank", actorHandle: "+34•••••••89",
      messageId: "wamid.one", timestamp: now - 5_000,
    }, now);
    expect(first).toMatchObject({ lastInboundAt: now - 5_000, lastInboundMessageId: "wamid.one", actorName: "Hank" });
    expect(whatsAppWindowOpen(first, now)).toBe(true);
    expect(whatsAppWindowOpen(first, now - 5_000 + WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS)).toBe(false);

    const replayOfOlder = bindManagedWhatsAppPeerIdentity(first, {
      actorId: "34611111189", surfaceId: "34611111189", messageId: "wamid.zero", timestamp: now - 60_000,
    }, now);
    expect(replayOfOlder).toMatchObject({ lastInboundAt: now - 5_000, lastInboundMessageId: "wamid.one", actorName: "Hank" });

    const future = bindManagedWhatsAppPeerIdentity(first, {
      actorId: "34611111189", surfaceId: "34611111189", messageId: "wamid.two", timestamp: now + 60_000,
    }, now);
    expect(future).toMatchObject({ lastInboundAt: now, lastInboundMessageId: "wamid.two" });
    expect(() => bindManagedWhatsAppPeerIdentity(first, {
      actorId: "34699999999", surfaceId: "34699999999", messageId: "wamid.x",
    }, now)).toThrow("identity mismatch");
    expect(whatsAppWindowOpen({ version: 1, actorId: "1", surfaceId: "1" }, now)).toBe(false);
  });

  it("resolves a pending template with the person's next message and keeps it across replays", () => {
    const now = 1_700_000_000_000;
    const identity = { actorId: "34611111189", surfaceId: "34611111189" };
    const base = bindManagedWhatsAppPeerIdentity(undefined, { ...identity, messageId: "wamid.one", timestamp: now - 5_000 }, now);
    const pending = withPendingWhatsAppTemplate(base, now, "wamid.template");
    expect(pending.pendingTemplate).toEqual({
      sentAt: now,
      expiresAt: now + HELD_OUTBOUND_RETENTION_MS,
      messageId: "wamid.template",
    });
    expect(whatsAppTemplatePending(pending, now)).toBe(true);
    expect(whatsAppTemplatePending(pending, now + HELD_OUTBOUND_RETENTION_MS)).toBe(false);
    expect(whatsAppTemplatePending(base, now)).toBe(false);

    const replay = bindManagedWhatsAppPeerIdentity(pending, { ...identity, messageId: "wamid.zero", timestamp: now - 60_000 }, now);
    expect(replay.pendingTemplate).toEqual(pending.pendingTemplate);
    const answered = bindManagedWhatsAppPeerIdentity(pending, { ...identity, messageId: "wamid.two", timestamp: now + 1_000 }, now + 1_000);
    expect(answered.pendingTemplate).toBeUndefined();
    expect(answered).toMatchObject({ lastInboundAt: now + 1_000, lastInboundMessageId: "wamid.two" });
  });

  it("keeps the old route live until explicit confirmation activates the new one", () => {
    const prepared = prepareManagedWhatsAppPairing(pendingState(), {
      claimId: "claim-1",
      expiresAt: 10_000,
      operationId: "operation-1",
      route: nextRoute,
      now: 1_000,
    });

    expect(prepared.state.activeRoute).toEqual(previousRoute);
    expect(prepared.preparation.previousRoute).toEqual(previousRoute);
    expect(prepared.preparation.route).toEqual(nextRoute);
    expect(prepared.preparation.candidate).toMatchObject({ accountId: "managed", actorId: "34611111189", linked: true });

    const activated = activateManagedWhatsAppPairing(prepared.state, {
      claimId: "claim-1",
      expiresAt: 10_000,
      operationId: "operation-1",
      route: nextRoute,
    });
    expect(activated.state.activeRoute).toEqual(nextRoute);

    const finalized = finalizeManagedWhatsAppPairing(activated.state, {
      claimId: "claim-1",
      expiresAt: 10_000,
      operationId: "operation-1",
      route: nextRoute,
    });
    expect(finalized.changed).toBe(true);
    expect(finalized.state.pairing?.status).toBe("finalized");
  });

  it("requires disconnect before moving a number between users in one GSV", () => {
    expect(() => prepareManagedWhatsAppPairing(pendingState({
      ...previousRoute,
      installationId: "installation-new",
      localUid: 2000,
    }), {
      claimId: "claim-1",
      expiresAt: 10_000,
      operationId: "operation-1",
      route: nextRoute,
      now: 1_000,
    })).toThrow("Disconnect this WhatsApp identity");
  });

  it("fences disconnects by the exact active generation and replays them safely", () => {
    const state = pendingState(nextRoute);
    expect(() => disconnectManagedWhatsAppPeer(state, {
      operationId: "disconnect-1",
      route: { ...nextRoute, generation: "stale" },
    })).toThrow("route changed");
    const disconnected = disconnectManagedWhatsAppPeer(state, { operationId: "disconnect-1", route: nextRoute });
    expect(disconnected.disconnected).toBe(true);
    expect(disconnected.state.activeRoute).toBeUndefined();
    expect(disconnectManagedWhatsAppPeer(disconnected.state, { operationId: "disconnect-1", route: nextRoute }).disconnected).toBe(true);
  });
});
