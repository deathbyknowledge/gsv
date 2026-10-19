import type { BrowserStorageSite, BrowserStorageUsage, JsonValue } from "@humansandmachines/gsv/protocol";
import type { StorageState } from "./browser";

type StorageSummarySource = {
  origin: string;
  localStorage: { name: string; value: string }[];
  indexedDB?: { name: string; stores: { records: JsonValue[] }[] }[];
};

/** Bounds the entire metadata value independently of the saved state allowance. */
export function boundBrowserStorageUsage(usage: BrowserStorageUsage): BrowserStorageUsage {
  const size = (value: JsonValue) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const result: BrowserStorageUsage = {
    ...usage, sites: [], cookieDomains: [], siteCount: usage.siteCount ?? usage.sites.length,
    sitesTruncated: usage.sitesTruncated ?? false, cookieDomainsTruncated: usage.cookieDomainsTruncated ?? false,
  };
  let remaining = 65536 - size(result);
  for (const domain of usage.cookieDomains ?? []) {
    const cost = size(domain) + 1;
    if (cost > remaining) break;
    result.cookieDomains!.push(domain); remaining -= cost;
  }
  // Keep the largest contributors useful when the detailed breakdown cannot fit.
  for (const site of [...usage.sites].sort((a, b) => b.bytes - a.bytes || a.origin.localeCompare(b.origin))) {
    const cost = size(site) + 1;
    if (cost > remaining) continue;
    result.sites.push(site); remaining -= cost;
  }
  if (result.cookieDomains!.length < (usage.cookieDomains?.length ?? 0)) result.cookieDomainsTruncated = true;
  if (result.sites.length < result.siteCount!) result.sitesTruncated = true;
  return result;
}

/** Serialized into the isolated export page; keep this function self-contained. */
export function summarizeBrowserStorage(data: StorageSummarySource, bytes: number): BrowserStorageSite {
  const size = (value: JsonValue) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const databases = data.indexedDB ?? [];
  const summary: BrowserStorageSite = {
    origin: data.origin, bytes, localStorageBytes: size(data.localStorage), indexedDBBytes: size(databases),
    localStorageEntries: data.localStorage.length, databases: databases.length,
    records: databases.reduce((n, db) => n + db.stores.reduce((m, store) => m + store.records.length, 0), 0),
    databaseUsage: [], databaseUsageTruncated: false,
  };
  let remaining = 4096 - size(summary);
  if (remaining < 0) throw new Error("Storage summary metadata exceeds its limit");
  for (const db of databases.slice(0, 32)) {
    const name = db.name.length > 128 ? `${db.name.slice(0, 127)}…` : db.name;
    const entry = { name, bytes: size(db), stores: db.stores.length, records: db.stores.reduce((n, store) => n + store.records.length, 0) };
    const cost = size(entry) + 1;
    if (cost > remaining) break;
    remaining -= cost;
    summary.databaseUsage!.push(entry);
    if (name !== db.name) summary.databaseUsageTruncated = true;
  }
  if (summary.databaseUsage!.length < databases.length) summary.databaseUsageTruncated = true;
  return summary;
}

export function summarizeBrowserCookies(cookies: StorageState["cookies"]): Pick<BrowserStorageUsage, "cookieDomains" | "cookieDomainsTruncated"> {
  const domains = new Map<string, { domain: string; bytes: number; cookies: number }>();
  const size = (value: JsonValue) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  for (const cookie of cookies) {
    let domain = domains.get(cookie.domain);
    if (!domain) { domain = { domain: cookie.domain, bytes: 2, cookies: 0 }; domains.set(cookie.domain, domain); }
    domain.bytes += size(cookie) + (domain.cookies ? 1 : 0); domain.cookies++;
  }
  const cookieDomains: NonNullable<BrowserStorageUsage["cookieDomains"]> = [];
  let remaining = 32768 - 2;
  for (const domain of [...domains.keys()].sort()) {
    const entry = domains.get(domain)!;
    const cost = size(entry) + 1;
    if (cookieDomains.length === 64 || cost > remaining) break;
    cookieDomains.push(entry); remaining -= cost;
  }
  return { cookieDomains, cookieDomainsTruncated: cookieDomains.length < domains.size };
}
