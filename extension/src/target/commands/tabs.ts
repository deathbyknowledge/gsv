export * from "@humansandmachines/gsv-browser/commands/tabs";
import { createTabCommands } from "@humansandmachines/gsv-browser/commands/tabs";
import * as browserBackend from "../../shared/chrome";
function viewerUrlFor(path: string, contentType: string, label: string): string {
  const params = new URLSearchParams({
    path,
    mime: contentType,
    label,
  });
  return chrome.runtime.getURL(`viewer.html?${params.toString()}`);
}
export const { tabCommands } = createTabCommands({ ...browserBackend, viewerUrlFor });
export default tabCommands;
