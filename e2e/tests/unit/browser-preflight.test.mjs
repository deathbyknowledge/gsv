import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  chromiumExecutableAvailable,
  chromiumPreflightFailure,
  PLAYWRIGHT_CHROMIUM_INSTALL_COMMAND,
  verifyInstalledChromium,
} from "../../lib/browser-preflight.mjs";

test("browser preflight requires the resolved executable to exist and be executable", () => {
  const root = mkdtempSync(join(tmpdir(), "gsv-e2e-browser-preflight-"));
  const executable = join(root, "chromium");
  try {
    writeFileSync(executable, "placeholder", { mode: 0o600 });
    assert.equal(chromiumExecutableAvailable(executable), false);
    chmodSync(executable, 0o700);
    assert.equal(chromiumExecutableAvailable(executable), true);
    assert.equal(chromiumExecutableAvailable(join(root, "missing")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser preflight checks the exact path selected by Playwright", async () => {
  const privatePath = "/private/cache/revision/chromium";
  let checkedPath;
  const available = await verifyInstalledChromium({
    loadPlaywright: async () => ({
      chromium: { executablePath: () => privatePath },
    }),
    access: (path) => {
      checkedPath = path;
    },
  });
  assert.equal(available, true);
  assert.equal(checkedPath, privatePath);

  assert.equal(await verifyInstalledChromium({
    loadPlaywright: async () => {
      throw new Error("private module error");
    },
  }), false);
});

test("browser preflight failure exposes only fixed remediation", () => {
  assert.equal(
    chromiumPreflightFailure(),
    `error: Playwright Chromium is unavailable; run: ${PLAYWRIGHT_CHROMIUM_INSTALL_COMMAND}`,
  );
  assert.equal(
    PLAYWRIGHT_CHROMIUM_INSTALL_COMMAND,
    "npm --prefix e2e exec -- playwright install chromium",
  );
  assert.doesNotMatch(chromiumPreflightFailure(), /cache|revision|private|home|credential/iu);
});
