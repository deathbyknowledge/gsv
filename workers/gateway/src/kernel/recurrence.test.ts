import { describe, expect, it } from "vitest";
import { calendarEvents, calendarInstant, parseCalendar, type CalendarTime } from "./icalendar";
import {
  calendarSeries,
  findOccurrence,
  formatRepeatRule,
  nextOccurrences,
  parseRepeatRule,
  repeatStarts,
  ruleIncludesStart,
} from "./recurrence";

const NEW_YORK = "America/New_York";
const AMSTERDAM = "Europe/Amsterdam";

function zoned(local: string, timeZone: string): CalendarTime {
  return { kind: "local", local, timeZone };
}

function dates(start: CalendarTime, rule: string, timeZone = NEW_YORK): string[] {
  return [...repeatStarts(start, parseRepeatRule(rule), timeZone)].map((time) => {
    if (time.kind !== "local") throw new Error("expected a local time");
    return time.local;
  });
}

/** A weekly team sync from Monday 30 November 2026: one Monday skipped, another moved to Tuesday. */
const SERIES = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:sync@ship.space",
  "DTSTAMP:20261111T120000Z",
  "DTSTART;TZID=Europe/Amsterdam:20261130T090000",
  "DTEND;TZID=Europe/Amsterdam:20261130T093000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20270628T215959Z",
  "EXDATE;TZID=Europe/Amsterdam:20261228T090000",
  "SUMMARY:Team sync",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:sync@ship.space",
  "DTSTAMP:20261111T120000Z",
  "RECURRENCE-ID;TZID=Europe/Amsterdam:20270104T090000",
  "DTSTART;TZID=Europe/Amsterdam:20270105T100000",
  "DTEND;TZID=Europe/Amsterdam:20270105T103000",
  "SUMMARY:Team sync",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("repeat rules", () => {
  // RFC 5545 section 3.8.5.3 works these examples, each starting at 09:00 in New York.
  it.each([
    { name: "daily for 10 occurrences", start: "1997-09-02", rule: "FREQ=DAILY;COUNT=10", days: ["09-02", "09-03", "09-04", "09-05", "09-06", "09-07", "09-08", "09-09", "09-10", "09-11"] },
    { name: "every 10 days, 5 occurrences", start: "1997-09-02", rule: "FREQ=DAILY;INTERVAL=10;COUNT=5", days: ["09-02", "09-12", "09-22", "10-02", "10-12"] },
    { name: "weekly for 10 occurrences", start: "1997-09-02", rule: "FREQ=WEEKLY;COUNT=10", days: ["09-02", "09-09", "09-16", "09-23", "09-30", "10-07", "10-14", "10-21", "10-28", "11-04"] },
    { name: "weekly on Tuesday and Thursday for five weeks", start: "1997-09-02", rule: "FREQ=WEEKLY;COUNT=10;WKST=SU;BYDAY=TU,TH", days: ["09-02", "09-04", "09-09", "09-11", "09-16", "09-18", "09-23", "09-25", "09-30", "10-02"] },
    {
      name: "every other week on Monday, Wednesday and Friday until 24 December",
      start: "1997-09-01",
      rule: "FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU;BYDAY=MO,WE,FR",
      days: ["09-01", "09-03", "09-05", "09-15", "09-17", "09-19", "09-29", "10-01", "10-03", "10-13", "10-15", "10-17", "10-27", "10-29", "10-31", "11-10", "11-12", "11-14", "11-24", "11-26", "11-28", "12-08", "12-10", "12-12", "12-22"],
    },
    { name: "every other week on Tuesday and Sunday, weeks from Monday", start: "1997-08-05", rule: "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO", days: ["08-05", "08-10", "08-19", "08-24"] },
    { name: "every other week on Tuesday and Sunday, weeks from Sunday", start: "1997-08-05", rule: "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU", days: ["08-05", "08-17", "08-19", "08-31"] },
    { name: "monthly on the first Friday for 10 occurrences", start: "1997-09-05", rule: "FREQ=MONTHLY;COUNT=10;BYDAY=1FR", days: ["1997-09-05", "1997-10-03", "1997-11-07", "1997-12-05", "1998-01-02", "1998-02-06", "1998-03-06", "1998-04-03", "1998-05-01", "1998-06-05"] },
    { name: "every other month on the first and last Sunday", start: "1997-09-07", rule: "FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU", days: ["1997-09-07", "1997-09-28", "1997-11-02", "1997-11-30", "1998-01-04", "1998-01-25", "1998-03-01", "1998-03-29", "1998-05-03", "1998-05-31"] },
    { name: "monthly on the 2nd and 15th", start: "1997-09-02", rule: "FREQ=MONTHLY;COUNT=10;BYMONTHDAY=2,15", days: ["1997-09-02", "1997-09-15", "1997-10-02", "1997-10-15", "1997-11-02", "1997-11-15", "1997-12-02", "1997-12-15", "1998-01-02", "1998-01-15"] },
    { name: "monthly on the first and last day", start: "1997-09-30", rule: "FREQ=MONTHLY;COUNT=10;BYMONTHDAY=1,-1", days: ["1997-09-30", "1997-10-01", "1997-10-31", "1997-11-01", "1997-11-30", "1997-12-01", "1997-12-31", "1998-01-01", "1998-01-31", "1998-02-01"] },
    { name: "every 18 months on the 10th to 15th", start: "1997-09-10", rule: "FREQ=MONTHLY;INTERVAL=18;COUNT=10;BYMONTHDAY=10,11,12,13,14,15", days: ["1997-09-10", "1997-09-11", "1997-09-12", "1997-09-13", "1997-09-14", "1997-09-15", "1999-03-10", "1999-03-11", "1999-03-12", "1999-03-13"] },
    { name: "yearly in June and July", start: "1997-06-10", rule: "FREQ=YEARLY;COUNT=10;BYMONTH=6,7", days: ["1997-06-10", "1997-07-10", "1998-06-10", "1998-07-10", "1999-06-10", "1999-07-10", "2000-06-10", "2000-07-10", "2001-06-10", "2001-07-10"] },
    { name: "every other year in January, February and March", start: "1997-03-10", rule: "FREQ=YEARLY;INTERVAL=2;COUNT=10;BYMONTH=1,2,3", days: ["1997-03-10", "1999-01-10", "1999-02-10", "1999-03-10", "2001-01-10", "2001-02-10", "2001-03-10", "2003-01-10", "2003-02-10", "2003-03-10"] },
  ])("expands $name as RFC 5545 does", ({ start, rule, days }) => {
    const expected = days.map((day) => `${day.length === 5 ? "1997-" : ""}${day}T09:00:00`);

    expect(dates(zoned(`${start}T09:00:00`, NEW_YORK), rule)).toEqual(expected);
  });

  it("keeps each occurrence's wall clock across a change to summer time", () => {
    const starts = [...repeatStarts(zoned("2027-03-22T09:00:00", AMSTERDAM), parseRepeatRule("FREQ=WEEKLY;COUNT=3"), AMSTERDAM)];

    expect(starts.map((time) => new Date(calendarInstant(time, AMSTERDAM) ?? 0).toISOString())).toEqual([
      "2027-03-22T08:00:00.000Z",
      "2027-03-29T07:00:00.000Z",
      "2027-04-05T07:00:00.000Z",
    ]);
  });

  it("keeps a date whose time the change to summer time skips, an hour later as calendars read it", () => {
    // New York's clocks go from 02:00 to 03:00 on 14 March 2027; RFC 5545 reads 02:30 with the offset before.
    const starts = [...repeatStarts(zoned("2027-03-13T02:30:00", NEW_YORK), parseRepeatRule("FREQ=DAILY;COUNT=3"), NEW_YORK)];

    expect(starts.map((time) => new Date(calendarInstant(time, NEW_YORK) ?? 0).toISOString())).toEqual([
      "2027-03-13T07:30:00.000Z",
      "2027-03-14T07:30:00.000Z",
      "2027-03-15T06:30:00.000Z",
    ]);
  });

  it("ends at a UTC UNTIL by instant in the hour a change to winter time repeats", () => {
    const start = zoned("2027-11-06T01:30:00", NEW_YORK);

    // UNTIL reads 01:00 in New York, on the hour's second pass; 01:30 that day comes first, at 05:30Z.
    expect(dates(start, "FREQ=DAILY;UNTIL=20271107T060000Z")).toEqual(["2027-11-06T01:30:00", "2027-11-07T01:30:00"]);
    expect(dates(start, "FREQ=DAILY;UNTIL=20271107T052959Z")).toEqual(["2027-11-06T01:30:00"]);
  });

  it("skips months without the day and years without 29 February", () => {
    expect(dates(zoned("2027-01-31T18:00:00", AMSTERDAM), "FREQ=MONTHLY;COUNT=4", AMSTERDAM)).toEqual([
      "2027-01-31T18:00:00", "2027-03-31T18:00:00", "2027-05-31T18:00:00", "2027-07-31T18:00:00",
    ]);
    expect(dates(zoned("2027-01-31T18:00:00", AMSTERDAM), "FREQ=MONTHLY;COUNT=4;BYMONTHDAY=-1", AMSTERDAM)).toEqual([
      "2027-01-31T18:00:00", "2027-02-28T18:00:00", "2027-03-31T18:00:00", "2027-04-30T18:00:00",
    ]);
    const birthdays = [...repeatStarts({ kind: "date", date: "2028-02-29" }, parseRepeatRule("FREQ=YEARLY;COUNT=3"), AMSTERDAM)];
    expect(birthdays).toEqual([
      { kind: "date", date: "2028-02-29" },
      { kind: "date", date: "2032-02-29" },
      { kind: "date", date: "2036-02-29" },
    ]);
  });

  it("ends a rule that can never happen again instead of searching forever", () => {
    const starts = [...repeatStarts({ kind: "date", date: "2027-02-01" }, parseRepeatRule("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"), AMSTERDAM)];

    expect(starts).toEqual([{ kind: "date", date: "2027-02-01" }]);
  });

  it("writes a rule back in one form", () => {
    expect(formatRepeatRule(parseRepeatRule("freq=weekly;byday=we,mo,we;wkst=su;until=20270628T215959Z;"))).toBe(
      "FREQ=WEEKLY;BYDAY=WE,MO;WKST=SU;UNTIL=20270628T215959Z",
    );
    expect(formatRepeatRule(parseRepeatRule("FREQ=MONTHLY;INTERVAL=2;BYDAY=+4FR,-1FR;COUNT=6"))).toBe(
      "FREQ=MONTHLY;INTERVAL=2;BYDAY=4FR,-1FR;COUNT=6",
    );
  });

  it.each([
    { rule: "FREQ=HOURLY", error: "needs FREQ=DAILY" },
    { rule: "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", error: "BYSETPOS isn't supported" },
    { rule: "FREQ=WEEKLY;COUNT=3;UNTIL=20270101", error: "COUNT or UNTIL, not both" },
    { rule: "FREQ=WEEKLY;BYDAY=2MO", error: "without a number" },
    { rule: "FREQ=MONTHLY;BYDAY=FR", error: "says which one" },
    { rule: "FREQ=MONTHLY;BYDAY=4FR;BYMONTHDAY=13", error: "not both" },
    { rule: "FREQ=MONTHLY;BYDAY=-2FR", error: "from 1 to 5, or -1" },
    { rule: "FREQ=MONTHLY;BYMONTHDAY=0", error: "isn't a day from 1 to 31" },
    { rule: "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", error: "not BYDAY" },
    { rule: "FREQ=YEARLY;BYMONTHDAY=15", error: "needs BYMONTH" },
    { rule: "FREQ=DAILY;BYDAY=MO", error: "a daily repeat takes no" },
    { rule: "FREQ=WEEKLY;INTERVAL=0", error: "whole number from 1" },
    { rule: "FREQ=WEEKLY;FREQ=DAILY", error: "FREQ twice" },
    { rule: "FREQ=WEEKLY;UNTIL=tomorrow", error: "UNTIL=TOMORROW isn't a date" },
  ])("refuses $rule", ({ rule, error }) => {
    expect(() => parseRepeatRule(rule)).toThrow(error);
  });

  it.each([
    { rule: "FREQ=WEEKLY;BYDAY=MO", start: "2026-11-30", included: true },
    { rule: "FREQ=WEEKLY;BYDAY=MO", start: "2026-12-01", included: false },
    { rule: "FREQ=MONTHLY;BYDAY=4FR", start: "2026-11-27", included: true },
    { rule: "FREQ=MONTHLY;BYDAY=4FR", start: "2026-11-20", included: false },
    { rule: "FREQ=MONTHLY;BYMONTHDAY=-1", start: "2027-01-30", included: false },
    { rule: "FREQ=YEARLY", start: "2028-02-29", included: true },
  ])("knows whether $rule includes a start on $start", ({ rule, start, included }) => {
    expect(ruleIncludesStart({ kind: "date", date: start }, parseRepeatRule(rule))).toBe(included);
  });
});

