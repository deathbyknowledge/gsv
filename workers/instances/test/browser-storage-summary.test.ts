import { describe, expect, it } from "vitest";
import type { JsonValue } from "@humansandmachines/gsv/protocol";
import type { StorageState } from "../src/browser";
import { summarizeBrowserCookies, summarizeBrowserStorage } from "../src/browser-storage-summary";

const size = (value: JsonValue) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
describe("browser storage metadata bounds", () => {
  it.each(["name", "\u0000", "😀"])("bounds database details containing %j while retaining exact totals", text => {
    const data: StorageState["origins"][number] = {
      origin: "https://example.com", localStorage: [{ name: "session", value: "present" }],
      indexedDB: Array.from({ length: 100 }, (_, index) => ({ name: `${index}-${text.repeat(4096)}`, version: 1, stores: [] })),
    };
    const summary = summarizeBrowserStorage(data, size(data));
    expect(size(summary)).toBeLessThanOrEqual(4096);
    expect(summary).toMatchObject({ bytes: size(data), databases: 100, records: 0, localStorageEntries: 1,
      localStorageBytes: size(data.localStorage), indexedDBBytes: size(data.indexedDB), databaseUsageTruncated: true });
    expect(summary.databaseUsage!.length).toBeGreaterThan(0);
    expect(summary.databaseUsage!.length).toBeLessThanOrEqual(32);
    expect(summary.databaseUsage![0]!.name.endsWith("…")).toBe(true);
    expect(summary.databaseUsage![0]!.bytes).toBe(size(data.indexedDB![0]));
    expect(data.indexedDB![0]!.name.length).toBeGreaterThan(4096);
  });
  it("reports complete details for ordinary databases", () => {
    const data = { origin: "https://example.com", localStorage: [], indexedDB: [{ name: "login", version: 1, stores: [] }] };
    expect(summarizeBrowserStorage(data, size(data))).toMatchObject({ databaseUsageTruncated: false,
      databaseUsage: [{ name: "login", bytes: size(data.indexedDB[0]!), stores: 0, records: 0 }] });
  });
  it("bounds cookie-domain details and preserves exact per-domain counts and bytes", () => {
    const cookie = { name: "session", value: "present", domain: "example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const };
    const cookies = Array.from({ length: 100 }, (_, index) => ({ ...cookie, domain: `${index.toString().padStart(3, "0")}.example.com` }));
    cookies.push({ ...cookies[0]!, name: "other" });
    const summary = summarizeBrowserCookies(cookies);
    expect(summary.cookieDomainsTruncated).toBe(true);
    expect(summary.cookieDomains).toHaveLength(64);
    expect(size(summary.cookieDomains)).toBeLessThanOrEqual(32768);
    expect(summary.cookieDomains![0]).toEqual({ domain: cookies[0]!.domain, cookies: 2, bytes: size([cookies[0], cookies[100]]) });
    expect(summarizeBrowserCookies([cookie]).cookieDomainsTruncated).toBe(false);
    expect(summarizeBrowserCookies([{ ...cookie, domain: "\u0000".repeat(32768) }])).toEqual({ cookieDomains: [], cookieDomainsTruncated: true });
  });
});
