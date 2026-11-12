/**
 * Repeating events (RFC 5545 RRULE) in the forms calendar apps offer on their custom-repeat
 * screens, so every rule GSV writes or sends can be said in words. Occurrences keep the wall
 * clock of the first in its own time zone, as RFC 5545 expands a start with a TZID.
 */

import { calendarInstant, calendarTime, type CalendarEvent, type CalendarTime } from "./icalendar";
import { formatLocalTime, resolveLocalTime } from "./timezone";

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type RepeatFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

/** A BYDAY entry: every Monday, or within a month its 4th (4FR) or last (-1FR) Friday. */
export type RepeatDay = { day: Weekday; ordinal?: number };

export type RepeatRule = {
  freq: RepeatFrequency;
  interval: number;
  byDay?: RepeatDay[];
  /** Days of the month from 1 to 31, or -1 for the last. */
  byMonthDay?: number[];
  byMonth?: number[];
  weekStart?: Weekday;
  count?: number;
  until?: CalendarTime;
};

/** An event that changes one occurrence of a series, named by its RECURRENCE-ID. */
export type OccurrenceChange = CalendarEvent & { recurrenceId: CalendarTime };

/** A repeating event and the occurrences changed from it, which calendars group by UID. */
export type CalendarSeries = { uid: string; event?: CalendarEvent; changes: OccurrenceChange[] };

/** A date and, unless the time is a whole day, the clock on it. */
export type WallClock = { date: string; time?: string };

/** An occurrence by the start its rule gave it (`id`, a RECURRENCE-ID) and where it starts now. */
export type Occurrence = { id: CalendarTime; start: CalendarTime; change?: OccurrenceChange };

/** Where an occurrence a date or time names falls: the occurrence, or the ones either side of it. */
export type OccurrenceSearch = { id?: CalendarTime; previous?: CalendarTime; next?: CalendarTime };

