import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { env } from "cloudflare:test";
import { createCommandContext, InMemoryFs } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import { calendarEvents, parseCalendar } from "../../../kernel/icalendar";
import { testPeer } from "../../../test-support/peers";
import { buildCalCommand } from "./cal";

const HANK: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000, 100],
  username: "hank",
  home: "/home/hank",
  cwd: "/home/hank",
};

/** Mike's invite, as his calendar wrote it: folded, with a TZID and a repeat rule. */
const MIKES_INVITE = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20261127T190000",
  "DTEND;TZID=America/New_York:20261127T200000",
  "DTSTAMP:20261111T120000Z",
  "ORGANIZER;CN=\"Mike, from Accounts\":mailto:mike@example.com",
  "UID:7kukuqrfedlm2f9t2vbotkei0h@google.com",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=",
  " TRUE;CN=Hank Hill:mailto:hank@ship.space",
  "SEQUENCE:2",
  "SUMMARY:Quarterly review",
  "RRULE:FREQ=MONTHLY;BYDAY=4FR",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

function calContext(): KernelContext {
  // SAFETY: this fixture supplies the KernelContext fields the cal command reads.
  return {
    peer: testPeer({ kind: "human", account: HANK, calls: ["shell.exec"] }),
    procs: { getOwnerUid: () => null },
    auth: {
      getPasswdByUid: (uid: number) => uid === HANK.uid
        ? { username: "hank", uid: HANK.uid, gid: HANK.gid, gecos: "hank", home: HANK.home, shell: "/bin/init" }
        : null,
    },
    mailboxes: {
      getMailboxForOwner: (uid: number) => uid === HANK.uid ? { address: "hank@ship.space" } : null,
      getPrimaryMailbox: () => null,
    },
    profiles: { draft: () => ({ fields: { displayName: "Hank Hill" } }) },
    config: { get: (key: string) => key === "users/1000/locale/timezone" ? "Europe/Amsterdam" : null },
  } as KernelContext;
}

function calShell() {
  const fs = new GsvFs(env.STORAGE, HANK);
  const command = buildCalCommand(fs, calContext());
  const shellCtx = createCommandContext({ fs: new InMemoryFs(), cwd: HANK.home });
  return {
    fs,
    run: (...args: string[]) => command.execute(args, shellCtx),
    event: async (path: string) => {
      const text = await fs.readFile(`${HANK.home}/${path}`);
      const calendar = parseCalendar(text);
      const [event] = calendarEvents(calendar);
      return { text, event };
    },
  };
}

function directory(): string {
  return `cal-${crypto.randomUUID()}`;
}

