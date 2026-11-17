import { describe, expect, it } from "vitest";
import { firstProperty, parseCalendar, serializeCalendar, type CalendarComponent } from "./icalendar";
import { utcOffsetReader } from "./timezone";
import { timeZoneComponent, writeTimeZones } from "./vtimezone";

const DAY_MS = 86_400_000;
/** The day these tests read zone data on, so the rules in force stay those of 2026. */
const NOW = Date.UTC(2026, 10, 12);

type Onset = { at: number; to: number };

/** When each observance begins, read back from its DTSTART and yearly rule as a calendar would. */
function onsets(component: CalendarComponent, lastYear: number): Onset[] {
  const found: Onset[] = [];
  for (const observance of component.components) {
    const value = (name: string) => firstProperty(observance, name)?.value ?? "";
    const from = offsetMs(value("TZOFFSETFROM"));
    const to = offsetMs(value("TZOFFSETTO"));
    const start = value("DTSTART");
    const [year, month, day, hour, minute, second] = [0, 4, 6, 9, 11, 13].map((at, index) => Number(start.slice(at, at + (index === 0 ? 4 : 2))));
    const rule = value("RRULE");
    if (!rule) {
      found.push({ at: Date.UTC(year, month - 1, day, hour, minute, second) - from, to });
      continue;
    }
    const parts = Object.fromEntries(rule.split(";").map((part) => part.split("=")));
    for (let current = year; current <= lastYear; current += 1) {
      const onsetDay = ruleDay(current, Number(parts.BYMONTH), parts.BYDAY, parts.BYMONTHDAY);
      found.push({ at: Date.UTC(current, Number(parts.BYMONTH) - 1, onsetDay, hour, minute, second) - from, to });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

function ruleDay(year: number, month: number, byDay: string, byMonthDay: string | undefined): number {
  const [, ordinal, weekday] = /^(-?\d)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(byDay) ?? [];
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days = Array.from({ length }, (_, index) => index + 1)
    .filter((day) => new Date(Date.UTC(year, month - 1, day)).getUTCDay() === ["SU", "MO", "TU", "WE", "TH", "FR", "SA"].indexOf(weekday));
  if (byMonthDay) return days.find((day) => byMonthDay.split(",").map(Number).includes(day)) ?? Number.NaN;
  return Number(ordinal) > 0 ? days[Number(ordinal) - 1] : days[days.length + Number(ordinal)];
}

function offsetMs(value: string): number {
  const [, sign, hours, minutes, seconds = "0"] = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(value) ?? [];
  return (sign === "-" ? -1 : 1) * ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

function predicted(found: Onset[], at: number): number | undefined {
  let offset: number | undefined;
  for (const onset of found) {
    if (onset.at > at) break;
    offset = onset.to;
  }
  return offset;
}

describe("VTIMEZONE", () => {
  it("writes a zone's clock changes as the yearly rules calendars use", () => {
    const text = serializeCalendar(timeZoneComponent("Europe/Amsterdam", 2026, NOW));

    expect(text).toBe([
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Amsterdam",
      "BEGIN:DAYLIGHT",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0200",
      "DTSTART:20250330T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "DTSTART:20251026T030000",
      "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
      "END:STANDARD",
      "END:VTIMEZONE",
      "",
    ].join("\r\n"));
  });

  it.each([
    "Europe/Amsterdam",
    "Europe/London",
    "Europe/Dublin",
    "America/New_York",
    "America/Havana",
    "America/Santiago",
    "America/Asuncion",
    "America/Sao_Paulo",
    "Australia/Sydney",
    "Australia/Lord_Howe",
    "Pacific/Auckland",
    "Pacific/Chatham",
    "Asia/Jerusalem",
    "Asia/Tehran",
    "Asia/Kolkata",
    "Asia/Kathmandu",
    "Africa/Casablanca",
    "Africa/Cairo",
    "Antarctica/Troll",
    "UTC",
  ])("predicts the offsets this runtime has for %s through 2029", (zone) => {
    const component = timeZoneComponent(zone, 2026, NOW);
    const offsetAt = utcOffsetReader(zone);
    const found = onsets(component, 2030);
    const [from, until] = [Date.UTC(2026, 0, 1), Date.UTC(2030, 0, 1)];
    const samples: number[] = [];
    for (let at = from + DAY_MS / 2; at < until; at += DAY_MS) samples.push(at);
    for (const onset of found) if (onset.at >= from && onset.at < until) samples.push(onset.at - 1000, onset.at);

    const wrong = samples.filter((at) => predicted(found, at) !== offsetAt(at)).map((at) => new Date(at).toISOString());

    expect(wrong).toEqual([]);
  });

  it("carries a series that began years ago through the rules in force now", () => {
    const component = timeZoneComponent("America/New_York", 2000, NOW);
    const offsetAt = utcOffsetReader("America/New_York");
    const found = onsets(component, 2030);
    const samples: number[] = [];
    for (let at = Date.UTC(2014, 0, 1) + DAY_MS / 2; at < Date.UTC(2030, 0, 1); at += DAY_MS) samples.push(at);

    const wrong = samples.filter((at) => predicted(found, at) !== offsetAt(at)).map((at) => new Date(at).toISOString());

    expect(wrong).toEqual([]);
    expect(serializeCalendar(component)).toContain("DTSTART:20250309T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU");
  });

  it("replaces a calendar's zones with one for each TZID its events name", () => {
    const calendar = parseCalendar([
      "BEGIN:VCALENDAR",
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Amsterdam",
      "BEGIN:STANDARD",
      "TZOFFSETFROM:+0000",
      "TZOFFSETTO:+0000",
      "DTSTART:19700101T000000",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:sync@ship.space",
      "DTSTART;TZID=Europe/Amsterdam:20261130T090000",
      "EXDATE;TZID=America/New_York:20261207T030000,20261214T030000",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n"));

    writeTimeZones(calendar);

    expect(calendar.components.map((component) => [component.name, firstProperty(component, "TZID")?.value])).toEqual([
      ["VTIMEZONE", "Europe/Amsterdam"],
      ["VTIMEZONE", "America/New_York"],
      ["VEVENT", undefined],
    ]);
    expect(calendar.components[0]).toEqual(timeZoneComponent("Europe/Amsterdam", 2026));
  });

  it("drops the zones of a calendar whose times are all UTC", () => {
    const calendar = parseCalendar("BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Amsterdam\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261127T201500Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");

    writeTimeZones(calendar);

    expect(calendar.components.map((component) => component.name)).toEqual(["VEVENT"]);
  });

  it("refuses a TZID that isn't an IANA time zone", () => {
    const calendar = parseCalendar("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=W. Europe Standard Time:20261130T090000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");

    expect(() => writeTimeZones(calendar)).toThrow("time zone W. Europe Standard Time isn't an IANA time zone");
  });
});
