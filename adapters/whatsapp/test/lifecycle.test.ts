import { DisconnectReason } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import { LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID } from "../../shared/src/installation";

import {
  canReplaceSupersededLifecycleAlarm,
  disconnectPolicy,
  earliestDeadline,
  enqueueThenDeliverInboundBatch,
  INBOUND_RETRY_DELAY_MS,
  nextAccountAlarmDeadline,
  pairingChallengeIsCurrent,
  pairingSessionExpired,
  reconnectDelayMs,
  restartDelayMs,
  socketLeaseAction,
  SOCKET_LEASE_REFRESH_INTERVAL_MS,
  SocketOperationQueue,
} from "../src/lifecycle";
import {
  defaultWhatsAppAccountState,
  restoreWhatsAppAccountState,
} from "../src/types";
import type { WhatsAppAccountState } from "../src/types";

const healthySocketLease = {
  hasSocket: true,
  stateConnected: true,
  socketAuthenticated: true,
  webSocketOpen: true,
};

describe("WhatsApp lifecycle policy", () => {
  it("refreshes a healthy transport only when its lease is due", () => {
    expect(SOCKET_LEASE_REFRESH_INTERVAL_MS).toBeLessThan(15 * 60 * 1_000);
    expect(socketLeaseAction(60_000, healthySocketLease, 10_000)).toBe("wait");
    expect(socketLeaseAction(60_000, healthySocketLease, 60_000)).toBe("refresh");
  });

  it("recovers an unhealthy established lease without waiting for expiry", () => {
    const healthSignals = Object.keys(healthySocketLease) as Array<
      keyof typeof healthySocketLease
    >;
    for (const field of healthSignals) {
      expect(socketLeaseAction(60_000, {
        ...healthySocketLease,
        [field]: false,
      }, 10_000))
        .toBe("recover");
    }
    expect(socketLeaseAction(undefined, {
      ...healthySocketLease,
      webSocketOpen: false,
    }, 10_000))
      .toBe("wait");
  });

  it("distinguishes restart, replacement, logout, and corrupt auth", () => {
    expect(disconnectPolicy(DisconnectReason.restartRequired)).toEqual({
      action: "restart",
      clearAuth: false,
    });
    expect(disconnectPolicy(DisconnectReason.connectionReplaced)).toEqual({
      action: "reconnect",
      clearAuth: false,
    });
    expect(disconnectPolicy(DisconnectReason.loggedOut)).toEqual({
      action: "logged_out",
      clearAuth: true,
    });
    expect(disconnectPolicy(DisconnectReason.badSession)).toEqual({
      action: "stop",
      clearAuth: true,
    });
    expect(disconnectPolicy(503)).toEqual({ action: "reconnect", clearAuth: false });
  });

  it("caps reconnect and restart backoff and chooses the earliest deadline", () => {
    expect(reconnectDelayMs(0, 0)).toBe(2_000);
    expect(reconnectDelayMs(20, 0)).toBe(5 * 60 * 1000);
    expect(reconnectDelayMs(20, 0.999999)).toBe(5 * 60 * 1000 + 999);
    expect(restartDelayMs(0, 0)).toBe(0);
    expect(restartDelayMs(1, 0)).toBe(2_000);
    expect(restartDelayMs(2, 0)).toBe(4_000);
    expect(restartDelayMs(30, 0)).toBe(5 * 60 * 1000);
    expect(earliestDeadline(undefined, 500, Number.NaN, 100, null)).toBe(100);
    expect(earliestDeadline(undefined, null)).toBeUndefined();
  });

  it("schedules pending inbound work ahead of later lifecycle maintenance", () => {
    expect(nextAccountAlarmDeadline(undefined, false, 1_000)).toBeUndefined();
    expect(nextAccountAlarmDeadline(2_000, false, 1_000)).toBe(2_000);
    expect(nextAccountAlarmDeadline(undefined, true, 1_000)).toBe(
      1_000 + INBOUND_RETRY_DELAY_MS,
    );
    expect(nextAccountAlarmDeadline(2_000, true, 1_000)).toBe(2_000);
    expect(nextAccountAlarmDeadline(60_000, true, 1_000)).toBe(
      1_000 + INBOUND_RETRY_DELAY_MS,
    );
  });

  it("never reuses a QR challenge after its pairing session expires", () => {
    expect(pairingSessionExpired(false, 1_000, 1_000)).toBe(true);
    expect(pairingSessionExpired(false, 1_001, 1_000)).toBe(false);
    expect(pairingSessionExpired(true, 1_000, 1_000)).toBe(false);
    expect(pairingChallengeIsCurrent("private-qr", 1_001, 1_000)).toBe(true);
    expect(pairingChallengeIsCurrent("private-qr", 1_000, 1_000)).toBe(false);
    expect(pairingChallengeIsCurrent(null, 1_001, 1_000)).toBe(false);
  });

  it("replaces a completed lease alarm without postponing inbound retry work", () => {
    expect(canReplaceSupersededLifecycleAlarm(30_000, 30_000, false)).toBe(true);
    expect(canReplaceSupersededLifecycleAlarm(10_000, 30_000, false)).toBe(false);
    expect(canReplaceSupersededLifecycleAlarm(30_000, 30_000, true)).toBe(false);
  });

  it("serializes stale-generation writes behind invalidation", async () => {
    const queue = new SocketOperationQueue();
    let generation = 1;
    let writes = 0;
    const captured = generation;

    const invalidate = queue.run(async () => {
      generation += 1;
    });
    const staleWrite = queue.run(async () => {
      if (captured === generation) writes += 1;
    });
    await Promise.all([invalidate, staleWrite]);

    expect(writes).toBe(0);
  });

  it("durably accepts a complete provider batch before forwarding its head", async () => {
    const events: string[] = [];

    await enqueueThenDeliverInboundBatch(
      async () => {
        const accepted = ["first", "second", "third"];
        for (const id of accepted) events.push(`enqueue:${id}`);
        return accepted;
      },
      async (id) => {
        events.push(`deliver:${id}`);
      },
    );

    expect(events).toEqual([
      "enqueue:first",
      "enqueue:second",
      "enqueue:third",
      "deliver:first",
      "deliver:second",
      "deliver:third",
    ]);
  });
});

