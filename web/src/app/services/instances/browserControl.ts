import type { GSVClient } from "@humansandmachines/gsv/client";
import { bodyFromText, decodeBrowserViewStream, type BrowserHumanInput, type SysBrowserWatchArgs, type SysBrowserInputArgs } from "@humansandmachines/gsv/protocol";

export async function watchBrowser(client: GSVClient, args: SysBrowserWatchArgs, signal: AbortSignal) {
  const result = await client.request("sys.browser.watch", args, { signal });
  if (!result.body) throw new Error("Browser returned no view stream");
  return decodeBrowserViewStream(result.body, signal);
}

export async function sendBrowserInput(client: GSVClient, args: SysBrowserInputArgs, input: BrowserHumanInput): Promise<void> {
  await client.request("sys.browser.input", args, { body: bodyFromText(JSON.stringify(input)) });
}
