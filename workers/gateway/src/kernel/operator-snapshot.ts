import type { OperatorShipSnapshot } from "@humansandmachines/gsv/services/operator";
import type { ProcessOperatorSummary } from "../process/operator-summary";
import type { IdentityLinkStore } from "./identity-links";
import type { ProcessRegistry } from "./processes";
import type { ResponsibilityStore } from "./responsibility-store";
import type { ShipEventStore } from "./ship-event-store";
import type { TargetRegistry } from "./target-registry";

export type OperatorSnapshotSources = {
  installationId: string;
  procs: ProcessRegistry;
  identityLinks: Pick<IdentityLinkStore, "list">;
  targets: Pick<TargetRegistry, "listForUser">;
  responsibilities: Pick<ResponsibilityStore, "list">;
  shipEvents: Pick<ShipEventStore, "backlog">;
  /** Asks the Ship's Process for its recent runs; null when it cannot answer. */
  shipSummary(pid: string): Promise<ProcessOperatorSummary | null>;
  now(): number;
};

/**
 * Assembles the operator view of a Ship from Kernel state and the Ship's own
 * Process. Every field is a count, time, name or outcome; nothing here reads
 * message text, actor identifiers, device names or tool data.
 */
export async function buildOperatorShipSnapshot(sources: OperatorSnapshotSources): Promise<OperatorShipSnapshot> {
  const processes = sources.procs.list();
  const ship = processes.find((process) => process.isPersonalController) ?? null;
  const summary = ship ? await sources.shipSummary(ship.processId).catch(() => null) : null;
  const ownerUid = ship?.ownerUid ?? null;
  const devices = sources.targets.listForUser(0, [])
    .sort((left, right) => left.first_seen_at - right.first_seen_at || left.target_id.localeCompare(right.target_id))
    .slice(0, 50);
  // Device names often carry a person's or employer's name, so operators see a
  // label numbered by first connection instead.
  const deviceLabels = new Map(devices.map((device, index) => [device.target_id, `Device ${index + 1}`]));
  const deviceLabel = (targetId: string) => targetId === "gsv" ? "gsv" : deviceLabels.get(targetId) ?? "Other device";
  return {
    version: 1,
    installationId: sources.installationId,
    capturedAt: sources.now(),
    ship: ship
      ? {
          pid: ship.processId,
          state: ship.state,
          lastActiveAt: ship.lastActiveAt,
          activeRunId: ship.activeRunId,
          queuedCount: ship.queuedCount,
          pendingApprovals: summary?.pendingApprovals ?? 0,
          lastCompactionAt: summary?.lastCompactionAt ?? null,
        }
      : null,
    processes: {
      total: processes.length,
      running: processes.filter((process) => process.state !== "idle").length,
    },
    runs: (summary?.runs ?? []).map((run) => ({
      ...run,
      steps: run.steps.map((step) => step.target === undefined ? step : { ...step, target: deviceLabel(step.target) }),
    })),
    messengers: sources.identityLinks.list().slice(0, 50).map((link) => ({
      adapter: link.adapter,
      linkedAt: link.createdAt,
    })),
    targets: devices.map((target) => ({
      id: deviceLabel(target.target_id),
      online: target.online,
      lastSeenAt: target.last_seen_at,
    })),
    shipEvents: ownerUid === null ? { queued: 0, oldestQueuedAt: null } : sources.shipEvents.backlog(ownerUid),
    openResponsibilities: ownerUid === null ? 0 : sources.responsibilities.list({ ownerUid, limit: 1 }).count,
  };
}
