import type { CronJobCreate, CronJobPatch, CronSchedule } from "./types";

type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

const LOCAL_ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2})(?::(\d{2})(?::(\d{2}))?)?)?$/;
const RELATIVE_DURATION_RE =
  /^in\s+(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)$/i;
const TODAY_TOMORROW_RE =
  /^(today|tomorrow)(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function normalizeCronToolJobCreateInput(
  input: Record<string, unknown>,
  timezone: string,
  nowMs: number = Date.now(),
): CronJobCreate {
  return {
    ...(input as unknown as CronJobCreate),
    schedule: normalizeCronToolScheduleInput(input.schedule, timezone, nowMs),
  };
}

export function normalizeCronToolJobPatchInput(
  patch: Record<string, unknown>,
  timezone: string,
  nowMs: number = Date.now(),
): CronJobPatch {
  const normalized = { ...(patch as unknown as CronJobPatch) };
  if (patch.schedule !== undefined) {
    normalized.schedule = normalizeCronToolScheduleInput(
      patch.schedule,
      timezone,
      nowMs,
    );
  }
  return normalized;
}

export function normalizeCronToolScheduleInput(
  raw: unknown,
  timezone: string,
  nowMs: number = Date.now(),
): CronSchedule {
  const schedule = asObject(raw);
  if (!schedule) {
    throw new Error("schedule must be an object");
  }

  const kind = asString(schedule.kind);
  if (!kind) {
    throw new Error("schedule.kind is required");
  }

  if (kind === "at") {
    const atMsCandidate =
      asNumber(schedule.atMs) ??
      asNumber(schedule.at) ??
      resolveAtMsFromRelativeInput(schedule, nowMs) ??
      resolveAtMsFromStringInput(schedule, timezone, nowMs);
    if (typeof atMsCandidate !== "number" || !Number.isFinite(atMsCandidate)) {
      throw new Error(
        'schedule.at requires atMs, at (datetime), or relative input such as "in 2 hours"',
      );
    }
    return { kind: "at", atMs: atMsCandidate };
  }

  if (kind === "every") {
    const everyMsCandidate = resolveEveryMs(schedule);
    if (
      typeof everyMsCandidate !== "number" ||
      !Number.isFinite(everyMsCandidate) ||
      everyMsCandidate <= 0
    ) {
      throw new Error(
        "schedule.every requires everyMs or everyMinutes/everyHours (positive numbers)",
      );
    }

    const anchorMs = resolveAnchorMs(schedule, timezone, nowMs);
    return anchorMs === undefined
      ? { kind: "every", everyMs: everyMsCandidate }
      : { kind: "every", everyMs: everyMsCandidate, anchorMs };
  }

  if (kind === "cron") {
    const expr = asString(schedule.expr);
    if (!expr) {
      throw new Error("schedule.expr is required for kind=cron");
    }
    const tz = asString(schedule.tz) ?? timezone;
    return tz ? { kind: "cron", expr, tz } : { kind: "cron", expr };
  }

  throw new Error(`Unsupported schedule.kind: ${kind}`);
}

function resolveAtMsFromRelativeInput(
  schedule: Record<string, unknown>,
  nowMs: number,
): number | undefined {
  const inMs = asNumber(schedule.inMs) ?? asNumber(schedule.delayMs);
  if (inMs !== undefined) {
    if (inMs < 0) {
      throw new Error("schedule.inMs must be non-negative");
    }
    return nowMs + inMs;
  }

  const inSeconds = asNumber(schedule.inSeconds);
  if (inSeconds !== undefined) {
    if (inSeconds < 0) {
      throw new Error("schedule.inSeconds must be non-negative");
    }
    return nowMs + inSeconds * 1_000;
  }

  const inMinutes = asNumber(schedule.inMinutes);
  if (inMinutes !== undefined) {
    if (inMinutes < 0) {
      throw new Error("schedule.inMinutes must be non-negative");
    }
    return nowMs + inMinutes * 60_000;
  }

  const inHours = asNumber(schedule.inHours);
  if (inHours !== undefined) {
    if (inHours < 0) {
      throw new Error("schedule.inHours must be non-negative");
    }
    return nowMs + inHours * 3_600_000;
  }

  const inDays = asNumber(schedule.inDays);
  if (inDays !== undefined) {
    if (inDays < 0) {
      throw new Error("schedule.inDays must be non-negative");
    }
    return nowMs + inDays * 86_400_000;
  }

  const inText = asString(schedule.in);
  if (!inText) {
    return undefined;
  }

  const deltaMs = parseRelativeDuration(inText);
  if (deltaMs === undefined) {
    throw new Error(
      'schedule.in must use a relative duration like "in 2 hours" or "in 30 minutes"',
    );
  }
  return nowMs + deltaMs;
}

function resolveAtMsFromStringInput(
  schedule: Record<string, unknown>,
  timezone: string,
  nowMs: number,
): number | undefined {
  const at = asString(schedule.at) ?? asString(schedule.when) ?? asString(schedule.atIso);
  if (!at) {
    return undefined;
  }
  return parseDateTimeInput(at, timezone, nowMs);
}

function resolveEveryMs(schedule: Record<string, unknown>): number | undefined {
  const everyMs = asNumber(schedule.everyMs);
  if (everyMs !== undefined) {
    return everyMs;
  }
  const everySeconds = asNumber(schedule.everySeconds);
  if (everySeconds !== undefined) {
    return everySeconds * 1_000;
  }
  const everyMinutes = asNumber(schedule.everyMinutes);
  if (everyMinutes !== undefined) {
    return everyMinutes * 60_000;
  }
  const everyHours = asNumber(schedule.everyHours);
  if (everyHours !== undefined) {
    return everyHours * 3_600_000;
  }
  const everyDays = asNumber(schedule.everyDays);
  if (everyDays !== undefined) {
    return everyDays * 86_400_000;
  }
  return undefined;
}

function resolveAnchorMs(
  schedule: Record<string, unknown>,
  timezone: string,
  nowMs: number,
): number | undefined {
  const anchorMs = asNumber(schedule.anchorMs) ?? asNumber(schedule.anchor);
  if (anchorMs !== undefined) {
    if (anchorMs < 0) {
      throw new Error("schedule.anchorMs must be non-negative");
    }
    return anchorMs;
  }

  const anchorText =
    asString(schedule.anchor) ??
    asString(schedule.anchorAt) ??
    asString(schedule.startAt);
  if (!anchorText) {
    return undefined;
  }
  return parseDateTimeInput(anchorText, timezone, nowMs);
}

function parseDateTimeInput(input: string, timezone: string, nowMs: number): number {
  const value = input.trim();
  if (!value) {
    throw new Error("Datetime input is empty");
  }

  if (/^\d{10}$/.test(value)) {
    return Number.parseInt(value, 10) * 1_000;
  }
  if (/^\d{11,16}$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  const relativeDurationMs = parseRelativeDuration(value);
  if (relativeDurationMs !== undefined) {
    return nowMs + relativeDurationMs;
  }

  const todayTomorrowMs = parseTodayTomorrowInput(value, timezone, nowMs);
  if (todayTomorrowMs !== undefined) {
    return todayTomorrowMs;
  }

  if (hasExplicitTimezone(value)) {
    const explicit = Date.parse(value);
    if (Number.isFinite(explicit)) {
      return explicit;
    }
  }

  const localIso = parseLocalIsoDateTime(value);
  if (localIso) {
    return zonedLocalToEpochMs(localIso, timezone);
  }

  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  throw new Error(
    `Unable to parse datetime "${value}". Use ISO datetime (recommended), "today/tomorrow", or relative "in N hours".`,
  );
}

function parseRelativeDuration(input: string): number | undefined {
  const match = RELATIVE_DURATION_RE.exec(input.trim());
  if (!match) {
    return undefined;
  }

  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(amount) || amount < 0) {
    return undefined;
  }

  let multiplier = 1;
  if (unit === "ms" || unit === "millisecond" || unit === "milliseconds") {
    multiplier = 1;
  } else if (
    unit === "s" ||
    unit === "sec" ||
    unit === "secs" ||
    unit === "second" ||
    unit === "seconds"
  ) {
    multiplier = 1_000;
  } else if (
    unit === "m" ||
    unit === "min" ||
    unit === "mins" ||
    unit === "minute" ||
    unit === "minutes"
  ) {
    multiplier = 60_000;
  } else if (
    unit === "h" ||
    unit === "hr" ||
    unit === "hrs" ||
    unit === "hour" ||
    unit === "hours"
  ) {
    multiplier = 3_600_000;
  } else if (unit === "d" || unit === "day" || unit === "days") {
    multiplier = 86_400_000;
  } else {
    return undefined;
  }

  return Math.round(amount * multiplier);
}

function parseTodayTomorrowInput(
  input: string,
  timezone: string,
  nowMs: number,
): number | undefined {
  const match = TODAY_TOMORROW_RE.exec(input.trim());
  if (!match) {
    return undefined;
  }

  const dayOffset = match[1].toLowerCase() === "tomorrow" ? 1 : 0;
  const hourText = match[2];
  const minuteText = match[3];
  const ampm = match[4]?.toLowerCase();

  let hour = hourText ? Number.parseInt(hourText, 10) : 0;
  const minute = minuteText ? Number.parseInt(minuteText, 10) : 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) {
    throw new Error(`Invalid today/tomorrow time format: ${input}`);
  }

  if (ampm) {
    if (hour < 1 || hour > 12) {
      throw new Error(`Invalid hour in today/tomorrow format: ${input}`);
    }
    if (hour === 12) {
      hour = ampm === "am" ? 0 : 12;
    } else if (ampm === "pm") {
      hour += 12;
    }
  } else if (hour < 0 || hour > 23) {
    throw new Error(`Invalid hour in today/tomorrow format: ${input}`);
  }

  const nowParts = getZonedDateTimeParts(nowMs, timezone);
  const baseDate = new Date(
    Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, 0, 0, 0, 0),
  );
  baseDate.setUTCDate(baseDate.getUTCDate() + dayOffset);

  const target: DateTimeParts = {
    year: baseDate.getUTCFullYear(),
    month: baseDate.getUTCMonth() + 1,
    day: baseDate.getUTCDate(),
    hour,
    minute,
    second: 0,
    millisecond: 0,
  };
  return zonedLocalToEpochMs(target, timezone);
}

