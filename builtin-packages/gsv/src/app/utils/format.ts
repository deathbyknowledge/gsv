export function formatTimestampMs(value: unknown): string {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) {
    return String(value ?? "");
  }
  return date.toLocaleString();
}

export function errorToText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function shortHash(value: string | null | undefined, length = 7): string {
  return value ? value.slice(0, length) : "unknown";
}

export function firstLine(value: string): string {
  return value.split("\n")[0] || "No commit message";
}

export function normalizeTimestampMs(value: number | null | undefined): number | null {
  if (!value || !Number.isFinite(value)) return null;
  return value < 100000000000 ? value * 1000 : value;
}

export function formatRelativeTime(value: number | null | undefined): string {
  const timestamp = normalizeTimestampMs(value);
  if (!timestamp) return "unknown";
  const deltaMs = timestamp - Date.now();
  const absMs = Math.abs(deltaMs);
  const divisions: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 1000 * 60 * 60 * 24 * 365],
    ["month", 1000 * 60 * 60 * 24 * 30],
    ["week", 1000 * 60 * 60 * 24 * 7],
    ["day", 1000 * 60 * 60 * 24],
    ["hour", 1000 * 60 * 60],
    ["minute", 1000 * 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of divisions) {
    if (absMs >= size) {
      return formatter.format(Math.round(deltaMs / size), unit);
    }
  }
  return "just now";
}
