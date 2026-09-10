import type { ScheduleExpression, ScheduleRecord, SchedulerAddArgs, SchedulerUpdateArgs } from "@humansandmachines/gsv/protocol";

export type RoutineDraft = {
  name: string;
  message: string;
  enabled: boolean;
  cadence: "daily" | "weekly" | "every" | "cron";
  time: string;
  day: string;
  interval: string;
  unit: string;
  cron: string;
  timezone: string;
};

export function routineDraft(schedule?: ScheduleRecord, timezone = "UTC"): RoutineDraft {
  const draft: RoutineDraft = {
    name: schedule?.name ?? "", message: schedule?.target.kind === "responsibility" ? schedule.target.message : "",
    enabled: schedule?.enabled ?? true, cadence: "daily", time: "09:00", day: "1", interval: "1", unit: "3600000", cron: "0 9 * * *", timezone,
  };
  const expression = schedule?.expression;
  if (expression?.kind === "cron") {
    draft.timezone = expression.timezone;
    draft.cron = expression.expr;
    const simple = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(expression.expr);
    if (simple) {
      draft.cadence = simple[3] === "*" ? "daily" : "weekly";
      draft.time = `${simple[2].padStart(2, "0")}:${simple[1].padStart(2, "0")}`;
      draft.day = simple[3] === "*" ? "1" : simple[3];
    } else draft.cadence = "cron";
  } else if (expression?.kind === "every") {
    draft.cadence = "every";
    const unit = [86_400_000, 3_600_000, 60_000, 1000].find((value) => expression.everyMs % value === 0) ?? 1000;
    draft.interval = String(expression.everyMs / unit);
    draft.unit = String(unit);
  }
  return draft;
}

export function routineInput(draft: RoutineDraft, original?: ScheduleRecord): SchedulerAddArgs {
  const name = draft.name.trim();
  const message = draft.message.trim();
  if (!name || !message) throw new Error("Give the routine a name and something for Ship to do.");
  let expression: ScheduleExpression;
  if (draft.cadence === "every") {
    const everyMs = Number(draft.interval) * Number(draft.unit);
    if (!Number.isSafeInteger(everyMs) || everyMs < 1000) throw new Error("Choose an interval of at least one second.");
    expression = { kind: "every", everyMs, ...(original?.expression.kind === "every" && original.expression.anchorMs !== undefined ? { anchorMs: original.expression.anchorMs } : {}) };
  } else {
    const timezone = draft.timezone.trim();
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { throw new Error("Choose a valid timezone, such as Europe/Amsterdam."); }
    let expr = draft.cron.trim();
    if (draft.cadence !== "cron") {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) throw new Error("Choose a time for this routine.");
      const [hour, minute] = draft.time.split(":").map(Number);
      expr = `${minute} ${hour} * * ${draft.cadence === "weekly" ? draft.day : "*"}`;
    }
    if (expr.split(/\s+/).length !== 5) throw new Error("A custom schedule needs five cron fields.");
    expression = { kind: "cron", expr, timezone };
  }
  return { name, enabled: draft.enabled, expression, target: { ...(original?.target.kind === "responsibility" ? original.target : {}), kind: "responsibility", message } };
}

export function routineEditable(schedule: ScheduleRecord): boolean {
  return schedule.target.kind === "responsibility" && (schedule.expression.kind === "every" || schedule.expression.kind === "cron");
}

/** Only settings belong to an editor's snapshot; a scheduled run also changes updatedAtMs. */
export function routineSettings(schedule: ScheduleRecord): string {
  return JSON.stringify({ name: schedule.name, description: schedule.description, enabled: schedule.enabled, expression: schedule.expression, target: schedule.target });
}

export function routinePatch(input: SchedulerAddArgs): SchedulerUpdateArgs["patch"] {
  return { name: input.name, enabled: input.enabled, expression: input.expression, target: input.target };
}

export function cadenceLabel(expression: ScheduleExpression): string {
  if (expression.kind === "at") return "once";
  if (expression.kind === "after") return "once, after a delay";
  if (expression.kind === "every") {
    const [unit, size] = expression.everyMs % 86_400_000 === 0 ? ["day", 86_400_000] as const
      : expression.everyMs % 3_600_000 === 0 ? ["hour", 3_600_000] as const
      : expression.everyMs % 60_000 === 0 ? ["minute", 60_000] as const : ["second", 1000] as const;
    const count = expression.everyMs / size;
    return count === 1 ? `every ${unit}` : `every ${count} ${unit}s`;
  }
  const simple = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(expression.expr);
  if (!simple) return `${expression.expr} · ${expression.timezone}`;
  const day = simple[3] === "*" ? "daily" : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Number(simple[3])];
  return `${day} at ${simple[2].padStart(2, "0")}:${simple[1].padStart(2, "0")} · ${expression.timezone}`;
}
