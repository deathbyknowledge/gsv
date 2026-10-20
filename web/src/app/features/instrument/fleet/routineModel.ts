import type { ScheduleExpression, ScheduleRecord, SchedulerAddArgs, SchedulerUpdateArgs } from "@humansandmachines/gsv/protocol";
import { t, type TextKey } from "../../../i18n/locale";

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
  if (!name || !message) throw new Error(t("fleet.routine.incomplete"));
  let expression: ScheduleExpression;
  if (draft.cadence === "every") {
    const everyMs = Number(draft.interval) * Number(draft.unit);
    if (!Number.isSafeInteger(everyMs) || everyMs < 1000) throw new Error(t("fleet.routine.shortInterval"));
    expression = { kind: "every", everyMs };
    if (original?.expression.kind === "every" && original.expression.anchorMs !== undefined) expression.anchorMs = original.expression.anchorMs;
  } else {
    const timezone = draft.timezone.trim();
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { throw new Error(t("settings.timezone.invalid")); }
    let expr = draft.cron.trim();
    if (draft.cadence !== "cron") {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) throw new Error(t("fleet.routine.noTime"));
      const [hour, minute] = draft.time.split(":").map(Number);
      expr = `${minute} ${hour} * * ${draft.cadence === "weekly" ? draft.day : "*"}`;
    }
    if (expr.split(/\s+/).length !== 5) throw new Error(t("fleet.routine.cronFieldCount"));
    expression = { kind: "cron", expr, timezone };
  }
  const target = original?.target.kind === "responsibility" ? { ...original.target, message } : { kind: "responsibility" as const, message };
  return { name, enabled: draft.enabled, expression, target };
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

/** The days of the week from Sunday, as cron numbers them. */
export const WEEKDAYS = [
  "fleet.weekday.sunday", "fleet.weekday.monday", "fleet.weekday.tuesday", "fleet.weekday.wednesday",
  "fleet.weekday.thursday", "fleet.weekday.friday", "fleet.weekday.saturday",
] as const satisfies readonly TextKey[];

const WEEKLY_CADENCES = [
  "fleet.cadence.sundays", "fleet.cadence.mondays", "fleet.cadence.tuesdays", "fleet.cadence.wednesdays",
  "fleet.cadence.thursdays", "fleet.cadence.fridays", "fleet.cadence.saturdays",
] as const satisfies readonly TextKey[];

const INTERVALS = [
  { size: 86_400_000, one: "fleet.cadence.everyDay", many: "fleet.cadence.everyDays" },
  { size: 3_600_000, one: "fleet.cadence.everyHour", many: "fleet.cadence.everyHours" },
  { size: 60_000, one: "fleet.cadence.everyMinute", many: "fleet.cadence.everyMinutes" },
  { size: 1000, one: "fleet.cadence.everySecond", many: "fleet.cadence.everySeconds" },
] as const;

export function cadenceLabel(expression: ScheduleExpression): string {
  if (expression.kind === "at") return t("fleet.cadence.once");
  if (expression.kind === "after") return t("fleet.cadence.afterDelay");
  if (expression.kind === "every") {
    const interval = INTERVALS.find(({ size }) => expression.everyMs % size === 0) ?? INTERVALS[3];
    const count = expression.everyMs / interval.size;
    return count === 1 ? t(interval.one) : t(interval.many, { count });
  }
  const simple = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(expression.expr);
  if (!simple) return `${expression.expr} · ${expression.timezone}`;
  const values = { time: `${simple[2].padStart(2, "0")}:${simple[1].padStart(2, "0")}`, timezone: expression.timezone };
  return t(simple[3] === "*" ? "fleet.cadence.daily" : WEEKLY_CADENCES[Number(simple[3])], values);
}
