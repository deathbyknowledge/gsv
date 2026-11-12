/**
 * iCalendar (RFC 5545) as plain data: a component tree whose property values stay as written,
 * so a file read and written again keeps everything this module doesn't interpret.
 */

import { formatLocalTime, normalizeTimezone, resolveLocalTime } from "./timezone";

export type CalendarProperty = {
  name: string;
  params: Record<string, string[]>;
  value: string;
};

export type CalendarComponent = {
  name: string;
  properties: CalendarProperty[];
  components: CalendarComponent[];
};

/** A DATE (all day), a UTC DATE-TIME, or a wall-clock DATE-TIME in its TZID or none. */
export type CalendarTime =
  | { kind: "date"; date: string }
  | { kind: "utc"; ms: number }
  | { kind: "local"; local: string; timeZone?: string };

export type CalendarPerson = { address: string; name?: string; status?: string };

/** The fields of one VEVENT that GSV reads; the component keeps the rest. */
export type CalendarEvent = {
  component: CalendarComponent;
  uid: string;
  sequence: number;
  status?: string;
  title?: string;
  start: CalendarTime;
  end?: CalendarTime;
  duration?: string;
  location?: string;
  description?: string;
  organizer?: CalendarPerson;
  attendees: CalendarPerson[];
  recurrence?: string;
  /** The occurrence of a repeating event this one changes. */
  recurrenceId?: CalendarTime;
  /** Occurrences a repeating event skips (EXDATE). */
  skipped: CalendarTime[];
};

const MAX_DEPTH = 8;
const NAME = /^[A-Za-z0-9-]+/;
const ENCODER = new TextEncoder();

export function parseCalendar(text: string): CalendarComponent {
  const stack: CalendarComponent[] = [];
  let root: CalendarComponent | undefined;
  for (const line of unfold(text)) {
    if (line.trim() === "") continue;
    const property = parseContentLine(line);
    if (property.name === "BEGIN") {
      const component: CalendarComponent = { name: property.value.toUpperCase(), properties: [], components: [] };
      const parent = stack.at(-1);
      if (parent) parent.components.push(component);
      else if (root) throw new Error("calendar has more than one VCALENDAR");
      else root = component;
      stack.push(component);
      if (stack.length > MAX_DEPTH) throw new Error("calendar nests components too deeply");
    } else if (property.name === "END") {
      if (stack.pop()?.name !== property.value.toUpperCase()) {
        throw new Error(`calendar END:${property.value} closes nothing open`);
      }
    } else {
      const current = stack.at(-1);
      if (!current) throw new Error("calendar has a property outside BEGIN:VCALENDAR");
      current.properties.push(property);
    }
  }
  if (!root || stack.length > 0) throw new Error("calendar is incomplete: a BEGIN has no END");
  if (root.name !== "VCALENDAR") throw new Error("not an iCalendar file: it doesn't begin with BEGIN:VCALENDAR");
  return root;
}

