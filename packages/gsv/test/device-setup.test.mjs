import assert from "node:assert/strict";
import { test } from "node:test";
import { browserExtensionDownloadUrl, buildCliInstallCommand, DEFAULT_INSTALL_URL, machineUpdateInstallerUrl } from "../dist/device-setup.js";

test("protocol-error installer hints preserve the older Windows directory contract", () => {
  const windows = machineUpdateInstallerUrl("windows");
  assert.equal(`${windows.replace(/\/$/, "")}/install.ps1`, "https://install.ship.space/install.ps1");
  assert.equal(machineUpdateInstallerUrl("linux"), DEFAULT_INSTALL_URL);
  assert.equal(machineUpdateInstallerUrl(undefined), DEFAULT_INSTALL_URL);
  assert.equal(machineUpdateInstallerUrl("windows", "https://downloads.example/host/install.sh"), "https://downloads.example/host");
  assert.equal(machineUpdateInstallerUrl("windows", "https://downloads.example/host/install.ps1"), "https://downloads.example/host");
  assert.equal(machineUpdateInstallerUrl("windows", "https://downloads.example"), "https://downloads.example");
});

test("operator installer URLs remain literal shell arguments", () => {
  assert.equal(buildCliInstallCommand("unix", "v0.7.0", "https://downloads.example/it's/install.sh"),
    "curl -fsSL 'https://downloads.example/it'\\''s/install.sh' | GSV_VERSION=v0.7.0 bash");
  assert.equal(buildCliInstallCommand("windows", "dev", "https://downloads.example/it's/install.sh"),
    "$env:GSV_CHANNEL='dev'; irm 'https://downloads.example/it''s/install.ps1' | iex");
});

test("Windows setup resolves script URLs and directories without losing query parameters", () => {
  for (const path of ["/host", "/host/", "/host/install.sh", "/host/install.ps1"]) {
    assert.equal(buildCliInstallCommand("windows", "v0.7.0", `https://downloads.example${path}?channel=stable`),
      "$env:GSV_VERSION='v0.7.0'; irm 'https://downloads.example/host/install.ps1?channel=stable' | iex");
  }
});

test("extension download uses the project release asset for the selected release", () => {
  assert.equal(browserExtensionDownloadUrl("v0.7.0"), "https://github.com/deathbyknowledge/gsv/releases/download/v0.7.0/gsv-browser-extension.zip");
  assert.equal(browserExtensionDownloadUrl("dev"), "https://github.com/deathbyknowledge/gsv/releases/download/dev/gsv-browser-extension.zip");
});
