import { describe, expect, it, vi } from "vitest";
import type { ProcessRecord } from "./processes";
import { buildOperatorShipSnapshot, type OperatorSnapshotSources } from "./operator-snapshot";

function process(fields: Partial<ProcessRecord>): ProcessRecord {
  return {
    processId: "proc:crew", parentPid: null, uid: 1002, ownerUid: 1000, interactive: false, isPersonalController: false,
    gid: 1000, gids: [1000], username: "crew", home: "/home/crew", cwd: "/home/crew", state: "idle",
    activeRunId: null, queuedCount: 0, lastActiveAt: 10, label: "Memory review", createdAt: 1, ...fields,
  };
}

function sources(processes: ProcessRecord[], summary = vi.fn(async () => ({
  pendingApprovals: 1, lastCompactionAt: 500, runs: [],
}))): OperatorSnapshotSources {
  return {
    installationId: "inst_snapshot",
    // SAFETY: the snapshot reads only the registry's list.
    procs: { list: () => processes } as never,
    identityLinks: { list: () => [{
      adapter: "whatsapp", accountId: "managed", actorId: "34690104444", uid: 1000, createdAt: 42, linkedByUid: 1000, metadata: null,
    }] },
    targets: { listForUser: () => [{
      target_id: "macbook-air", owner_uid: 1000, label: "Mac", description: "", implements: [], platform: "darwin", version: "1",
      online: true, first_seen_at: 1, last_seen_at: 99, connected_at: 2, disconnected_at: null,
    }] },
    // SAFETY: the snapshot reads only the open count.
    responsibilities: { list: () => ({ records: [], count: 3, revision: 1 }) } as never,
    shipEvents: { backlog: () => ({ queued: 2, oldestQueuedAt: 77 }) },
    shipSummary: summary,
    now: () => 1_000,
  };
}

describe("operator Ship snapshot", () => {
  it("assembles Kernel state and the Ship's own summary without identifying the people it talks to", async () => {
    const ship = process({ processId: "proc:ship", isPersonalController: true, state: "running", activeRunId: "run-1", queuedCount: 1 });
    const summary = vi.fn(async () => ({ pendingApprovals: 1, lastCompactionAt: 500, runs: [] }));
    const snapshot = await buildOperatorShipSnapshot(sources([ship, process({})], summary));
    expect(summary).toHaveBeenCalledWith("proc:ship");
    expect(snapshot).toEqual({
      version: 1, installationId: "inst_snapshot", capturedAt: 1_000,
      ship: { pid: "proc:ship", state: "running", lastActiveAt: 10, activeRunId: "run-1", queuedCount: 1, pendingApprovals: 1, lastCompactionAt: 500 },
      processes: { total: 2, running: 1 },
      runs: [],
      messengers: [{ adapter: "whatsapp", linkedAt: 42 }],
      targets: [{ id: "macbook-air", online: true, lastSeenAt: 99 }],
      shipEvents: { queued: 2, oldestQueuedAt: 77 },
      openResponsibilities: 3,
    });
    expect(JSON.stringify(snapshot)).not.toContain("34690104444");
  });

  it("still answers when the Ship's Process cannot", async () => {
    const ship = process({ processId: "proc:ship", isPersonalController: true });
    const snapshot = await buildOperatorShipSnapshot(sources([ship], vi.fn(async () => { throw new Error("Process unavailable"); })));
    expect(snapshot.ship).toMatchObject({ pid: "proc:ship", pendingApprovals: 0, lastCompactionAt: null });
    expect(snapshot.runs).toEqual([]);
  });

  it("reports a space without a Ship", async () => {
    const snapshot = await buildOperatorShipSnapshot(sources([]));
    expect(snapshot).toMatchObject({ ship: null, shipEvents: { queued: 0, oldestQueuedAt: null }, openResponsibilities: 0 });
  });
});
