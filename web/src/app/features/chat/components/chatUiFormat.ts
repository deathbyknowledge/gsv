export function shortId(value: string | null | undefined): string {
  return value ? value.slice(0, 8) : "";
}

export function formatCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "UNKNOWN";
}
