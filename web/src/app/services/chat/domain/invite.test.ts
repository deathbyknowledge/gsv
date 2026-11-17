import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLanguagePreference } from "../../../i18n/locale";
import { describeInvite } from "./invite";

/** A rule as an approval carries it, and how the approval says it. */
type RuleCase = { rule: string; repeats: JsonValue; text: string };

const AMSTERDAM = "+01:00[Europe/Amsterdam]";
const SYNC = {
  method: "REQUEST",
  title: "Team sync",
  allDay: false,
  start: `2026-11-30T09:00:00${AMSTERDAM}`,
  end: `2026-11-30T09:30:00${AMSTERDAM}`,
  repeats: { freq: "WEEKLY", interval: 1, byDay: ["MO"], until: "2027-06-28T23:59:59+02:00[Europe/Amsterdam]" },
  skipped: [`2026-12-07T09:00:00${AMSTERDAM}`, `2026-12-28T09:00:00${AMSTERDAM}`],
  changed: [{ from: `2027-01-04T09:00:00${AMSTERDAM}`, start: `2027-01-05T10:00:00${AMSTERDAM}`, end: `2027-01-05T10:30:00${AMSTERDAM}` }],
};

beforeEach(() => {
  vi.stubGlobal("document", { documentElement: {} });
});

afterEach(async () => {
  await applyLanguagePreference("en");
  vi.unstubAllGlobals();
});

/** ICU spaces a time range and its day period with thin and narrow spaces; these tests read them as plain spaces. */
function plain(text: string | null): string | null {
  return text?.replace(/[  ]/g, " ") ?? null;
}

