import { describe, expect, it, vi } from "vitest";

import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { stableOpaqueId } from "../shared/stable-id";
import { AdapterStore } from "./adapter-store";
import type { KernelContext } from "./context";
import type { DeviceRecord } from "./devices";
import type { FederationContactRecord } from "./federation-store";
import {
  recordAdapterStatusTransition,
  recordContactAddedResponsibility,
  recordMachineAddedResponsibility,
} from "./lifecycle-responsibilities";
import { ResponsibilitySourcePolicyStore } from "./responsibility-source-policies";
import { ResponsibilityStore } from "./responsibility-store";

describe("Kernel lifecycle responsibilities", () => {
  it("creates one confirmation for a newly added physical machine", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const ctx = lifecycleContext(sql, storage);
      const machine: DeviceRecord = {
        device_id: "workstation",
        owner_uid: 1000,
        label: "Workstation",
        description: "",
        implements: ["shell.exec"],
        platform: "linux",
        version: "1.0.0",
        online: true,
        first_seen_at: 1_700_000_000_000,
        last_seen_at: 1_700_000_000_000,
        connected_at: 1_700_000_000_000,
        disconnected_at: null,
      };

      await recordMachineAddedResponsibility(machine, ctx);
      await recordMachineAddedResponsibility(machine, ctx);
      ctx.responsibilitySources.set(1000, "machine.added", false);
      await recordMachineAddedResponsibility({
        ...machine,
        device_id: "disabled-machine",
        first_seen_at: machine.first_seen_at + 1,
      }, ctx);
      const eventId = await stableOpaqueId("machine-added", [
        machine.device_id,
        machine.first_seen_at,
      ]);

      expect(ctx.responsibilities.list({
        ownerUid: 1000,
        includeTerminal: true,
      }).records).toEqual([
        expect.objectContaining({
          title: "Confirm that a new machine is connected",
          source: {
            kind: "event",
            eventType: "machine.added",
            eventId,
          },
          dedupeKey: `machine.added:${eventId}`,
        }),
      ]);
      expect(ctx.reconcileResponsibilityWake).toHaveBeenCalledOnce();
    });
  });

  it("creates one learning responsibility for each contact generation", async () => {
    await runWithRealKernelSql((sql, storage) => {
      const ctx = lifecycleContext(sql, storage);
      const initial = contactRecord({
        generation: "generation:initial",
        updatedAtMs: 1_700_000_000_000,
      });

      recordContactAddedResponsibility(initial, "incoming", ctx);
      recordContactAddedResponsibility(initial, "incoming", ctx);
      const replacement = contactRecord({
        generation: "generation:replacement",
        updatedAtMs: initial.updatedAtMs + 1,
      });
      recordContactAddedResponsibility(replacement, "outgoing", ctx);
      ctx.responsibilitySources.set(1000, "contact.added", false);
      recordContactAddedResponsibility(contactRecord({
        generation: "generation:disabled",
        updatedAtMs: replacement.updatedAtMs + 1,
      }), "incoming", ctx);

      const responsibilities = ctx.responsibilities.list({
        ownerUid: 1000,
        includeTerminal: true,
      }).records;
      expect(responsibilities).toHaveLength(2);
      expect(responsibilities).toEqual(expect.arrayContaining([
        expect.objectContaining({
          title: "Learn about a new contact and preserve useful context",
          dedupeKey: `contact.added:${initial.id}:${initial.generation}`,
          details: expect.objectContaining({
            eventType: "contact.added",
            contactGeneration: initial.generation,
            displayName: "Remote Person",
            inviteDirection: "incoming",
            contentTrust: "untrusted",
          }),
        }),
        expect.objectContaining({
          dedupeKey: `contact.added:${replacement.id}:${replacement.generation}`,
          details: expect.objectContaining({
            contactGeneration: replacement.generation,
            inviteDirection: "outgoing",
          }),
        }),
      ]));
    });
  });

  it("confirms an adapter account once without treating transport reconnects as new", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const ctx = lifecycleContext(sql, storage);
      ctx.adapters.status.setOwner("telegram", "primary", 1000);

      const initial = ctx.adapters.status.get("telegram", "primary");
      const connected = ctx.adapters.status.upsert("telegram", "primary", {
        accountId: "primary",
        connected: true,
        authenticated: true,
      });
      recordAdapterStatusTransition(initial, connected, ctx);

      const transportOffline = ctx.adapters.status.upsert("telegram", "primary", {
        accountId: "primary",
        connected: false,
        authenticated: true,
      });
      recordAdapterStatusTransition(connected, transportOffline, ctx);
      const reconnected = ctx.adapters.status.upsert("telegram", "primary", {
        accountId: "primary",
        connected: true,
        authenticated: true,
      });
      recordAdapterStatusTransition(transportOffline, reconnected, ctx);

      const connectedResponsibilities = ctx.responsibilities.list({
        ownerUid: 1000,
        includeTerminal: true,
      }).records.filter((record) => record.source.kind === "event"
        && record.source.eventType === "adapter.connected");
      expect(connectedResponsibilities).toHaveLength(1);
      expect(connectedResponsibilities[0]).toMatchObject({
        dedupeKey: `adapter.connected:${connected.lifecycleId}`,
        details: {
          adapter: "telegram",
          accountId: "primary",
        },
      });
    });
  });

  it("preserves migrated ready state across the first transport reconnect", async () => {
    await runWithRealKernelSql((sql, storage) => {
      const ctx = lifecycleContext(sql, storage);
      ctx.adapters.status.setOwner("telegram", "existing", 1000);
      const existing = ctx.adapters.status.upsert("telegram", "existing", {
        accountId: "existing",
        connected: true,
        authenticated: true,
      });
      ctx.adapters.status.markReadyForOwner("telegram", "existing", 1000);

      const transportOffline = ctx.adapters.status.upsert("telegram", "existing", {
        accountId: "existing",
        connected: false,
        authenticated: true,
      });
      recordAdapterStatusTransition(existing, transportOffline, ctx);
      const reconnected = ctx.adapters.status.upsert("telegram", "existing", {
        accountId: "existing",
        connected: true,
        authenticated: true,
      });
      recordAdapterStatusTransition(transportOffline, reconnected, ctx);

      expect(ctx.responsibilities.list({
        ownerUid: 1000,
        includeTerminal: true,
      }).records.some((record) => record.source.kind === "event"
        && record.source.eventType === "adapter.connected")).toBe(false);
    });
  });

  it("remembers first readiness while connected responsibilities are disabled", async () => {
    await runWithRealKernelSql((sql, storage) => {
      const ctx = lifecycleContext(sql, storage);
      ctx.adapters.status.setOwner("telegram", "disabled", 1000);
      ctx.responsibilitySources.set(1000, "adapter.connected", false);
      const initial = ctx.adapters.status.get("telegram", "disabled");
      const connected = ctx.adapters.status.upsert("telegram", "disabled", {
        accountId: "disabled",
        connected: true,
        authenticated: true,
      });
      recordAdapterStatusTransition(initial, connected, ctx);
      expect(ctx.adapters.status.get("telegram", "disabled")?.readyOwnerUid).toBe(1000);

      ctx.responsibilitySources.set(1000, "adapter.connected", true);
      const transportOffline = ctx.adapters.status.upsert("telegram", "disabled", {
        accountId: "disabled",
        connected: false,
        authenticated: true,
      });
      recordAdapterStatusTransition(connected, transportOffline, ctx);
      const reconnected = ctx.adapters.status.upsert("telegram", "disabled", {
        accountId: "disabled",
        connected: true,
        authenticated: true,
      });
      recordAdapterStatusTransition(transportOffline, reconnected, ctx);

      expect(ctx.responsibilities.list({
        ownerUid: 1000,
        includeTerminal: true,
      }).records.some((record) => record.source.kind === "event"
        && record.source.eventType === "adapter.connected")).toBe(false);
    });
  });

  it("tracks recurring authentication loss and resolves stale recovery work", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const ctx = lifecycleContext(sql, storage);
      const accountId = "primary-🛰️";
      ctx.adapters.status.setOwner("whatsapp", accountId, 1000);
      const initial = ctx.adapters.status.get("whatsapp", accountId);
      const connected = ctx.adapters.status.upsert("whatsapp", accountId, {
        accountId,
        connected: true,
        authenticated: true,
      });
      recordAdapterStatusTransition(initial, connected, ctx);

      const lost = ctx.adapters.status.upsert("whatsapp", accountId, {
        accountId,
        connected: false,
        authenticated: false,
      });
      recordAdapterStatusTransition(connected, lost, ctx);
      const repeated = ctx.adapters.status.upsert("whatsapp", accountId, {
        accountId,
        connected: false,
        authenticated: false,
      });
      recordAdapterStatusTransition(lost, repeated, ctx);

      const restored = ctx.adapters.status.upsert("whatsapp", accountId, {
        accountId,
        connected: true,
        authenticated: true,
      });
      recordAdapterStatusTransition(repeated, restored, ctx);
      const lostAgain = ctx.adapters.status.upsert("whatsapp", accountId, {
        accountId,
        connected: false,
        authenticated: false,
      });
      recordAdapterStatusTransition(restored, lostAgain, ctx);

      const recoveries = ctx.responsibilities.list({
        ownerUid: 1000,
        includeTerminal: true,
      }).records.filter((record) => record.source.kind === "event"
        && record.source.eventType === "adapter.auth_required");
      expect(recoveries).toHaveLength(2);
      expect(recoveries.map((record) => record.state).sort()).toEqual([
        "open",
        "resolved",
      ]);
      expect(recoveries.find((record) => record.state === "resolved")?.resolution)
        .toMatchObject({ eventType: "adapter.authentication_restored" });
    });
  });

  it("cancels authentication recovery after an explicit adapter disconnect", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const ctx = lifecycleContext(sql, storage);
      ctx.adapters.status.setOwner("discord", "primary", 1000);
      const initial = ctx.adapters.status.get("discord", "primary");
      const connected = ctx.adapters.status.upsert("discord", "primary", {
        accountId: "primary",
        connected: true,
        authenticated: true,
      });
      recordAdapterStatusTransition(initial, connected, ctx);
      const lost = ctx.adapters.status.upsert("discord", "primary", {
        accountId: "primary",
        connected: false,
        authenticated: false,
      });
      recordAdapterStatusTransition(connected, lost, ctx);
      const disconnected = ctx.adapters.status.upsert("discord", "primary", {
        accountId: "primary",
        connected: false,
        authenticated: false,
      });

      recordAdapterStatusTransition(lost, disconnected, ctx, {
        suppressAuthenticationRequired: true,
        intentionalDisconnect: true,
      });

      const recovery = ctx.responsibilities.list({
        ownerUid: 1000,
        includeTerminal: true,
      }).records.find((record) => record.source.kind === "event"
        && record.source.eventType === "adapter.auth_required");
      expect(recovery).toMatchObject({
        state: "cancelled",
        resolution: {
          eventType: "adapter.disconnected",
          adapter: "discord",
          accountId: "primary",
        },
      });
    });
  });
});

