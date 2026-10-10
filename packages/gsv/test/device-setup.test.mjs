import assert from "node:assert/strict";
import { test } from "node:test";
import { browserExtensionDownloadUrl } from "../dist/device-setup.js";

test("extension download stays on the GSV browser route for the selected release", () => {
  assert.equal(browserExtensionDownloadUrl("v0.7.0"), "https://gsv.space/browser?release=v0.7.0");
  assert.equal(browserExtensionDownloadUrl("dev"), "https://gsv.space/browser?release=dev");
});
