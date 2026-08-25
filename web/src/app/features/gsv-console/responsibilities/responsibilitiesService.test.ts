import { describe, expect, it, vi } from "vitest";
import type { GSVClient } from "@humansandmachines/gsv/client";

import {
  loadResponsibilitiesWorkspace,
  mutateResponsibilitiesWorkspace,
} from "./responsibilitiesService";

describe("responsibilitiesService", () => {
  it("loads open/history, source policies, and only recurring Ship schedules", async () => {
    const listResponsibilities = vi.fn<GSVClient["r12y"]["list"]>(async () => ({
      responsibilities: [],
      count: 0,
      revision: 1,
    }));
    const listSources = vi.fn<GSVClient["r12y"]["source"]["list"]>(async () => ({
      sources: [
        {
          id: "interaction.response",
          name: "Conversation replies",
          description: "Keep direct interactions active until they are answered or silenced.",
          control: "required",
          enabled: true,
          defaultEnabled: true,
        },
        {
          id: "mail.received",
          name: "Incoming mail",
          description: "Create a responsibility when mail arrives.",
          control: "configurable",
          enabled: true,
          defaultEnabled: true,
        },
      ],
    }));
    const listSchedules = vi.fn<GSVClient["sched"]["list"]>(async () => ({
        schedules: [
          schedule("recurring", { kind: "responsibility", message: "Review" }, { kind: "every", everyMs: 60_000 }),
          schedule("one-shot", { kind: "responsibility", message: "Review" }, { kind: "after", afterMs: 60_000 }),
          schedule("worker", { kind: "process.event", pid: "proc:worker", message: "Continue" }, { kind: "every", everyMs: 60_000 }),
        ],
        count: 3,
    }));
    const client = {
      r12y: {
        list: listResponsibilities,
        source: { list: listSources, update: vi.fn() },
      },
      sched: {
        add: vi.fn(),
        list: listSchedules,
        remove: vi.fn(),
        update: vi.fn(),
      },
    } satisfies Parameters<typeof loadResponsibilitiesWorkspace>[0];

    const workspace = await loadResponsibilitiesWorkspace(client);

    expect(workspace.sources.map((source) => source.id)).toEqual([
      "interaction.response",
      "mail.received",
    ]);
    expect(workspace.schedules.map((schedule) => schedule.id)).toEqual(["recurring"]);
    expect(listResponsibilities).toHaveBeenCalledWith(expect.objectContaining({ states: ["open", "active", "waiting"] }));
    expect(listResponsibilities).toHaveBeenCalledWith(expect.objectContaining({ states: ["resolved", "cancelled"] }));
  });

  it("creates recurring schedules as responsibility targets", async () => {
    const add = vi.fn<GSVClient["sched"]["add"]>(async () => ({ schedule: schedule(
      "created",
      { kind: "responsibility", message: "Check for new patch notes." },
      { kind: "cron", expr: "0 9 * * *", timezone: "UTC" },
    ) }));
    const client = {
      r12y: {
        list: vi.fn(),
        source: { list: vi.fn(), update: vi.fn() },
      },
      sched: {
        add,
        list: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
      },
    } satisfies Parameters<typeof mutateResponsibilitiesWorkspace>[0];

    await mutateResponsibilitiesWorkspace(client, {
      kind: "schedule.save",
      input: {
        name: "Patch notes",
        instructions: "Check for new patch notes.",
        expression: { kind: "cron", expr: "0 9 * * *", timezone: "UTC" },
        enabled: true,
      },
    });

    expect(add).toHaveBeenCalledWith({
      name: "Patch notes",
      enabled: true,
      expression: { kind: "cron", expr: "0 9 * * *", timezone: "UTC" },
      target: { kind: "responsibility", message: "Check for new patch notes." },
    });
  });
});

function schedule(
  id: string,
  target: Parameters<GSVClient["sched"]["add"]>[0]["target"],
  expression: Parameters<GSVClient["sched"]["add"]>[0]["expression"],
) {
  return {
    id,
    ownerUid: 1000,
    creator: { kind: "user" as const, uid: 1000, username: "hank" },
    runAs: { kind: "user" as const, uid: 1000, username: "hank" },
    name: id,
    enabled: true,
    expression,
    target,
    overlapPolicy: "skip" as const,
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {
      nextRunAtMs: 2,
      runningAtMs: null,
      lastRunAtMs: null,
      lastStatus: null,
      lastError: null,
      lastDurationMs: null,
      runCount: 0,
    },
  };
}
