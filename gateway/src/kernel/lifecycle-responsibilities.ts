import type { KernelContext } from "./context";
import type { DeviceRecord } from "./devices";
import type { AdapterStatusRecord } from "./adapter-status";
import { stableOpaqueId } from "../shared/stable-id";

type AdapterTransitionOptions = {
  suppressAuthenticationRequired?: boolean;
};

export async function recordMachineAddedResponsibility(
  machine: DeviceRecord,
  ctx: KernelContext,
): Promise<void> {
  const ownerUid = humanOwnerUid(machine.owner_uid, ctx);
  if (
    ownerUid === null
    || !ctx.responsibilitySources.isEnabled(ownerUid, "machine.added")
  ) {
    return;
  }

  const eventId = await stableOpaqueId("machine-added", [
    machine.device_id,
    machine.first_seen_at,
  ]);
  const outcome = ctx.responsibilities.create({
    ownerUid,
    title: "Confirm that a new machine is connected",
    details: {
      eventType: "machine.added",
      deviceId: boundedUntrustedText(machine.device_id, 512),
      label: boundedUntrustedText(machine.label, 512),
      platform: boundedUntrustedText(machine.platform, 128),
      version: boundedUntrustedText(machine.version, 128),
      firstSeenAt: machine.first_seen_at,
      contentTrust: "untrusted",
    },
    source: {
      kind: "event",
      eventType: "machine.added",
      eventId,
    },
    assignee: { kind: "ship" },
    state: "open",
    priority: "normal",
    dedupeKey: `machine.added:${eventId}`,
    actor: { kind: "system", component: "device-lifecycle" },
    observedByShip: false,
    now: machine.first_seen_at,
  });
  if (outcome.created) scheduleLifecycleWake(ownerUid, ctx);
}

export function recordAdapterStatusTransition(
  previous: AdapterStatusRecord | null,
  current: AdapterStatusRecord,
  ctx: KernelContext,
  options: AdapterTransitionOptions = {},
): void {
  const ownerUid = humanOwnerUid(current.ownerUid, ctx);
  if (ownerUid === null) return;

  const identity = current.lifecycleId;
  const authenticationPrefix = `adapter.auth_required:${identity}:`;
  let changed = false;

  if (current.authenticated) {
    for (const responsibility of ctx.responsibilities.listActiveByDedupeKeyPrefix(
      ownerUid,
      authenticationPrefix,
    )) {
      const outcome = ctx.responsibilities.update({
        ownerUid,
        id: responsibility.id,
        patch: {
          state: "resolved",
          resolution: {
            eventType: "adapter.authentication_restored",
            adapter: boundedUntrustedText(current.adapter, 128),
            accountId: boundedUntrustedText(current.accountId, 512),
            restoredAt: current.updatedAt,
          },
        },
        actor: { kind: "system", component: "adapter-lifecycle" },
        observedByShip: false,
        now: current.updatedAt,
      });
      changed ||= outcome.changed;
    }
  }

  const wasReady = previous?.ownerUid === ownerUid
    && previous.connected
    && previous.authenticated;
  const isReady = current.connected && current.authenticated;
  if (
    isReady
    && !wasReady
    && ctx.responsibilitySources.isEnabled(ownerUid, "adapter.connected")
  ) {
    const dedupeKey = `adapter.connected:${identity}`;
    const outcome = ctx.responsibilities.create({
      ownerUid,
      title: "Confirm that a messaging adapter is connected",
      details: {
        eventType: "adapter.connected",
        adapter: boundedUntrustedText(current.adapter, 128),
        accountId: boundedUntrustedText(current.accountId, 512),
        connectedAt: current.updatedAt,
        contentTrust: "untrusted",
      },
      source: {
        kind: "event",
        eventType: "adapter.connected",
        eventId: dedupeKey,
      },
      assignee: { kind: "ship" },
      state: "open",
      priority: "normal",
      dedupeKey,
      actor: { kind: "system", component: "adapter-lifecycle" },
      observedByShip: false,
      now: current.updatedAt,
    });
    changed ||= outcome.created;
  }

  const authenticationLost = previous?.ownerUid === ownerUid
    && previous.authenticated
    && !current.authenticated;
  if (
    authenticationLost
    && !options.suppressAuthenticationRequired
    && ctx.responsibilitySources.isEnabled(ownerUid, "adapter.auth_required")
    && ctx.responsibilities.listActiveByDedupeKeyPrefix(
      ownerUid,
      authenticationPrefix,
    ).length === 0
  ) {
    const baseDedupeKey = `${authenticationPrefix}${current.updatedAt}`;
    const dedupeKey = ctx.responsibilities.getByDedupeKey(ownerUid, baseDedupeKey)
      ? `${baseDedupeKey}:${crypto.randomUUID()}`
      : baseDedupeKey;
    const outcome = ctx.responsibilities.create({
      ownerUid,
      title: "Restore authentication for a messaging adapter",
      details: {
        eventType: "adapter.auth_required",
        adapter: boundedUntrustedText(current.adapter, 128),
        accountId: boundedUntrustedText(current.accountId, 512),
        detectedAt: current.updatedAt,
        contentTrust: "untrusted",
      },
      source: {
        kind: "event",
        eventType: "adapter.auth_required",
        eventId: dedupeKey,
      },
      assignee: { kind: "ship" },
      state: "open",
      priority: "high",
      dedupeKey,
      actor: { kind: "system", component: "adapter-lifecycle" },
      observedByShip: false,
      now: current.updatedAt,
    });
    changed ||= outcome.created;
  }

  if (changed) scheduleLifecycleWake(ownerUid, ctx);
}

function humanOwnerUid(ownerUid: number | null, ctx: KernelContext): number | null {
  if (
    ownerUid === null
    || ownerUid < 1_000
    || ctx.auth.isPersonalAgentUid(ownerUid)
  ) {
    return null;
  }
  return ownerUid;
}

function scheduleLifecycleWake(ownerUid: number, ctx: KernelContext): void {
  ctx.defer(ctx.reconcileResponsibilityWake(ownerUid).catch(() => {
    console.warn("[Kernel] Failed to schedule lifecycle responsibility wake");
  }));
}

function boundedUntrustedText(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let bounded = "";
  for (const character of value) {
    if (encoder.encode(bounded + character).byteLength > maxBytes) break;
    bounded += character;
  }
  return bounded;
}
