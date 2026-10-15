import assert from "node:assert/strict";
import { createServer } from "node:http";
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

test("legacy Windows filename appending preserves the requested script and query", async (t) => {
  const server = createServer((request, response) => response.end(request.url));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const path of ["/host", "/host/", "/host/install.sh", "/host/install.ps1"]) {
    for (const suffix of ["?channel=stable&arch=x64", "#instructions", "?channel=stable&arch=x64#instructions"]) {
      const hint = machineUpdateInstallerUrl("windows", `https://downloads.example${path}${suffix}`);
      const legacyRequest = new URL(`${hint.replace(/\/+$/, "")}/install.ps1`);
      assert.equal(legacyRequest.origin, "https://downloads.example");
      assert.equal(legacyRequest.pathname, "/host/install.ps1");
      assert.equal(legacyRequest.search, suffix.startsWith("?") ? "?channel=stable&arch=x64" : "");
      legacyRequest.protocol = "http:";
      legacyRequest.host = `127.0.0.1:${server.address().port}`;
      const response = await fetch(legacyRequest, { signal: AbortSignal.timeout(5000) });
      assert.equal(await response.text(), `/host/install.ps1${legacyRequest.search}`);
    }
  }
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
