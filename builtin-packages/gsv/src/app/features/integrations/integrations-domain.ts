import type { AdapterAccount, AdapterKind, AdaptersState } from "./types";

export type AdapterMeta = {
  id: AdapterKind;
  name: string;
  shortName: string;
  icon: string;
  summary: string;
  detail: string;
  accountPlaceholder: string;
};

export const ADAPTERS: AdapterMeta[] = [
  {
    id: "whatsapp",
    name: "WhatsApp",
    shortName: "WA",
    icon: "W",
    summary: "Phone-linked direct messages and groups.",
    detail: "Pair once, keep the gateway session alive, and route inbound conversations into GSV.",
    accountPlaceholder: "primary",
  },
  {
    id: "discord",
    name: "Discord",
    shortName: "DC",
    icon: "D",
    summary: "Bot-driven channels, DMs, and communities.",
    detail: "Attach a bot identity, monitor health, and control which account GSV uses for replies.",
    accountPlaceholder: "main",
  },
];

export const EMPTY_ADAPTERS_STATE: AdaptersState = {
  statusByAdapter: {
    whatsapp: [],
    discord: [],
  },
};

export function getAdapterMeta(adapter: AdapterKind): AdapterMeta {
  return ADAPTERS.find((item) => item.id === adapter) ?? ADAPTERS[0];
}

export function getAdapterTone(accounts: AdapterAccount[]): "is-good" | "is-warn" | "is-idle" {
  const connectedCount = accounts.filter((account) => account.connected).length;
  return connectedCount > 0 ? "is-good" : accounts.length > 0 ? "is-warn" : "is-idle";
}

export function getAccountStatus(account: AdapterAccount): string {
  return account.connected ? "Connected" : account.authenticated ? "Authenticated" : "Needs attention";
}

export function getAccountTone(account: AdapterAccount): "is-good" | "is-warn" | "is-idle" {
  return account.connected ? "is-good" : account.authenticated ? "is-warn" : "is-idle";
}

export function describeAccount(adapter: AdapterKind, account: AdapterAccount): Array<[string, string]> {
  const rows: Array<[string, string]> = [["Account", account.accountId]];
  const extras = account.extra ?? {};
  if (adapter === "whatsapp") {
    const phone = typeof extras.selfE164 === "string" ? extras.selfE164.trim() : "";
    const jid = typeof extras.selfJid === "string" ? extras.selfJid.trim() : "";
    if (phone) rows.push(["Phone", phone]);
    if (jid) rows.push(["JID", jid]);
  }
  for (const [key, value] of Object.entries(extras)) {
    if (key === "selfE164" || key === "selfJid") continue;
    if (value === null || value === undefined || value === "") continue;
    rows.push([humanizeKey(key), String(value)]);
  }
  if (rows.length === 1) {
    rows.push(["Details", "No extra identity details reported."]);
  }
  return rows;
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/^./, (value) => value.toUpperCase());
}