function parseLocalIsoDateTime(input: string): DateTimeParts | undefined {
  const match = LOCAL_ISO_RE.exec(input.trim());
  if (!match) {
    return undefined;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const hour = match[4] ? Number.parseInt(match[4], 10) : 0;
  const minute = match[5] ? Number.parseInt(match[5], 10) : 0;
  const second = match[6] ? Number.parseInt(match[6], 10) : 0;

  const parts: DateTimeParts = {
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond: 0,
  };

  if (!isValidDateTimeParts(parts)) {
    throw new Error(`Invalid local ISO datetime: ${input}`);
  }
  return parts;
}

function hasExplicitTimezone(input: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2}|\b(?:UTC|GMT))$/i.test(input.trim());
}

function isValidDateTimeParts(parts: DateTimeParts): boolean {
  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > 31 ||
    parts.hour < 0 ||
    parts.hour > 23 ||
    parts.minute < 0 ||
    parts.minute > 59 ||
    parts.second < 0 ||
    parts.second > 59
  ) {
    return false;
  }

  const date = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      parts.millisecond,
    ),
  );
  return (
    date.getUTCFullYear() === parts.year &&
    date.getUTCMonth() + 1 === parts.month &&
    date.getUTCDate() === parts.day &&
    date.getUTCHours() === parts.hour &&
    date.getUTCMinutes() === parts.minute &&
    date.getUTCSeconds() === parts.second
  );
}

