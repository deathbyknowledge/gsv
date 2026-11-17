import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { currentLocale, t, type TextKey } from "../../../i18n/locale";

/** Skipped dates and changes an approval names before it counts the rest. */
const LISTED = 3;
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
/** "The fourth Friday" by its ordinal; Saturday and Sunday take their own forms, as some languages gender weekday names. */
const ORDINALS = new Map<string, { weekday: TextKey; weekend: TextKey }>([
  ["1", { weekday: "chat.hil.repeat.nth.first", weekend: "chat.hil.repeat.nthWeekend.first" }],
  ["2", { weekday: "chat.hil.repeat.nth.second", weekend: "chat.hil.repeat.nthWeekend.second" }],
  ["3", { weekday: "chat.hil.repeat.nth.third", weekend: "chat.hil.repeat.nthWeekend.third" }],
  ["4", { weekday: "chat.hil.repeat.nth.fourth", weekend: "chat.hil.repeat.nthWeekend.fourth" }],
  ["5", { weekday: "chat.hil.repeat.nth.fifth", weekend: "chat.hil.repeat.nthWeekend.fifth" }],
  ["-1", { weekday: "chat.hil.repeat.nth.last", weekend: "chat.hil.repeat.nthWeekend.last" }],
]);

const repeatSchema = z.object({
  freq: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
  interval: z.number().int().min(1),
  byDay: z.array(z.string().regex(/^(?:-1|[1-5])?(?:MO|TU|WE|TH|FR|SA|SU)$/)).optional(),
  byMonthDay: z.array(z.number().int().min(-1).max(31).refine((day) => day !== 0)).optional(),
  byMonth: z.array(z.number().int().min(1).max(12)).optional(),
  count: z.number().int().min(1).optional(),
  until: z.string().optional(),
});
type Repeat = z.infer<typeof repeatSchema>;

const inviteSchema = z.object({
  method: z.enum(["REQUEST", "CANCEL"]),
  title: z.string().optional(),
  allDay: z.boolean(),
  start: z.string(),
  end: z.string().optional(),
  // A zone this device doesn't know leaves the times unlabelled rather than unreadable.
  timeZone: z.string().refine(knownZone).optional().catch(undefined),
  // A rule this client can't say reads as null, so the event still shows that it repeats.
  repeats: repeatSchema.nullable().optional().catch(null),
  skipped: z.array(z.string()).optional(),
  changed: z.array(z.object({ from: z.string(), start: z.string(), end: z.string().optional() })).optional(),
});

/** The event an email invites to or cancels at the times the owner reads them, how it repeats, and its exceptions. */
export function describeInvite(value: JsonValue | undefined): string | null {
  const invite = inviteSchema.safeParse(value);
  if (!invite.success) return null;
  const { method, title, allDay, start, end, timeZone, repeats, skipped = [], changed = [] } = invite.data;
  const event = [title, eventTimes(start, end, allDay, timeZone), repeats === undefined ? undefined : describeRepeat(repeats)];
  const parts = [t(method === "CANCEL" ? "chat.hil.inviteCancel" : "chat.hil.invite", { event: event.filter(Boolean).join(", ") })];
  // A cancellation withdraws every date, so its exceptions no longer matter.
  if (method === "CANCEL") return parts[0];
  if (skipped.length > 0) {
    const dates = skipped.slice(0, LISTED).map(shortDate);
    if (skipped.length > LISTED) dates.push(t("chat.hil.inviteMore", { count: skipped.length - LISTED }));
    parts.push(t("chat.hil.inviteSkipped", { dates: list(dates) }));
  }
  const length = span(start, end);
  for (const change of changed.slice(0, LISTED)) {
    // A changed date can be timed in an all-day series, or all day in a timed one; a date alone says which.
    const changeAllDay = /^\d{4}-\d{2}-\d{2}$/.test(change.start);
    // One that keeps its start and the series' length differs only in what the approval doesn't show.
    parts.push(change.start === change.from && span(change.start, change.end) === length
      ? t("chat.hil.inviteChanged", { date: shortDate(change.from) })
      : t("chat.hil.inviteChangedTo", { from: shortDate(change.from), to: eventTimes(change.start, change.end, changeAllDay, timeZone) }));
  }
  if (changed.length > LISTED) parts.push(t("chat.hil.inviteMoreChanges", { count: changed.length - LISTED }));
  return parts.join(" · ");
}

