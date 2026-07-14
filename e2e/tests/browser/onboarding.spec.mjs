import { expect, test } from "@playwright/test";
import { createBrowserStepRunner } from "../../lib/browser-diagnostics.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const gatewayUrl = required("GSV_E2E_GATEWAY_URL");
const username = required("GSV_E2E_USERNAME");
const userPassword = required("GSV_E2E_USER_PASSWORD");
const rootPassword = required("GSV_E2E_ROOT_PASSWORD");
const bootstrapSource = required("GSV_E2E_BOOTSTRAP_SOURCE");
const bootstrapRef = required("GSV_E2E_BOOTSTRAP_REF");
const browserDiagnosticsFile = required("GSV_E2E_BROWSER_DIAGNOSTICS_FILE");
const runBrowserStep = createBrowserStepRunner(browserDiagnosticsFile);

async function expectDesktop(page) {
  await expect(page.locator('[data-session-screen]')).toHaveAttribute("data-session-view", "desktop", {
    timeout: 5 * 60 * 1000,
  });
  await expect(page.getByRole("button", { name: `Lock ${username}`, exact: true })).toBeVisible();
}

test("fresh setup reaches a persistent, recoverable desktop", async ({ page }) => {
  let sessionScreen;
  let login;

  await runBrowserStep("open-setup", async () => {
    await page.goto(gatewayUrl, { waitUntil: "domcontentloaded" });
    sessionScreen = page.locator('[data-session-screen]');
    await expect(sessionScreen).toHaveAttribute("data-session-view", "setup");
    await expect(page.locator('[data-session-setup-view]')).toBeVisible();
  });

  await runBrowserStep("enter-account", async () => {
    await page.locator('[data-setup-lane="customize"]').click();
    const accountStep = page.locator('[data-setup-detail-step="account"]');
    await expect(accountStep).toBeVisible();
    await accountStep.getByLabel(/^Username\b/).fill(username);
    await accountStep.getByLabel(/^Password\b/).fill(userPassword);
    await accountStep.getByLabel(/^Confirm password\b/).fill(userPassword);
    await page.locator('[data-session-setup-form]').getByRole("button", { name: "Next", exact: true }).click();
  });

  await runBrowserStep("enter-system", async () => {
    const systemStep = page.locator('[data-setup-detail-step="system"]');
    await expect(systemStep).toBeVisible();
    await systemStep.getByRole("checkbox", { name: /extra security layer/i }).check();
    await page.locator('[data-setup-root-password]').fill(rootPassword);
    await page.locator('[data-setup-root-password-confirm]').fill(rootPassword);

    await page.locator('[data-setup-source-enabled] input[type="checkbox"]').check();
    await page.locator('[data-setup-bootstrap-source]').fill(bootstrapSource);
    await page.locator('[data-setup-bootstrap-ref]').fill(bootstrapRef);
    await page.locator('[data-session-setup-form]').getByRole("button", { name: "Next", exact: true }).click();
  });

  await runBrowserStep("submit-review", async () => {
    const review = page.locator('[data-setup-stage="review"]');
    await expect(review).toBeVisible();
    await expect(page.locator('[data-setup-summary-account]')).toContainText(username);
    await expect(page.locator('[data-setup-summary-source]')).toContainText(bootstrapRef);
    await page.locator('[data-setup-submit]').click();
  });

  await runBrowserStep("complete-setup", async () => {
    const complete = page.locator('[data-session-setup-complete]');
    await expect(complete).toBeVisible({ timeout: 8 * 60 * 1000 });
    await expect(page.locator('[data-setup-result-username]')).toHaveText(username);
    await expect(page.locator('[data-setup-result-source]')).toContainText(bootstrapSource.replace(/^https?:\/\/github\.com\//, ""));
    await expect(page.locator('[data-setup-result-ref]')).toContainText(bootstrapRef);
    await page.locator('[data-session-setup-continue]').click();
    await expectDesktop(page);
  });

  await runBrowserStep("reload-desktop", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectDesktop(page);
  });

  await runBrowserStep("lock-session", async () => {
    await page.getByRole("button", { name: `Lock ${username}`, exact: true }).click();
    await expect(sessionScreen).toHaveAttribute("data-session-view", "login");
    login = page.locator('[data-session-login-view]');
    await expect(login).toBeVisible();
  });

  await runBrowserStep("reject-wrong-password", async () => {
    await page.locator('[data-session-username]').fill(username);
    await page.locator('[data-session-password]').fill(`${userPassword}-wrong`);
    await login.getByRole("button", { name: "SIGN IN", exact: true }).click();
    await expect(login.locator('.gsv-login-error')).toBeVisible();
    await expect(sessionScreen).toHaveAttribute("data-session-view", "login");
  });

  await runBrowserStep("recover-session", async () => {
    await page.locator('[data-session-password]').fill(userPassword);
    await login.getByRole("button", { name: "SIGN IN", exact: true }).click();
    await expectDesktop(page);
  });
});