function lifecycleContext(
  sql: SqlStorage,
  storage: DurableObjectStorage,
): KernelContext {
  // SAFETY: the lifecycle helpers use only the concrete Kernel fields supplied by this fixture.
  return {
    auth: {
      isPersonalAgentUid: vi.fn(() => false),
    },
    adapters: new AdapterStore(sql),
    responsibilities: new ResponsibilityStore(storage),
    responsibilitySources: new ResponsibilitySourcePolicyStore(sql),
    reconcileResponsibilityWake: vi.fn(async () => undefined),
    defer: vi.fn((promise: Promise<unknown>) => {
      void promise;
    }),
  } as KernelContext;
}

function contactRecord(
  overrides: Partial<FederationContactRecord> = {},
): FederationContactRecord {
  return {
    id: "contact:remote",
    ownerUid: 1000,
    state: "active",
    generation: "generation:remote",
    remoteShipId: "ship:remote",
    remoteSubject: {
      id: "subject:remote",
      displayName: "Remote Person",
    },
    remoteOrigin: "https://remote.example",
    remotePublicKey: {
      kty: "EC",
      crv: "P-256",
      x: "remote-x",
      y: "remote-y",
    },
    sharedSecret: "shared-secret",
    conversationId: "conversation:remote",
    threadId: "thread:remote",
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}