/** A rule such as "weekly on Monday, until Jun 28, 2027", with the days the Kernel wrote out. */
function describeRepeat(repeats: Repeat | null): string {
  if (!repeats) return t("chat.hil.repeat.unknown");
  const { freq, interval, byDay = [], byMonthDay = [], byMonth = [], count, until } = repeats;
  let rule: string | undefined;
  if (freq === "DAILY") {
    rule = interval === 1 ? t("chat.hil.repeat.daily") : t("chat.hil.repeat.everyDays", { count: interval });
  } else {
    const days = list(freq === "WEEKLY" ? byDay.map(dayName)
      : freq === "MONTHLY" ? [...byMonthDay.map(monthDay), ...byDay.map(nthDay)]
      : byMonth.flatMap((month) => byMonthDay.flatMap((day) => yearDay(month, day))));
    if (days) {
      const [once, every] = ({
        WEEKLY: ["chat.hil.repeat.weekly", "chat.hil.repeat.everyWeeks"],
        MONTHLY: ["chat.hil.repeat.monthly", "chat.hil.repeat.everyMonths"],
        YEARLY: ["chat.hil.repeat.yearly", "chat.hil.repeat.everyYears"],
      } as const)[freq];
      rule = interval === 1 ? t(once, { days }) : t(every, { count: interval, days });
    }
  }
  if (!rule) return t("chat.hil.repeat.unknown");
  const parts = [rule];
  const last = until ? wallClock(until) : null;
  if (last) parts.push(t("chat.hil.repeat.until", { date: dateFormat({ day: "numeric", month: "short", year: "numeric" }).format(last) }));
  if (count !== undefined) parts.push(t("chat.hil.repeat.times", { count }));
  return parts.join(", ");
}

function dayName(code: string): string {
  const day = WEEKDAYS.findIndex((weekday) => weekday === code.slice(-2));
  // 1 January 2024 was a Monday.
  return dateFormat({ weekday: "long" }).format(Date.UTC(2024, 0, 1 + day));
}

function nthDay(code: string): string {
  const keys = ORDINALS.get(code.slice(0, -2));
  if (!keys) return dayName(code);
  return t(code.endsWith("SA") || code.endsWith("SU") ? keys.weekend : keys.weekday, { day: dayName(code) });
}

function monthDay(day: number): string {
  return day === -1 ? t("chat.hil.repeat.lastDay") : t("chat.hil.repeat.monthDay", { day: new Intl.NumberFormat(currentLocale()).format(day) });
}

/** "February 29" for a month and day, or nothing for a date no year has, such as 30 February, which the rule skips. */
function yearDay(month: number, day: number): string[] {
  // A leap year, so 29 February has a date.
  const date = new Date(Date.UTC(2024, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return [];
  return [dateFormat({ month: "long", day: "numeric" }).format(date)];
}

function shortDate(value: string): string {
  const date = wallClock(value);
  return date ? dateFormat({ day: "numeric", month: "short" }).format(date) : value;
}

function list(items: string[]): string {
  return new Intl.ListFormat(currentLocale(), { type: "conjunction" }).format(items);
}

/**
 * Times arrive as the owner's wall clock, such as 2026-11-27T21:15:00+01:00[Europe/Amsterdam],
 * so they are formatted as written rather than converted to this device's zone. A repeating
 * event in another zone is shown in that zone, named, as its rule counts days there.
 */
function eventTimes(start: string, end: string | undefined, allDay: boolean, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = allDay
    ? { weekday: "short", day: "numeric", month: "short" }
    : { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" };
  const zone = allDay ? undefined : timeZone;
  const read = zone ? instant : wallClock;
  const from = read(start);
  if (!from) return start;
  const format = zone
    ? new Intl.DateTimeFormat(currentLocale(), { ...options, timeZone: zone, timeZoneName: "shortGeneric" })
    : dateFormat(options);
  const to = end ? read(end) : null;
  return to && to.getTime() !== from.getTime() ? format.formatRange(from, to) : format.format(from);
}

function dateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(currentLocale(), { ...options, timeZone: "UTC" });
}

/** How long a start and end apart are, an all-day event's by its days; NaN when either can't be read. */
function span(start: string, end = start): number {
  const from = instant(start);
  const to = instant(end);
  return from && to ? to.getTime() - from.getTime() : Number.NaN;
}

/** The moment a time such as 2026-11-30T00:30:00+09:00[Asia/Tokyo] names; a date alone reads as its UTC midnight. */
function instant(value: string): Date | null {
  const moment = Date.parse(value.replace(/\[.*\]$/, ""));
  return Number.isNaN(moment) ? null : new Date(moment);
}

/** Whether this device's Intl knows a zone; it refuses one it doesn't. */
function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function wallClock(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value);
  if (!match) return null;
  const [year, month, day, hour = "0", minute = "0"] = match.slice(1);
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
}