/** CRLF lines folded at 75 octets, as RFC 5545 requires. */
export function serializeCalendar(root: CalendarComponent): string {
  const lines: string[] = [];
  const write = (component: CalendarComponent) => {
    lines.push(`BEGIN:${component.name}`);
    for (const property of component.properties) lines.push(contentLine(property));
    for (const child of component.components) write(child);
    lines.push(`END:${component.name}`);
  };
  write(root);
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

export function calendarEvents(root: CalendarComponent): CalendarEvent[] {
  return root.components.filter((component) => component.name === "VEVENT").map((component) => {
    const uid = firstProperty(component, "UID")?.value.trim();
    if (!uid) throw new Error("calendar event has no UID");
    const start = firstProperty(component, "DTSTART");
    if (!start) throw new Error(`calendar event ${uid} has no start`);
    const sequence = Number(firstProperty(component, "SEQUENCE")?.value ?? 0);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error(`calendar event ${uid} has an invalid SEQUENCE`);
    const end = firstProperty(component, "DTEND");
    const organizer = firstProperty(component, "ORGANIZER");
    const event: CalendarEvent = {
      component,
      uid,
      sequence,
      start: calendarTime(start),
      attendees: component.properties.filter((property) => property.name === "ATTENDEE").map(calendarPerson),
      skipped: component.properties.filter((property) => property.name === "EXDATE").flatMap(calendarTimes),
    };
    if (end) event.end = calendarTime(end);
    if (organizer) event.organizer = calendarPerson(organizer);
    const texts = [["status", "STATUS"], ["title", "SUMMARY"], ["location", "LOCATION"], ["description", "DESCRIPTION"]] as const;
    for (const [field, name] of texts) {
      const value = textProperty(component, name);
      if (value) event[field] = value;
    }
    const duration = firstProperty(component, "DURATION")?.value;
    if (duration) event.duration = duration;
    const recurrence = firstProperty(component, "RRULE")?.value;
    if (recurrence) event.recurrence = recurrence;
    const recurrenceId = firstProperty(component, "RECURRENCE-ID");
    if (recurrenceId) event.recurrenceId = calendarTime(recurrenceId);
    return event;
  });
}

export function firstProperty(component: CalendarComponent, name: string): CalendarProperty | undefined {
  return component.properties.find((property) => property.name === name);
}

export function textProperty(component: CalendarComponent, name: string): string | undefined {
  const property = firstProperty(component, name);
  return property ? unescapeText(property.value) : undefined;
}

/** Replaces every `name` property with `values`, keeping the first one's place in the component. */
export function setProperty(component: CalendarComponent, name: string, ...values: CalendarProperty[]): void {
  const index = component.properties.findIndex((property) => property.name === name);
  const kept = component.properties.filter((property) => property.name !== name);
  kept.splice(index < 0 ? kept.length : index, 0, ...values);
  component.properties = kept;
}

export function calendarProperty(name: string, value: string, params: Record<string, string[]> = {}): CalendarProperty {
  return { name, params, value };
}

export function escapeText(value: string): string {
  return value.replace(/[\\;,]/g, "\\$&").replace(/\r\n|\r|\n/g, "\\n");
}

export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, character: string) => (character.toLowerCase() === "n" ? "\n" : character));
}

export function calendarTime(property: CalendarProperty): CalendarTime {
  const { value } = property;
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date) return { kind: "date", date: `${date[1]}-${date[2]}-${date[3]}` };
  const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!time || property.params.VALUE?.[0]?.toUpperCase() === "DATE") {
    throw new Error(`calendar ${property.name} is not a date or time: ${value}`);
  }
  const local = `${time[1]}-${time[2]}-${time[3]}T${time[4]}:${time[5]}:${time[6]}`;
  if (time[7]) {
    const ms = Date.parse(`${local}Z`);
    if (!Number.isFinite(ms)) throw new Error(`calendar ${property.name} is not a real time: ${value}`);
    return { kind: "utc", ms };
  }
  const timeZone = property.params.TZID?.[0];
  return timeZone ? { kind: "local", local, timeZone } : { kind: "local", local };
}

/** Each value of a property that may list several, such as EXDATE:20261228T090000,20270104T090000. */
export function calendarTimes(property: CalendarProperty): CalendarTime[] {
  return property.value.split(",").map((value) => calendarTime({ ...property, value: value.trim() }));
}

/** A time as a property value: 20261127, 20261127T201500Z, or a wall clock with its TZID. */
export function timeProperty(name: string, time: CalendarTime): CalendarProperty {
  if (time.kind === "date") return calendarProperty(name, dateValue(time.date), { VALUE: ["DATE"] });
  if (time.kind === "utc") return calendarProperty(name, utcValue(time.ms));
  return calendarProperty(name, time.local.replace(/[-:]/g, ""), time.timeZone ? { TZID: [time.timeZone] } : {});
}

/** When an event happens as read in a time zone: an all-day event by its first and last day. */
export type CalendarWhen = { allDay: boolean; start: string; end?: string; duration?: string };

/** A DATE-TIME as an instant, floating times read in `timeZone`; none for a date or a TZID outside IANA. */
export function calendarInstant(time: CalendarTime, timeZone: string): number | undefined {
  if (time.kind === "utc") return time.ms;
  if (time.kind === "date") return undefined;
  try {
    return resolveLocalTime(time.local, time.timeZone ? normalizeTimezone(time.timeZone) : timeZone);
  } catch {
    return undefined;
  }
}

