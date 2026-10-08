export * from "@humansandmachines/gsv-browser/commands/tabs";
import { createTabCommands } from "@humansandmachines/gsv-browser/commands/tabs";
import * as browserBackend from "../../shared/chrome";
import { tabSummaryPage, MAX_TAB_PAGE_SIZE } from "@humansandmachines/gsv-browser/tab-metadata";
function viewerUrlFor(path: string, contentType: string, label: string): string {
  const params = new URLSearchParams({
    path,
    mime: contentType,
    label,
  });
  return chrome.runtime.getURL(`viewer.html?${params.toString()}`);
}
export const { tabCommands } = createTabCommands({ ...browserBackend, viewerUrlFor,
  listTabs: async (offset = 0) => {
    const tabs = await browserBackend.listTabs();
    return tabSummaryPage(tabs.slice(offset, offset + MAX_TAB_PAGE_SIZE), tabs.length, offset);
  },
});
export default tabCommands;
