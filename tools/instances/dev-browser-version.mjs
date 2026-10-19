import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// Miniflare pins Chrome 126, whose anchor positioning breaks modern popovers.
// Match the Chromium build supported by our @cloudflare/playwright package.
// Remove this local-only shim when Wrangler exposes a browser version option.
export const LOCAL_BROWSER_VERSION = "145.0.7632.6";

export function setLocalBrowserVersion(source, version) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("GSV_DEV_BROWSER_VERSION must be a full Chrome for Testing version");
  }
  const declaration = /\b(?:var|const) BROWSER_VERSION = "\d+\.\d+\.\d+\.\d+";/g;
  if ([...source.matchAll(declaration)].length !== 1) {
    throw new Error("Miniflare's browser version declaration changed; review the GSV local browser shim");
  }
  return source.replace(declaration, `var BROWSER_VERSION = ${JSON.stringify(version)};`);
}

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const miniflareUrl = pathToFileURL(wranglerRequire.resolve("miniflare")).href;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== miniflareUrl) return loaded;
    const version = process.env.GSV_DEV_BROWSER_VERSION ?? LOCAL_BROWSER_VERSION;
    const source = setLocalBrowserVersion(String(loaded.source), version);
    console.info(`GSV local browser: Chrome ${version}`);
    return { ...loaded, source };
  },
});
