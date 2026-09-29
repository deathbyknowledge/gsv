import { describe, expect, it } from "vitest";
import type { ScheduleRecord } from "@humansandmachines/gsv/protocol";
import { cadenceLabel, routineDraft, routineInput, routineSettings } from "./routineModel";

const original: ScheduleRecord = {
  id: "routine:one", ownerUid: 1000, name: "Morning", enabled: true,
  creator: { kind: "user", uid: 1000, username: "hank" }, runAs: { kind: "user", uid: 1000, username: "hank" },
  description: "Keep this description", target: { kind: "responsibility", message: "Check the news", data: { region: "NL" }, priority: "high" },
  expression: { kind: "cron", expr: "30 9 * * 1", timezone: "Europe/Amsterdam" }, overlapPolicy: "skip", createdAtMs: 1, updatedAtMs: 1,
  state: { nextRunAtMs: 100, runningAtMs: null, lastRunAtMs: null, lastStatus: null, lastError: null, lastDurationMs: null, runCount: 0 },
};
describe("routine editing", () => {
  it("round-trips a weekly routine and retains target data, priority, and timezone", () => {
    const draft = routineDraft(original, "America/New_York");
    expect(draft).toMatchObject({ cadence: "weekly", day: "1", time: "09:30", timezone: "Europe/Amsterdam" });
    expect(routineInput({ ...draft, name: "Updated" }, original)).toMatchObject({ name: "Updated", target: original.target, expression: original.expression });
    expect(cadenceLabel(original.expression)).toBe("Monday at 09:30 · Europe/Amsterdam");
  });
  it("preserves interval anchors and custom cron expressions", () => {
    for (const expression of [{ kind: "every", everyMs: 5_400_000, anchorMs: 50 }, { kind: "cron", expr: "*/15 8-18 * * 1-5", timezone: "Europe/Amsterdam" }] as const) {
      const schedule = { ...original, expression };
      expect(routineInput(routineDraft(schedule), schedule).expression).toEqual(expression);
    }
  });
  it("distinguishes edited definitions from background run bookkeeping", () => {
    expect(routineSettings({ ...original, updatedAtMs: 500, state: { ...original.state, runCount: 1 } })).toBe(routineSettings(original));
    expect(routineSettings({ ...original, enabled: false })).not.toBe(routineSettings(original));
  });
  it("rejects empty instructions, invalid timezones and invalid intervals", () => {
    expect(() => routineInput({ ...routineDraft(original), message: " " })).toThrow("something for Ship");
    expect(() => routineInput({ ...routineDraft(original), timezone: "Somewhere/Nope" })).toThrow("timezone");
    expect(() => routineInput({ ...routineDraft(original), cadence: "every", interval: "0" })).toThrow("interval");
  });
});
