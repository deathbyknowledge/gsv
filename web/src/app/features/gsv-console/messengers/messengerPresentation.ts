import type { StatusTone } from "../../../components/ui/StatusDot";
import {
  detailRow,
  listRowStatusForTone,
  liveRows,
} from "../components/consoleDetailRows";
import type { ConsoleDetailSection } from "../components/ConsoleDetailPage";
import { compactText, formatAge, formatTokenLabel } from "../domain/consoleFormat";
import type { ConsoleAdapter, ConsoleAdapterAccount } from "../domain/consoleModels";

export function iconForAdapterName(adapter: string): string {
  if (adapter === "telegram") return "telegram";
  if (adapter === "discord") return "discord";
  if (adapter === "whatsapp") return "doticons/messenger";
  return "chat";
}

export function adapterName(adapter: string): string {
  return formatTokenLabel(adapter);
}

export function adapterFamilySub(adapter: ConsoleAdapter): string {
  const connected = adapter.accounts.filter((account) => account.connected && account.authenticated && !account.error).length;
  const capabilities = [
    adapter.supportsConnect ? "connect" : "",
    adapter.supportsSend ? "send" : "",
    adapter.supportsActivity ? "activity" : "",
  ].filter(Boolean).join(", ");
  return compactText([
    adapter.available ? `${connected}/${adapter.accounts.length} accounts connected` : "adapter worker unavailable",
    capabilities ? `supports ${capabilities}` : "",
  ], `${adapterName(adapter.adapter)} adapter`);
}

export function toneForAdapterFamily(adapter: ConsoleAdapter): StatusTone {
  if (!adapter.available) return adapter.accounts.length > 0 ? "warn" : "idle";
  if (adapter.accounts.some((account) => account.error)) return "error";
  if (adapter.accounts.some((account) => account.connected && account.authenticated)) return "online";
  if (adapter.accounts.some((account) => account.connected || account.authenticated)) return "warn";
  return "idle";
}

export function statusForAdapterFamily(adapter: ConsoleAdapter): string {
  if (!adapter.available) return "UNAVAILABLE";
  const connected = adapter.accounts.filter((account) => account.connected && account.authenticated && !account.error).length;
  if (adapter.accounts.length === 0) return "READY";
  return `${connected}/${adapter.accounts.length}`;
}

export function adapterDetailId(adapter: ConsoleAdapterAccount): string {
  return `${adapter.adapter}:${adapter.accountId}`;
}

export function parseAdapterDetailId(id: string): { adapter: string; accountId: string } | null {
  const separator = id.indexOf(":");
  if (separator <= 0) {
    return null;
  }
  const adapter = id.slice(0, separator).trim();
  const accountId = id.slice(separator + 1).trim();
  return adapter && accountId ? { adapter, accountId } : null;
}

export function adapterLabel(adapter: ConsoleAdapterAccount): string {
  return adapter.accountId;
}

export function adapterSub(adapter: ConsoleAdapterAccount): string {
  return compactText([
    formatTokenLabel(adapter.adapter),
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
  const extraRows = Object.entries(adapter.extra)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => detailRow(`extra-${key}`, formatTokenLabel(key), String(value)));

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
    {
      title: "IDENTITY",
      meta: `${extraRows.filter(Boolean).length}`,
      rows: liveRows(extraRows),
    },
  ];
}

export type AdapterFamilyStatus = "not-enabled" | "connected" | "disconnected" | "attention";

export interface AdapterFamilyStatusInfo {
  status: AdapterFamilyStatus;
  tone: StatusTone;
  label: string;
  connectedCount: number;
  disconnectedCount: number;
  total: number;
  tooltip: string | null;
}

export function familyStatus(adapter: ConsoleAdapter): AdapterFamilyStatusInfo {
  return familyStatusFromAccounts(adapter.accounts, adapter.available);
}

