/**
 * VTIMEZONE components for the IANA zones a calendar's times name, written from this runtime's
 * own zone data. RFC 5545 asks for one per TZID, and Outlook places a zoned time by it.
 */

import { calendarProperty, calendarTimes, type CalendarComponent } from "./icalendar";
import { weekdayOf, type Weekday } from "./recurrence";
import { normalizeTimezone, utcOffsetReader } from "./timezone";

/** Within 28 years each date of a month falls on every weekday, so a yearly rule shows whole. */
const RULE_YEARS = 28;
/** Years of clock changes listed one by one: before the rules in force now, or ahead for a zone that follows none. */
const LISTED_YEARS = 12;
/** Zones one calendar may name; each is a scan of up to RULE_YEARS + LISTED_YEARS of zone data the first time it's written. */
const MAX_ZONES = 8;
const DAY_MS = 86_400_000;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

type ClockChange = { kind: "DAYLIGHT" | "STANDARD"; at: number; from: number; to: number; local: string };

const written = new Map<string, CalendarComponent>();

/** Replaces a calendar's VTIMEZONEs with one for each TZID its events name. */
export function writeTimeZones(calendar: CalendarComponent): void {
  const firstYears = new Map<string, number>();
  for (const event of calendar.components) {
    if (event.name !== "VEVENT") continue;
    for (const property of event.properties) {
      const zone = property.params.TZID?.[0];
      if (zone === undefined) continue;
      try {
        normalizeTimezone(zone);
      } catch {
        throw new Error(`time zone ${zone} isn't an IANA time zone, such as Europe/Amsterdam`);
      }
      for (const time of calendarTimes(property)) {
        if (time.kind !== "local") continue;
        const year = Number(time.local.slice(0, 4));
        firstYears.set(zone, Math.min(firstYears.get(zone) ?? year, year));
      }
    }
  }
  if (firstYears.size > MAX_ZONES) throw new Error(`calendar names ${firstYears.size} time zones; GSV writes at most ${MAX_ZONES}`);
  const zones = [...firstYears].map(([zone, year]) => timeZoneComponent(zone, year));
  calendar.components = [...zones, ...calendar.components.filter((component) => component.name !== "VTIMEZONE")];
}

/**
 * A zone's offsets and clock changes for a calendar whose times begin in `year`: the yearly rules
 * in force from then, or from this year for a calendar begun earlier, with the changes before
 * them listed as far back as LISTED_YEARS. A zone whose changes follow no yearly rule has them
 * listed through LISTED_YEARS ahead.
 */
export function timeZoneComponent(zone: string, year: number, now = Date.now()): CalendarComponent {
  const ruleYear = Math.max(year, new Date(now).getUTCFullYear());
  const firstYear = Math.max(year, ruleYear - LISTED_YEARS);
  const key = `${zone}\n${firstYear}\n${ruleYear}`;
  const cached = written.get(key);
  if (cached) return structuredClone(cached);
  const offsetAt = utcOffsetReader(zone);
  const from = Date.UTC(firstYear - 1, 0, 1);
  const ruleFrom = Date.UTC(ruleYear - 1, 0, 1);
  const changes = clockChanges(offsetAt, from, Date.UTC(ruleYear - 1 + RULE_YEARS, 0, 1));
  const component: CalendarComponent = { name: "VTIMEZONE", properties: [calendarProperty("TZID", zone)], components: [] };
  if (changes.length === 0) {
    const offset = offsetAt(from);
    component.components.push(observance("STANDARD", "19700101T000000", offset, offset));
  } else {
    const rules = yearlyRules(changes.filter((change) => change.at >= ruleFrom), ruleYear - 1);
    const listedUntil = rules ? ruleFrom : Date.UTC(ruleYear + LISTED_YEARS, 0, 1);
    const listed = changes.filter((change) => change.at < listedUntil);
    if (listed.length > 0 || !rules) {
      const offset = offsetAt(from);
      component.components.push(observance("STANDARD", compact(isoWall(from + offset)), offset, offset));
    }
    for (const change of listed) component.components.push(observance(change.kind, compact(change.local), change.from, change.to));
    if (rules) component.components.push(...rules);
  }
  written.set(key, component);
  return structuredClone(component);
}

