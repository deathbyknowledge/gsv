import { defineCommand } from "just-bash";
import type { CommandContext, ExecResult } from "just-bash";
import type { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import { resolveCallerOwnerUid } from "../../../kernel/context";
import {
  calendarEvents,
  calendarProperty,
  dateValue,
  escapeText,
  firstProperty,
  parseCalendar,
  serializeCalendar,
  setProperty,
  utcValue,
  type CalendarComponent,
  type CalendarEvent,
  type CalendarPerson,
  type CalendarTime,
} from "../../../kernel/icalendar";
import { managedMailAddressForOwner } from "../../../kernel/mailbox";
import { ownerDisplayName } from "../../../kernel/profiles";
import {
  formatLocalTime,
  isLocalTime,
  normalizeTimezone,
  ownerTimezone,
  resolveLocalTime,
} from "../../../kernel/timezone";
import { requireShellOptionValue } from "./common";

const MAX_CALENDAR_FILE_BYTES = 1024 * 1024;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;

const CAL_USAGE = `Usage:
  cal add --title TITLE --start WHEN [--end WHEN | --duration LENGTH] [--timezone ZONE] [--location PLACE] [--description TEXT] [--attendee ADDRESS]... --out PATH
  cal update PATH [--title TITLE] [--start WHEN] [--end WHEN | --duration LENGTH] [--timezone ZONE] [--location PLACE] [--description TEXT] [--attendee ADDRESS]...
  cal cancel PATH
  cal show PATH [--timezone ZONE]

WHEN is a local time such as 2026-11-27T21:15 in --timezone (default: your time zone),
or a date such as 2026-11-27 for an all-day event. LENGTH is like 45m, 2h or 1h30m.
`;

type EventOptions = {
  title?: string;
  start?: string;
  end?: string;
  duration?: string;
  timeZone?: string;
  location?: string;
  description?: string;
  attendees: string[];
  out?: string;
};

/** Start and end of an event: all-day dates with an exclusive end, or instants. */
type Span =
  | { kind: "date"; start: string; end: string }
  | { kind: "time"; start: number; end: number };

type Organizer = { address: string; name?: string };

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
  const [path, options] = parseEventOptions(args, false);
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
  writeSpan(event, newSpan(options, timeZone, undefined));
  setProperty(event, "SEQUENCE", calendarProperty("SEQUENCE", "0"));
  setProperty(event, "STATUS", calendarProperty("STATUS", "CONFIRMED"));
  writeDetails(event, options);
  if (organizer) setProperty(event, "ORGANIZER", organizerProperty(organizer));
  writeAttendees(event, options.attendees);
  return await saveCalendar(fs, out, calendar, timeZone);
}

/** A new version of an event the Ship organizes: same UID, next SEQUENCE. */
async function changeEvent(
  change: "update" | "cancel",
  args: string[],
  shellCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
): Promise<ExecResult> {
  const [path, options] = parseEventOptions(args, change === "cancel");
  if (!path) throw new Error(`cal ${change} requires a calendar file`);
  if (options.out) throw new Error(`cal ${change} changes the file in place; --out applies to cal add`);
  const resolved = shellCtx.fs.resolvePath(shellCtx.cwd, path);
  const calendar = parseCalendar(await readCalendarFile(fs, resolved));
  const events = calendarEvents(calendar);
  if (events.length !== 1) {
    throw new Error(`${path} holds ${events.length} events; cal ${change} changes a file with one`);
  }
  const [current] = events;
  const organizer = shipOrganizer(ctx);
  if (current.organizer && current.organizer.address.toLowerCase() !== organizer?.address.toLowerCase()) {
    throw new Error(`${current.organizer.address} organizes this event; only its organizer can change it`);
  }
  const timeZone = eventTimeZone(options, ctx);
  const event = current.component;
  setProperty(calendar, "METHOD", calendarProperty("METHOD", change === "cancel" ? "CANCEL" : "REQUEST"));
  setProperty(event, "DTSTAMP", calendarProperty("DTSTAMP", utcValue(Date.now())));
  setProperty(event, "SEQUENCE", calendarProperty("SEQUENCE", String(current.sequence + 1)));
  setProperty(event, "STATUS", calendarProperty("STATUS", change === "cancel" ? "CANCELLED" : "CONFIRMED"));
  if (change === "update") {
    if (options.start || options.end || options.duration) {
      // A repeating event's times stay in its own zone so each occurrence keeps its wall-clock time.
      if (current.recurrence) throw new Error("this event repeats; cal can't change a repeating event's times");
      writeSpan(event, newSpan(options, timeZone, current));
    }
    writeDetails(event, options);
    if (options.attendees.length > 0) writeAttendees(event, options.attendees);
  }
  if (organizer && !current.organizer) setProperty(event, "ORGANIZER", organizerProperty(organizer));
  return await saveCalendar(fs, resolved, calendar, timeZone);
}

