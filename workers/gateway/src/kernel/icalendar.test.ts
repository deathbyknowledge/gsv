import { describe, expect, it } from "vitest";
import {
  calendarEvents,
  escapeText,
  parseCalendar,
  serializeCalendar,
  unescapeText,
} from "./icalendar";

/** An invite as Google Calendar writes one, folded, with parameters this module doesn't read. */
const GOOGLE_INVITE = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "CALSCALE:GREGORIAN",
  "METHOD:REQUEST",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20261127T190000",
  "DTEND;TZID=America/New_York:20261127T200000",
  "DTSTAMP:20261111T120000Z",
  "ORGANIZER;CN=\"Mike, from Accounts\":mailto:mike@example.com",
  "UID:7kukuqrfedlm2f9t2vbotkei0h@google.com",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=",
  " TRUE;CN=hank@ship.space;X-NUM-GUESTS=0:mailto:hank@ship.space",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE",
  " ;CN=Mike;X-NUM-GUESTS=0:mailto:mike@example.com",
  "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
  "DESCRIPTION:Agenda:\\n1. Budget\\, again\\n2. Q\\;A",
  "SEQUENCE:2",
  "STATUS:CONFIRMED",
  "SUMMARY:Quarterly review",
  "RRULE:FREQ=MONTHLY;BYDAY=4FR",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("iCalendar", () => {
  it("reads an event someone else's calendar wrote, folded lines and quoted parameters included", () => {
    const [event] = calendarEvents(parseCalendar(GOOGLE_INVITE));

    expect(event).toMatchObject({
      uid: "7kukuqrfedlm2f9t2vbotkei0h@google.com",
      sequence: 2,
      status: "CONFIRMED",
      title: "Quarterly review",
      start: { kind: "local", local: "2026-11-27T19:00:00", timeZone: "America/New_York" },
      end: { kind: "local", local: "2026-11-27T20:00:00", timeZone: "America/New_York" },
      description: "Agenda:\n1. Budget, again\n2. Q;A",
      organizer: { address: "mike@example.com", name: "Mike, from Accounts" },
      attendees: [
        { address: "hank@ship.space", name: "hank@ship.space", status: "NEEDS-ACTION" },
        { address: "mike@example.com", name: "Mike", status: "ACCEPTED" },
      ],
      recurrence: "FREQ=MONTHLY;BYDAY=4FR",
    });
  });

  it("writes back everything it read, folded within 75 octets without splitting a character", () => {
    const calendar = parseCalendar(GOOGLE_INVITE);
    const [event] = calendarEvents(calendar);
    event.component.properties.push({ name: "LOCATION", params: {}, value: escapeText("Café ".repeat(30).trim()) });

    const written = serializeCalendar(calendar);
    const reread = parseCalendar(written);

    expect(reread).toEqual(calendar);
    expect(written).toContain("X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij");
    expect(written).toContain("ORGANIZER;CN=\"Mike, from Accounts\":mailto:mike@example.com");
    expect(written.endsWith("\r\n")).toBe(true);
    const lines = written.split("\r\n");
    expect(lines.filter((line) => new TextEncoder().encode(line).byteLength > 75)).toEqual([]);
    expect(lines.filter((line) => line.includes("�"))).toEqual([]);
    expect(calendarEvents(reread)[0].location).toBe("Café ".repeat(30).trim());
  });

  it("escapes and unescapes TEXT values", () => {
    const text = "Line one\nback\\slash; comma, done";

    expect(escapeText(text)).toBe("Line one\\nback\\\\slash\\; comma\\, done");
    expect(unescapeText(escapeText(text))).toBe(text);
  });

  it.each([
    { problem: "isn't iCalendar", text: "BEGIN:VCARD\r\nEND:VCARD\r\n", error: "not an iCalendar file" },
    { problem: "never ends", text: "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n", error: "incomplete" },
    { problem: "closes the wrong component", text: "BEGIN:VCALENDAR\r\nEND:VEVENT\r\n", error: "closes nothing open" },
    { problem: "has an event without an id", text: "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261127T201500Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n", error: "no UID" },
    { problem: "has a bad time", text: "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:tomorrow\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n", error: "not a date or time" },
  ])("refuses a calendar that $problem", ({ text, error }) => {
    expect(() => calendarEvents(parseCalendar(text))).toThrow(error);
  });
});
