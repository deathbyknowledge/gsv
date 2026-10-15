import assert from "node:assert/strict";
import { test } from "node:test";
import { browserExtensionDownloadUrl, buildCliInstallCommand } from "../dist/device-setup.js";

test("operator installer URLs remain literal shell arguments", () => {
  assert.equal(buildCliInstallCommand("unix", "v0.7.0", "https://downloads.example/it's/install.sh"),
    "curl -fsSL 'https://downloads.example/it'\\''s/install.sh' | GSV_VERSION=v0.7.0 bash");
  assert.equal(buildCliInstallCommand("windows", "dev", "https://downloads.example/it's/install.sh"),
    "$env:GSV_CHANNEL='dev'; irm 'https://downloads.example/it''s/install.ps1' | iex");
});

test("extension download uses the project release asset for the selected release", () => {
  assert.equal(browserExtensionDownloadUrl("v0.7.0"), "https://github.com/deathbyknowledge/gsv/releases/download/v0.7.0/gsv-browser-extension.zip");
  assert.equal(browserExtensionDownloadUrl("dev"), "https://github.com/deathbyknowledge/gsv/releases/download/dev/gsv-browser-extension.zip");
});
