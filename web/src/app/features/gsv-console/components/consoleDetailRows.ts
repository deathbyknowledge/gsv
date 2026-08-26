import type { ListRowStatus } from "../../../components/ui/ListRow";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { ConsoleDetailRow } from "./ConsoleDetailPage";
import { z } from "zod";

export function detailRow(
  id: string,
  label: string,
  value: string | number | boolean | null | undefined,
  options: Pick<ConsoleDetailRow, "icon" | "status" | "statusLabel" | "labelInfo"> = {},
): ConsoleDetailRow | null {
  const sub = z.boolean().safeParse(value).success
    ? (value ? "YES" : "NO")
    : z.number().safeParse(value).success
      ? String(value)
      : z.string().safeParse(value).data?.trim() ?? "";

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
