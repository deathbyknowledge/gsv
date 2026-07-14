import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLAYWRIGHT_CHROMIUM_INSTALL_COMMAND =
  "npm --prefix e2e exec -- playwright install chromium";

export function chromiumExecutableAvailable(path, access = accessSync) {
  if (typeof path !== "string" || path.length === 0) {
    return false;
  }
  try {
    access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function verifyInstalledChromium({
  loadPlaywright = () => import("@playwright/test"),
  access = accessSync,
} = {}) {
  try {
    const playwright = await loadPlaywright();
    const executablePath = playwright.chromium.executablePath();
    return chromiumExecutableAvailable(executablePath, access);
  } catch {
    return false;
  }
}

export function chromiumPreflightFailure() {
  return `error: Playwright Chromium is unavailable; run: ${PLAYWRIGHT_CHROMIUM_INSTALL_COMMAND}`;
}

async function main(args) {
  if (args.length !== 1 || args[0] !== "verify") {
    console.error("usage: browser-preflight.mjs verify");
    process.exitCode = 1;
    return;
  }
  if (!await verifyInstalledChromium()) {
    console.error(chromiumPreflightFailure());
    process.exitCode = 1;
    return;
  }
  console.log("Playwright Chromium executable verified.");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
