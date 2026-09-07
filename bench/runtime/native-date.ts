type SyntheticDateParts = {
  year: string;
  month: string;
  monthName: string;
  day: string;
  weekday: string;
  hour: string;
  minute: string;
  second: string;
  zone: string;
  offset: string;
};

/** Render the synthetic native `date` command from the scenario clock. */
export function renderSyntheticDate(
  now: Date,
  args: string[],
  configuredTimezone: string,
): string {
  let timezone = configuredTimezone;
  let format: string | undefined;
  let isoPrecision: string | undefined;
  let rfcPrecision: string | undefined;
  for (const argument of args) {
    if (argument === "-u" || argument === "--utc" || argument === "--universal") {
      timezone = "UTC";
      continue;
    }
    if (argument === "--help") return "Usage: date [-u] [+FORMAT]\n";
    if (argument === "-I" || argument === "--iso-8601") {
      isoPrecision = "date";
      continue;
    }
    if (argument.startsWith("--iso-8601=")) {
      isoPrecision = argument.slice("--iso-8601=".length);
      continue;
    }
    if (argument.startsWith("-I") && argument.length > 2) {
      isoPrecision = argument.slice(2);
      continue;
    }
    if (argument.startsWith("--rfc-3339=")) {
      rfcPrecision = argument.slice("--rfc-3339=".length);
      continue;
    }
    if (argument.startsWith("+")) {
      if (format !== undefined) throw new Error("extra operand " + argument);
      format = argument.slice(1);
      continue;
    }
    throw new Error("unsupported operand " + argument);
  }

  const parts = syntheticDateParts(now, timezone);
  if (isoPrecision !== undefined) {
    if (isoPrecision === "date") return isoDate(parts) + "\n";
    if (!new Set(["hours", "minutes", "seconds", "ns"]).has(isoPrecision)) {
      throw new Error("invalid argument for --iso-8601: " + isoPrecision);
    }
    const time = isoPrecision === "hours"
      ? parts.hour
      : isoPrecision === "minutes"
        ? `${parts.hour}:${parts.minute}`
        : `${parts.hour}:${parts.minute}:${parts.second}`;
    const fraction = isoPrecision === "ns" ? "." + nanoseconds(now) : "";
    return `${isoDate(parts)}T${time}${fraction}${colonOffset(parts.offset)}\n`;
  }
  if (rfcPrecision !== undefined) {
    if (!new Set(["date", "seconds", "ns"]).has(rfcPrecision)) {
      throw new Error("invalid argument for --rfc-3339: " + rfcPrecision);
    }
    if (rfcPrecision === "date") return isoDate(parts) + "\n";
    const fraction = rfcPrecision === "ns" ? "." + nanoseconds(now) : "";
    return `${isoDate(parts)} ${parts.hour}:${parts.minute}:${parts.second}${fraction}${colonOffset(parts.offset)}\n`;
  }
  if (format !== undefined) {
    return formatSyntheticDate(format, parts, now) + "\n";
  }
  return [
    parts.weekday,
    parts.monthName,
    parts.day.padStart(2, " "),
    `${parts.hour}:${parts.minute}:${parts.second}`,
    parts.zone,
    parts.year,
  ].join(" ") + "\n";
}

function syntheticDateParts(now: Date, timezone: string): SyntheticDateParts {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return {
    year: requireDatePart(formatted, "year"),
    month: requireDatePart(formatted, "month"),
    monthName: new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
    }).format(now),
    day: requireDatePart(formatted, "day"),
    weekday: requireDatePart(formatted, "weekday"),
    hour: requireDatePart(formatted, "hour"),
    minute: requireDatePart(formatted, "minute"),
    second: requireDatePart(formatted, "second"),
    zone: timezone === "UTC"
      ? "UTC"
      : dateZonePart(now, timezone, "short"),
    offset: timezone === "UTC"
      ? "+0000"
      : normalizeDateOffset(dateZonePart(now, timezone, "longOffset")),
  };
}

function requireDatePart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined) throw new Error("date formatter omitted " + type);
  return value;
}

function dateZonePart(
  now: Date,
  timezone: string,
  style: "short" | "longOffset",
): string {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: style,
  }).formatToParts(now).find(({ type }) => type === "timeZoneName")?.value;
  if (part === undefined) throw new Error("date formatter omitted time zone");
  return part;
}

function normalizeDateOffset(value: string): string {
  if (value === "GMT" || value === "UTC") return "+0000";
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/u.exec(value);
  if (!match) throw new Error("unsupported time zone offset: " + value);
  return (match[1] ?? "+")
    + (match[2] ?? "0").padStart(2, "0")
    + (match[3] ?? "00");
}

function isoDate(parts: SyntheticDateParts): string {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function colonOffset(value: string): string {
  return value.slice(0, 3) + ":" + value.slice(3);
}

function nanoseconds(now: Date): string {
  return String(now.getUTCMilliseconds()).padStart(3, "0") + "000000";
}

function formatSyntheticDate(
  format: string,
  parts: SyntheticDateParts,
  now: Date,
): string {
  const replacements = new Map(Object.entries({
    "%%": "%",
    "%a": parts.weekday,
    "%b": parts.monthName,
    "%d": parts.day,
    "%e": parts.day.padStart(2, " "),
    "%F": isoDate(parts),
    "%H": parts.hour,
    "%L": nanoseconds(now).slice(0, 3),
    "%m": parts.month,
    "%M": parts.minute,
    "%N": nanoseconds(now),
    "%s": String(Math.floor(now.valueOf() / 1_000)),
    "%S": parts.second,
    "%T": `${parts.hour}:${parts.minute}:${parts.second}`,
    "%Y": parts.year,
    "%z": parts.offset,
    "%:z": colonOffset(parts.offset),
    "%Z": parts.zone,
  }));
  return format.replace(/%%|%:z|%[1-9]N|%[abdeFHlLmMNsSTYzZ]/gu, (token) => {
    const fractional = /^%(\d)N$/u.exec(token);
    if (fractional) return nanoseconds(now).slice(0, Number(fractional[1]));
    return replacements.get(token) ?? token;
  });
}
