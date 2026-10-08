import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { LOCAL_BROWSER_VERSION, setLocalBrowserVersion } from "./dev-browser-version.mjs";

test("changes only the browser version in the installed Wrangler dependency", () => {
  const require = createRequire(import.meta.url);
  const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
  const source = readFileSync(wranglerRequire.resolve("miniflare"), "utf8");
  const updated = setLocalBrowserVersion(source, LOCAL_BROWSER_VERSION);
  assert.equal(updated, source.replace('var BROWSER_VERSION = "126.0.6478.182";', `var BROWSER_VERSION = "${LOCAL_BROWSER_VERSION}";`));
  assert.notEqual(updated, source);
});

test("refuses invalid versions and a changed dependency instead of silently using old Chrome", () => {
  assert.throws(() => setLocalBrowserVersion('var BROWSER_VERSION = "126.0.6478.182";', "stable"), /full Chrome/);
  assert.throws(() => setLocalBrowserVersion("const browser = 126;", LOCAL_BROWSER_VERSION), /declaration changed/);
});
