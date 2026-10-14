import type { TabSummary } from "./backend";

export const MAX_TAB_PAGE_SIZE = 128;
const MAX_TAB_PAGE_BYTES = 128 * 1024;
const encoder = new TextEncoder();

function displayText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = limit - 1;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${value.slice(0, end)}…`;
}

type TabMetadata = { title: string; url: string };

export function browserTabMetadata(title: string, url: string): TabMetadata {
  return { title: displayText(title, 1024), url: browserDisplayUrl(url) };
}

export function browserDisplayUrl(url: string): string { return displayText(url, 8192); }

export type TabList = { tabs: TabSummary[]; total: number; nextOffset?: number };

export function tabSummaryPage(candidates: Iterable<TabSummary>, total: number, offset = 0): TabList {
  const tabs: TabSummary[] = [];
  let bytes = 2;
  for (const candidate of candidates) {
    const tab = { ...candidate,
      title: candidate.title === null ? null : displayText(candidate.title, 1024),
      url: candidate.url === null ? null : browserDisplayUrl(candidate.url),
      favIconUrl: candidate.favIconUrl === null ? null : browserDisplayUrl(candidate.favIconUrl),
    };
    const length = encoder.encode(JSON.stringify(tab, null, 2)).byteLength + 64;
    if (tabs.length >= MAX_TAB_PAGE_SIZE || bytes + length > MAX_TAB_PAGE_BYTES) break;
    tabs.push(tab); bytes += length;
  }
  const nextOffset = offset + tabs.length;
  const page: TabList = { tabs, total };
  if (nextOffset < total) page.nextOffset = nextOffset;
  return page;
}
