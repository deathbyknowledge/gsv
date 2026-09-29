export function compactText(parts: readonly (string | null | undefined)[], fallback: string): string {
  const value = parts
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join(" / ");
  return value || fallback;
}

export function formatTokenLabel(value: string): string {
  return value
    .split(/[-_.:/\s]+/g)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ") || "Unknown";
}

export function uidLabel(uid: number | null): string {
  return uid === null ? "" : `uid ${uid}`;
}

function normalizeTimestamp(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value;
}

export function formatAge(value: number): string {
  const timestamp = normalizeTimestamp(value);
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "NOW";
  if (minutes < 60) return `${minutes}M AGO`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}H AGO`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}D AGO`;
  return new Date(timestamp).toLocaleDateString();
}