function zonedLocalToEpochMs(local: DateTimeParts, timezone: string): number {
  const targetPseudoUtcMs = toPseudoUtcMs(local);
  let candidateMs = targetPseudoUtcMs;

  for (let i = 0; i < 6; i++) {
    const current = getZonedDateTimeParts(candidateMs, timezone);
    const currentPseudoUtcMs = toPseudoUtcMs(current);
    const delta = targetPseudoUtcMs - currentPseudoUtcMs;
    if (delta === 0) {
      return candidateMs;
    }
    candidateMs += delta;
  }

  const finalParts = getZonedDateTimeParts(candidateMs, timezone);
  if (sameDateTimeParts(finalParts, local)) {
    return candidateMs;
  }

  throw new Error(
    `Unable to resolve local datetime ${formatDateTimeParts(local)} in timezone ${timezone}`,
  );
}

function getZonedDateTimeParts(timestampMs: number, timezone: string): DateTimeParts {
  const formatter = getFormatter(timezone);
  const parts = formatter.formatToParts(new Date(timestampMs));

  let year = NaN;
  let month = NaN;
  let day = NaN;
  let hour = NaN;
  let minute = NaN;
  let second = NaN;

  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number.parseInt(part.value, 10);
        break;
      case "month":
        month = Number.parseInt(part.value, 10);
        break;
      case "day":
        day = Number.parseInt(part.value, 10);
        break;
      case "hour":
        hour = Number.parseInt(part.value, 10);
        break;
      case "minute":
        minute = Number.parseInt(part.value, 10);
        break;
      case "second":
        second = Number.parseInt(part.value, 10);
        break;
      default:
        break;
    }
  }

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    throw new Error(`Failed to resolve date/time parts for timezone ${timezone}`);
  }

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond: 0,
  };
}

function getFormatter(timezone: string): Intl.DateTimeFormat {
  const key = timezone.trim() || "UTC";
  const existing = formatterCache.get(key);
  if (existing) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: key,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(key, formatter);
  return formatter;
}

function toPseudoUtcMs(parts: DateTimeParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
}

function sameDateTimeParts(a: DateTimeParts, b: DateTimeParts): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second &&
    a.millisecond === b.millisecond
  );
}

function formatDateTimeParts(parts: DateTimeParts): string {
  const year = String(parts.year).padStart(4, "0");
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  const hour = String(parts.hour).padStart(2, "0");
  const minute = String(parts.minute).padStart(2, "0");
  const second = String(parts.second).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}