/** Each change of offset in [from, until), found day by day and then to the second. */
function clockChanges(offsetAt: (ms: number) => number, from: number, until: number): ClockChange[] {
  const changes: ClockChange[] = [];
  let before = offsetAt(from);
  for (let low = from; low < until; low += DAY_MS) {
    const after = offsetAt(low + DAY_MS);
    if (after === before) continue;
    let [lo, hi] = [low, low + DAY_MS];
    while (hi - lo > 1000) {
      const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
      if (offsetAt(mid) === before) lo = mid;
      else hi = mid;
    }
    if (hi < until) {
      changes.push({ kind: after > before ? "DAYLIGHT" : "STANDARD", at: hi, from: before, to: after, local: isoWall(hi + before) });
    }
    before = after;
  }
  return changes;
}

/**
 * DAYLIGHT and STANDARD rules when each happens once a year from `firstYear`, in one month, on
 * one weekday, at one wall-clock time: the first such weekday on or after one date, as zone
 * data writes its rules, which RFC 5545 says as 2SU, -1SU, or a week of BYMONTHDAY.
 */
function yearlyRules(changes: ClockChange[], firstYear: number): CalendarComponent[] | undefined {
  const rules: CalendarComponent[] = [];
  for (const kind of ["DAYLIGHT", "STANDARD"] as const) {
    const group = changes.filter((change) => change.kind === kind);
    if (group.length !== RULE_YEARS) return undefined;
    const [first] = group;
    const month = Number(first.local.slice(5, 7));
    const weekday = weekdayOf(first.local.slice(0, 10));
    const regular = group.every((change, index) => Number(change.local.slice(0, 4)) === firstYear + index
      && Number(change.local.slice(5, 7)) === month
      && change.local.slice(11) === first.local.slice(11)
      && weekdayOf(change.local.slice(0, 10)) === weekday
      && change.from === first.from
      && change.to === first.to);
    const days = group.map((change) => Number(change.local.slice(8, 10)));
    const firstDay = Math.min(...days);
    const byDay = regular && Math.max(...days) - firstDay <= 6 ? weekdayRule(month, weekday, firstDay) : undefined;
    if (!byDay) return undefined;
    rules.push(observance(kind, compact(first.local), first.from, first.to, `FREQ=YEARLY;BYMONTH=${month};${byDay}`));
  }
  return rules;
}

function weekdayRule(month: number, weekday: Weekday, firstDay: number): string | undefined {
  const length = MONTH_LENGTHS[month - 1];
  if ([1, 8, 15, 22].includes(firstDay)) return `BYDAY=${(firstDay + 6) / 7}${weekday}`;
  if (month !== 2 && firstDay === length - 6) return `BYDAY=-1${weekday}`;
  if (firstDay + 6 > length) return undefined;
  return `BYMONTHDAY=${Array.from({ length: 7 }, (_, index) => firstDay + index).join(",")};BYDAY=${weekday}`;
}

function observance(kind: "DAYLIGHT" | "STANDARD", start: string, from: number, to: number, rule?: string): CalendarComponent {
  const properties = [
    calendarProperty("TZOFFSETFROM", offsetValue(from)),
    calendarProperty("TZOFFSETTO", offsetValue(to)),
    calendarProperty("DTSTART", start),
  ];
  if (rule) properties.push(calendarProperty("RRULE", rule));
  return { name: kind, properties, components: [] };
}

/** +0100, -0330, or with seconds +002030; RFC 5545 has no -0000. */
function offsetValue(ms: number): string {
  const total = Math.round(ms / 1000);
  const seconds = Math.abs(total);
  const pad = (value: number) => String(value).padStart(2, "0");
  const rest = seconds % 60;
  return `${total < 0 ? "-" : "+"}${pad(Math.floor(seconds / 3600))}${pad(Math.floor((seconds % 3600) / 60))}${rest ? pad(rest) : ""}`;
}

function isoWall(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

function compact(local: string): string {
  return local.replace(/[-:]/g, "");
}
