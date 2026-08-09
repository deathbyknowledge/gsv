import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { InstallationOnboardingStore } from "../onboarding";
import { AccountStore } from "../store";
import { InstallationAdminService } from "./service";

function adminService(): InstallationAdminService {
  const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
  return new InstallationAdminService(
    env.ACCOUNT_DB,
    accounts,
    new InstallationOnboardingStore(env.ACCOUNT_DB, accounts),
  );
}

describe("installation admin service", () => {
  it("creates a routed installation and one-time onboarding claim", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = adminService();
    const created = await service.create({
      operationId: `operation_admin_${suffix}`,
      handle: `admin-${suffix}`,
    });

    expect(created.installation).toMatchObject({
      installationId: created.onboarding.installationId,
      handle: `admin-${suffix}`,
      state: "provisioning",
      operationState: "provisioning",
    });
    expect(created.onboarding.onboardingUrl).toMatch(
      new RegExp(`^https://admin-${suffix}\\.gsv\\.space/onboarding#onboard_`),
    );
    await expect(service.list()).resolves.toContainEqual(created.installation);
  });

  it("reissues a claim without creating another installation", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = adminService();
    const created = await service.create({
      operationId: `operation_reissue_${suffix}`,
      handle: `reissue-${suffix}`,
    });
    const reissued = await service.reissueOnboarding(
      created.installation.installationId,
    );

    expect(reissued.installation.installationId).toBe(
      created.installation.installationId,
    );
    expect(reissued.onboarding.onboardingUrl).not.toBe(
      created.onboarding.onboardingUrl,
    );
  });
});
