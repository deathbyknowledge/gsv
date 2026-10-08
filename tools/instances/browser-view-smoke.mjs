import { decodeBrowserViewStream } from "../../packages/gsv/dist/protocol.js";

/** Read the displayed document through the same stream used by Instrument. */
export async function readBrowserView(client, args) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
  try {
    const result = await client.request("sys.browser.watch", args, { signal });
    let state;
    for await (const { metadata, image } of decodeBrowserViewStream(result.body, signal)) {
      if (metadata.kind === "state") state = metadata;
      else if (state) return { ...state, ...metadata, image };
    }
    throw new Error("Browser view ended before displaying a document");
  } finally { controller.abort(); }
}