const FREQUENCIES: readonly RepeatFrequency[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const PARTS: readonly string[] = ["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "WKST", "COUNT", "UNTIL"];
const DAY_MS = 86_400_000;
/** How far a rule is expanded; a rule that finds nothing sooner, such as February 30, ends there. */
const HORIZON_DAYS = 100 * 366;

export function parseRepeatRule(value: string): RepeatRule {
  const parts = new Map<string, string>();
  for (const part of value.trim().split(";")) {
    if (!part.trim()) continue;
    const separator = part.indexOf("=");
    const name = part.slice(0, Math.max(separator, 0)).trim().toUpperCase();
    const text = part.slice(separator + 1).trim().toUpperCase();
    if (separator < 1 || !text) throw new Error(`repeat rule part ${part} is not NAME=VALUE`);
    if (!PARTS.includes(name)) {
      throw new Error(`repeat rule ${name} isn't supported; use FREQ, INTERVAL, BYDAY, BYMONTHDAY, BYMONTH, COUNT or UNTIL`);
    }
    if (parts.has(name)) throw new Error(`repeat rule has ${name} twice`);
    parts.set(name, text);
  }
  const freq = FREQUENCIES.find((frequency) => frequency === parts.get("FREQ"));
  if (!freq) {
    throw new Error("repeat rule needs FREQ=DAILY, FREQ=WEEKLY, FREQ=MONTHLY or FREQ=YEARLY");
  }
  const rule: RepeatRule = { freq, interval: wholeNumber("INTERVAL", parts.get("INTERVAL") ?? "1") };
  const days = list(parts.get("BYDAY"), repeatDay, (day) => formatRepeatDay(day));
  const monthDays = list(parts.get("BYMONTHDAY"), (text) => {
    const day = Number(text);
    if (!/^[+-]?\d{1,2}$/.test(text) || !((day >= 1 && day <= 31) || day === -1)) {
      throw new Error(`repeat rule BYMONTHDAY=${text} isn't a day from 1 to 31, or -1 for the last`);
    }
    return day;
  });
  const months = list(parts.get("BYMONTH"), (text) => {
    const month = Number(text);
    if (!/^\d{1,2}$/.test(text) || month < 1 || month > 12) throw new Error(`repeat rule BYMONTH=${text} isn't a month from 1 to 12`);
    return month;
  });
  switch (rule.freq) {
    case "DAILY":
      if (days || monthDays || months) throw new Error("a daily repeat takes no BYDAY, BYMONTHDAY or BYMONTH");
      break;
    case "WEEKLY":
      if (monthDays || months) throw new Error("a weekly repeat takes BYDAY days, such as BYDAY=MO,WE, not BYMONTHDAY or BYMONTH");
      if (days?.some((day) => day.ordinal !== undefined)) {
        throw new Error("a weekly repeat's BYDAY lists days such as MO,WE, without a number");
      }
      break;
    case "MONTHLY":
      if (months) throw new Error("a monthly repeat takes no BYMONTH");
      if (days && monthDays) throw new Error("a monthly repeat takes BYMONTHDAY or BYDAY, not both");
      if (days?.some((day) => day.ordinal === undefined)) {
        throw new Error("a monthly BYDAY says which one, such as 4FR for the fourth Friday or -1FR for the last");
      }
      break;
    case "YEARLY":
      if (days) throw new Error("a yearly repeat takes BYMONTH and BYMONTHDAY, not BYDAY");
      if (monthDays && !months) throw new Error("a yearly BYMONTHDAY needs BYMONTH");
      if (monthDays?.includes(-1)) throw new Error("a yearly BYMONTHDAY is a day from 1 to 31");
      break;
  }
  if (days) rule.byDay = days;
  if (monthDays) rule.byMonthDay = monthDays;
  if (months) rule.byMonth = months;
  const weekStart = parts.get("WKST");
  if (weekStart) rule.weekStart = weekday(weekStart, "WKST");
  const count = parts.get("COUNT");
  const until = parts.get("UNTIL");
  if (count && until) throw new Error("repeat rule takes COUNT or UNTIL, not both");
  if (count) rule.count = wholeNumber("COUNT", count);
  if (until) {
    try {
      rule.until = calendarTime({ name: "UNTIL", params: {}, value: until });
    } catch {
      throw new Error(`repeat rule UNTIL=${until} isn't a date such as 20270628 or a time such as 20270628T215959Z`);
    }
  }
  return rule;
}

export function formatRepeatRule(rule: RepeatRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byMonth) parts.push(`BYMONTH=${rule.byMonth.join(",")}`);
  if (rule.byMonthDay) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
  if (rule.byDay) parts.push(`BYDAY=${rule.byDay.map(formatRepeatDay).join(",")}`);
  if (rule.weekStart) parts.push(`WKST=${rule.weekStart}`);
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${untilValue(rule.until)}`);
  return parts.join(";");
}

export function formatRepeatDay(day: RepeatDay): string {
  return `${day.ordinal ?? ""}${day.day}`;
}

/** The rule with what it leaves to its start written out: a weekly rule's day, a monthly or yearly rule's date. */
export function explicitRule(rule: RepeatRule, startDate: string): RepeatRule {
  const [, month, day] = startDate.split("-").map(Number);
  const explicit = { ...rule };
  if (rule.freq === "WEEKLY" && !rule.byDay) explicit.byDay = [{ day: WEEKDAYS[weekdayIndex(dayNumber(startDate))] }];
  if (rule.freq === "MONTHLY" && !rule.byDay && !rule.byMonthDay) explicit.byMonthDay = [day];
  if (rule.freq === "YEARLY") {
    explicit.byMonth ??= [month];
    explicit.byMonthDay ??= [day];
  }
  return explicit;
}

/** The date and wall clock a time reads where it was written: its TZID, UTC, or none. */
export function wallClock(time: CalendarTime): WallClock {
  if (time.kind === "date") return { date: time.date };
  const text = time.kind === "local" ? time.local : new Date(time.ms).toISOString().slice(0, 19);
  return { date: text.slice(0, 10), time: text.slice(11, 19) };
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[weekdayIndex(dayNumber(date))];
}

/**
 * The starts a rule gives an event, from its own start, which always counts first as RFC 5545
 * has it, through COUNT or UNTIL. Each is the same kind of time as the start.
 */
export function* repeatStarts(start: CalendarTime, rule: RepeatRule, timeZone: string): Generator<CalendarTime> {
  const { date, time } = wallClock(start);
  const first = dayNumber(date);
  const pastUntil = rule.until ? afterUntil(start, rule.until, timeZone) : undefined;
  if (pastUntil === null) return;
  yield start;
  let emitted = 1;
  for (const day of candidateDays(first, explicitRule(rule, date))) {
    if (rule.count !== undefined && emitted >= rule.count) return;
    if (day <= first) continue;
    const next = startOn(start, dateOf(day), time);
    if (pastUntil?.(next)) return;
    yield next;
    emitted += 1;
  }
}

/** Whether a rule's own expansion begins on the event's start; calendars disagree about a start it skips. */
export function ruleIncludesStart(start: CalendarTime, rule: RepeatRule): boolean {
  const { date } = wallClock(start);
  const first = dayNumber(date);
  for (const day of candidateDays(first, explicitRule(rule, date))) {
    if (day >= first) return day === first;
  }
  return false;
}

/** Groups events by UID: each series' own event and the occurrences changed from it (RECURRENCE-ID). */
export function calendarSeries(events: CalendarEvent[]): CalendarSeries[] {
  const groups = new Map<string, CalendarSeries>();
  for (const event of events) {
    const series = groups.get(event.uid) ?? { uid: event.uid, changes: [] };
    groups.set(event.uid, series);
    if (event.recurrenceId) series.changes.push({ ...event, recurrenceId: event.recurrenceId });
    else if (series.event) throw new Error(`calendar holds event ${event.uid} twice`);
    else series.event = event;
  }
  return [...groups.values()];
}

/** Whether two times name the same occurrence: by date when either is a date, otherwise by instant. */
export function sameOccurrence(a: CalendarTime, b: CalendarTime, timeZone: string): boolean {
  if (a.kind === "date" || b.kind === "date") return wallClock(a).date === wallClock(b).date;
  if (a.kind === "local" && b.kind === "local" && a.timeZone === b.timeZone) return a.local === b.local;
  if (a.kind === "utc" && b.kind === "utc") return a.ms === b.ms;
  const instant = calendarInstant(a, timeZone);
  return instant !== undefined && instant === calendarInstant(b, timeZone);
}

/** The occurrence a date or an instant names, by the start its rule gave it. */
export function findOccurrence(
  start: CalendarTime,
  rule: RepeatRule,
  target: { date: string } | { ms: number },
  timeZone: string,
): OccurrenceSearch {
  const instant: CalendarTime | undefined = "ms" in target ? { kind: "utc", ms: target.ms } : undefined;
  const date = instant ? seriesDate(start, instant, timeZone) : "date" in target ? target.date : undefined;
  if (date === undefined) return {};
  let previous: CalendarTime | undefined;
  for (const id of repeatStarts(start, rule, timeZone)) {
    const order = wallClock(id).date.localeCompare(date);
    if (order === 0 && (!instant || sameOccurrence(instant, id, timeZone))) return { id };
    if (order > 0) return previous ? { previous, next: id } : { next: id };
    previous = id;
  }
  return previous ? { previous } : {};
}

/**
 * The occurrence each of `times` names, by the start its rule gave it, or undefined where it
 * names none: one pass over the series, comparing each occurrence only with the times on its date.
 */
export function matchOccurrences(
  start: CalendarTime,
  rule: RepeatRule,
  times: readonly CalendarTime[],
  timeZone: string,
): (CalendarTime | undefined)[] {
  const found: (CalendarTime | undefined)[] = times.map(() => undefined);
  const byDate = timesByDate(start, times, timeZone);
  const last = [...byDate.keys()].sort().at(-1);
  if (last === undefined) return found;
  for (const id of repeatStarts(start, rule, timeZone)) {
    const { date } = wallClock(id);
    if (date > last) break;
    for (const index of byDate.get(date) ?? []) {
      if (sameOccurrence(times[index], id, timeZone)) found[index] = id;
    }
  }
  return found;
}

/** The first `limit` occurrences starting at or after `after`, a changed one where it starts now. */
export function nextOccurrences(
  series: CalendarSeries & { event: CalendarEvent },
  rule: RepeatRule,
  timeZone: string,
  after: number,
  limit: number,
): Occurrence[] {
  const { event, changes } = series;
  const upcoming = notBefore(after, timeZone);
  const exceptions = [...event.skipped, ...changes.map((change) => change.recurrenceId)];
  const byDate = timesByDate(event.start, exceptions, timeZone);
  const excepted = (id: CalendarTime) => (byDate.get(wallClock(id).date) ?? [])
    .some((index) => sameOccurrence(exceptions[index], id, timeZone));
  const found: Occurrence[] = [];
  let regular = 0;
  for (const id of repeatStarts(event.start, rule, timeZone)) {
    if (regular >= limit) break;
    if (!upcoming(id) || excepted(id)) continue;
    found.push({ id, start: id });
    regular += 1;
  }
  for (const change of changes) {
    if (change.status === "CANCELLED" || !upcoming(change.start)) continue;
    found.push({ id: change.recurrenceId, start: change.start, change });
  }
  const order = (time: CalendarTime) => time.kind === "date"
    ? resolveLocalTime(`${time.date}T00:00`, timeZone)
    : calendarInstant(time, timeZone) ?? Number.POSITIVE_INFINITY;
  return found.sort((a, b) => order(a.start) - order(b.start)).slice(0, limit);
}

/** The indexes of `times` by the date each falls on where the series repeats, as its occurrences read. */
function timesByDate(start: CalendarTime, times: readonly CalendarTime[], timeZone: string): Map<string, number[]> {
  const byDate = new Map<string, number[]>();
  times.forEach((time, index) => {
    const date = seriesDate(start, time, timeZone);
    if (date === undefined) return;
    const indexes = byDate.get(date);
    if (indexes) indexes.push(index);
    else byDate.set(date, [index]);
  });
  return byDate;
}

/**
 * The date a time falls on in the wall clock of the series' start: its own date when written the
 * same way, or for an instant the date where the start was written. Undefined where that can't be read.
 */
function seriesDate(start: CalendarTime, time: CalendarTime, timeZone: string): string | undefined {
  if (start.kind === "date" || time.kind === "date" || (start.kind === "utc" && time.kind === "utc")
    || (start.kind === "local" && time.kind === "local" && start.timeZone === time.timeZone)) {
    return wallClock(time).date;
  }
  const ms = calendarInstant(time, timeZone);
  if (ms === undefined) return undefined;
  try {
    return formatLocalTime(ms, start.kind === "local" ? start.timeZone ?? timeZone : "UTC").slice(0, 10);
  } catch {
    return undefined;
  }
}

function* candidateDays(first: number, rule: RepeatRule): Generator<number> {
  const [year, month] = dateOf(first).split("-").map(Number);
  const weekStart = WEEKDAYS.indexOf(rule.weekStart ?? "MO");
  for (let period = 0; ; period += 1) {
    let begins: number;
    let days: number[];
    if (rule.freq === "DAILY") {
      begins = first + period * rule.interval;
      days = [begins];
    } else if (rule.freq === "WEEKLY") {
      begins = first - mod(weekdayIndex(first) - weekStart, 7) + 7 * period * rule.interval;
      days = (rule.byDay ?? []).map(({ day }) => begins + mod(WEEKDAYS.indexOf(day) - weekStart, 7));
    } else if (rule.freq === "MONTHLY") {
      const index = month - 1 + period * rule.interval;
      const [current, currentMonth] = [year + Math.floor(index / 12), (index % 12) + 1];
      begins = monthStart(current, currentMonth);
      days = monthDays(current, currentMonth, rule);
    } else {
      const current = year + period * rule.interval;
      begins = monthStart(current, 1);
      days = (rule.byMonth ?? []).flatMap((each) => monthDays(current, each, rule));
    }
    if (begins > first + HORIZON_DAYS) return;
    yield* [...new Set(days)].sort((a, b) => a - b);
  }
}

function monthDays(year: number, month: number, rule: RepeatRule): number[] {
  const first = monthStart(year, month);
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (rule.byMonthDay) {
    return rule.byMonthDay
      .map((day) => (day < 0 ? length + day + 1 : day))
      .filter((day) => day >= 1 && day <= length)
      .map((day) => first + day - 1);
  }
  return (rule.byDay ?? []).flatMap(({ day, ordinal = 1 }) => {
    const firstMatch = first + mod(WEEKDAYS.indexOf(day) - weekdayIndex(first), 7);
    const matches = Math.floor((first + length - 1 - firstMatch) / 7) + 1;
    const index = ordinal > 0 ? ordinal - 1 : matches + ordinal;
    return index >= 0 && index < matches ? [firstMatch + 7 * index] : [];
  });
}

/**
 * Whether an occurrence starts after UNTIL, in the start's own terms. UNTIL is UTC beside a zoned
 * start, so it is read as that zone's wall clock; a start past that wall clock can still come
 * first in an hour a clock change repeats, so that start is compared by instant. Null when that
 * zone can't be read.
 */
function afterUntil(start: CalendarTime, until: CalendarTime, timeZone: string): ((time: CalendarTime) => boolean) | null {
  if (until.kind !== "utc" || start.kind !== "local") {
    const { date, time } = wallClock(until);
    const last = time && start.kind !== "date" ? `${date}T${time}` : date;
    return (next) => pastWall(next, last);
  }
  const zone = start.timeZone ?? timeZone;
  let last: string;
  try {
    last = formatLocalTime(until.ms, zone).slice(0, 19);
  } catch {
    return null;
  }
  return (next) => pastWall(next, last) && (calendarInstant(next, zone) ?? Number.POSITIVE_INFINITY) > until.ms;
}

function pastWall(time: CalendarTime, last: string): boolean {
  const { date, time: clock } = wallClock(time);
  return (last.length === 10 || !clock ? date : `${date}T${clock}`) > last;
}

/**
 * Whether a time starts at or after an instant, compared as wall clocks where it was written. A
 * time that reads at or after the instant's wall clock can still have passed in an hour a clock
 * change repeats, so that one is compared by instant.
 */
function notBefore(after: number, timeZone: string): (time: CalendarTime) => boolean {
  const walls = new Map<string, string | null>();
  const wallIn = (zone: string) => {
    if (!walls.has(zone)) {
      try {
        walls.set(zone, formatLocalTime(after, zone).slice(0, 19));
      } catch {
        walls.set(zone, null);
      }
    }
    return walls.get(zone) ?? null;
  };
  return (time) => {
    if (time.kind === "utc") return time.ms >= after;
    const zone = time.kind === "local" ? time.timeZone ?? timeZone : timeZone;
    const now = wallIn(zone);
    if (now === null) return false;
    if (time.kind === "date") return time.date >= now.slice(0, 10);
    return time.local >= now && (calendarInstant(time, zone) ?? Number.POSITIVE_INFINITY) >= after;
  };
}

function startOn(start: CalendarTime, date: string, time: string | undefined): CalendarTime {
  if (start.kind === "date") return { kind: "date", date };
  if (start.kind === "utc") return { kind: "utc", ms: Date.parse(`${date}T${time}Z`) };
  return start.timeZone ? { kind: "local", local: `${date}T${time}`, timeZone: start.timeZone } : { kind: "local", local: `${date}T${time}` };
}

function untilValue(until: CalendarTime): string {
  if (until.kind === "date") return until.date.replaceAll("-", "");
  if (until.kind === "utc") return new Date(until.ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return until.local.replace(/[-:]/g, "");
}

function repeatDay(text: string): RepeatDay {
  const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(text);
  if (!match) throw new Error(`repeat rule BYDAY=${text} isn't a day such as MO, or 4FR for the fourth Friday`);
  const day = weekday(match[2], "BYDAY");
  if (match[1] === undefined) return { day };
  const ordinal = Number(match[1]);
  if (!((ordinal >= 1 && ordinal <= 5) || ordinal === -1)) {
    throw new Error(`repeat rule BYDAY=${text} needs a number from 1 to 5, or -1 for the last`);
  }
  return { day, ordinal };
}

function weekday(text: string, name: string): Weekday {
  const day = WEEKDAYS.find((code) => code === text);
  if (!day) throw new Error(`repeat rule ${name}=${text} isn't a day such as MO`);
  return day;
}

function wholeNumber(name: string, text: string): number {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`repeat rule ${name}=${text} isn't a whole number from 1`);
  }
  return value;
}

/** A comma list without repeats, in its first order; undefined when the part is absent. */
function list<T>(text: string | undefined, parse: (value: string) => T, key: (value: T) => string = String): T[] | undefined {
  if (text === undefined) return undefined;
  const values = new Map<string, T>();
  for (const part of text.split(",")) {
    const value = parse(part.trim());
    if (!values.has(key(value))) values.set(key(value), value);
  }
  return [...values.values()];
}

function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

function dateOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function monthStart(year: number, month: number): number {
  return Date.UTC(year, month - 1, 1) / DAY_MS;
}

/** Monday is 0; 1 January 1970 was a Thursday. */
function weekdayIndex(day: number): number {
  return mod(day + 3, 7);
}

function mod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}
