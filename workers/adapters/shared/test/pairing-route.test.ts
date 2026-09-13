import { describe, expect, it } from "vitest";
import { activateAdapterPairing, disconnectAdapterPeer, prepareAdapterPairing, type AdapterPeerLink, type AdapterPeerRoute } from "../src/pairing-route";

const route: AdapterPeerRoute = { installationId: "installation", localUid: 1000, generation: "prepared", canonicalOrigin: "https://space.example.test", linkedAt: 1 };
const transition = { claimId: "claim", expiresAt: 10_000, operationId: "pair", route };
const disconnect = { operationId: "disconnect", route };
function preparation(): AdapterPeerLink {
  return prepareAdapterPairing({ pairing: { claimId: "claim", code: "ABCDEFGHJKLM", expiresAt: transition.expiresAt, status: "pending" } }, { ...transition, now: 1 }, "adapter").state;
}

describe("exclusive adapter route disconnection", () => {
  it("cancels the exact preparation before activation and replays the lost disconnect reply", () => {
    const result = disconnectAdapterPeer(preparation(), disconnect, "adapter");
    expect(result.disconnected).toBe(true);
    expect(result.state.pairing).toBeUndefined();
    expect(() => activateAdapterPairing(result.state, transition)).toThrow("Pairing code is invalid");
    expect(disconnectAdapterPeer(result.state, disconnect, "adapter").disconnected).toBe(true);
  });

  it.each([
    { ...route, installationId: "other-installation" },
    { ...route, localUid: 1001 },
    { ...route, generation: "other-generation" },
  ])("preserves a prepared route when the cancellation identity differs", (foreign) => {
    const state = preparation();
    const result = disconnectAdapterPeer(state, { ...disconnect, route: foreign }, "adapter");
    expect(result).toEqual({ state, disconnected: false });
    expect(activateAdapterPairing(result.state, transition).state.activeRoute).toEqual(route);
  });

  it("preserves a separately prepared successor while disconnecting the old active generation", () => {
    const previous = { ...route, generation: "previous" };
    const state = { ...preparation(), activeRoute: previous };
    const result = disconnectAdapterPeer(state, { ...disconnect, route: previous }, "adapter");
    expect(result.state.activeRoute).toBeUndefined();
    expect(result.state.pairing).toEqual(state.pairing);
    expect(activateAdapterPairing(result.state, transition).state.activeRoute).toEqual(route);
    const preparedCancelled = disconnectAdapterPeer(state, disconnect, "adapter");
    expect(preparedCancelled.state.activeRoute).toEqual(previous);
    expect(preparedCancelled.state.pairing).toBeUndefined();
    expect(() => activateAdapterPairing(preparedCancelled.state, transition)).toThrow("Pairing code is invalid");
    expect(disconnectAdapterPeer(preparedCancelled.state, disconnect, "adapter")).toEqual({ state: preparedCancelled.state, disconnected: true });
  });

  it("removes both active and prepared projections only when their exact generation matches", () => {
    const active = activateAdapterPairing(preparation(), transition).state;
    const result = disconnectAdapterPeer(active, disconnect, "adapter");
    expect(result.state.activeRoute).toBeUndefined();
    expect(result.state.pairing).toBeUndefined();
    expect(disconnectAdapterPeer(result.state, disconnect, "adapter").disconnected).toBe(true);
  });
});