async function showCalendar(
  args: string[],
  shellCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
): Promise<ExecResult> {
  const [path, options] = parseEventOptions(args, true);
  if (!path) throw new Error("cal show requires a calendar file");
  if (options.out) throw new Error("cal show doesn't write; --out applies to cal add");
  const resolved = shellCtx.fs.resolvePath(shellCtx.cwd, path);
  const calendar = parseCalendar(await readCalendarFile(fs, resolved));
  return completed(describeCalendar(resolved, calendar, eventTimeZone(options, ctx)));
}

function parseEventOptions(args: string[], timeZoneOnly: boolean): [string | undefined, EventOptions] {
  const options: EventOptions = { attendees: [] };
  let path: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith("--")) {
      if (path) throw new Error(`unexpected argument: ${current}`);
      path = current;
      continue;
    }
    if (timeZoneOnly && current !== "--timezone") throw new Error(`unexpected argument: ${current}`);
    index += 1;
    const value = requireShellOptionValue(args[index], current);
    switch (current) {
      case "--title": options.title = value; break;
      case "--start": options.start = value; break;
      case "--end": options.end = value; break;
      case "--duration": options.duration = value; break;
      case "--timezone": options.timeZone = normalizeTimezone(value); break;
      case "--location": options.location = value; break;
      case "--description": options.description = value; break;
      case "--out": options.out = value; break;
      case "--attendee":
        options.attendees.push(...value.split(",").map((address) => address.trim()).filter(Boolean));
        break;
      default:
        throw new Error(`unexpected argument: ${current}`);
    }
  }
  if (options.end && options.duration) throw new Error("--end and --duration are mutually exclusive");
  return [path, options];
}

function eventTimeZone(options: EventOptions, ctx: KernelContext): string {
  return options.timeZone ?? ownerTimezone(ctx.config, resolveCallerOwnerUid(ctx));
}

/** The Ship's own address organizes what it sends, so replies come back to it. */
function shipOrganizer(ctx: KernelContext): Organizer | undefined {
  const ownerUid = resolveCallerOwnerUid(ctx);
  const address = managedMailAddressForOwner(ownerUid, ctx);
  if (!address) return undefined;
  const name = ownerDisplayName(ownerUid, ctx)?.trim();
  return name ? { address, name } : { address };
}