describe("cal shell command", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes an event in the owner's time zone, organized by the Ship, and won't overwrite it", async () => {
    const cal = calShell();
    const path = `${directory()}/dinner.ics`;

    const added = await cal.run(
      "add",
      "--title", "Dinner, then drinks",
      "--start", "2026-11-27 21:15",
      "--duration", "2h",
      "--location", "Casa Lucio",
      "--attendee", "anna@example.com,mike@example.com",
      "--attendee", "Anna@example.com",
      "--out", path,
    );

    expect(added.stderr).toBe("");
    expect(added.exitCode).toBe(0);
    expect(added.stdout).toContain("method=REQUEST\n");
    expect(added.stdout).toContain("start=2026-11-27T21:15:00+01:00[Europe/Amsterdam]\nend=2026-11-27T23:15:00+01:00[Europe/Amsterdam]\n");
    const { text, event } = await cal.event(path);
    expect(text).toContain("\r\nDTSTART:20261127T201500Z\r\nDTEND:20261127T221500Z\r\n");
    expect(text).toContain("\r\nSUMMARY:Dinner\\, then drinks\r\n");
    expect(text).toContain("\r\nORGANIZER;CN=Hank Hill:mailto:hank@ship.space\r\n");
    expect(event).toMatchObject({
      uid: expect.stringMatching(/^[0-9a-f-]{36}@ship\.space$/),
      sequence: 0,
      status: "CONFIRMED",
      title: "Dinner, then drinks",
      location: "Casa Lucio",
    });
    const invited = { ROLE: ["REQ-PARTICIPANT"], PARTSTAT: ["NEEDS-ACTION"], RSVP: ["TRUE"] };
    expect(event.component.properties.filter((property) => property.name === "ATTENDEE")).toEqual([
      { name: "ATTENDEE", params: invited, value: "mailto:Anna@example.com" },
      { name: "ATTENDEE", params: invited, value: "mailto:mike@example.com" },
    ]);

    const again = await cal.run("add", "--title", "Other", "--start", "2026-11-28T10:00", "--out", path);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("already exists");
    expect((await cal.event(path)).text).toBe(text);
  });

  it.each([
    { day: "the day before summer time", start: "2026-03-28T02:30", utc: "20260328T013000Z" },
    { day: "a time the change to summer time skips", start: "2026-03-29T02:30", utc: "20260329T013000Z" },
    { day: "a time the change back repeats", start: "2026-10-25T02:30", utc: "20261025T003000Z" },
    { day: "an exact instant", start: "2026-03-29T02:30:00Z", utc: "20260329T023000Z" },
  ])("resolves $day in the owner's time zone", async ({ start, utc }) => {
    const cal = calShell();
    const path = `${directory()}/event.ics`;

    const added = await cal.run("add", "--title", "Call", "--start", start, "--out", path);

    expect(added.stderr).toBe("");
    expect((await cal.event(path)).text).toContain(`\r\nDTSTART:${utc}\r\n`);
  });

  it("moves an event with the same UID and length, then cancels it", async () => {
    const cal = calShell();
    const path = `${directory()}/dinner.ics`;
    await cal.run("add", "--title", "Dinner", "--start", "2026-11-27T21:15", "--duration", "2h", "--attendee", "anna@example.com", "--out", path);
    const { event: original } = await cal.event(path);

    const moved = await cal.run("update", path, "--start", "2026-11-27T21:45");

    expect(moved.stderr).toBe("");
    const { text: movedText, event: update } = await cal.event(path);
    expect(movedText).toContain("\r\nMETHOD:REQUEST\r\n");
    expect(movedText).toContain("\r\nDTSTART:20261127T204500Z\r\nDTEND:20261127T224500Z\r\n");
    expect(update).toMatchObject({ uid: original.uid, sequence: 1, status: "CONFIRMED", title: "Dinner" });
    expect(update.attendees).toEqual(original.attendees);

    const cancelled = await cal.run("cancel", path);

    expect(cancelled.stderr).toBe("");
    expect(cancelled.stdout).toContain("method=CANCEL\n");
    const { text: cancelText, event: cancel } = await cal.event(path);
    expect(cancelText).toContain("\r\nMETHOD:CANCEL\r\n");
    expect(cancel).toMatchObject({ uid: original.uid, sequence: 2, status: "CANCELLED", title: "Dinner" });
  });

  it("writes all-day events with an exclusive end and shows the days they cover", async () => {
    const cal = calShell();
    const path = `${directory()}/offsite.ics`;

    const added = await cal.run("add", "--title", "Offsite", "--start", "2026-12-01", "--end", "2026-12-02", "--out", path);

    expect(added.stderr).toBe("");
    expect(added.stdout).toContain("all_day=true\nstart=2026-12-01\nend=2026-12-02\n");
    expect((await cal.event(path)).text).toContain("\r\nDTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261203\r\n");

    await cal.run("update", path, "--start", "2026-12-07");
    expect((await cal.event(path)).text).toContain("\r\nDTSTART;VALUE=DATE:20261207\r\nDTEND;VALUE=DATE:20261209\r\n");
  });

  it("shows an invite someone else's calendar wrote, and leaves it to its organizer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
    const cal = calShell();
    const path = `${directory()}/review.ics`;
    await cal.fs.writeFile(`${HANK.home}/${path}`, MIKES_INVITE);

    const shown = await cal.run("show", path);
    const inNewYork = await cal.run("show", path, "--timezone", "America/New_York");
    const changed = await cal.run("update", path, "--title", "Mine now");

    expect(shown.stderr).toBe("");
    expect(shown.stdout).toBe([
      `path=${HANK.home}/${path}`,
      "method=REQUEST",
      "",
      "uid=7kukuqrfedlm2f9t2vbotkei0h@google.com",
      "sequence=2",
      "title=Quarterly review",
      "start=2026-11-28T01:00:00+01:00[Europe/Amsterdam]",
      "end=2026-11-28T02:00:00+01:00[Europe/Amsterdam]",
      "repeats=FREQ=MONTHLY;BYDAY=4FR",
      "next=2026-11-28T01:00:00+01:00[Europe/Amsterdam]",
      "next=2026-12-26T01:00:00+01:00[Europe/Amsterdam]",
      "next=2027-01-23T01:00:00+01:00[Europe/Amsterdam]",
      "next=2027-02-27T01:00:00+01:00[Europe/Amsterdam]",
      "next=2027-03-27T00:00:00+01:00[Europe/Amsterdam]",
      "organizer=Mike, from Accounts <mike@example.com>",
      "attendee=Hank Hill <hank@ship.space> needs-action",
      "",
    ].join("\n"));
    expect(inNewYork.stdout).toContain("start=2026-11-27T19:00:00-05:00[America/New_York]\n");
    expect(changed.exitCode).toBe(1);
    expect(changed.stderr).toContain("mike@example.com organizes this event; only its organizer can change it");
    expect((await cal.event(path)).text).toBe(MIKES_INVITE);
  });

  it("moves a repeating event in its own time zone", async () => {
    const cal = calShell();
    const path = `${directory()}/review.ics`;
    await cal.fs.writeFile(`${HANK.home}/${path}`, MIKES_INVITE.replace(/ORGANIZER[^\r]*/, "ORGANIZER:mailto:hank@ship.space"));

    const moved = await cal.run("update", path, "--start", "2026-11-27T10:00");
    const renamed = await cal.run("update", path, "--title", "Review");

    expect(moved.stderr).toBe("");
    expect(renamed.stderr).toBe("");
    const { text, event } = await cal.event(path);
    expect(text).toContain("\r\nDTSTART;TZID=America/New_York:20261127T100000\r\nDTEND;TZID=America/New_York:20261127T110000\r\n");
    expect(text).toContain("\r\nBEGIN:VTIMEZONE\r\nTZID:America/New_York\r\n");
    expect(event).toMatchObject({ title: "Review", sequence: 4, recurrence: "FREQ=MONTHLY;BYDAY=4FR" });
  });

  it("keeps a series written in UTC in UTC when it changes", async () => {
    const cal = calShell();
    const path = `${directory()}/standup.ics`;
    await cal.fs.writeFile(`${HANK.home}/${path}`, [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example//EN", "METHOD:REQUEST",
      "BEGIN:VEVENT", "UID:standup@example.com", "DTSTAMP:20261112T120000Z",
      "DTSTART:20261130T233000Z", "DTEND:20261201T000000Z", "RRULE:FREQ=WEEKLY",
      "SUMMARY:Standup", "ORGANIZER:mailto:hank@ship.space",
      "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n"));

    const longer = await cal.run("update", path, "--duration", "45m");

    expect(longer.stderr).toBe("");
    const { text, event } = await cal.event(path);
    expect(text).toContain("\r\nDTSTART:20261130T233000Z\r\nDTEND:20261201T001500Z\r\n");
    expect(text).not.toContain("VTIMEZONE");
    expect(event).toMatchObject({ recurrence: "FREQ=WEEKLY", sequence: 1 });
  });

  it.each([
    { problem: "a time it can't read", args: ["--start", "tomorrow"], error: "invalid time: tomorrow" },
    { problem: "an end before its start", args: ["--start", "2026-11-27T21:15", "--end", "2026-11-27T20:00"], error: "ends before it starts" },
    { problem: "both an end and a length", args: ["--start", "2026-11-27T21:15", "--end", "2026-11-27T22:00", "--duration", "1h"], error: "mutually exclusive" },
    { problem: "a length it can't read", args: ["--start", "2026-11-27T21:15", "--duration", "an hour"], error: "invalid length" },
    { problem: "a date that doesn't exist", args: ["--start", "2026-02-30"], error: "not a real date" },
    { problem: "a guest without an address", args: ["--start", "2026-11-27T21:15", "--attendee", "Anna"], error: "not an email address: Anna" },
    { problem: "an unknown time zone", args: ["--start", "2026-11-27T21:15", "--timezone", "Mars/Olympus"], error: "valid IANA timezone" },
  ])("refuses $problem", async ({ args, error }) => {
    const cal = calShell();
    const path = `${directory()}/event.ics`;

    const result = await cal.run("add", "--title", "Dinner", ...args, "--out", path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(error);
    expect(await cal.fs.exists(`${HANK.home}/${path}`)).toBe(false);
  });
});