describe("WhatsApp state upgrade", () => {
  it("reconnects an existing registered legacy session", () => {
    expect(restoreWhatsAppAccountState(
      undefined,
      "default",
      true,
      10_000,
    )).toEqual({
      ...defaultWhatsAppAccountState(),
      installationId: LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
      accountId: "default",
      desired: "connected",
      status: "reconnecting",
      authenticated: true,
      reconnectAt: 11_000,
    });
  });

  it("preserves explicit v2 state while dropping obsolete maintenance fields", () => {
    const stored = {
      ...defaultWhatsAppAccountState(),
      accountId: "default",
      status: "logged_out" as const,
      rotationAt: 42_000,
      lastMessageAt: 41_000,
    };
    expect(restoreWhatsAppAccountState(
      stored as WhatsAppAccountState & {
        rotationAt: number;
        lastMessageAt: number;
      },
      undefined,
      false,
      10_000,
    )).toEqual({
      ...defaultWhatsAppAccountState(),
      accountId: "default",
      status: "logged_out",
    });
  });

  it("assigns legacy v2 state to the standalone installation", () => {
    const current = {
      ...defaultWhatsAppAccountState(),
      accountId: "default",
    };
    const {
      installationId: _missingLegacyField,
      ...legacy
    } = current;

    expect(restoreWhatsAppAccountState(
      legacy as WhatsAppAccountState,
      undefined,
      false,
      10_000,
    ).installationId).toBe(LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID);
  });
});
