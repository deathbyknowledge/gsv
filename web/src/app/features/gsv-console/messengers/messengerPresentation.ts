import type { StatusTone } from "../../../components/ui/StatusDot";
import {
  detailRow,
  listRowStatusForTone,
  liveRows,
} from "../components/consoleDetailRows";
import type { ConsoleDetailSection } from "../components/ConsoleDetailPage";
import { compactText, formatAge, formatTokenLabel } from "../domain/consoleFormat";
import type { ConsoleAdapterAccount } from "../domain/consoleModels";

export function iconForAdapterName(adapter: string): string {
  if (adapter === "telegram") return "telegram";
  if (adapter === "discord") return "discord";
  return "chat";
}

export function adapterDetailId(adapter: ConsoleAdapterAccount): string {
  return `${adapter.adapter}:${adapter.accountId}`;
}

export function adapterLabel(adapter: ConsoleAdapterAccount): string {
  return `${formatTokenLabel(adapter.adapter)} · ${adapter.accountId}`;
}

export function adapterSub(adapter: ConsoleAdapterAccount): string {
  return compactText([
    adapter.mode ? `mode ${adapter.mode}` : "",
    adapter.lastActivity !== null ? `active ${formatAge(adapter.lastActivity)}` : "",
    adapter.error,
  ], `${adapter.adapter}:${adapter.accountId}`);
}

export function toneForAdapter(adapter: ConsoleAdapterAccount): StatusTone {
  if (adapter.error) return "error";
  if (adapter.connected && adapter.authenticated) return "online";
  if (adapter.connected && !adapter.authenticated) return "warn";
  return "idle";
}

export function statusForAdapter(adapter: ConsoleAdapterAccount): string {
  if (adapter.error) return "ERROR";
  if (adapter.connected && adapter.authenticated) return "CONNECTED";
  if (adapter.connected) return "AUTH REQUIRED";
  return "DISCONNECTED";
}

export function adapterDetailSections(adapter: ConsoleAdapterAccount): ConsoleDetailSection[] {
  return [
    {
      title: "MESSENGER",
      meta: statusForAdapter(adapter),
      rows: liveRows([
        detailRow("adapter", "ADAPTER", formatTokenLabel(adapter.adapter)),
        detailRow("account", "ACCOUNT", adapter.accountId),
        detailRow("mode", "MODE", adapter.mode),
        detailRow("status", "STATUS", statusForAdapter(adapter), {
          status: listRowStatusForTone(toneForAdapter(adapter)),
          statusLabel: statusForAdapter(adapter),
        }),
        detailRow("authenticated", "AUTHENTICATED", adapter.authenticated),
        detailRow("last-activity", "LAST ACTIVITY", adapter.lastActivity === null ? "" : formatAge(adapter.lastActivity)),
        detailRow("error", "ERROR", adapter.error),
      ]),
    },
  ];
}