describe("a series and its changed dates", () => {
  const [series] = calendarSeries(calendarEvents(parseCalendar(SERIES)));

  it("groups an event with the dates changed from it", () => {
    expect(series.event?.skipped).toEqual([zoned("2026-12-28T09:00:00", AMSTERDAM)]);
    expect(series.changes.map((change) => change.recurrenceId)).toEqual([zoned("2027-01-04T09:00:00", AMSTERDAM)]);
  });

  it("lists the next occurrences, skipping one and placing a moved one where it is now", () => {
    if (!series.event?.recurrence) throw new Error("expected a repeating event");
    const rule = parseRepeatRule(series.event.recurrence);

    const next = nextOccurrences({ ...series, event: series.event }, rule, AMSTERDAM, Date.parse("2026-12-20T00:00:00Z"), 4);

    expect(next.map((occurrence) => occurrence.start)).toEqual([
      zoned("2026-12-21T09:00:00", AMSTERDAM),
      zoned("2027-01-05T10:00:00", AMSTERDAM),
      zoned("2027-01-11T09:00:00", AMSTERDAM),
      zoned("2027-01-18T09:00:00", AMSTERDAM),
    ]);
    expect(next[1].id).toEqual(zoned("2027-01-04T09:00:00", AMSTERDAM));
  });

  it("leaves out a start that has passed in the hour a change to winter time repeats", () => {
    const [nightly] = calendarSeries(calendarEvents(parseCalendar([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:nightly@ship.space",
      "DTSTAMP:20271101T120000Z",
      "DTSTART;TZID=America/New_York:20271106T013000",
      "RRULE:FREQ=DAILY",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n"))));
    const { event } = nightly;
    if (!event?.recurrence) throw new Error("expected a repeating event");
    const rule = parseRepeatRule(event.recurrence);
    const next = (now: string) => nextOccurrences({ ...nightly, event }, rule, NEW_YORK, Date.parse(now), 2)
      .map((occurrence) => occurrence.start);

    // 01:30 on 7 November comes first, at 05:30Z; by 06:15Z New York reads 01:15 a second time.
    expect(next("2027-11-07T05:15:00Z")).toEqual([zoned("2027-11-07T01:30:00", NEW_YORK), zoned("2027-11-08T01:30:00", NEW_YORK)]);
    expect(next("2027-11-07T06:15:00Z")).toEqual([zoned("2027-11-08T01:30:00", NEW_YORK), zoned("2027-11-09T01:30:00", NEW_YORK)]);
  });

  it("finds an occurrence by date or instant, or the dates either side", () => {
    if (!series.event?.recurrence) throw new Error("expected a repeating event");
    const rule = parseRepeatRule(series.event.recurrence);

    expect(findOccurrence(series.event.start, rule, { date: "2026-12-14" }, AMSTERDAM)).toEqual({ id: zoned("2026-12-14T09:00:00", AMSTERDAM) });
    expect(findOccurrence(series.event.start, rule, { ms: Date.parse("2026-12-21T08:00:00Z") }, AMSTERDAM)).toEqual({ id: zoned("2026-12-21T09:00:00", AMSTERDAM) });
    expect(findOccurrence(series.event.start, rule, { date: "2026-12-16" }, AMSTERDAM)).toEqual({
      previous: zoned("2026-12-14T09:00:00", AMSTERDAM),
      next: zoned("2026-12-21T09:00:00", AMSTERDAM),
    });
    expect(findOccurrence(series.event.start, rule, { date: "2027-07-05" }, AMSTERDAM)).toEqual({ previous: zoned("2027-06-28T09:00:00", AMSTERDAM) });
  });
});
