import type { GSVClient } from "@humansandmachines/gsv/client";
import { bodyFromText, bodyToBytes, type BrowserHumanInput, type SysBrowserHandoffGetArgs } from "@humansandmachines/gsv/protocol";

export async function browserFrame(client: GSVClient, args: SysBrowserHandoffGetArgs, signal: AbortSignal) {
  const result = await client.request("sys.browser.handoff.frame", args, { signal });
  if (!result.body) throw new Error("Browser returned no image");
  const bytes = await bodyToBytes(result.body, 8 * 1024 * 1024, signal);
  return { data: result.data, image: new Blob([new Uint8Array(bytes)], { type: result.data.contentType }) };
}

export async function sendBrowserInput(client: GSVClient, args: SysBrowserHandoffGetArgs, input: BrowserHumanInput): Promise<void> {
  await client.request("sys.browser.handoff.input", args, { body: bodyFromText(JSON.stringify(input)) });
}
