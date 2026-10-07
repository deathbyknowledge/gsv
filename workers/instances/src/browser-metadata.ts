import type { BrowserViewState } from "@humansandmachines/gsv/protocol";
import { browserTabMetadata } from "@humansandmachines/gsv-browser/tab-metadata";
export { browserTabMetadata, browserDisplayUrl } from "@humansandmachines/gsv-browser/tab-metadata";

export const MAX_BROWSER_VIEW_TABS = 128;
const MAX_TAB_METADATA_BYTES = 128 * 1024;
const encoder = new TextEncoder();
type TabMetadata = { title: string; url: string };

/** Reserve packet space for handoff and pointer fields, including JSON/UTF-8 expansion. */
export function browserViewTabs(metadata: ReadonlyMap<number, TabMetadata>, activeTabId: number, preferredTabId?: number): BrowserViewState["tabs"] {
  const selected = new Map<number, BrowserViewState["tabs"][number]>();
  let bytes = 2;
  const add = (id: number, value: TabMetadata): boolean => {
    if (selected.has(id)) return true;
    const tab = { id, ...browserTabMetadata(value.title, value.url) };
    const length = encoder.encode(JSON.stringify(tab)).byteLength + 1;
    if (bytes + length > MAX_TAB_METADATA_BYTES) return false;
    selected.set(id, tab); bytes += length;
    return true;
  };
  for (const id of [activeTabId, preferredTabId]) {
    if (id === undefined) continue;
    const value = metadata.get(id);
    if (value) add(id, value);
  }
  for (const [id, value] of metadata) {
    if (selected.size >= MAX_BROWSER_VIEW_TABS || !add(id, value)) break;
  }
  return [...selected.values()].sort((a, b) => a.id - b.id);
}
