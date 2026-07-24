import type { ListRowStatus } from "../../../components/ui/ListRow";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { ConsoleDetailRow } from "./ConsoleDetailPage";

export function detailRow(
  id: string,
  label: string,
  value: string | number | boolean | null | undefined,
  options: Pick<ConsoleDetailRow, "icon" | "status" | "statusLabel" | "labelInfo"> = {},
): ConsoleDetailRow | null {
  const sub = typeof value === "boolean"
    ? (value ? "YES" : "NO")
    : typeof value === "number"
      ? String(value)
      : value?.trim() ?? "";

  return sub ? { id, label, sub, ...options } : null;
}

export function liveRows(rows: readonly (ConsoleDetailRow | null)[]): ConsoleDetailRow[] {
  return rows.filter((row): row is ConsoleDetailRow => row !== null);
}

export function listRowStatusForTone(tone: StatusTone): ListRowStatus {
  if (tone === "online" || tone === "error" || tone === "idle" || tone === "live" || tone === "update" || tone === "warn") {
    return tone;
  }
  return "online";
}
