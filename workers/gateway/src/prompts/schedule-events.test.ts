import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessScheduleDeliverArgs } from "../protocol/process-frames";
import { formatScheduleEventMessage } from "./schedule-events";

const BASE: ProcessScheduleDeliverArgs = {
  runId: "run:schedule", scheduleId: "schedule:golden", scheduleName: "Synthetic reminder",
  message: "Inspect the fixture.", data: { count: 2 }, scheduledAtMs: 1_699_999_999_500, firedAtMs: 1_700_000_000_000,
  replyTo: {
    kind: "adapter", adapter: "slack", accountId: "account:fixture", actorId: "actor:fixture",
    surface: { kind: "thread", id: "surface:fixture", threadId: "thread:fixture" },
  },
};

afterEach(() => { vi.restoreAllMocks(); });

describe("schedule event prompt", () => {
  it("renders the approved schedule sample without a model event marker or payload mutation", () => {
    const before = structuredClone(BASE);
    expect(formatScheduleEventMessage(BASE)).toBe([
      "Schedule `Synthetic reminder` fired.",
      "ID: `schedule:golden`",
      "Reply destination: this Slack thread.",
      "Scheduled: 2023-11-14T22:13:19.500Z",
      "Fired: 2023-11-14T22:13:20.000Z",
      "",
      "Inspect the fixture.",
      "",
      "Data:",
      "```json",
      "{",
      '  "count": 2',
      "}",
      "```",
    ].join("\n"));
    expect(BASE).toEqual(before);
  });

  it("omits an unspecified reply destination and preserves absent-name and blank-message fallbacks", () => {
    expect(formatScheduleEventMessage({
      runId: "run:local", scheduleId: " ", scheduleName: "\t", message: "\n", firedAtMs: 0,
    })).toBe([
      "Schedule fired.",
      "Fired: 1970-01-01T00:00:00.000Z",
      "",
      "Scheduled event fired.",
    ].join("\n"));
  });

  it("trims only the existing optional string fields and retains empty or nested JSON data", () => {
    const value = { ...BASE, scheduleId: " schedule:trimmed ", scheduleName: " Name ", message: " Message ", data: {} };
    const empty = formatScheduleEventMessage(value);
    expect(empty).toContain("Schedule `Name` fired.\nID: `schedule:trimmed`");
    expect(empty).toContain("\n\nMessage\n\nData:\n```json\n{}\n```");
    const data = { literal: '{"ok":false}', values: [null, false, 0, "", { multiline: "one\ntwo" }] };
    expect(formatScheduleEventMessage({ ...BASE, data })).toContain(`Data:\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``);
    expect(value.scheduleName).toBe(" Name ");
  });

  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY])("omits an unavailable scheduled timestamp: %s", (scheduledAtMs) => {
    const output = formatScheduleEventMessage({ ...BASE, scheduledAtMs, data: undefined });
    expect(output).not.toContain("Scheduled:");
    expect(output).toContain("Fired: 2023-11-14T22:13:20.000Z");
    expect(output).not.toContain("Data:");
  });

  it("retains finite pre-epoch schedule times and uses the clock only for an invalid fired time", () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const output = formatScheduleEventMessage({ ...BASE, scheduledAtMs: -1, firedAtMs: Number.NaN });
    expect(output).toContain("Scheduled: 1969-12-31T23:59:59.999Z\nFired: 1970-01-01T00:00:02.000Z");
  });

  it.each([
    { adapter: "whatsapp", kind: "dm", description: "this WhatsApp direct message" },
    { adapter: "custom-adapter", kind: "channel", description: "this Custom-adapter channel" },
  ] as const)("uses the shared destination wording for $adapter", ({ adapter, kind, description }) => {
    const output = formatScheduleEventMessage({
      ...BASE, replyTo: { kind: "adapter", adapter, accountId: "account:fixture", actorId: "actor:fixture", surface: { kind, id: "surface:fixture" } },
    });
    expect(output).toContain(`Reply destination: ${description}.`);
  });
});
