import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { env } from "cloudflare:test";
import { createCommandContext, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
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
    { day: "a time the change to summer time skips", start: "2026-03-29T02:30", utc: "20260329T010000Z" },
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
      "organizer=Mike, from Accounts <mike@example.com>",
      "attendee=Hank Hill <hank@ship.space> needs-action",
      "",
    ].join("\n"));
    expect(inNewYork.stdout).toContain("start=2026-11-27T19:00:00-05:00[America/New_York]\n");
    expect(changed.exitCode).toBe(1);
    expect(changed.stderr).toContain("mike@example.com organizes this event; only its organizer can change it");
    expect((await cal.event(path)).text).toBe(MIKES_INVITE);
  });

  it("won't move a repeating event", async () => {
    const cal = calShell();
    const path = `${directory()}/standup.ics`;
    await cal.fs.writeFile(`${HANK.home}/${path}`, MIKES_INVITE.replace(/ORGANIZER[^\r]*/, "ORGANIZER:mailto:hank@ship.space"));

    const moved = await cal.run("update", path, "--start", "2026-11-27T10:00");
    const renamed = await cal.run("update", path, "--title", "Standup");

    expect(moved.exitCode).toBe(1);
    expect(moved.stderr).toContain("this event repeats");
    expect(renamed.stderr).toBe("");
    expect((await cal.event(path)).event).toMatchObject({ title: "Standup", sequence: 3, recurrence: "FREQ=MONTHLY;BYDAY=4FR" });
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
