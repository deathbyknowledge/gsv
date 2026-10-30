export function normalizeTimezone(value: string): string {
  const timezone = value.trim();
  if (!timezone) throw new Error("timezone must be a valid IANA timezone");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); }
  catch { throw new Error("timezone must be a valid IANA timezone"); }
  return timezone;
}

/** A human's local time follows their Ship; existing schedules retain their explicit timezone. */
export function ownerTimezone(config: { get(key: string): string | null }, ownerUid: number): string {
  return config.get(`users/${ownerUid}/locale/timezone`) || config.get("config/server/timezone") || "UTC";
}

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const DAY_MS = 86_400_000;

export function isLocalTime(value: string): boolean {
  return LOCAL_TIME.test(value);
}

function utcOffsetReader(timezone: string): (ms: number) => number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return (ms) => {
    const parts = formatter.formatToParts(new Date(ms));
    const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
    const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    return wall - Math.floor(ms / 1000) * 1000;
  };
}

/**
 * The instant a wall clock in `timezone` reads `localTime`, using the offset in
 * force on that date. A time skipped by a clock change resolves to the first
 * valid minute after the gap; a time that happens twice, to its first occurrence.
 */
export function resolveLocalTime(localTime: string, timezone: string): number {
  const match = LOCAL_TIME.exec(localTime);
  if (!match) {
    throw new Error(`invalid local time, expected a form such as 2026-10-26T10:00: ${localTime}`);
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map((field) => Number(field ?? 0));
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  // Date.UTC rolls over out-of-range fields, so a real date round-trips unchanged.
  if (new Date(wall).toISOString().slice(0, 19) !== `${localTime}:00`.slice(0, 19)) {
    throw new Error(`invalid local time: ${localTime}`);
  }

  const offsetAt = utcOffsetReader(timezone);
  const before = offsetAt(wall - DAY_MS);
  const after = offsetAt(wall + DAY_MS);
  const candidates = [wall - before, wall - after];
  const valid = candidates.filter((candidate) => offsetAt(candidate) === wall - candidate);
  if (valid.length > 0) {
    return Math.min(...valid);
  }

  // Neither offset produces this wall clock: it is in a gap, whose end is the changeover itself.
  let lo = Math.min(...candidates);
  let hi = Math.max(...candidates);
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (offsetAt(mid) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** An instant as its local time, offset and zone: 2026-10-26T10:00:00+01:00[Europe/Madrid]. */
export function formatLocalTime(ms: number, timezone: string): string {
  const offset = utcOffsetReader(timezone)(ms);
  const wall = new Date(Math.floor(ms / 1000) * 1000 + offset).toISOString().slice(0, 19);
  const minutes = Math.floor(Math.abs(offset) / 60_000);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${wall}${offset < 0 ? "-" : "+"}${hh}:${mm}[${timezone}]`;
}