describe("cal repeating events", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function weeklySync() {
    const cal = calShell();
    const path = `${directory()}/sync.ics`;
    const added = await cal.run(
      "add",
      "--title", "Team sync",
      "--start", "2026-11-30 09:00",
      "--duration", "30m",
      "--repeat", "FREQ=WEEKLY;BYDAY=MO;UNTIL=2027-06-28",
      "--attendee", "anna@example.com",
      "--out", path,
    );
    return { cal, path, added };
  }

  it("writes a series in its time zone, with the zone's clock changes and the next dates", async () => {
    const { cal, path, added } = await weeklySync();

    expect(added.stderr).toBe("");
    expect(added.stdout).toContain([
      "start=2026-11-30T09:00:00+01:00[Europe/Amsterdam]",
      "end=2026-11-30T09:30:00+01:00[Europe/Amsterdam]",
      "repeats=FREQ=WEEKLY;BYDAY=MO;UNTIL=20270628T215959Z",
      "next=2026-11-30T09:00:00+01:00[Europe/Amsterdam]",
      "next=2026-12-07T09:00:00+01:00[Europe/Amsterdam]",
    ].join("\n"));
    expect(added.stdout.match(/^next=/gm)).toHaveLength(5);
    const { text, event } = await cal.event(path);
    expect(text).toContain("\r\nDTSTART;TZID=Europe/Amsterdam:20261130T090000\r\nDTEND;TZID=Europe/Amsterdam:20261130T093000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20270628T215959Z\r\n");
    expect(text).toMatch(/^BEGIN:VCALENDAR\r\n(?:[^\r]*\r\n)*?BEGIN:VTIMEZONE\r\nTZID:Europe\/Amsterdam\r\n/);
    expect(event).toMatchObject({ sequence: 0, recurrence: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20270628T215959Z" });
  });

  it("refuses a start the rule skips, and a rule it can't say in words", async () => {
    const cal = calShell();

    const tuesday = await cal.run("add", "--title", "Sync", "--start", "2026-12-01T09:00", "--repeat", "FREQ=WEEKLY;BYDAY=MO", "--out", `${directory()}/a.ics`);
    const setPosition = await cal.run("add", "--title", "Sync", "--start", "2026-12-01T09:00", "--repeat", "FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1", "--out", `${directory()}/b.ics`);

    expect(tuesday.stderr).toContain("FREQ=WEEKLY;BYDAY=MO doesn't include the start, 2026-12-01 (a Tuesday)");
    expect(setPosition.stderr).toContain("BYSETPOS isn't supported");
  });

  it("skips one date and moves another, keeping the series' length and guests", async () => {
    const { cal, path } = await weeklySync();

    const skipped = await cal.run("cancel", path, "--occurrence", "2026-12-28");
    const moved = await cal.run("update", path, "--occurrence", "2027-01-04", "--start", "2027-01-05 10:00");

    expect(skipped.stderr).toBe("");
    expect(skipped.stdout).toContain("method=REQUEST\n");
    expect(skipped.stdout).toContain("skipped=2026-12-28T09:00:00+01:00[Europe/Amsterdam]\n");
    expect(moved.stderr).toBe("");
    expect(moved.stdout).toContain([
      "occurrence=2027-01-04T09:00:00+01:00[Europe/Amsterdam]",
      "sequence=2",
      "status=CONFIRMED",
      "title=Team sync",
      "start=2027-01-05T10:00:00+01:00[Europe/Amsterdam]",
      "end=2027-01-05T10:30:00+01:00[Europe/Amsterdam]",
    ].join("\n"));
    const text = await cal.fs.readFile(`${HANK.home}/${path}`);
    const events = calendarEvents(parseCalendar(text));
    expect(events.map((event) => event.sequence)).toEqual([2, 2]);
    expect(events[0].skipped).toEqual([{ kind: "local", local: "2026-12-28T09:00:00", timeZone: "Europe/Amsterdam" }]);
    expect(events[1]).toMatchObject({
      uid: events[0].uid,
      recurrenceId: { kind: "local", local: "2027-01-04T09:00:00", timeZone: "Europe/Amsterdam" },
      start: { kind: "local", local: "2027-01-05T10:00:00", timeZone: "Europe/Amsterdam" },
      attendees: events[0].attendees,
    });
    expect(events[1].recurrence).toBeUndefined();
    expect(events[1].skipped).toEqual([]);
  });

  it("moves skipped and changed dates with the series, and drops the ones a new rule leaves out", async () => {
    const { cal, path } = await weeklySync();
    await cal.run("cancel", path, "--occurrence", "2026-12-28");
    await cal.run("update", path, "--occurrence", "2027-01-04", "--start", "2027-01-05 10:00", "--title", "Sync, moved");

    const later = await cal.run("update", path, "--start", "2026-11-30 09:30", "--title", "Weekly sync");
    expect(later.stderr).toBe("");
    let events = calendarEvents(parseCalendar(await cal.fs.readFile(`${HANK.home}/${path}`)));
    expect(events[0].skipped).toEqual([{ kind: "local", local: "2026-12-28T09:30:00", timeZone: "Europe/Amsterdam" }]);
    expect(events[1]).toMatchObject({
      recurrenceId: { kind: "local", local: "2027-01-04T09:30:00", timeZone: "Europe/Amsterdam" },
      start: { kind: "local", local: "2027-01-05T10:00:00", timeZone: "Europe/Amsterdam" },
      title: "Sync, moved",
    });

    const fortnightly = await cal.run("update", path, "--repeat", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
    expect(fortnightly.stderr).toBe("");
    expect(fortnightly.stdout).toContain("dropped=2027-01-04T09:30:00+01:00[Europe/Amsterdam] (no longer in the series)\n");
    events = calendarEvents(parseCalendar(await cal.fs.readFile(`${HANK.home}/${path}`)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ title: "Weekly sync", recurrence: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" });
    expect(events[0].skipped).toEqual([{ kind: "local", local: "2026-12-28T09:30:00", timeZone: "Europe/Amsterdam" }]);
  });

  it("restores a skipped date when it changes, and names nearby dates for one the series doesn't have", async () => {
    const { cal, path } = await weeklySync();
    await cal.run("cancel", path, "--occurrence", "2026-12-28");

    const restored = await cal.run("update", path, "--occurrence", "2026-12-28", "--title", "Short sync");
    const missing = await cal.run("update", path, "--occurrence", "2026-12-29", "--title", "Nope");
    const guests = await cal.run("update", path, "--occurrence", "2027-01-04", "--attendee", "mike@example.com");

    expect(restored.stderr).toBe("");
    expect(restored.stdout).toContain("restored=2026-12-28T09:00:00+01:00[Europe/Amsterdam]\n");
    const events = calendarEvents(parseCalendar(await cal.fs.readFile(`${HANK.home}/${path}`)));
    expect(events[0].skipped).toEqual([]);
    expect(events[1]).toMatchObject({ title: "Short sync", start: { local: "2026-12-28T09:00:00" } });
    expect(missing.stderr).toContain("2026-12-29 isn't a date this series happens on; nearby: 2026-12-28, 2027-01-04");
    expect(guests.stderr).toContain("every date of a series has the series' guests");
  });

  it("cancels a whole series with its changed dates", async () => {
    const { cal, path } = await weeklySync();
    await cal.run("update", path, "--occurrence", "2027-01-04", "--start", "2027-01-05 10:00");

    const cancelled = await cal.run("cancel", path);

    expect(cancelled.stderr).toBe("");
    expect(cancelled.stdout).toContain("method=CANCEL\n");
    const events = calendarEvents(parseCalendar(await cal.fs.readFile(`${HANK.home}/${path}`)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "CANCELLED", sequence: 2 });
  });

  it("repeats an all-day event by date, with no time zone", async () => {
    const cal = calShell();
    const path = `${directory()}/birthday.ics`;

    const added = await cal.run("add", "--title", "Anna's birthday", "--start", "2026-12-01", "--repeat", "FREQ=YEARLY", "--out", path);
    const shown = await cal.run("show", path, "--next", "2");

    expect(added.stderr).toBe("");
    const { text } = await cal.event(path);
    expect(text).toContain("\r\nDTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261202\r\nRRULE:FREQ=YEARLY\r\n");
    expect(text).not.toContain("VTIMEZONE");
    expect(shown.stdout).toContain("repeats=FREQ=YEARLY\nnext=2026-12-01\nnext=2027-12-01\n");
  });

  it("refuses --occurrence on an event that doesn't repeat", async () => {
    const cal = calShell();
    const path = `${directory()}/dinner.ics`;
    await cal.run("add", "--title", "Dinner", "--start", "2026-11-27T21:15", "--out", path);

    const result = await cal.run("cancel", path, "--occurrence", "2026-11-27");

    expect(result.stderr).toContain("this event doesn't repeat");
  });
});

/** A whole calendar as a published link serves it: one-off events, a trip, and a series with a skipped and a moved date. */
const PUBLISHED_CALENDAR = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:dentist@example.com",
  "DTSTAMP:20261101T120000Z",
  "DTSTART;TZID=Europe/Amsterdam:20261117T100000",
  "DTEND;TZID=Europe/Amsterdam:20261117T103000",
  "SUMMARY:Dentist",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:lisbon@example.com",
  "DTSTAMP:20261101T120000Z",
  "DTSTART;VALUE=DATE:20261114",
  "DTEND;VALUE=DATE:20261117",
  "SUMMARY:Lisbon",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup@example.com",
  "DTSTAMP:20261101T120000Z",
  "DTSTART;TZID=Europe/Amsterdam:20261102T090000",
  "DTEND;TZID=Europe/Amsterdam:20261102T093000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
  "EXDATE;TZID=Europe/Amsterdam:20261118T090000",
  "SUMMARY:Standup",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup@example.com",
  "DTSTAMP:20261101T120000Z",
  "RECURRENCE-ID;TZID=Europe/Amsterdam:20261120T090000",
  "DTSTART;TZID=Europe/Amsterdam:20261120T110000",
  "DTEND;TZID=Europe/Amsterdam:20261120T113000",
  "SUMMARY:Standup",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:october@example.com",
  "DTSTAMP:20261001T120000Z",
  "DTSTART:20261001T080000Z",
  "DTEND:20261001T090000Z",
  "SUMMARY:Old meeting",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:next-week@example.com",
  "DTSTAMP:20261101T120000Z",
  "DTSTART;TZID=Europe/Amsterdam:20261123T100000",
  "DTEND;TZID=Europe/Amsterdam:20261123T110000",
  "SUMMARY:Next week",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("cal show over a range", () => {
  async function published() {
    const cal = calShell();
    const path = `${directory()}/calendar.ics`;
    await cal.fs.writeFile(`${HANK.home}/${path}`, PUBLISHED_CALENDAR);
    return { cal, path };
  }

  function titlesAndStarts(stdout: string): string[] {
    return stdout.split("\n\n").slice(1).map((block) => {
      const field = (name: string) => block.split("\n").find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);
      return `${field("title")} ${field("start")}`;
    });
  }

  it("lists what falls in the days named, in order, with each date of a series", async () => {
    const { cal, path } = await published();

    const week = await cal.run("show", path, "--from", "2026-11-16", "--until", "2026-11-22");

    expect(week.stderr).toBe("");
    expect(week.stdout).toContain("from=2026-11-16T00:00:00+01:00[Europe/Amsterdam]\nuntil=2026-11-23T00:00:00+01:00[Europe/Amsterdam]\nevents=4\n");
    expect(titlesAndStarts(week.stdout)).toEqual([
      "Lisbon 2026-11-14",
      "Standup 2026-11-16T09:00:00+01:00[Europe/Amsterdam]",
      "Dentist 2026-11-17T10:00:00+01:00[Europe/Amsterdam]",
      "Standup 2026-11-20T11:00:00+01:00[Europe/Amsterdam]",
    ]);
    expect(week.stdout).toContain("occurrence=2026-11-20T09:00:00+01:00[Europe/Amsterdam]");
  });

  it("shows one day with --from alone, and what is under way at a time", async () => {
    const { cal, path } = await published();

    const tuesday = await cal.run("show", path, "--from", "2026-11-17");
    expect(titlesAndStarts(tuesday.stdout)).toEqual(["Dentist 2026-11-17T10:00:00+01:00[Europe/Amsterdam]"]);

    const now = await cal.run("show", path, "--from", "2026-11-17T10:15", "--until", "2026-11-17T12:00");
    expect(titlesAndStarts(now.stdout)).toEqual(["Dentist 2026-11-17T10:00:00+01:00[Europe/Amsterdam]"]);

    const empty = await cal.run("show", path, "--from", "2026-11-21");
    expect(empty.stdout).toContain("events=0\n");
  });

  it("refuses a range that runs backwards or past a year, and --next with a range", async () => {
    const { cal, path } = await published();

    expect((await cal.run("show", path, "--from", "2026-11-22", "--until", "2026-11-16")).stderr).toContain("--until comes before --from");
    expect((await cal.run("show", path, "--from", "2026-01-01", "--until", "2027-06-01")).stderr).toContain("at most 366 days");
    expect((await cal.run("show", path, "--until", "2026-11-22")).stderr).toContain("--until needs --from");
    expect((await cal.run("show", path, "--from", "2026-11-16", "--next", "3")).stderr).toContain("--next lists a repeating event's next dates");
  });
});
