import { defineCommand } from "just-bash";
import type { CommandContext, ExecResult } from "just-bash";
import type { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import { resolveCallerOwnerUid } from "../../../kernel/context";
import {
  addDays,
  calendarEvents,
  calendarInstant,
  calendarProperty,
  calendarTimeText,
  calendarWhen,
  dateValue,
  escapeText,
  firstProperty,
  parseCalendar,
  serializeCalendar,
  setProperty,
  textProperty,
  timeProperty,
  utcValue,
  type CalendarComponent,
  type CalendarEvent,
  type CalendarPerson,
  type CalendarTime,
} from "../../../kernel/icalendar";
import { managedMailAddressForOwner } from "../../../kernel/mailbox";
import { ownerDisplayName } from "../../../kernel/profiles";
import {
  calendarSeries,
  findOccurrence,
  formatRepeatRule,
  matchOccurrences,
  nextOccurrences,
  parseRepeatRule,
  ruleIncludesStart,
  sameOccurrence,
  wallClock,
  weekdayOf,
  type CalendarSeries,
  type RepeatRule,
} from "../../../kernel/recurrence";
import {
  formatLocalTime,
  isLocalTime,
  normalizeTimezone,
  ownerTimezone,
  resolveLocalTime,
} from "../../../kernel/timezone";
import { writeTimeZones } from "../../../kernel/vtimezone";
import { requireShellOptionValue } from "./common";

const MAX_CALENDAR_FILE_BYTES = 1024 * 1024;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NEXT_OCCURRENCES = 5;
const MAX_NEXT_OCCURRENCES = 100;
const MAX_RANGE_DAYS = 366;
const MAX_RANGE_EVENTS = 500;
const ISO_DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;
const DAY_NAMES = { MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" };
/** What only a series has, which a changed occurrence doesn't copy. */
const SERIES_ONLY = new Set(["RRULE", "RDATE", "EXDATE", "RECURRENCE-ID"]);

const EVENT_FLAGS = ["--title", "--start", "--end", "--duration", "--repeat", "--timezone", "--location", "--description", "--attendee"];
const ADD_FLAGS = [...EVENT_FLAGS, "--out"];
const UPDATE_FLAGS = [...EVENT_FLAGS, "--occurrence", "--out"];
const CANCEL_FLAGS = ["--occurrence", "--timezone"];
const SHOW_FLAGS = ["--timezone", "--next", "--from", "--until"];

const CAL_USAGE = `Usage:
  cal add --title TITLE --start WHEN [--end WHEN | --duration LENGTH] [--repeat RULE] [--timezone ZONE] [--location PLACE] [--description TEXT] [--attendee ADDRESS]... --out PATH
  cal update PATH [--occurrence WHEN] [--title TITLE] [--start WHEN] [--end WHEN | --duration LENGTH] [--repeat RULE] [--timezone ZONE] [--location PLACE] [--description TEXT] [--attendee ADDRESS]...
  cal cancel PATH [--occurrence WHEN]
  cal show PATH [--timezone ZONE] [--next COUNT | --from WHEN [--until WHEN]]

WHEN is a local time such as 2026-11-27T21:15 in --timezone (default: your time zone),
or a date such as 2026-11-27 for an all-day event. LENGTH is like 45m, 2h or 1h30m.
RULE is an RRULE such as FREQ=WEEKLY;BYDAY=MO;UNTIL=2027-06-28, and --occurrence WHEN
names one date of a repeating event to change or cancel. --from and --until list what
falls between them, a date standing for its whole day; --from alone shows one day.
Send an event to its guests with: mail send --invite PATH --subject SUBJECT --message TEXT
`;

type EventOptions = {
  title?: string;
  start?: string;
  end?: string;
  duration?: string;
  repeat?: string;
  occurrence?: string;
  timeZone?: string;
  location?: string;
  description?: string;
  attendees: string[];
  out?: string;
  next?: number;
  from?: string;
  until?: string;
};

/** Start and end of an event: all-day dates with an exclusive end, or instants. */
type Span =
  | { kind: "date"; start: string; end: string }
  | { kind: "time"; start: number; end: number };

type Organizer = { address: string; name?: string };

/** Instants a `cal show` range covers, end exclusive. */
type TimeRange = { start: number; end: number };

type Series = CalendarSeries & { event: CalendarEvent };

export function buildCalCommand(fs: GsvFs, ctx: KernelContext) {
  return defineCommand("cal", async (args, shellCtx): Promise<ExecResult> => {
    try {
      return await runCalCommand(args, shellCtx, fs, ctx);
    } catch (error) {
      return {
        stdout: "",
        stderr: `cal: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runCalCommand(
  args: string[],
  shellCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;
  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return completed(CAL_USAGE);
    case "add":
      return await addEvent(rest, shellCtx, fs, ctx);
    case "update":
    case "cancel":
      return await changeEvent(subcommand, rest, shellCtx, fs, ctx);
    case "show":
      return await showCalendar(rest, shellCtx, fs, ctx);
    default:
      throw new Error(`unknown command: ${subcommand}\n${CAL_USAGE}`);
  }
}

async function addEvent(
  args: string[],
  shellCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
): Promise<ExecResult> {
  const [path, options] = parseEventOptions(args, ADD_FLAGS);
  if (path) throw new Error(`unexpected argument: ${path}`);
  if (!options.out) throw new Error("cal add requires --out PATH");
  if (!options.title) throw new Error("cal add requires --title");
  if (!options.start) throw new Error("cal add requires --start");
  const out = shellCtx.fs.resolvePath(shellCtx.cwd, options.out);
  if (await fs.exists(out)) throw new Error(`${options.out} already exists; change it with cal update`);
  const timeZone = eventTimeZone(options, ctx);
  const organizer = shipOrganizer(ctx);
  const event: CalendarComponent = { name: "VEVENT", properties: [], components: [] };
  const calendar: CalendarComponent = {
    name: "VCALENDAR",
    properties: [
      calendarProperty("PRODID", "-//GSV//cal//EN"),
      calendarProperty("VERSION", "2.0"),
      calendarProperty("CALSCALE", "GREGORIAN"),
      calendarProperty("METHOD", "REQUEST"),
    ],
    components: [event],
  };
  const domain = organizer?.address.split("@")[1] ?? "gsv";
  setProperty(event, "UID", calendarProperty("UID", `${crypto.randomUUID()}@${domain}`));
  setProperty(event, "DTSTAMP", calendarProperty("DTSTAMP", utcValue(Date.now())));
  const span = newSpan(options, timeZone, undefined);
  if (options.repeat === undefined) writeSpan(event, span);
  else writeSeries(event, span, repeatRule(options.repeat, span, timeZone), timeZone);
  setProperty(event, "SEQUENCE", calendarProperty("SEQUENCE", "0"));
  setProperty(event, "STATUS", calendarProperty("STATUS", "CONFIRMED"));
  writeDetails(event, options);
  if (organizer) setProperty(event, "ORGANIZER", organizerProperty(organizer));
  writeAttendees(event, options.attendees);
  return await saveCalendar(fs, out, calendar, timeZone);
}

/** A new version of an event the Ship organizes: same UID, next SEQUENCE on every event of its series. */
async function changeEvent(
  change: "update" | "cancel",
  args: string[],
  shellCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
): Promise<ExecResult> {
  const [path, options] = parseEventOptions(args, change === "cancel" ? CANCEL_FLAGS : UPDATE_FLAGS);
  if (!path) throw new Error(`cal ${change} requires a calendar file`);
  if (options.out) throw new Error(`cal ${change} changes the file in place; --out applies to cal add`);
  const resolved = shellCtx.fs.resolvePath(shellCtx.cwd, path);
  const calendar = parseCalendar(await readCalendarFile(fs, resolved));
  const events = calendarEvents(calendar);
  const groups = calendarSeries(events);
  const [group] = groups;
  if (groups.length !== 1 || !group.event) {
    throw new Error(`${path} holds ${events.length} events; cal ${change} changes a file with one`);
  }
  const series: Series = { ...group, event: group.event };
  const { event } = series;
  const organizer = shipOrganizer(ctx);
  if (event.organizer && event.organizer.address.toLowerCase() !== organizer?.address.toLowerCase()) {
    throw new Error(`${event.organizer.address} organizes this event; only its organizer can change it`);
  }
  const zone = seriesZone(event, options, ctx);
  const notes: string[] = [];
  const cancelsAll = change === "cancel" && options.occurrence === undefined;
  if (options.occurrence !== undefined) {
    changeOccurrence(change, calendar, series, options, zone, notes);
  } else if (cancelsAll) {
    // A cancelled series takes its changed dates with it.
    calendar.components = calendar.components.filter((component) => !series.changes.some((each) => each.component === component));
  } else {
    updateSeries(calendar, series, options, zone, notes);
  }
  setProperty(calendar, "METHOD", calendarProperty("METHOD", cancelsAll ? "CANCEL" : "REQUEST"));
  setProperty(event.component, "STATUS", calendarProperty("STATUS", cancelsAll ? "CANCELLED" : "CONFIRMED"));
  const now = utcValue(Date.now());
  for (const component of calendar.components) {
    if (component.name !== "VEVENT" || firstProperty(component, "UID")?.value.trim() !== series.uid) continue;
    setProperty(component, "DTSTAMP", calendarProperty("DTSTAMP", now));
    setProperty(component, "SEQUENCE", calendarProperty("SEQUENCE", String(event.sequence + 1)));
  }
  if (organizer && !event.organizer) setProperty(event.component, "ORGANIZER", organizerProperty(organizer));
  return await saveCalendar(fs, resolved, calendar, eventTimeZone(options, ctx), notes);
}

/** Changes the whole series; a change to its times moves each skipped or changed date with it. */
function updateSeries(calendar: CalendarComponent, series: Series, options: EventOptions, zone: string, notes: string[]): void {
  const { event } = series;
  if (options.start || options.end || options.duration || options.repeat !== undefined) {
    const span = newSpan(options, zone, changeableSpan(event, zone, options));
    const text = options.repeat ?? event.recurrence;
    if (text === undefined) {
      writeSpan(event.component, span);
    } else {
      const rule = options.repeat === undefined ? existingRule(text, span, zone) : repeatRule(text, span, zone);
      writeSeries(event.component, span, rule, zone);
      moveExceptions(calendar, series, spanTimes(span, zone)[0], rule, zone, notes);
    }
  }
  const before = { SUMMARY: textProperty(event.component, "SUMMARY"), LOCATION: textProperty(event.component, "LOCATION"), DESCRIPTION: textProperty(event.component, "DESCRIPTION") };
  writeDetails(event.component, options);
  // A changed date follows the series' new details unless it had its own.
  for (const change of series.changes) {
    for (const [name, value] of Object.entries(before)) {
      const own = textProperty(change.component, name);
      const changed = name === "SUMMARY" ? options.title : name === "LOCATION" ? options.location : options.description;
      if (changed !== undefined && own === value) writeDetail(change.component, name, changed);
    }
  }
  if (options.attendees.length > 0) {
    for (const component of [event.component, ...series.changes.map((change) => change.component)]) writeAttendees(component, options.attendees);
  }
}

/**
 * Changes or skips one occurrence. A change is its own event with the series' UID and the start
 * the rule gave it (RECURRENCE-ID); a skipped date is an EXDATE. Changing a skipped date restores it.
 */
function changeOccurrence(
  change: "update" | "cancel",
  calendar: CalendarComponent,
  series: Series,
  options: EventOptions,
  zone: string,
  notes: string[],
): void {
  const { event } = series;
  if (!event.recurrence) throw new Error("this event doesn't repeat; --occurrence names one date of a repeating event");
  if (options.repeat !== undefined) throw new Error("--repeat changes the whole series; leave out --occurrence");
  if (options.attendees.length > 0) {
    throw new Error("every date of a series has the series' guests; change them without --occurrence");
  }
  const rule = existingRule(event.recurrence, undefined, zone);
  const target = parseWhen(options.occurrence ?? "", zone);
  const found = findOccurrence(
    event.start,
    rule,
    target.kind === "date" ? { date: target.date } : event.start.kind === "date" ? { date: localDate(target.ms, zone) } : { ms: target.ms },
    zone,
  );
  if (!found.id) throw new Error(missingOccurrence(options.occurrence ?? "", found, series, zone));
  const id = found.id;
  const existing = series.changes.find((each) => sameOccurrence(each.recurrenceId, id, zone));
  const skipped = event.skipped.filter((time) => !sameOccurrence(time, id, zone));
  if (change === "cancel") {
    if (existing) calendar.components = calendar.components.filter((component) => component !== existing.component);
    setProperty(event.component, "EXDATE", ...[...skipped, id].map((time) => timeProperty("EXDATE", time)));
    return;
  }
  if (skipped.length < event.skipped.length) {
    setProperty(event.component, "EXDATE", ...skipped.map((time) => timeProperty("EXDATE", time)));
    notes.push(`restored=${calendarTimeText(id, zone)}`);
  }
  const component = existing?.component ?? occurrenceComponent(event, id);
  const before = existing ? changeableSpan(existing, zone, options) : occurrenceSpan(event, id, zone, options);
  writeZonedSpan(component, newSpan(options, zone, before), zone);
  writeDetails(component, options);
  if (!existing) calendar.components.push(component);
}

/** A changed occurrence starts as a copy of the series without its rule, at the start the rule gave it. */
function occurrenceComponent(event: CalendarEvent, id: CalendarTime): CalendarComponent {
  const properties = event.component.properties
    .filter((property) => !SERIES_ONLY.has(property.name))
    .map((property) => ({ ...property, params: { ...property.params } }));
  properties.splice(properties.findIndex((property) => property.name === "UID") + 1, 0, timeProperty("RECURRENCE-ID", id));
  return { name: "VEVENT", properties, components: [] };
}

/** One occurrence's times before any change: its start, and the series' length. */
function occurrenceSpan(event: CalendarEvent, id: CalendarTime, zone: string, options: EventOptions): Span | undefined {
  const series = changeableSpan(event, zone, options);
  if (!series) return undefined;
  if (series.kind === "date" || id.kind === "date") {
    const date = wallClock(id).date;
    return { kind: "date", start: date, end: addDays(date, series.kind === "date" ? dayCount(series.start, series.end) : 1) };
  }
  const start = calendarInstant(id, zone);
  return start === undefined ? undefined : { kind: "time", start, end: start + series.end - series.start };
}

/**
 * Moves each skipped and changed date onto the occurrence the series now has on that date, and
 * drops the ones the series no longer has.
 */
function moveExceptions(calendar: CalendarComponent, series: Series, start: CalendarTime, rule: RepeatRule, zone: string, notes: string[]): void {
  const { event, changes } = series;
  const times = [...event.skipped, ...changes.map((change) => change.recurrenceId)];
  const moved = matchOccurrences(start, rule, times.map((time) => ({ kind: "date", date: occurrenceDate(time, zone) })), zone);
  const dropped = (index: number) => notes.push(`dropped=${calendarTimeText(times[index], zone)} (no longer in the series)`);
  const skipped: CalendarTime[] = [];
  event.skipped.forEach((_, index) => {
    const id = moved[index];
    if (id) skipped.push(id);
    else dropped(index);
  });
  setProperty(event.component, "EXDATE", ...skipped.map((time) => timeProperty("EXDATE", time)));
  changes.forEach((change, offset) => {
    const id = moved[event.skipped.length + offset];
    if (id) {
      setProperty(change.component, "RECURRENCE-ID", timeProperty("RECURRENCE-ID", id));
    } else {
      calendar.components = calendar.components.filter((component) => component !== change.component);
      dropped(event.skipped.length + offset);
    }
  });
}

function missingOccurrence(when: string, found: ReturnType<typeof findOccurrence>, series: Series, zone: string): string {
  const nearby = [found.previous, found.next].filter((time) => time !== undefined).map((time) => occurrenceDate(time, zone));
  const target = parseWhen(when, zone);
  const date = target.kind === "date" ? target.date : localDate(target.ms, zone);
  const movedHere = series.changes.find((change) => occurrenceDate(change.start, zone) === date);
  if (movedHere) {
    return `${when} has the occurrence moved from ${occurrenceDate(movedHere.recurrenceId, zone)}; name it with --occurrence ${occurrenceDate(movedHere.recurrenceId, zone)}`;
  }
  return `${when} isn't a date this series happens on${nearby.length > 0 ? `; nearby: ${nearby.join(", ")}` : ""}`;
}

async function showCalendar(
  args: string[],
  shellCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
): Promise<ExecResult> {
  const [path, options] = parseEventOptions(args, SHOW_FLAGS);
  if (!path) throw new Error("cal show requires a calendar file");
  const resolved = shellCtx.fs.resolvePath(shellCtx.cwd, path);
  const calendar = parseCalendar(await readCalendarFile(fs, resolved));
  const timeZone = eventTimeZone(options, ctx);
  if (options.from === undefined && options.until === undefined) {
    return completed(describeCalendar(resolved, calendar, timeZone, options.next));
  }
  return completed(describeRange(resolved, calendar, timeZone, showRange(options, timeZone)));
}

/** The span --from and --until name, end exclusive: a date stands for its whole day, and --from alone for its day. */
function showRange(options: EventOptions, timeZone: string): TimeRange {
  if (options.from === undefined) throw new Error("--until needs --from");
  if (options.next !== undefined) throw new Error("--next lists a repeating event's next dates; leave it out with --from");
  const from = parseWhen(options.from, timeZone);
  const start = from.kind === "date" ? dayStart(from.date, timeZone) : from.ms;
  const until = options.until === undefined ? undefined : parseWhen(options.until, timeZone);
  const end = until === undefined
    ? dayStart(addDays(from.kind === "date" ? from.date : localDate(start, timeZone), 1), timeZone)
    : until.kind === "date" ? dayStart(addDays(until.date, 1), timeZone) : until.ms;
  if (end <= start) throw new Error("--until comes before --from");
  if (end - start > MAX_RANGE_DAYS * DAY_MS) throw new Error(`a range covers at most ${MAX_RANGE_DAYS} days`);
  return { start, end };
}

/** Each event and date of a series that overlaps the range, in the order they start. */
function describeRange(path: string, calendar: CalendarComponent, timeZone: string, range: TimeRange): string {
  const found: { event: CalendarEvent; start: number }[] = [];
  const consider = (event: CalendarEvent) => {
    if (event.status === "CANCELLED") return;
    const span = eventSpan(event, timeZone);
    if (span && span.start < range.end && (span.end > range.start || (span.end === span.start && span.start >= range.start))) {
      found.push({ event, start: span.start });
    }
  };
  for (const series of calendarSeries(calendarEvents(calendar))) {
    const occurrences = series.event ? rangeOccurrences({ ...series, event: series.event }, timeZone, range) : undefined;
    if (occurrences) occurrences.forEach(consider);
    else [...(series.event ? [series.event] : []), ...series.changes].forEach(consider);
    if (found.length > MAX_RANGE_EVENTS) throw new Error(`more than ${MAX_RANGE_EVENTS} events fall in that range; give a shorter one`);
  }
  const head = [`path=${path}`, `from=${formatLocalTime(range.start, timeZone)}`, `until=${formatLocalTime(range.end, timeZone)}`, `events=${found.length}`];
  const blocks = found.sort((a, b) => a.start - b.start).map(({ event }) => describeEvent(event, timeZone, []).join("\n"));
  return `${[head.join("\n"), ...blocks].join("\n\n")}\n`;
}

/**
 * A repeating event's dates from just before the range to its end, each as an event of its own; undefined for
 * an event that doesn't repeat or a rule cal can't read, which then shows as written.
 */
function rangeOccurrences(series: Series, timeZone: string, range: TimeRange): CalendarEvent[] | undefined {
  const { event } = series;
  if (!event.recurrence || firstProperty(event.component, "RDATE")) return undefined;
  let rule: RepeatRule;
  try {
    rule = parseRepeatRule(event.recurrence);
    if (event.start.kind === "local" && event.start.timeZone) normalizeTimezone(event.start.timeZone);
  } catch {
    return undefined;
  }
  const span = eventSpan(event, timeZone);
  const length = span ? span.end - span.start : 0;
  // A changed date keeps its own length, so it is checked against the range on its own.
  const regular = nextOccurrences(series, rule, timeZone, range.start - length, MAX_RANGE_EVENTS + 1)
    .filter(({ start, change }) => !change && (timeAt(start, timeZone) ?? Number.POSITIVE_INFINITY) < range.end);
  if (regular.length > MAX_RANGE_EVENTS) throw new Error(`more than ${MAX_RANGE_EVENTS} events fall in that range; give a shorter one`);
  return [
    ...regular.map(({ id, start }) => ({ ...event, start, end: shiftedEnd(event, start, length, timeZone), recurrenceId: id })),
    ...series.changes,
  ];
}

/** Where an occurrence starting at `start` ends, keeping the series' length; none when the series gives a DURATION. */
function shiftedEnd(event: CalendarEvent, start: CalendarTime, length: number, timeZone: string): CalendarTime | undefined {
  if (!event.end) return undefined;
  if (start.kind === "date") return { kind: "date", date: addDays(start.date, Math.round(length / DAY_MS)) };
  const ms = calendarInstant(start, timeZone);
  return ms === undefined ? undefined : { kind: "utc", ms: ms + length };
}

/** An event's start and end as instants; a date covers its days, and an event with no end or length is a moment. */
function eventSpan(event: CalendarEvent, timeZone: string): TimeRange | undefined {
  const start = timeAt(event.start, timeZone);
  if (start === undefined) return undefined;
  const end = event.end ? timeAt(event.end, timeZone) : undefined;
  if (end !== undefined) return { start, end };
  const duration = event.duration ? ISO_DURATION.exec(event.duration.trim()) : null;
  const [weeks, days, hours, minutes, seconds] = (duration?.slice(1) ?? []).map((part) => Number(part ?? 0));
  const clock = (hours ?? 0) * HOUR_MS + (minutes ?? 0) * 60_000 + (seconds ?? 0) * 1000;
  // Whole days end at a local midnight, which a clock change moves away from a multiple of 24 hours.
  if (event.start.kind === "date") {
    return { start, end: dayStart(addDays(event.start.date, duration ? (weeks ?? 0) * 7 + (days ?? 0) : 1), timeZone) + clock };
  }
  return { start, end: duration ? start + ((weeks ?? 0) * 7 + (days ?? 0)) * DAY_MS + clock : start };
}

function timeAt(time: CalendarTime, timeZone: string): number | undefined {
  return time.kind === "date" ? dayStart(time.date, timeZone) : calendarInstant(time, timeZone);
}

function dayStart(date: string, timeZone: string): number {
  return resolveLocalTime(`${date}T00:00`, timeZone);
}

function parseEventOptions(args: string[], allowed: readonly string[]): [string | undefined, EventOptions] {
  const options: EventOptions = { attendees: [] };
  let path: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith("--")) {
      if (path) throw new Error(`unexpected argument: ${current}`);
      path = current;
      continue;
    }
    if (!allowed.includes(current)) throw new Error(`unexpected argument: ${current}`);
    index += 1;
    const value = requireShellOptionValue(args[index], current);
    switch (current) {
      case "--title": options.title = value; break;
      case "--start": options.start = value; break;
      case "--end": options.end = value; break;
      case "--duration": options.duration = value; break;
      case "--repeat": options.repeat = value; break;
      case "--occurrence": options.occurrence = value; break;
      case "--timezone": options.timeZone = normalizeTimezone(value); break;
      case "--location": options.location = value; break;
      case "--description": options.description = value; break;
      case "--out": options.out = value; break;
      case "--from": options.from = value; break;
      case "--until": options.until = value; break;
      case "--attendee":
        options.attendees.push(...value.split(",").map((address) => address.trim()).filter(Boolean));
        break;
      case "--next": {
        const count = Number(value);
        if (!/^\d+$/.test(value) || count < 1 || count > MAX_NEXT_OCCURRENCES) {
          throw new Error(`--next takes a count from 1 to ${MAX_NEXT_OCCURRENCES}`);
        }
        options.next = count;
        break;
      }
    }
  }
  if (options.end && options.duration) throw new Error("--end and --duration are mutually exclusive");
  return [path, options];
}

function eventTimeZone(options: EventOptions, ctx: KernelContext): string {
  return options.timeZone ?? ownerTimezone(ctx.config, resolveCallerOwnerUid(ctx));
}

/**
 * A series repeats in its own zone, or in UTC when written in UTC, which --timezone changes; a
 * single event reads times in yours.
 */
function seriesZone(event: CalendarEvent, options: EventOptions, ctx: KernelContext): string {
  if (!options.timeZone && event.recurrence !== undefined && event.start.kind === "utc") return "UTC";
  if (options.timeZone || event.start.kind !== "local" || !event.start.timeZone) return eventTimeZone(options, ctx);
  try {
    return normalizeTimezone(event.start.timeZone);
  } catch {
    return eventTimeZone(options, ctx);
  }
}

/** The Ship's own address organizes what it sends, so replies come back to it. */
function shipOrganizer(ctx: KernelContext): Organizer | undefined {
  const ownerUid = resolveCallerOwnerUid(ctx);
  const address = managedMailAddressForOwner(ownerUid, ctx);
  if (!address) return undefined;
  const name = ownerDisplayName(ownerUid, ctx)?.trim();
  return name ? { address, name } : { address };
}

/** A --repeat RRULE whose UNTIL is read like --start: a date, a local time or an instant. */
function repeatRule(text: string, span: Span, zone: string): RepeatRule {
  const value = text.trim().replace(/^RRULE:/i, "").replace(
    /(^|;)\s*UNTIL\s*=\s*([^;]*)/i,
    (_, separator: string, until: string) => `${separator}UNTIL=${untilValue(until.trim(), span, zone)}`,
  );
  return parseRepeatRule(value);
}

/** The series' own rule, its UNTIL rewritten if the series now runs by dates rather than times or back. */
function existingRule(text: string, span: Span | undefined, zone: string): RepeatRule {
  try {
    return span ? repeatRule(text, span, zone) : parseRepeatRule(text);
  } catch (error) {
    throw new Error(`this event repeats by a rule cal can't change: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * UNTIL as RFC 5545 needs it beside the start: a date for an all-day series, otherwise UTC.
 * A date ends a timed series at the end of that day where it repeats.
 */
function untilValue(text: string, span: Span, zone: string): string {
  const compact = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(text);
  let when: ReturnType<typeof parseWhen>;
  try {
    when = parseWhen(compact ? `${compact[1]}-${compact[2]}-${compact[3]}${compact[4] ? `T${compact[4]}:${compact[5]}:${compact[6]}${compact[7] ? "Z" : ""}` : ""}` : text, zone);
  } catch {
    throw new Error(`repeat rule UNTIL=${text} isn't a date such as 2027-06-28 or a time such as 2027-06-28T18:00`);
  }
  if (span.kind === "date") return dateValue(when.kind === "date" ? when.date : localDate(when.ms, zone));
  return utcValue(when.kind === "date" ? resolveLocalTime(`${when.date}T23:59:59`, zone) : when.ms);
}

/** The event's new times; whatever isn't given keeps its current value, or its current length. */
function newSpan(options: EventOptions, timeZone: string, existing: Span | undefined): Span {
  const start = options.start
    ? parseWhen(options.start, timeZone)
    : existing?.kind === "date"
      ? { kind: "date" as const, date: existing.start }
      : existing
        ? { kind: "time" as const, ms: existing.start }
        : undefined;
  if (!start) throw new Error("the event needs --start");
  if (start.kind === "date") {
    const end = options.end
      ? parseWhen(options.end, timeZone)
      : undefined;
    if (end && end.kind !== "date") throw new Error("an all-day event ends on a date such as 2026-11-28");
    const days = end
      ? dayCount(start.date, end.date) + 1
      : options.duration
        ? wholeDays(parseLength(options.duration))
        : existing?.kind === "date" ? dayCount(existing.start, existing.end) : 1;
    if (days < 1) throw new Error("the event ends before it starts");
    return { kind: "date", start: start.date, end: addDays(start.date, days) };
  }
  let end: number;
  if (options.end) {
    const parsed = parseWhen(options.end, timeZone);
    if (parsed.kind !== "time") throw new Error("an event that starts at a time ends at a time, such as 2026-11-27T23:00");
    end = parsed.ms;
  } else if (options.duration) {
    end = start.ms + parseLength(options.duration);
  } else {
    end = start.ms + (existing?.kind === "time" ? existing.end - existing.start : HOUR_MS);
  }
  if (end <= start.ms) throw new Error("the event ends before it starts");
  return { kind: "time", start: start.ms, end };
}

/** An event's times, which a change keeps unless it gives new ones. */
function changeableSpan(event: CalendarEvent, timeZone: string, options: EventOptions): Span | undefined {
  const span = currentSpan(event, timeZone);
  if (!span && !(options.start && (options.end || options.duration))) {
    throw new Error("this event's times can't be read here; give --start with --end or --duration");
  }
  return span;
}

function currentSpan(event: CalendarEvent, timeZone: string): Span | undefined {
  if (!event.end && event.duration) return undefined;
  if (event.start.kind === "date") {
    const end = event.end?.kind === "date" ? event.end.date : addDays(event.start.date, 1);
    return { kind: "date", start: event.start.date, end };
  }
  const start = calendarInstant(event.start, timeZone);
  const end = event.end ? calendarInstant(event.end, timeZone) : start === undefined ? undefined : start + HOUR_MS;
  return start === undefined || end === undefined ? undefined : { kind: "time", start, end };
}

/** A single event's times: all-day dates, or UTC instants every calendar reads alike. */
function writeSpan(event: CalendarComponent, span: Span): void {
  setProperty(event, "DURATION");
  if (span.kind === "date") {
    setProperty(event, "DTSTART", calendarProperty("DTSTART", dateValue(span.start), { VALUE: ["DATE"] }));
    setProperty(event, "DTEND", calendarProperty("DTEND", dateValue(span.end), { VALUE: ["DATE"] }));
  } else {
    setProperty(event, "DTSTART", calendarProperty("DTSTART", utcValue(span.start)));
    setProperty(event, "DTEND", calendarProperty("DTEND", utcValue(span.end)));
  }
}

/** A repeating event's times stay in its own zone, so each occurrence keeps the first's wall clock. */
function writeSeries(event: CalendarComponent, span: Span, rule: RepeatRule, zone: string): void {
  const [start] = spanTimes(span, zone);
  if (!ruleIncludesStart(start, rule)) {
    const { date } = wallClock(start);
    throw new Error(`${formatRepeatRule(rule)} doesn't include the start, ${date} (a ${DAY_NAMES[weekdayOf(date)]}); start on a date it includes`);
  }
  writeZonedSpan(event, span, zone);
  setProperty(event, "RRULE", calendarProperty("RRULE", formatRepeatRule(rule)));
}

function writeZonedSpan(event: CalendarComponent, span: Span, zone: string): void {
  const [start, end] = spanTimes(span, zone);
  setProperty(event, "DURATION");
  setProperty(event, "DTSTART", timeProperty("DTSTART", start));
  setProperty(event, "DTEND", timeProperty("DTEND", end));
}

function spanTimes(span: Span, zone: string): [CalendarTime, CalendarTime] {
  if (span.kind === "date") return [{ kind: "date", date: span.start }, { kind: "date", date: span.end }];
  // A series in UTC is written in UTC, which no clock change moves.
  const zoned = (ms: number): CalendarTime => zone === "UTC"
    ? { kind: "utc", ms }
    : { kind: "local", local: formatLocalTime(ms, zone).slice(0, 19), timeZone: zone };
  return [zoned(span.start), zoned(span.end)];
}

function writeDetails(event: CalendarComponent, options: EventOptions): void {
  const details = [["SUMMARY", options.title], ["LOCATION", options.location], ["DESCRIPTION", options.description]] as const;
  for (const [name, value] of details) {
    if (value !== undefined) writeDetail(event, name, value);
  }
}

function writeDetail(event: CalendarComponent, name: string, value: string): void {
  if (value.trim()) setProperty(event, name, calendarProperty(name, escapeText(value.trim())));
  else setProperty(event, name);
}

function writeAttendees(event: CalendarComponent, attendees: string[]): void {
  const distinct = new Map<string, string>();
  for (const attendee of attendees) {
    if (!/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+$/.test(attendee)) throw new Error(`not an email address: ${attendee}`);
    distinct.set(attendee.toLowerCase(), attendee);
  }
  setProperty(event, "ATTENDEE", ...[...distinct.values()].map((address) => calendarProperty(
    "ATTENDEE",
    `mailto:${address}`,
    { ROLE: ["REQ-PARTICIPANT"], PARTSTAT: ["NEEDS-ACTION"], RSVP: ["TRUE"] },
  )));
}

function organizerProperty(organizer: Organizer) {
  return calendarProperty("ORGANIZER", `mailto:${organizer.address}`, organizer.name ? { CN: [organizer.name] } : {});
}

async function readCalendarFile(fs: GsvFs, path: string): Promise<string> {
  const stat = await fs.stat(path);
  if (!stat.isFile) throw new Error(`not a file: ${path}`);
  if (stat.size > MAX_CALENDAR_FILE_BYTES) throw new Error(`${path} exceeds ${MAX_CALENDAR_FILE_BYTES} bytes`);
  return await fs.readFile(path);
}

async function saveCalendar(fs: GsvFs, path: string, calendar: CalendarComponent, timeZone: string, notes: string[] = []): Promise<ExecResult> {
  writeTimeZones(calendar);
  await fs.writeFile(path, serializeCalendar(calendar));
  return completed(describeCalendar(path, calendar, timeZone, undefined, notes));
}

function describeCalendar(path: string, calendar: CalendarComponent, timeZone: string, next = NEXT_OCCURRENCES, notes: string[] = []): string {
  const method = firstProperty(calendar, "METHOD")?.value;
  const blocks = calendarSeries(calendarEvents(calendar)).flatMap((series) => [
    ...(series.event ? [describeEvent(series.event, timeZone, repeatLines({ ...series, event: series.event }, timeZone, next))] : []),
    ...series.changes.map((change) => describeEvent(change, timeZone, [])),
  ]).map((lines) => lines.join("\n"));
  const head = [`path=${path}`, ...(method ? [`method=${method}`] : []), ...notes].join("\n");
  return `${[head, ...(blocks.length > 0 ? blocks : ["events=0"])].join("\n\n")}\n`;
}

function describeEvent(event: CalendarEvent, timeZone: string, repeats: string[]): string[] {
  const lines = [`uid=${event.uid}`];
  if (event.recurrenceId) lines.push(`occurrence=${calendarTimeText(event.recurrenceId, timeZone)}`);
  lines.push(`sequence=${event.sequence}`);
  if (event.status) lines.push(`status=${event.status}`);
  if (event.title) lines.push(`title=${oneLine(event.title)}`);
  const when = calendarWhen(event, timeZone);
  if (when.allDay) lines.push("all_day=true");
  lines.push(`start=${when.start}`);
  if (when.end) lines.push(`end=${when.end}`);
  else if (when.duration) lines.push(`duration=${when.duration}`);
  if (event.recurrence) lines.push(`repeats=${event.recurrence}`);
  lines.push(...repeats);
  if (event.location) lines.push(`location=${oneLine(event.location)}`);
  if (event.organizer) lines.push(`organizer=${person(event.organizer)}`);
  for (const attendee of event.attendees) {
    lines.push(`attendee=${person(attendee)}${attendee.status ? ` ${attendee.status.toLowerCase()}` : ""}`);
  }
  if (event.description) lines.push(`description=${event.description.trim().replace(/\r\n|\r|\n/g, "\n  ")}`);
  return lines;
}

/** A series' skipped dates and next occurrences, which a rule cal can't read leaves out. */
function repeatLines(series: Series, timeZone: string, next: number): string[] {
  const { event } = series;
  if (!event.recurrence) return [];
  const lines = event.skipped.map((time) => `skipped=${calendarTimeText(time, timeZone)}`);
  let rule: RepeatRule;
  try {
    rule = parseRepeatRule(event.recurrence);
    if (event.start.kind === "local" && event.start.timeZone) normalizeTimezone(event.start.timeZone);
  } catch {
    return lines;
  }
  if (firstProperty(event.component, "RDATE")) return lines;
  const upcoming = nextOccurrences(series, rule, timeZone, Date.now(), next);
  if (upcoming.length === 0) return [...lines, "next=none"];
  return [...lines, ...upcoming.map((occurrence) => `next=${calendarTimeText(occurrence.start, timeZone)}`)];
}

function person(value: CalendarPerson): string {
  return value.name ? `${oneLine(value.name)} <${value.address}>` : value.address;
}

function oneLine(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").trim();
}

function parseWhen(value: string, timeZone: string): { kind: "date"; date: string } | { kind: "time"; ms: number } {
  const text = value.trim().replace(" ", "T");
  if (DATE.test(text)) {
    if (addDays(text, 0) !== text) throw new Error(`not a real date: ${value}`);
    return { kind: "date", date: text };
  }
  // A time a clock change skips reads as it would in the calendar file.
  if (isLocalTime(text)) return { kind: "time", ms: resolveLocalTime(text, timeZone, "offset-before") };
  const ms = INSTANT.test(text) ? Date.parse(text) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid time: ${value}; use a local time such as 2026-11-27T21:15 or a date such as 2026-11-27`);
  }
  return { kind: "time", ms };
}

/** The date an occurrence falls on where its series repeats. */
function occurrenceDate(time: CalendarTime, zone: string): string {
  if (time.kind !== "utc") return wallClock(time).date;
  return localDate(time.ms, zone);
}

function localDate(ms: number, zone: string): string {
  return formatLocalTime(ms, zone).slice(0, 10);
}

/** 45m, 2h, 1h30m or 2d. */
function parseLength(value: string): number {
  const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/.exec(value.trim());
  if (!match || !match.slice(1).some(Boolean)) throw new Error(`invalid length: ${value}; use a form such as 45m, 2h or 1h30m`);
  const [days, hours, minutes] = match.slice(1).map((part) => Number(part ?? 0));
  return days * DAY_MS + hours * HOUR_MS + minutes * 60_000;
}

function wholeDays(ms: number): number {
  if (ms % DAY_MS !== 0) throw new Error("an all-day event lasts whole days, such as 2d");
  return ms / DAY_MS;
}

function dayCount(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
}

function completed(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}
