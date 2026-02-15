import { describe, expect, it } from "vitest";
import {
  normalizeCronToolJobCreateInput,
  normalizeCronToolJobPatchInput,
  normalizeCronToolScheduleInput,
} from "./tool-input";

describe("cron tool input normalization", () => {
  it("parses one-shot local datetime strings in user timezone", () => {
    const schedule = normalizeCronToolScheduleInput(
      { kind: "at", at: "2026-02-14 09:30" },
      "America/Chicago",
      Date.UTC(2026, 1, 13, 0, 0, 0, 0),
    );

    expect(schedule).toEqual({
      kind: "at",
      atMs: Date.UTC(2026, 1, 14, 15, 30, 0, 0),
    });
  });

  it("parses one-shot relative datetime strings", () => {
    const nowMs = Date.UTC(2026, 1, 13, 12, 0, 0, 0);
    const schedule = normalizeCronToolScheduleInput(
      { kind: "at", at: "in 2 hours" },
      "UTC",
      nowMs,
    );

    expect(schedule).toEqual({
      kind: "at",
      atMs: nowMs + 2 * 3_600_000,
    });
  });

  it("supports everyMinutes and anchor datetime input", () => {
    const schedule = normalizeCronToolScheduleInput(
      {
        kind: "every",
        everyMinutes: 15,
        anchor: "2026-02-14T09:00",
      },
      "UTC",
      Date.UTC(2026, 1, 13, 0, 0, 0, 0),
    );

    expect(schedule).toEqual({
      kind: "every",
      everyMs: 15 * 60_000,
      anchorMs: Date.UTC(2026, 1, 14, 9, 0, 0, 0),
    });
  });

  it("defaults cron timezone to user timezone", () => {
    const schedule = normalizeCronToolScheduleInput(
      {
        kind: "cron",
        expr: "0 9 * * *",
      },
      "America/Chicago",
    );

    expect(schedule).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
      tz: "America/Chicago",
    });
  });

  it("normalizes create and patch payloads with datetime schedule input", () => {
    const createPayload = normalizeCronToolJobCreateInput(
      {
        name: "Morning check-in",
        schedule: {
          kind: "at",
          at: "tomorrow 9:15am",
        },
        spec: {
          mode: "task",
          message: "Send morning summary",
        },
      },
      "America/Chicago",
      Date.UTC(2026, 1, 13, 18, 0, 0, 0),
    );

    expect(createPayload.schedule).toEqual({
      kind: "at",
      atMs: Date.UTC(2026, 1, 14, 15, 15, 0, 0),
    });

    const patchPayload = normalizeCronToolJobPatchInput(
      {
        schedule: {
          kind: "every",
          everyHours: 6,
        },
      },
      "UTC",
      Date.UTC(2026, 1, 13, 0, 0, 0, 0),
    );

    expect(patchPayload.schedule).toEqual({
      kind: "every",
      everyMs: 6 * 3_600_000,
    });
  });
});