/** Times read like 2026-11-27T21:15:00+01:00[Europe/Amsterdam]. */
export function calendarWhen(event: CalendarEvent, timeZone: string): CalendarWhen {
  if (event.start.kind === "date") {
    const when: CalendarWhen = { allDay: true, start: event.start.date };
    if (event.end?.kind === "date") when.end = addDays(event.end.date, -1);
    else if (event.duration) when.duration = event.duration;
    else when.end = event.start.date;
    return when;
  }
  const when: CalendarWhen = { allDay: false, start: calendarTimeText(event.start, timeZone) };
  if (event.end && event.end.kind !== "date") when.end = calendarTimeText(event.end, timeZone);
  else if (event.duration) when.duration = event.duration;
  return when;
}

/** A date as written, or a time like 2026-11-27T21:15:00+01:00[Europe/Amsterdam]; a time this can't place keeps its TZID. */
export function calendarTimeText(time: CalendarTime, timeZone: string): string {
  if (time.kind === "date") return time.date;
  const ms = calendarInstant(time, timeZone);
  if (ms !== undefined) return formatLocalTime(ms, timeZone);
  return time.kind === "local" ? `${time.local} ${time.timeZone ?? "floating"}` : utcValue(time.ms);
}

/** A YYYY-MM-DD date `days` later, or earlier when negative. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** A UTC DATE-TIME value: 20261127T201500Z. */
export function utcValue(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** A DATE value from YYYY-MM-DD: 20261127. */
export function dateValue(date: string): string {
  return date.replaceAll("-", "");
}

/** The address behind a CAL-ADDRESS such as mailto:anna@example.com. */
export function calendarAddress(value: string): string | undefined {
  const match = /^mailto:(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : undefined;
}

function calendarPerson(property: CalendarProperty): CalendarPerson {
  const address = calendarAddress(property.value);
  if (!address) throw new Error(`calendar ${property.name} is not an email address: ${property.value}`);
  const person: CalendarPerson = { address };
  const name = property.params.CN?.[0];
  if (name) person.name = name;
  const status = property.params.PARTSTAT?.[0];
  if (status) person.status = status.toUpperCase();
  return person;
}

function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  return lines;
}

/** name *(";" param) ":" value, where a quoted parameter value may hold ";", ":" and ",". */
function parseContentLine(line: string): CalendarProperty {
  const name = NAME.exec(line)?.[0];
  if (!name) throw new Error(`calendar line is not a property: ${line.slice(0, 40)}`);
  let index = name.length;
  const params: Record<string, string[]> = {};
  while (line[index] === ";") {
    const param = NAME.exec(line.slice(index + 1))?.[0];
    if (!param || line[index + 1 + param.length] !== "=") throw new Error(`calendar ${name} has a malformed parameter`);
    index += param.length + 2;
    const values: string[] = [];
    for (;;) {
      if (line[index] === "\"") {
        const close = line.indexOf("\"", index + 1);
        if (close < 0) throw new Error(`calendar ${name} has an unclosed quote`);
        values.push(line.slice(index + 1, close));
        index = close + 1;
      } else {
        const value = /^[^";:,]*/.exec(line.slice(index))?.[0] ?? "";
        values.push(value);
        index += value.length;
      }
      if (line[index] !== ",") break;
      index += 1;
    }
    params[param.toUpperCase()] = values;
  }
  if (line[index] !== ":") throw new Error(`calendar ${name} has no value`);
  return { name: name.toUpperCase(), params, value: line.slice(index + 1) };
}

function contentLine(property: CalendarProperty): string {
  const params = Object.entries(property.params)
    .map(([name, values]) => `;${name}=${values.map(paramValue).join(",")}`)
    .join("");
  return `${property.name}${params}:${property.value}`;
}

/** A parameter value can't hold a double quote or control character; one holding ";:," is quoted. */
function paramValue(value: string): string {
  const clean = value.replace(/["\p{Cc}]/gu, "");
  return /[;:,]/.test(clean) ? `"${clean}"` : clean;
}

/** Splits between characters, so a continuation never starts inside a UTF-8 sequence. */
function fold(line: string): string {
  const pieces: string[] = [];
  let piece = "";
  let octets = 0;
  for (const character of line) {
    const size = ENCODER.encode(character).byteLength;
    // A continuation's leading space counts toward its 75 octets.
    if (octets + size > (pieces.length === 0 ? 75 : 74)) {
      pieces.push(piece);
      piece = "";
      octets = 0;
    }
    piece += character;
    octets += size;
  }
  pieces.push(piece);
  return pieces.join("\r\n ");
}
