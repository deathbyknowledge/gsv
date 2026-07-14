import { defineConfig } from "@playwright/test";

const outputDir = process.env.GSV_E2E_PLAYWRIGHT_OUTPUT_DIR;
if (!outputDir) {
  throw new Error("GSV_E2E_PLAYWRIGHT_OUTPUT_DIR is required");
}

export default defineConfig({
  testDir: "./tests/browser",
  outputDir,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10 * 60 * 1000,
  expect: {
    timeout: 30 * 1000,
  },
  reporter: [["line"]],
  use: {
    browserName: "chromium",
    headless: process.env.GSV_E2E_HEADED !== "1",
    screenshot: "off",
    trace: "off",
    video: "off",
    viewport: { width: 1440, height: 1000 },
  },
});