/** The event's new times; whatever isn't given keeps its current value, or its current length. */
function newSpan(options: EventOptions, timeZone: string, current: CalendarEvent | undefined): Span {
  const existing = current ? currentSpan(current, timeZone) : undefined;
  if (current && !existing && !(options.start && (options.end || options.duration))) {
    throw new Error("this event's times can't be read here; give --start with --end or --duration");
  }
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

function currentSpan(event: CalendarEvent, timeZone: string): Span | undefined {
  if (!event.end && event.duration) return undefined;
  if (event.start.kind === "date") {
    const end = event.end?.kind === "date" ? event.end.date : addDays(event.start.date, 1);
    return { kind: "date", start: event.start.date, end };
  }
  const start = instant(event.start, timeZone);
  const end = event.end ? instant(event.end, timeZone) : start === undefined ? undefined : start + HOUR_MS;
  return start === undefined || end === undefined ? undefined : { kind: "time", start, end };
}

/** A DATE-TIME as an instant: floating times are read in `timeZone`, TZIDs when they name an IANA zone. */
function instant(time: CalendarTime, timeZone: string): number | undefined {
  if (time.kind === "utc") return time.ms;
  if (time.kind === "date") return undefined;
  try {
    return resolveLocalTime(time.local, time.timeZone ? normalizeTimezone(time.timeZone) : timeZone);
  } catch {
    return undefined;
  }
}

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

function writeDetails(event: CalendarComponent, options: EventOptions): void {
  const details = [["SUMMARY", options.title], ["LOCATION", options.location], ["DESCRIPTION", options.description]] as const;
  for (const [name, value] of details) {
    if (value === undefined) continue;
    if (value.trim()) setProperty(event, name, calendarProperty(name, escapeText(value.trim())));
    else setProperty(event, name);
  }
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

async function saveCalendar(fs: GsvFs, path: string, calendar: CalendarComponent, timeZone: string): Promise<ExecResult> {
  await fs.writeFile(path, serializeCalendar(calendar));
  return completed(describeCalendar(path, calendar, timeZone));
}

function describeCalendar(path: string, calendar: CalendarComponent, timeZone: string): string {
  const method = firstProperty(calendar, "METHOD")?.value;
  const blocks = calendarEvents(calendar).map((event) => describeEvent(event, timeZone).join("\n"));
  const head = [`path=${path}`, ...(method ? [`method=${method}`] : [])].join("\n");
  return `${[head, ...(blocks.length > 0 ? blocks : ["events=0"])].join("\n\n")}\n`;
}

function describeEvent(event: CalendarEvent, timeZone: string): string[] {
  const lines = [`uid=${event.uid}`, `sequence=${event.sequence}`];
  if (event.status) lines.push(`status=${event.status}`);
  if (event.title) lines.push(`title=${oneLine(event.title)}`);
  if (event.start.kind === "date") {
    lines.push("all_day=true", `start=${event.start.date}`);
    if (event.end?.kind === "date") lines.push(`end=${addDays(event.end.date, -1)}`);
    else if (event.duration) lines.push(`duration=${event.duration}`);
    else lines.push(`end=${event.start.date}`);
  } else {
    lines.push(`start=${describeTime(event.start, timeZone)}`);
    if (event.end && event.end.kind !== "date") lines.push(`end=${describeTime(event.end, timeZone)}`);
    else if (event.duration) lines.push(`duration=${event.duration}`);
  }
  if (event.recurrence) lines.push(`repeats=${event.recurrence}`);
  if (event.location) lines.push(`location=${oneLine(event.location)}`);
  if (event.organizer) lines.push(`organizer=${person(event.organizer)}`);
  for (const attendee of event.attendees) {
    lines.push(`attendee=${person(attendee)}${attendee.status ? ` ${attendee.status.toLowerCase()}` : ""}`);
  }
  if (event.description) lines.push(`description=${event.description.trim().replace(/\r\n|\r|\n/g, "\n  ")}`);
  return lines;
}

function describeTime(time: Exclude<CalendarTime, { kind: "date" }>, timeZone: string): string {
  const ms = instant(time, timeZone);
  if (ms !== undefined) return formatLocalTime(ms, timeZone);
  return time.kind === "local" ? `${time.local} ${time.timeZone ?? "floating"}` : utcValue(time.ms);
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
  if (isLocalTime(text)) return { kind: "time", ms: resolveLocalTime(text, timeZone) };
  const ms = INSTANT.test(text) ? Date.parse(text) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid time: ${value}; use a local time such as 2026-11-27T21:15 or a date such as 2026-11-27`);
  }
  return { kind: "time", ms };
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

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function dayCount(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
}

function completed(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}