export function familyStatusFromAccounts(
  accounts: readonly ConsoleAdapterAccount[],
  available = true,
): AdapterFamilyStatusInfo {
  const total = accounts.length;
  const connectedCount = accounts.filter(
    (account) => account.connected && account.authenticated && !account.error,
  ).length;
  const disconnectedCount = total - connectedCount;

  // When the adapter worker/service binding is absent, persisted account
  // statuses are stale — a no-longer-deployed bot must not keep showing
  // CONNECTED across the card grid, overview, and desktop objects.
  if (!available) {
    return {
      status: total > 0 ? "attention" : "not-enabled",
      tone: total > 0 ? "warn" : "idle",
      label: total > 0 ? "UNAVAILABLE" : "NOT ENABLED",
      connectedCount,
      disconnectedCount,
      total,
      tooltip: total > 0 ? "Adapter worker unavailable — status may be stale" : null,
    };
  }

  if (total === 0) {
    return {
      status: "not-enabled",
      tone: "idle",
      label: "NOT ENABLED",
      connectedCount,
      disconnectedCount,
      total,
      tooltip: null,
    };
  }

  if (connectedCount === total) {
    return {
      status: "connected",
      tone: "online",
      label: "CONNECTED",
      connectedCount,
      disconnectedCount,
      total,
      tooltip: null,
    };
  }

  if (connectedCount === 0) {
    return {
      status: "disconnected",
      tone: "error",
      label: "DISCONNECTED",
      connectedCount,
      disconnectedCount,
      total,
      tooltip: null,
    };
  }

  return {
    status: "attention",
    tone: "warn",
    label: "ATTENTION",
    connectedCount,
    disconnectedCount,
    total,
    tooltip: `${connectedCount} connected / ${disconnectedCount} disconnected`,
  };
}

/** Messenger platforms GSV supports, in display order. These are ALWAYS shown
 *  (as "NOT ENABLED" when no bot is connected) — there is no empty state. */
export const SUPPORTED_MESSENGER_ADAPTERS = ["telegram", "discord"] as const;

export interface MessengerFamily {
  adapter: string;
  accounts: ConsoleAdapterAccount[];
  status: AdapterFamilyStatusInfo;
}

/** Group a flat list of adapter accounts into the canonical supported platforms,
 *  each with its aggregated family status. Always returns one entry per platform. */
export function messengerFamilies(
  accounts: readonly ConsoleAdapterAccount[],
  inventory: readonly ConsoleAdapter[] = [],
): MessengerFamily[] {
  const availableByAdapter = new Map(inventory.map((entry) => [entry.adapter, entry.available]));
  return SUPPORTED_MESSENGER_ADAPTERS.map((adapter) => {
    const own = accounts.filter((account) => account.adapter === adapter);
    // Absent inventory entry → assume available so we don't falsely flag
    // platforms when callers don't supply availability info.
    const available = availableByAdapter.get(adapter) ?? true;
    return { adapter, accounts: own, status: familyStatusFromAccounts(own, available) };
  });
}

export function deriveTelegramAccountId(botToken: string): string {
  const separator = botToken.indexOf(":");
  if (separator <= 0) {
    return "bot";
  }
  const botId = botToken.slice(0, separator).trim();
  return /^\d+$/.test(botId) ? botId : "bot";
}

/** Discord bot tokens encode the bot's user id (a snowflake) in their first
 *  dot-delimited segment as base64url. Decoding it yields a stable, per-bot
 *  account id — so connecting a second Discord bot gets its own gateway status
 *  entry and Durable Object instead of reusing/overwriting the first ("main"),
 *  while reconnecting the same bot keeps reusing its instance. */
export function deriveDiscordAccountId(botToken: string): string {
  const segment = botToken.split(".")[0]?.trim() ?? "";
  if (!segment) {
    return "bot";
  }
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const decoded = atob(padded);
    return /^\d+$/.test(decoded) ? decoded : "bot";
  } catch {
    return "bot";
  }
}

/** Pick a stable per-bot account id from the bot token for the given adapter. */
export function deriveAccountId(adapter: string, botToken: string): string {
  return adapter === "telegram" ? deriveTelegramAccountId(botToken) : deriveDiscordAccountId(botToken);
}