describe("invite descriptions", () => {
  it("describes a repeating event, the dates it skips and the dates it moves", () => {
    expect(plain(describeInvite(SYNC))).toBe(
      "invitation: Team sync, Mon, Nov 30, 9:00 – 9:30 AM, weekly on Monday, until Jun 28, 2027"
      + " · not on Dec 7 and Dec 28 · Jan 4 changed to Tue, Jan 5, 10:00 – 10:30 AM",
    );
  });

  it.each<RuleCase>([
    { rule: "daily", repeats: { freq: "DAILY", interval: 1 }, text: "daily" },
    { rule: "every few days", repeats: { freq: "DAILY", interval: 3, count: 10 }, text: "every 3 days, 10 times" },
    { rule: "every other week", repeats: { freq: "WEEKLY", interval: 2, byDay: ["MO", "WE"] }, text: "every 2 weeks on Monday and Wednesday" },
    { rule: "a weekday of the month", repeats: { freq: "MONTHLY", interval: 1, byDay: ["-1FR"] }, text: "monthly on the last Friday" },
    { rule: "days of the month", repeats: { freq: "MONTHLY", interval: 1, byMonthDay: [1, 15] }, text: "monthly on day 1 and day 15" },
    { rule: "the month's last day", repeats: { freq: "MONTHLY", interval: 3, byMonthDay: [-1] }, text: "every 3 months on the last day" },
    { rule: "a date each year", repeats: { freq: "YEARLY", interval: 1, byMonth: [2], byMonthDay: [29], count: 6 }, text: "yearly on February 29, 6 times" },
    { rule: "a date some of its months lack", repeats: { freq: "YEARLY", interval: 1, byMonth: [2, 3], byMonthDay: [30] }, text: "yearly on March 30" },
    { rule: "a date none of its months has", repeats: { freq: "YEARLY", interval: 1, byMonth: [2], byMonthDay: [30] }, text: "repeats" },
    { rule: "a rule this client can't say", repeats: { freq: "HOURLY", interval: 1 }, text: "repeats" },
    { rule: "a weekly rule without its days", repeats: { freq: "WEEKLY", interval: 1 }, text: "repeats" },
  ])("says $rule", ({ repeats, text }) => {
    const invite = { method: "REQUEST", allDay: true, start: "2027-03-12", end: "2027-03-12", repeats };

    expect(describeInvite(invite)).toBe(`invitation: Fri, Mar 12, ${text}`);
  });

  it("names the zone of a repeating event shown in its own clock", () => {
    const invite = {
      method: "REQUEST",
      title: "Sync",
      allDay: false,
      start: "2026-11-30T00:30:00+09:00[Asia/Tokyo]",
      end: "2026-11-30T01:00:00+09:00[Asia/Tokyo]",
      timeZone: "Asia/Tokyo",
      repeats: { freq: "WEEKLY", interval: 1, byDay: ["MO"] },
      changed: [{ from: "2026-12-07T00:30:00+09:00[Asia/Tokyo]", start: "2026-12-08T09:00:00+09:00[Asia/Tokyo]" }],
    };

    expect(plain(describeInvite(invite))).toBe(
      "invitation: Sync, Mon, Nov 30, 12:30 – 1:00 AM Japan Time, weekly on Monday · Dec 7 changed to Tue, Dec 8, 9:00 AM Japan Time",
    );
    expect(plain(describeInvite({ ...invite, timeZone: "Mars/Olympus_Mons" }))).toBe(
      "invitation: Sync, Mon, Nov 30, 12:30 – 1:00 AM, weekly on Monday · Dec 7 changed to Tue, Dec 8, 9:00 AM",
    );
  });

  it("shows a changed date as all day or timed by its own times, not the series'", () => {
    const offsite = {
      method: "REQUEST",
      title: "Offsite",
      allDay: true,
      start: "2026-11-30",
      end: "2026-11-30",
      repeats: { freq: "WEEKLY", interval: 1, byDay: ["MO"] },
      changed: [{ from: "2026-12-07", start: "2026-12-07T10:00:00+01:00[Europe/Amsterdam]", end: "2026-12-07T11:00:00+01:00[Europe/Amsterdam]" }],
    };
    const sync = {
      ...SYNC,
      skipped: [],
      changed: [{ from: `2026-12-07T09:00:00${AMSTERDAM}`, start: "2026-12-08", end: "2026-12-08" }],
    };

    expect(plain(describeInvite(offsite))).toBe("invitation: Offsite, Mon, Nov 30, weekly on Monday · Dec 7 changed to Mon, Dec 7, 10:00 – 11:00 AM");
    expect(plain(describeInvite(sync))).toBe(
      "invitation: Team sync, Mon, Nov 30, 9:00 – 9:30 AM, weekly on Monday, until Jun 28, 2027 · Dec 7 changed to Tue, Dec 8",
    );
  });

  it("shows the times of a changed date that keeps its start but not the series' length", () => {
    const at = (time: string) => `2026-12-07T${time}:00${AMSTERDAM}`;
    const longer = { ...SYNC, skipped: [], changed: [{ from: at("09:00"), start: at("09:00"), end: at("12:00") }] };
    const renamed = { ...SYNC, skipped: [], changed: [{ from: at("09:00"), start: at("09:00"), end: at("09:30") }] };
    const series = "invitation: Team sync, Mon, Nov 30, 9:00 – 9:30 AM, weekly on Monday, until Jun 28, 2027";

    expect(plain(describeInvite(longer))).toBe(`${series} · Dec 7 changed to Mon, Dec 7, 9:00 AM – 12:00 PM`);
    expect(plain(describeInvite(renamed))).toBe(`${series} · Dec 7 changed`);
  });

  it("names the first dates and counts the rest", () => {
    const dates = ["2026-12-07", "2026-12-14", "2026-12-21", "2026-12-28", "2027-01-04"];
    const invite = {
      method: "REQUEST",
      allDay: true,
      start: "2026-11-30",
      end: "2026-11-30",
      repeats: { freq: "WEEKLY", interval: 1, byDay: ["MO"] },
      skipped: dates,
      changed: dates.slice(0, 4).map((from) => ({ from, start: from, end: from })),
    };

    expect(describeInvite(invite)).toBe(
      "invitation: Mon, Nov 30, weekly on Monday · not on Dec 7, Dec 14, Dec 21, and 2 more"
      + " · Dec 7 changed · Dec 14 changed · Dec 21 changed · 1 more change",
    );
  });

  it("leaves a cancellation's exceptions out", () => {
    expect(plain(describeInvite({ ...SYNC, method: "CANCEL" })))
      .toBe("cancellation: Team sync, Mon, Nov 30, 9:00 – 9:30 AM, weekly on Monday, until Jun 28, 2027");
  });

  it.each([
    { language: "es", text: "invitación: vie, 12 mar, cada mes el último sábado y cuarto viernes, hasta el 28 jun 2027 · excepto 7 dic" },
    { language: "pt-BR", text: "convite: sex., 12 de mar., todo mês: último sábado e quarta sexta-feira, até 28 de jun. de 2027 · exceto 7 de dez." },
  ])("says weekday ordinals in $language", async ({ language, text }) => {
    await applyLanguagePreference(language);
    const invite = {
      method: "REQUEST",
      allDay: true,
      start: "2027-03-12",
      end: "2027-03-12",
      repeats: { freq: "MONTHLY", interval: 1, byDay: ["-1SA", "4FR"], until: "2027-06-28" },
      skipped: ["2026-12-07"],
    };

    expect(describeInvite(invite)).toBe(text);
  });
});
